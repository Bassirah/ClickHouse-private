#!/usr/bin/env bash
# Builds the two images of the web console and packages them for distribution as archives (see README.md):
#
#   clickhouse-server-console:<version>   the ClickHouse server with the console (Dockerfile), on the official image
#   clickhouse-console-tools:<version>    the backup worker, the cluster agent, and the access policy worker (Dockerfile.tools)
#
#   utils/web-console/package_images.sh [--binary <path>] [--base-image <image>] [--out <dir>] [--allow-dirty]
#
# The version is `<tag of the base image>-console.<commit>`. The output directory gets one `.tar.gz` per image (load with
# `docker load -i`), SHA256SUMS, MANIFEST.txt, and the deployment examples of `deploy/`. Both images are smoke-tested
# before they are saved. A working tree with uncommitted changes is refused unless --allow-dirty is given, because the
# version would not identify what the images contain.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/utils/web-console"
BINARY="$ROOT/build_release/programs/clickhouse"
BASE_IMAGE="clickhouse/clickhouse-server:26.9.8.3"
OUT=""
ALLOW_DIRTY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --binary) BINARY="$2"; shift 2 ;;
        --base-image) BASE_IMAGE="$2"; shift 2 ;;
        --out) OUT="$2"; shift 2 ;;
        --allow-dirty) ALLOW_DIRTY=1; shift ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

die() { echo "error: $*" >&2; exit 1; }

# --- Version and checks

REVISION="$(git -C "$ROOT" rev-parse HEAD)"
DIRTY=""
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no -- programs src utils/web-console)" ]; then
    [ "$ALLOW_DIRTY" = 1 ] || die "the working tree has uncommitted changes in programs/, src/, or utils/web-console/: commit them, or pass --allow-dirty"
    DIRTY="-dirty"
fi
BASE_TAG="${BASE_IMAGE##*:}"
VERSION="${BASE_TAG}-console.$(git -C "$ROOT" rev-parse --short=11 HEAD)${DIRTY}"
OUT="${OUT:-$ROOT/tmp/dist/$VERSION}"
SERVER_IMAGE="clickhouse-server-console:$VERSION"
TOOLS_IMAGE="clickhouse-console-tools:$VERSION"

[ -x "$BINARY" ] || die "no clickhouse binary at $BINARY (build it with utils/web-console/build_images.sh)"
BUILD_TYPE="$(grep -oP '^CMAKE_BUILD_TYPE:STRING=\K.*' "$(dirname "$(dirname "$BINARY")")/CMakeCache.txt" 2>/dev/null || echo unknown)"
[ "$BUILD_TYPE" = Release ] || [ "$BUILD_TYPE" = RelWithDebInfo ] \
    || die "the binary comes from a $BUILD_TYPE build; distribute a Release or RelWithDebInfo build"
BINARY_VERSION="$("$BINARY" local --version | grep -oP 'version \K[0-9]+\.[0-9]+\.[0-9]+')"
case "$BASE_TAG" in
    "$BINARY_VERSION"|"$BINARY_VERSION".*) ;;
    *) die "the binary is version $BINARY_VERSION, the base image $BASE_TAG: use the official image of the same release" ;;
esac
docker image inspect "$BASE_IMAGE" > /dev/null 2>&1 || docker pull "$BASE_IMAGE"
BASE_DIGEST="$(docker image inspect "$BASE_IMAGE" --format '{{index .RepoDigests 0}}')"

echo "Version:    $VERSION"
echo "Binary:     $BINARY ($BUILD_TYPE, $BINARY_VERSION)"
echo "Base image: $BASE_DIGEST"
echo "Output:     $OUT"

# --- Staging

STAGE="$(mktemp -d "$ROOT/tmp/package-images.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/server" "$STAGE/tools" "$OUT"

# Debug information only: the symbols stay, so that stack traces in the server log keep their function names.
llvm-strip-22 --strip-debug -o "$STAGE/server/clickhouse" "$BINARY" 2>/dev/null || strip --strip-debug -o "$STAGE/server/clickhouse" "$BINARY"
cp "$HERE/backup_worker.mjs" "$HERE/server_bundle.mjs" "$HERE/cluster_agent.mjs" "$HERE/access_policy_worker.mjs" "$HERE/sso_authenticator.mjs" "$HERE/tools-entrypoint.sh" "$STAGE/tools/"
cp "$ROOT/programs/server/console.html" "$STAGE/tools/"
echo "$VERSION $REVISION" > "$STAGE/tools/VERSION"

# --- Build

docker build -q -f "$HERE/Dockerfile" --build-arg BASE_IMAGE="$BASE_IMAGE" --build-arg VERSION="$VERSION" --build-arg REVISION="$REVISION" \
    -t "$SERVER_IMAGE" "$STAGE/server"
docker build -q -f "$HERE/Dockerfile.tools" --build-arg VERSION="$VERSION" --build-arg REVISION="$REVISION" \
    -t "$TOOLS_IMAGE" "$STAGE/tools"

# --- Smoke tests: the server answers, serves the console, and runs the binary of this build; the tools start.

NAME="console-smoke-$$"
docker run -d --name "$NAME" -e CLICKHOUSE_PASSWORD=smoke-test-password --ulimit nofile=262144:262144 "$SERVER_IMAGE" > /dev/null
cleanup_smoke() { docker rm -f "$NAME" > /dev/null 2>&1 || true; }
trap 'cleanup_smoke; rm -rf "$STAGE"' EXIT
for _ in $(seq 60); do
    docker exec "$NAME" clickhouse-client --password smoke-test-password -q 'SELECT 1' > /dev/null 2>&1 && break
    sleep 1
done
SERVER_VERSION="$(docker exec "$NAME" clickhouse-client --password smoke-test-password -q 'SELECT version()')"
case "$SERVER_VERSION" in "$BINARY_VERSION"|"$BINARY_VERSION".*) ;; *) die "the server reports version $SERVER_VERSION, the binary $BINARY_VERSION" ;; esac
CONSOLE_STATUS="$(docker exec "$NAME" sh -c 'wget -q -S -O /dev/null http://127.0.0.1:8123/console 2>&1 | grep -m1 "HTTP/" | tr -d "\r"')"
case "$CONSOLE_STATUS" in *" 200"*) ;; *) die "/console answered: $CONSOLE_STATUS" ;; esac
docker exec "$NAME" sh -c 'wget -q -O - http://127.0.0.1:8123/console | grep -q "admin-data-access"' || die "/console does not serve the page of this build"
cleanup_smoke
echo "Server smoke test: version $SERVER_VERSION, /console served"

for process in backup-worker cluster-agent access-policy-worker; do
    # Without a server to connect to, each process must start, load its code, and fail on the connection, not earlier.
    output="$(docker run --rm --network none -e CLICKHOUSE_URL=http://127.0.0.1:1 -e CLUSTER_AGENT_STATE_DIR=/tmp/agent "$TOOLS_IMAGE" "$process" --once 2>&1 || true)"
    case "$output" in
        *SyntaxError*|*"Cannot find module"*|*ERR_MODULE_NOT_FOUND*|*ENOENT*console.html*) die "$process does not start: $output" ;;
    esac
done
docker run --rm --entrypoint sh "$TOOLS_IMAGE" -c 'docker --version && docker compose version && kubectl version --client && node --version' > /dev/null
echo "Tools smoke test: the three processes start; docker, compose, kubectl, and node present"

# --- Package

save() {
    local image="$1" file="$2"
    docker save "$image" | gzip -6 > "$OUT/$file"
}
SERVER_FILE="clickhouse-server-console-$VERSION-amd64.tar.gz"
TOOLS_FILE="clickhouse-console-tools-$VERSION-amd64.tar.gz"
save "$SERVER_IMAGE" "$SERVER_FILE"
save "$TOOLS_IMAGE" "$TOOLS_FILE"
rm -rf "$OUT/deploy" && cp -r "$HERE/deploy" "$OUT/deploy"
sed -i "s/^CONSOLE_VERSION=.*/CONSOLE_VERSION=$VERSION/" "$OUT/deploy/.env.example"
sed -i "s/clickhouse-server-console:VERSION/clickhouse-server-console:$VERSION/; s/clickhouse-console-tools:VERSION/clickhouse-console-tools:$VERSION/" "$OUT/deploy/kubernetes.yaml"

cat > "$OUT/MANIFEST.txt" <<EOF
ClickHouse web console $VERSION
Revision:      $REVISION
Built:         $(date -u +%Y-%m-%dT%H:%M:%SZ)
Platform:      linux/amd64
Base image:    $BASE_DIGEST
Server binary: $BINARY_VERSION ($BUILD_TYPE)

$SERVER_IMAGE  image $(docker image inspect "$SERVER_IMAGE" --format '{{.Id}}')
$TOOLS_IMAGE  image $(docker image inspect "$TOOLS_IMAGE" --format '{{.Id}}')

Load:     docker load -i $SERVER_FILE && docker load -i $TOOLS_FILE
Verify:   sha256sum -c SHA256SUMS
Deploy:   see deploy/README.md
EOF
(cd "$OUT" && sha256sum "$SERVER_FILE" "$TOOLS_FILE" MANIFEST.txt > SHA256SUMS)

echo
cat "$OUT/MANIFEST.txt"
ls -la "$OUT"
