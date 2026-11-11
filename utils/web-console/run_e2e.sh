#!/usr/bin/env bash
# Runs the browser suites of the web console against a server of their own (see "Browser checks" in README.md):
#
#   utils/web-console/run_e2e.sh [options]
#
#     --suites <list>       comma-separated, from: console, access, data_access, backup, cluster (default: all of them)
#     --binary <path>       clickhouse binary (default: build/programs/clickhouse)
#     --page-from-source    serve programs/server/console.html as it is in the working tree, instead of the page built
#                           into the binary: try a change of the page without rebuilding
#     --e2e-dir <dir>       Playwright workspace with node_modules/playwright (default: ~/console-e2e)
#     --keep                leave the server, MinIO, and the agent running at the end, for inspection
#
# Every run starts from nothing: a new server (HTTP 38123, native 39000, Keeper 39181) with an empty data directory,
# its own MinIO container (39900) for the backup suite, and its own cluster agent (lab ports 32000-32999, with the
# server itself as the credential reference `PLATFORM` that the registration check uses) for the
# cluster suite. No suite depends on what a person or another run left on a server, and none touches the development
# server. Everything lives in tmp/console-e2e-run/: the logs stay there after the run; the rest is removed.
#
# The backup suite stops and starts the MinIO container and restarts the server; the cluster suite creates Docker lab
# clusters `e2e-*` and deletes them. If Chromium needs libraries that are not installed, set LD_LIBRARY_PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/utils/web-console"
BINARY="$ROOT/build/programs/clickhouse"
E2E_DIR="$HOME/console-e2e"
SUITES="console,access,data_access,backup,cluster"
PAGE_FROM_SOURCE=0
KEEP=0

while [ $# -gt 0 ]; do
    case "$1" in
        --suites) SUITES="$2"; shift 2 ;;
        --binary) BINARY="$(realpath "$2")"; shift 2 ;;
        --page-from-source) PAGE_FROM_SOURCE=1; shift ;;
        --e2e-dir) E2E_DIR="$(realpath "$2")"; shift 2 ;;
        --keep) KEEP=1; shift ;;
        -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1 (see --help)" >&2; exit 2 ;;
    esac
done

die() { echo "error: $*" >&2; exit 1; }
has_suite() { [[ ",$SUITES," == *",$1,"* ]]; }

HTTP_PORT=38123
TCP_PORT=39000
DEAD_PORT=39099   # nothing listens there: the second shard of `console_test`, for changes that partly fail
KEEPER_PORT=39181
RAFT_PORT=39234
MINIO_PORT=39900
AGENT_PORTS=32000-32999
ADMIN_PASSWORD=e2e-admin-pass
LIMITED_PASSWORD=e2e-limited-pass
MINIO_CONTAINER=console-e2e-minio
MINIO_IMAGE=minio/minio:RELEASE.2025-07-23T15-54-02Z
MINIO_USER=e2eminio
MINIO_SECRET=e2eminio-secret-1
BUCKET=ch-backups
BASE="http://127.0.0.1:$HTTP_PORT"

# --- Checks

for suite in ${SUITES//,/ }; do
    case "$suite" in console|access|data_access|backup|cluster) ;; *) die "unknown suite: $suite" ;; esac
done
[ -x "$BINARY" ] || die "no clickhouse binary at $BINARY"
command -v node > /dev/null || die "node is not installed"
[ -d "$E2E_DIR/node_modules/playwright" ] || die "no Playwright in $E2E_DIR (see \"Browser checks\" in $HERE/README.md)"
if has_suite backup || has_suite cluster; then
    docker info > /dev/null 2>&1 || die "Docker is not running, or this user cannot use it"
fi
if has_suite backup; then
    docker image inspect "$MINIO_IMAGE" > /dev/null 2>&1 || die "the image $MINIO_IMAGE is not on this host"
fi
for port in $HTTP_PORT $TCP_PORT $KEEPER_PORT $RAFT_PORT $MINIO_PORT; do
    ! ss -ltn | grep -q ":$port " || die "port $port is in use: is another run still going? (stop it, or remove what --keep left)"
done

RUN="$ROOT/tmp/console-e2e-run"
SERVER="$RUN/server"
LOGS="$RUN/logs"
rm -rf "$RUN"
mkdir -p "$SERVER/config.d" "$SERVER/users.d" "$SERVER/data/user_files" "$SERVER/backups" "$LOGS" "$RUN/agent"

# --- Server configuration: the stock files, and what the suites need.

cp "$ROOT/programs/server/config.xml" "$ROOT/programs/server/users.xml" "$SERVER/"
cat > "$SERVER/config.d/e2e.xml" <<EOF
<clickhouse>
    <http_port replace="1">$HTTP_PORT</http_port>
    <tcp_port replace="1">$TCP_PORT</tcp_port>
    <interserver_http_port remove="1"/>
    <mysql_port remove="1"/>
    <postgresql_port remove="1"/>
    <listen_host replace="1">127.0.0.1</listen_host>
    <path replace="1">$SERVER/data/</path>
    <tmp_path replace="1">$SERVER/data/tmp/</tmp_path>
    <user_files_path replace="1">$SERVER/data/user_files/</user_files_path>
    <format_schema_path replace="1">$SERVER/data/format_schemas/</format_schema_path>
    <logger replace="1">
        <level>information</level>
        <log>$LOGS/clickhouse-server.log</log>
        <errorlog>$LOGS/clickhouse-server.err.log</errorlog>
    </logger>
    <user_directories replace="1">
        <users_xml><path>users.xml</path></users_xml>
        <local_directory><path>$SERVER/data/access/</path></local_directory>
    </user_directories>
    <keeper_server>
        <tcp_port>$KEEPER_PORT</tcp_port>
        <server_id>1</server_id>
        <log_storage_path>$SERVER/data/coordination/log</log_storage_path>
        <snapshot_storage_path>$SERVER/data/coordination/snapshots</snapshot_storage_path>
        <raft_configuration>
            <server><id>1</id><hostname>127.0.0.1</hostname><port>$RAFT_PORT</port></server>
        </raft_configuration>
    </keeper_server>
    <zookeeper>
        <node><host>127.0.0.1</host><port>$KEEPER_PORT</port></node>
    </zookeeper>
    <distributed_ddl>
        <path>/clickhouse/task_queue/ddl</path>
    </distributed_ddl>
    <remote_servers>
        <console_test>
            <shard><replica><host>127.0.0.1</host><port>$TCP_PORT</port></replica></shard>
            <shard><replica><host>127.0.0.1</host><port>$DEAD_PORT</port></replica></shard>
        </console_test>
        <dap_nosecret>
            <shard><replica><host>127.0.0.1</host><port>$TCP_PORT</port><user>default</user><password>$ADMIN_PASSWORD</password></replica></shard>
        </dap_nosecret>
        <dap_secret>
            <secret>e2e-interserver-secret</secret>
            <shard><replica><host>127.0.0.1</host><port>$TCP_PORT</port></replica></shard>
        </dap_secret>
    </remote_servers>
    <storage_configuration>
        <disks>
            <backups>
                <type>local</type>
                <path>$SERVER/backups/</path>
            </backups>
        </disks>
    </storage_configuration>
    <backups>
        <allowed_disk>backups</allowed_disk>
    </backups>
    <remote_url_allow_hosts>
        <host>127.0.0.1</host>
        <host>localhost</host>
    </remote_url_allow_hosts>
    <!-- The MinIO container, and the two patterns that backup_e2e.mjs checks. -->
    <web_console>
        <backup_s3_endpoints>http://127.0.0.1:$MINIO_PORT, https://*.example.com, http://*:29999</backup_s3_endpoints>
    </web_console>
</clickhouse>
EOF
cat > "$SERVER/users.d/e2e.xml" <<EOF
<clickhouse>
    <users>
        <default>
            <password replace="1">$ADMIN_PASSWORD</password>
            <access_management>1</access_management>
            <named_collection_control>1</named_collection_control>
        </default>
    </users>
</clickhouse>
EOF
if [ "$PAGE_FROM_SOURCE" = 1 ]; then
    cp "$ROOT/programs/server/console.html" "$SERVER/data/user_files/console.html"
    # The same headers as the built-in handler (`ConsoleWebUIRequestHandler`), so the page runs under the same policy.
    cat > "$SERVER/config.d/page-from-source.xml" <<'EOF'
<clickhouse>
    <http_handlers>
        <rule>
            <url>/console/config.json</url>
            <methods>GET,HEAD</methods>
            <handler><type>console</type></handler>
        </rule>
        <rule>
            <url>regex:^/console(/.*)?$</url>
            <methods>GET,HEAD</methods>
            <handler>
                <type>static</type>
                <status>200</status>
                <content_type>text/html; charset=UTF-8</content_type>
                <response_content>file://console.html</response_content>
                <http_response_headers>
                    <Cache-Control>no-store</Cache-Control>
                    <X-Frame-Options>DENY</X-Frame-Options>
                    <Content-Security-Policy>default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self' http: https:; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'</Content-Security-Policy>
                </http_response_headers>
            </handler>
        </rule>
        <defaults/>
    </http_handlers>
</clickhouse>
EOF
fi

start_server() {
    (cd "$SERVER" && "$BINARY" server --config-file="$SERVER/config.xml" --daemon --pid-file="$SERVER/server.pid")
    for _ in $(seq 120); do
        curl -sf "$BASE/ping" > /dev/null 2>&1 && return 0
        sleep 1
    done
    die "the server did not start; see $LOGS/clickhouse-server.err.log"
}

# The backup suite simulates a failure: kill -9 the server and its watchdog, then start it again.
cat > "$RUN/restart-server.sh" <<EOF
#!/usr/bin/env bash
pid=\$(cat "$SERVER/server.pid")
watchdog=\$(ps -o ppid= -p "\$pid" | tr -d ' ')
kill -9 "\$watchdog" "\$pid" 2>/dev/null || true
while kill -0 "\$pid" 2>/dev/null; do sleep 1; done
while ss -ltn | grep -q ':$HTTP_PORT '; do sleep 1; done
rm -f "$SERVER/server.pid"
cd "$SERVER" && "$BINARY" server --config-file="$SERVER/config.xml" --daemon --pid-file="$SERVER/server.pid"
EOF
chmod +x "$RUN/restart-server.sh"

AGENT_PID=""
cleanup() {
    [ "$KEEP" = 1 ] && return
    [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2> /dev/null || true
    docker rm -f "$MINIO_CONTAINER" > /dev/null 2>&1 || true
    if [ -f "$SERVER/server.pid" ]; then
        pid=$(cat "$SERVER/server.pid")
        kill "$pid" 2> /dev/null || true
        while kill -0 "$pid" 2> /dev/null; do sleep 1; done
    fi
    rm -rf "$SERVER" "$RUN/agent" "$RUN/suites"
}
trap cleanup EXIT

echo "Starting the server ($("$BINARY" local --version), page: $([ "$PAGE_FROM_SOURCE" = 1 ] && echo "from source" || echo built-in))"
start_server
"$BINARY" client --port "$TCP_PORT" --password "$ADMIN_PASSWORD" --multiquery -q "
    CREATE USER limited IDENTIFIED BY '$LIMITED_PASSWORD';
    -- No SELECT ON system.part_log and no INTROSPECTION, which console_e2e.mjs checks the console reports.
    GRANT SELECT ON system.tables, SELECT ON system.columns, SELECT ON system.dashboards, SELECT ON system.documentation TO limited;"

if has_suite backup; then
    docker rm -f "$MINIO_CONTAINER" > /dev/null 2>&1 || true
    docker run -d --name "$MINIO_CONTAINER" -p "127.0.0.1:$MINIO_PORT:9000" \
        -e MINIO_ROOT_USER="$MINIO_USER" -e MINIO_ROOT_PASSWORD="$MINIO_SECRET" "$MINIO_IMAGE" server /data > /dev/null
    for _ in $(seq 60); do
        curl -sf "http://127.0.0.1:$MINIO_PORT/minio/health/live" > /dev/null 2>&1 && break
        sleep 1
    done
    curl -sf -X PUT --user "$MINIO_USER:$MINIO_SECRET" --aws-sigv4 "aws:amz:us-east-1:s3" "http://127.0.0.1:$MINIO_PORT/$BUCKET" > /dev/null \
        || die "cannot create the bucket $BUCKET in MinIO"
fi

if has_suite cluster; then
    (cd "$ROOT" && CLICKHOUSE_URL="$BASE" CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD="$ADMIN_PASSWORD" \
        CLUSTER_AGENT_STATE_DIR="$RUN/agent" AGENT_ID=e2e-agent INTERVAL_SECONDS=5 OBSERVE_SECONDS=20 \
        CLUSTER_AGENT_PORT_RANGE="$AGENT_PORTS" PLATFORM_USER=default PLATFORM_PASSWORD="$ADMIN_PASSWORD" \
        exec node "$HERE/cluster_agent.mjs" > "$LOGS/cluster-agent.log" 2>&1) &
    AGENT_PID=$!
fi

# --- Suites. They import Playwright, so they run from the workspace that has it.

SUITE_DIR="$E2E_DIR/run-$$"
mkdir -p "$SUITE_DIR"
cp "$HERE"/*.mjs "$SUITE_DIR/"
ln -sfn "$E2E_DIR/node_modules" "$SUITE_DIR/node_modules"
trap 'rm -rf "$SUITE_DIR"; cleanup' EXIT

run_suite() {
    local name="$1"; shift
    has_suite "$name" || return 0
    echo "Running $name"
    local status=0
    (cd "$SUITE_DIR" && node "$@" --screenshots "$LOGS/screenshots-$name") > "$LOGS/$name.log" 2>&1 || status=$?
    echo "  $(tail -n 1 "$LOGS/$name.log") (exit $status, log $LOGS/$name.log)"
    [ "$status" = 0 ] || FAILED="$FAILED $name"
}

FAILED=""
run_suite console console_e2e.mjs --url "$BASE" --admin "default:$ADMIN_PASSWORD" --limited "limited:$LIMITED_PASSWORD"
run_suite access access_e2e.mjs --url "$BASE" --admin "default:$ADMIN_PASSWORD" --cluster console_test
run_suite data_access data_access_e2e.mjs --url "$BASE" --admin "default:$ADMIN_PASSWORD" --native-port "$TCP_PORT" \
    --clickhouse "$BINARY" --worker "$HERE/access_policy_worker.mjs" --console-html "$ROOT/programs/server/console.html" \
    --cluster dap_secret --partial-cluster console_test
run_suite backup backup_e2e.mjs --url "$BASE" --admin "default:$ADMIN_PASSWORD" --native-port "$TCP_PORT" \
    --s3 "http://127.0.0.1:$MINIO_PORT/$BUCKET:$MINIO_USER:$MINIO_SECRET" --minio-container "$MINIO_CONTAINER" \
    --worker "$HERE/backup_worker.mjs" --server-restart "$RUN/restart-server.sh" --server-log "$LOGS/clickhouse-server.log"
run_suite cluster cluster_e2e.mjs --url "$BASE" --admin "default:$ADMIN_PASSWORD"

if [ "$KEEP" = 1 ]; then
    echo "Kept: the server at $BASE (default:$ADMIN_PASSWORD), MinIO $MINIO_CONTAINER, agent pid ${AGENT_PID:-none}. Stop them before the next run."
fi
if [ -n "$FAILED" ]; then
    echo "Failed:$FAILED"
    exit 1
fi
echo "All suites passed"
