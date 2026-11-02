#!/usr/bin/env bash
# Builds the Docker images of the web console from source, end to end (see "Docker images" in README.md):
#
#   1. checks the tools, the free disk space, and the working tree;
#   2. configures a Release build in build_release/ (once; later runs reuse it);
#   3. builds the `clickhouse` binary, with the output in <build dir>/ninja_release.log;
#   4. runs package_images.sh: builds, smoke-tests, and packages both images into tmp/dist/<version>/.
#
#   utils/web-console/build_images.sh [options]
#
#     --build-dir <dir>     build directory (default: build_release in the repository)
#     --with-rust           build the Rust components too (needs rustup with the toolchain named in
#                           contrib/corrosion-cmake/CMakeLists.txt); default: without them
#     --package-only        do not build: package the binary already in the build directory
#     --base-image <image>  official server image of the same release (default: package_images.sh's)
#     --out <dir>           output directory (default: tmp/dist/<version>)
#     --allow-dirty         allow uncommitted changes; the version gets the suffix -dirty
#
# Compilers: CC and CXX, or clang-22 and clang++-22 when installed. The first build of the binary takes several hours
# (about 6 on 22 cores); an interrupted build resumes where it stopped when the script runs again. Packaging takes a few
# minutes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_DIR="$ROOT/build_release"
WITH_RUST=0
PACKAGE_ONLY=0
ALLOW_DIRTY=0
PACKAGE_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --build-dir) BUILD_DIR="$(realpath -m "$2")"; shift 2 ;;
        --with-rust) WITH_RUST=1; shift ;;
        --package-only) PACKAGE_ONLY=1; shift ;;
        --base-image|--out) PACKAGE_ARGS+=("$1" "$2"); shift 2 ;;
        --allow-dirty) ALLOW_DIRTY=1; PACKAGE_ARGS+=("$1"); shift ;;
        -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1 (see --help)" >&2; exit 2 ;;
    esac
done

die() { echo "error: $*" >&2; exit 1; }
step() { echo; echo "=== $*"; }

# --- 1. Checks: everything that would otherwise fail only after hours of compiling.

step "Checks"
for tool in docker git; do
    command -v "$tool" > /dev/null || die "$tool is not installed"
done
docker info > /dev/null 2>&1 || die "Docker is not running, or this user cannot use it"
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no -- programs src utils/web-console)" ] && [ "$ALLOW_DIRTY" = 0 ]; then
    die "the working tree has uncommitted changes in programs/, src/, or utils/web-console/: commit them, or pass --allow-dirty"
fi

if [ "$PACKAGE_ONLY" = 0 ]; then
    for tool in cmake ninja; do
        command -v "$tool" > /dev/null || die "$tool is not installed"
    done
    if [ -z "${CC:-}" ] && command -v clang-22 > /dev/null; then export CC=clang-22 CXX=clang++-22; fi
    export CC="${CC:-clang}" CXX="${CXX:-clang++}"
    command -v "$CC" > /dev/null && command -v "$CXX" > /dev/null || die "compilers $CC and $CXX not found: set CC and CXX"
    if [ "$WITH_RUST" = 1 ]; then
        TOOLCHAIN="$(grep -oP 'set\(Rust_TOOLCHAIN "\K[^"]+' "$ROOT/contrib/corrosion-cmake/CMakeLists.txt")"
        command -v rustup > /dev/null && rustup toolchain list | grep -q "^$TOOLCHAIN" \
            || die "--with-rust needs the Rust toolchain $TOOLCHAIN: rustup toolchain install $TOOLCHAIN"
    fi
    # A Release build of the binary needs about 60 GB in the build directory.
    mkdir -p "$BUILD_DIR"
    FREE_GB=$(( $(df --output=avail -k "$BUILD_DIR" | tail -1) / 1024 / 1024 ))
    [ "$FREE_GB" -ge 60 ] || [ -x "$BUILD_DIR/programs/clickhouse" ] || die "only ${FREE_GB} GB free in $BUILD_DIR; the build needs about 60 GB"
    echo "Compilers: $CC, $CXX; Rust components: $([ "$WITH_RUST" = 1 ] && echo yes || echo no); free space: ${FREE_GB} GB"
fi

# --- 2. Configure, once. An existing build directory must be a Release build with the same Rust choice.

if [ "$PACKAGE_ONLY" = 0 ]; then
    step "Configure $BUILD_DIR"
    RUST_FLAG=$([ "$WITH_RUST" = 1 ] && echo ON || echo OFF)
    if [ -f "$BUILD_DIR/CMakeCache.txt" ]; then
        BUILD_TYPE="$(grep -oP '^CMAKE_BUILD_TYPE:STRING=\K.*' "$BUILD_DIR/CMakeCache.txt")"
        [ "$BUILD_TYPE" = Release ] || die "$BUILD_DIR is a $BUILD_TYPE build: use another --build-dir"
        CACHED_RUST="$(grep -oP '^ENABLE_RUST:BOOL=\K.*' "$BUILD_DIR/CMakeCache.txt" || echo OFF)"
        [ "$CACHED_RUST" = "$RUST_FLAG" ] || die "$BUILD_DIR was configured with ENABLE_RUST=$CACHED_RUST: use another --build-dir, or $([ "$CACHED_RUST" = ON ] && echo add || echo remove) --with-rust"
        echo "Already configured (Release, ENABLE_RUST=$CACHED_RUST)"
    else
        cmake -S "$ROOT" -B "$BUILD_DIR" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
            -DENABLE_TESTS=0 -DENABLE_RUST="$RUST_FLAG" > "$BUILD_DIR/cmake.log" 2>&1 \
            || { tail -30 "$BUILD_DIR/cmake.log"; die "configuration failed; the full output is in $BUILD_DIR/cmake.log"; }
        echo "Configured; the output is in $BUILD_DIR/cmake.log"
    fi

    # --- 3. Build the binary. ninja chooses the parallelism; the progress is the last [n/total] of the log.

    step "Build the clickhouse binary (log: $BUILD_DIR/ninja_release.log)"
    STARTED=$(date +%s)
    if ! ninja -C "$BUILD_DIR" clickhouse > "$BUILD_DIR/ninja_release.log" 2>&1; then
        grep -A20 -m3 '^FAILED' "$BUILD_DIR/ninja_release.log" || tail -30 "$BUILD_DIR/ninja_release.log"
        die "the build failed; the full output is in $BUILD_DIR/ninja_release.log. Run the script again after fixing it: the build resumes"
    fi
    echo "Built in $(( ($(date +%s) - STARTED) / 60 )) minutes: $("$BUILD_DIR/programs/clickhouse" local --version)"
fi

# --- 4. Images and archives.

step "Build, test, and package the images"
exec "$ROOT/utils/web-console/package_images.sh" --binary "$BUILD_DIR/programs/clickhouse" ${PACKAGE_ARGS[@]+"${PACKAGE_ARGS[@]}"}
