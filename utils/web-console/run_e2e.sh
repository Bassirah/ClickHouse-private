#!/usr/bin/env bash
# Runs the browser suites of the web console against a server of their own (see "Browser checks" in README.md):
#
#   utils/web-console/run_e2e.sh [options]
#
#     --suites <list>       comma-separated, from: console, access, data_access, backup, cluster, ldap (default: all of them)
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
SUITES="console,access,data_access,backup,cluster,ldap"
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
VAULT_CONTAINER=console-e2e-vault
VAULT_IMAGE=hashicorp/vault:1.17.6
VAULT_PORT=39200
LDAP_CONTAINER=console-e2e-ldap
LDAP_IMAGE=bitnamilegacy/openldap:2.6.8
LDAP_PORT=39636
LDAP_ADMIN_PASSWORD=e2e-ldap-admin
MINIO_USER=e2eminio
MINIO_SECRET=e2eminio-secret-1
BUCKET=ch-backups
BASE="http://127.0.0.1:$HTTP_PORT"

# --- Checks

for suite in ${SUITES//,/ }; do
    case "$suite" in console|access|data_access|backup|cluster|ldap) ;; *) die "unknown suite: $suite" ;; esac
done
[ -x "$BINARY" ] || die "no clickhouse binary at $BINARY"
command -v node > /dev/null || die "node is not installed"
[ -d "$E2E_DIR/node_modules/playwright" ] || die "no Playwright in $E2E_DIR (see \"Browser checks\" in $HERE/README.md)"
if has_suite backup || has_suite cluster || has_suite ldap; then
    docker info > /dev/null 2>&1 || die "Docker is not running, or this user cannot use it"
fi
if has_suite ldap; then
    docker image inspect "$LDAP_IMAGE" > /dev/null 2>&1 || die "the image $LDAP_IMAGE is not on this host (docker pull $LDAP_IMAGE)"
fi
if has_suite backup; then
    docker image inspect "$MINIO_IMAGE" > /dev/null 2>&1 || die "the image $MINIO_IMAGE is not on this host"
fi
for port in $HTTP_PORT $TCP_PORT $KEEPER_PORT $RAFT_PORT $MINIO_PORT $VAULT_PORT $LDAP_PORT; do
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
    docker rm -f "$MINIO_CONTAINER" "$VAULT_CONTAINER" "$LDAP_CONTAINER" > /dev/null 2>&1 || true
    if [ -f "$SERVER/server.pid" ]; then
        pid=$(cat "$SERVER/server.pid")
        kill "$pid" 2> /dev/null || true
        while kill -0 "$pid" 2> /dev/null; do sleep 1; done
    fi
    rm -rf "$SERVER" "$RUN/agent" "$RUN/suites" "$RUN/keys" "$RUN/staging" "$RUN/ldap"
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
        -e MINIO_ROOT_USER="$MINIO_USER" -e MINIO_ROOT_PASSWORD="$MINIO_SECRET" \
        -e MINIO_KMS_SECRET_KEY="e2e-key:$(head -c 32 /dev/urandom | base64)" "$MINIO_IMAGE" server /data > /dev/null
    for _ in $(seq 60); do
        curl -sf "http://127.0.0.1:$MINIO_PORT/minio/health/live" > /dev/null 2>&1 && break
        sleep 1
    done
    curl -sf -X PUT --user "$MINIO_USER:$MINIO_SECRET" --aws-sigv4 "aws:amz:us-east-1:s3" "http://127.0.0.1:$MINIO_PORT/$BUCKET" > /dev/null \
        || die "cannot create the bucket $BUCKET in MinIO"
fi

if has_suite ldap; then
    # An OpenLDAP directory with LDAPS, signed by a certificate authority of this run, as a production directory would be:
    # the server checks its certificate (tls_require_cert demand). Users dana (in console-analysts) and eli (in no group); the
    # group also lists the directory administrator, because groupOfNames requires a member when dana is removed.
    mkdir -p "$RUN/ldap/tls" "$RUN/ldap/ldif"
    (cd "$RUN/ldap/tls"
        openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj "/CN=e2e LDAP CA" 2> /dev/null
        openssl req -newkey rsa:2048 -nodes -keyout ldap.key -out ldap.csr -subj "/CN=localhost" 2> /dev/null
        printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\n' > san.ext
        openssl x509 -req -in ldap.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out ldap.crt -days 2 -extfile san.ext 2> /dev/null)
    cat > "$RUN/ldap/ldif/tree.ldif" <<'END_OF_LDIF'
dn: dc=example,dc=org
objectClass: dcObject
objectClass: organization
dc: example
o: example

dn: ou=users,dc=example,dc=org
objectClass: organizationalUnit
ou: users

dn: ou=groups,dc=example,dc=org
objectClass: organizationalUnit
ou: groups

dn: uid=dana,ou=users,dc=example,dc=org
objectClass: inetOrgPerson
uid: dana
cn: Dana
sn: Analyst
userPassword: Dana-Ldap-Pw-1

dn: uid=eli,ou=users,dc=example,dc=org
objectClass: inetOrgPerson
uid: eli
cn: Eli
sn: Engineer
userPassword: Eli-Ldap-Pw-1

dn: cn=console-analysts,ou=groups,dc=example,dc=org
objectClass: groupOfNames
cn: console-analysts
member: uid=dana,ou=users,dc=example,dc=org
member: cn=admin,dc=example,dc=org
END_OF_LDIF
    # The image runs as the user 1001: it must read the tree and the certificates (throwaway test material only).
    chmod -R a+rX "$RUN/ldap"
    docker rm -f "$LDAP_CONTAINER" > /dev/null 2>&1 || true
    docker run -d --name "$LDAP_CONTAINER" -p "127.0.0.1:$LDAP_PORT:1636" -e LDAP_ROOT=dc=example,dc=org -e LDAP_ADMIN_USERNAME=admin \
        -e LDAP_ADMIN_PASSWORD="$LDAP_ADMIN_PASSWORD" -e LDAP_CUSTOM_LDIF_DIR=/ldifs -e LDAP_ENABLE_TLS=yes -e LDAP_TLS_CERT_FILE=/tls/ldap.crt \
        -e LDAP_TLS_KEY_FILE=/tls/ldap.key -e LDAP_TLS_CA_FILE=/tls/ca.crt -v "$RUN/ldap/ldif:/ldifs:ro" -v "$RUN/ldap/tls:/tls:ro" "$LDAP_IMAGE" > /dev/null
    for _ in $(seq 60); do
        docker exec "$LDAP_CONTAINER" ldapsearch -x -H ldap://localhost:1389 -D cn=admin,dc=example,dc=org -w "$LDAP_ADMIN_PASSWORD" \
            -b ou=groups,dc=example,dc=org cn 2> /dev/null | grep -q console-analysts && break
        sleep 2
    done
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
if has_suite backup && docker image inspect "$VAULT_IMAGE" > /dev/null 2>&1; then
    # A Vault in development mode, with a Transit key and a token that may only encrypt and decrypt with it, as
    # deploy/README.md recommends; without the image, the checks use a stand-in of its API.
    docker rm -f "$VAULT_CONTAINER" > /dev/null 2>&1 || true
    docker run -d --name "$VAULT_CONTAINER" --cap-add IPC_LOCK -p "127.0.0.1:$VAULT_PORT:8200" -e VAULT_DEV_ROOT_TOKEN_ID=e2e-root-token \
        -e VAULT_DEV_LISTEN_ADDRESS=0.0.0.0:8200 "$VAULT_IMAGE" > /dev/null
    for _ in $(seq 30); do curl -sf "http://127.0.0.1:$VAULT_PORT/v1/sys/health" > /dev/null 2>&1 && break; sleep 1; done
    vault() { docker exec -i -e VAULT_ADDR=http://127.0.0.1:8200 -e VAULT_TOKEN=e2e-root-token "$VAULT_CONTAINER" vault "$@"; }
    vault secrets enable transit > /dev/null
    vault write -f transit/keys/clickhouse-bundles > /dev/null
    printf 'path "transit/encrypt/clickhouse-bundles" { capabilities = ["update"] }\npath "transit/decrypt/clickhouse-bundles" { capabilities = ["update"] }\n' \
        | vault policy write clickhouse-bundles - > /dev/null
    printf 'path "transit/encrypt/clickhouse-bundles" { capabilities = ["update"] }\n' | vault policy write encrypt-only - > /dev/null
    export VAULT_TEST_ADDR="http://127.0.0.1:$VAULT_PORT" VAULT_TEST_ROOT_TOKEN=e2e-root-token
    VAULT_TEST_TOKEN=$(vault token create -policy=clickhouse-bundles -field=token)
    VAULT_TEST_TOKEN_ENCRYPT_ONLY=$(vault token create -policy=encrypt-only -field=token)
    export VAULT_TEST_TOKEN VAULT_TEST_TOKEN_ENCRYPT_ONLY E2E_VAULT_ADDR="$VAULT_TEST_ADDR" E2E_VAULT_TOKEN="$VAULT_TEST_TOKEN"
    echo "Vault: $VAULT_IMAGE on port $VAULT_PORT"
fi
if has_suite backup; then
    # The module of server bundles alone, then the worker of the suite with a key file, the configuration of this server,
    # and its embedded Keeper.
    echo "Running bundle module"
    if node "$HERE/server_bundle_test.mjs" > "$LOGS/bundle_module.log" 2>&1; then echo "  $(tail -n 1 "$LOGS/bundle_module.log")"
    else echo "  $(tail -n 1 "$LOGS/bundle_module.log") (log $LOGS/bundle_module.log)"; FAILED="$FAILED bundle_module"; fi
    node "$HERE/backup_worker.mjs" bundle-key-init --key-file "$RUN/keys/bundle.key" > /dev/null
    export BUNDLE_KEY_PROVIDER=file BUNDLE_KEY_FILE="$RUN/keys/bundle.key" BUNDLE_PATHS="$SERVER/config.d,$SERVER/users.d" \
        BUNDLE_KEEPER="127.0.0.1:$KEEPER_PORT" BUNDLE_KEEPER_SNAPSHOTS="$SERVER/data/coordination/snapshots" BUNDLE_STAGING_DIR="$RUN/staging" BUNDLE_COMPARE_ROOT=/ \
        REHEARSAL_BINARY="$BINARY"
fi
run_suite backup backup_e2e.mjs --url "$BASE" --admin "default:$ADMIN_PASSWORD" --native-port "$TCP_PORT" \
    --s3 "http://127.0.0.1:$MINIO_PORT/$BUCKET:$MINIO_USER:$MINIO_SECRET" --minio-container "$MINIO_CONTAINER" \
    --worker "$HERE/backup_worker.mjs" --server-restart "$RUN/restart-server.sh" --server-log "$LOGS/clickhouse-server.log"
run_suite cluster cluster_e2e.mjs --url "$BASE" --admin "default:$ADMIN_PASSWORD"
# Last: it installs an LDAP directory and restarts the server, and removes the directory again at the end.
run_suite ldap ldap_e2e.mjs --url "$BASE" --admin "default:$ADMIN_PASSWORD" --config-dir "$SERVER/config.d" --server-restart "$RUN/restart-server.sh" \
    --ldap-port "$LDAP_PORT" --ldap-ca "$RUN/ldap/tls/ca.crt" --ldap-container "$LDAP_CONTAINER" --ldap-admin-password "$LDAP_ADMIN_PASSWORD"

if [ "$KEEP" = 1 ]; then
    echo "Kept: the server at $BASE (default:$ADMIN_PASSWORD), MinIO $MINIO_CONTAINER, agent pid ${AGENT_PID:-none}. Stop them before the next run."
fi
if [ -n "$FAILED" ]; then
    echo "Failed:$FAILED"
    exit 1
fi
echo "All suites passed"
