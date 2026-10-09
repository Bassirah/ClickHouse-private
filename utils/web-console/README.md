# Web console: build, run, test, package

The web console is served by the server at `/console`. User documentation, configuration, security
model, and limitations: `docs/concepts/features/interfaces/web-console.mdx`.

## What is where

| File | Role |
|---|---|
| `programs/server/console.html` | The console: login, home page, sidebar, panel lifecycle, navigation registry (`COMPONENTS`). |
| `src/Server/WebUIRequestHandler.{h,cpp}` | `ConsoleWebUIRequestHandler`: serves the page for `/console/*` and `/console/config.json`. |
| `src/Server/HTTPHandlerFactory.cpp` | Registers `/console` and the `console` handler type of `http_handlers`. |
| `src/Core/ServerSettings.cpp` | Accepts the `web_console` configuration section. |
| `programs/server/{dashboard,binary,merges,schema,jemalloc,processors_profile,docs}.html` | `getConsoleConnection`: take the connection from the console when embedded by it. |
| `programs/server/index.html` | Link to the console on the landing page. |
| `tests/queries/0_stateless/05293_web_console.sh` | Routes, headers, configuration defaults, integration contract. |
| `tests/integration/test_web_console` | `web_console` configuration, configuration reload, `console` handler type. |
| `utils/web-console/console_e2e.mjs` | Browser end-to-end checks (Playwright; not part of the build). |
| `utils/web-console/Dockerfile` | Image with a locally built binary on top of the official image. |

All HTML pages are embedded into the binary with `#embed`: **any change to an `.html` file needs a
rebuild of the `clickhouse` binary**, like a change to the C++ files. A change to the `web_console`
configuration does not: `SYSTEM RELOAD CONFIG` (or the automatic reload) applies it.

## Build (WSL, Ubuntu 24.04)

```bash
cd ~/src/ClickHouse-private
git switch private/unified-web-console
# The existing build directory is configured as Debug with clang-22. Incremental build:
cd build && ninja clickhouse > build_console.log 2>&1; tail -n 3 build_console.log
```

For a binary to deploy, use a separate release build directory:

```bash
cd ~/src/ClickHouse-private
cmake -S . -B build_release -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo \
    -DCMAKE_C_COMPILER=clang-22 -DCMAKE_CXX_COMPILER=clang++-22
cd build_release && ninja clickhouse > build.log 2>&1; tail -n 3 build.log
```

## Run a separate development instance

This uses its own ports (28123 for HTTP, 29000 for native) and its own data directory under `tmp/`,
which is ignored by Git, so it does not touch another server on the machine.

```bash
cd ~/src/ClickHouse-private
D=$PWD/tmp/console-dev
mkdir -p $D/data $D/log $D/config.d $D/users.d
cp programs/server/config.xml programs/server/users.xml $D/
cat > $D/config.d/dev.xml <<EOF
<clickhouse>
    <http_port replace="1">28123</http_port>
    <tcp_port replace="1">29000</tcp_port>
    <interserver_http_port remove="1"/>
    <mysql_port remove="1"/>
    <postgresql_port remove="1"/>
    <listen_host replace="1">127.0.0.1</listen_host>
    <path replace="1">$D/data/</path>
    <tmp_path replace="1">$D/data/tmp/</tmp_path>
    <user_files_path replace="1">$D/data/user_files/</user_files_path>
    <format_schema_path replace="1">$D/data/format_schemas/</format_schema_path>
    <logger replace="1">
        <level>information</level>
        <log>$D/log/clickhouse-server.log</log>
        <errorlog>$D/log/clickhouse-server.err.log</errorlog>
    </logger>
    <user_directories replace="1">
        <users_xml><path>users.xml</path></users_xml>
        <local_directory><path>$D/data/access/</path></local_directory>
    </user_directories>
</clickhouse>
EOF
cat > $D/users.d/dev-users.xml <<'EOF'
<clickhouse>
    <users>
        <default>
            <password replace="1">devpass</password>
            <access_management>1</access_management>
        </default>
    </users>
</clickhouse>
EOF
cd $D && ~/src/ClickHouse-private/build/programs/clickhouse server --config-file=$D/config.xml
```

Open `http://localhost:28123/console` in the Windows browser (WSL2 forwards `localhost`). Sign in as
`default` with the password `devpass`.

Users for the permission checks (with the server running):

```bash
C="curl -s -u default:devpass http://127.0.0.1:28123/ --data-binary"
$C "CREATE USER alice IDENTIFIED BY 'alicepass'"
$C "GRANT CURRENT GRANTS ON *.* TO alice WITH GRANT OPTION"
$C "CREATE USER limited IDENTIFIED BY 'limitedpass'"
for t in tables columns dashboards documentation; do $C "GRANT SELECT ON system.$t TO limited"; done
```

## Tests

```bash
# Functional test, against a running server (it uses only curl):
cd tests/queries/0_stateless
CLICKHOUSE_HOST=127.0.0.1 CLICKHOUSE_PORT_HTTP=28123 bash 05293_web_console.sh | diff - 05293_web_console.reference

# Integration test (Docker):
cd ~/src/ClickHouse-private && python3 -m ci.praktika run "integration" --test test_web_console
```

Browser checks. Playwright is a development tool only: install it outside of the repository.

```bash
mkdir -p ~/console-e2e && cd ~/console-e2e
npm init -y && npm install playwright@1.48.2 && npx playwright install chromium
# If Chromium reports missing libraries: sudo npx playwright install-deps chromium
cp ~/src/ClickHouse-private/utils/web-console/console_e2e.mjs .
node console_e2e.mjs --url http://127.0.0.1:28123 --admin alice:alicepass --limited limited:limitedpass --screenshots shots
```

## Docker image

The image keeps everything of the official image of the same release and replaces the binary. Use a
release build; a Debug binary works but is large and slow (strip it with `llvm-strip --strip-debug`).

```bash
mkdir -p ~/src/ClickHouse-private/tmp/console-docker
cp ~/src/ClickHouse-private/build_release/programs/clickhouse ~/src/ClickHouse-private/tmp/console-docker/
docker build -f ~/src/ClickHouse-private/utils/web-console/Dockerfile \
    --build-arg BASE_IMAGE=clickhouse/clickhouse-server:26.9.8.3 \
    -t clickhouse-server-console:26.9.8.3 ~/src/ClickHouse-private/tmp/console-docker
docker run -d --name clickhouse-console -p 127.0.0.1:38123:8123 \
    -e CLICKHOUSE_PASSWORD=change-me -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
    --ulimit nofile=262144:262144 clickhouse-server-console:26.9.8.3
```

For a restricted network, build the image where the base image is available, then move it with
`docker save` and `docker load`. The console needs no Internet access; the Binary visualizer and
Jemalloc pages load libraries from public CDNs and do not work offline.

## Rollback

- Server: deploy the previous binary or image (`clickhouse/clickhouse-server:26.9.8.3`). The change
  stores nothing on the server; the only configuration it adds is the optional `web_console` section.
  Remove that section before downgrading, because older servers reject unknown sections.
- Source: the change is on the branch `private/unified-web-console`; `private/main` is unchanged.
