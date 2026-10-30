# Web console: build, run, test, package

The web console is served by the server at `/console`. User documentation, configuration, security
model, and limitations: `docs/concepts/features/interfaces/web-console.mdx`.

## What is where

| File | Role |
|---|---|
| `programs/server/console.html` | The console: login, home page, sidebar, panel lifecycle, navigation registry (`COMPONENTS`), and the Administration pages (users, roles, component access, profiles and quotas, audit, backup and restore, clusters). |
| `src/Server/WebUIRequestHandler.{h,cpp}` | `ConsoleWebUIRequestHandler`: serves the page for `/console/*` and `/console/config.json`. |
| `src/Server/HTTPHandlerFactory.cpp` | Registers `/console` and the `console` handler type of `http_handlers`. |
| `src/Core/ServerSettings.cpp` | Accepts the `web_console` configuration section. |
| `programs/server/{dashboard,binary,merges,schema,jemalloc,processors_profile,docs}.html` | `getConsoleConnection`: take the connection from the console when embedded by it. |
| `programs/server/index.html` | Link to the console on the landing page. |
| `tests/queries/0_stateless/05293_web_console.sh` | Routes, headers, configuration defaults, integration contract. |
| `tests/queries/0_stateless/05294_web_console_access_management.sh` | Server behavior the Administration pages rely on: suspension, scoped `CHECK GRANT`, delegation, the audit table, password masking. |
| `tests/queries/0_stateless/05295_web_console_backup.sh` | Server behavior Backup & Restore relies on: operation IDs, refusal of duplicate IDs and locations, missing bases, restores that never write into existing tables, the `Backup` engine, privileges. |
| `tests/integration/test_web_console` | `web_console` configuration, configuration reload, `console` handler type. |
| `utils/web-console/console_e2e.mjs` | Browser end-to-end checks (Playwright; not part of the build). |
| `utils/web-console/access_e2e.mjs` | Browser acceptance checks of the Administration pages (Playwright; not part of the build). |
| `utils/web-console/backup_worker.mjs` | Backup worker: schedules, reconciliation, retention, deletions (Node.js 18, no packages). |
| `utils/web-console/backup_e2e.mjs` | Browser acceptance checks of Backup & Restore, including a server restart and an unavailable destination (Playwright; not part of the build). |
| `utils/web-console/cluster_agent.mjs` | Cluster agent: executes cluster lifecycle operations through the docker-compose provider, and observes clusters (Node.js 18, no packages). |
| `utils/web-console/cluster_e2e.mjs` | Browser acceptance checks of Cluster Management against a running agent: provisioning, registration, drift, scaling, failures, and retirement (Playwright; not part of the build). |
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

The Administration pages have their own checks. They need a user with access management and every privilege
`WITH GRANT OPTION`, create and remove `e2e_*` users, roles, profiles, quotas, and databases, and set up the
console tables in `console_admin` if they do not exist. `--cluster` names a cluster where one server is down,
to check the report of a partly applied `ON CLUSTER` change (the development instance can get one with an
embedded Keeper and a replica on a port where nothing listens):

```bash
cp ~/src/ClickHouse-private/utils/web-console/access_e2e.mjs ~/console-e2e/
node access_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass [--cluster console_test] --screenshots shots
```

Backup & Restore has its own checks. They need a `backups` disk allowed in `backups.allowed_disk`, an S3
endpoint (a MinIO container) listed in `web_console.backup_s3_endpoints`, and a command that kills and starts
the server. They create the database `e2e_bk_src`, the user `e2e_bk_reader`, destinations named `e2e disk` and
`e2e s3` with new prefixes, and stop and start the MinIO container. For the development instance:

```bash
D=~/src/ClickHouse-private/tmp/console-dev
cat > $D/config.d/dev-backups.xml <<EOF
<clickhouse>
    <storage_configuration><disks><backups><type>local</type><path>$D/backups/</path></backups></disks></storage_configuration>
    <backups><allowed_disk>backups</allowed_disk></backups>
    <web_console><backup_s3_endpoints>http://127.0.0.1:29900</backup_s3_endpoints></web_console>
</clickhouse>
EOF
mkdir -p $D/e2e && cat > $D/e2e/restart.sh <<'EOF'
#!/bin/bash
# Simulates a server failure: kill -9 the server and its watchdog (a stop that waits would let the running
# backup finish), then start again.
cd ~/src/ClickHouse-private/tmp/console-dev
pid=$(cat clickhouse-server.pid)
watchdog=$(ps -o ppid= -p "$pid" | tr -d ' ')
kill -9 "$watchdog" "$pid"
while kill -0 "$pid" 2>/dev/null; do sleep 1; done
while ss -ltn | grep -q ':28123 '; do sleep 1; done
rm -f clickhouse-server.pid
~/src/ClickHouse-private/build/programs/clickhouse server --config-file=$PWD/config.xml --daemon --pid-file=$PWD/clickhouse-server.pid
EOF
chmod +x $D/e2e/restart.sh
docker run -d --name console-minio -p 29900:9000 -e MINIO_ROOT_USER=consoleminio -e MINIO_ROOT_PASSWORD=consoleminio-secret-1 \
    minio/minio server /data
docker exec console-minio mkdir -p /data/ch-backups
cp ~/src/ClickHouse-private/utils/web-console/backup_e2e.mjs ~/console-e2e/
node backup_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass \
    --s3 http://127.0.0.1:29900/ch-backups:consoleminio:consoleminio-secret-1 --minio-container console-minio \
    --worker ~/src/ClickHouse-private/utils/web-console/backup_worker.mjs \
    --server-restart ~/src/ClickHouse-private/tmp/console-dev/e2e/restart.sh \
    --server-log ~/src/ClickHouse-private/tmp/console-dev/log/clickhouse-server.log --screenshots shots
```

Cluster Management has its own checks. They need the cluster agent running against the same server with the
docker-compose provider for the environment `lab`, the image `clickhouse/clickhouse-server:26.9.8.3` on the Docker
host, and a credential reference `PLATFORM` (the agent's `PLATFORM_USER` and `PLATFORM_PASSWORD`) for the
registration check. They create lab clusters named `e2e-*`, retire them, and delete their resources:

```bash
cd ~/src/ClickHouse-private
CLICKHOUSE_URL=http://127.0.0.1:28123 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD=devpass \
CLUSTER_AGENT_STATE_DIR=$PWD/tmp/clusterlab/state PLATFORM_USER=default PLATFORM_PASSWORD=devpass \
node utils/web-console/cluster_agent.mjs &
cp utils/web-console/cluster_e2e.mjs ~/console-e2e/ && cd ~/console-e2e
node cluster_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass --screenshots shots
```

Without root access for `playwright install-deps`, unpack the missing libraries locally and point the loader at them:

```bash
mkdir -p ~/console-e2e/libs && cd ~/console-e2e/libs && apt-get download libnss3 libnspr4 libasound2t64
for f in *.deb; do dpkg-deb -x "$f" root; done
export LD_LIBRARY_PATH=$HOME/console-e2e/libs/root/usr/lib/x86_64-linux-gnu:$HOME/console-e2e/libs/root/usr/lib/x86_64-linux-gnu/nss
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

- Server: deploy the previous binary or image (`clickhouse/clickhouse-server:26.9.8.3`). The console
  itself stores nothing on the server; the only configuration it adds is the optional `web_console`
  section. Remove that section before downgrading, because older servers reject unknown sections.
- Administration data: the Administration pages store their audit log, component access policy, and
  protected accounts in the `console_admin` database (the `admin_database` setting), created only when an
  administrator selects **Set up**, and the role `console_admin_reader`. Users, roles, profiles, and quotas
  changed in the console are ordinary access entities and stay as they are after a rollback. To remove the
  console's own data: `DROP DATABASE console_admin; DROP ROLE console_admin_reader`. Back up the audit log
  first if it must be kept, for example with `BACKUP DATABASE console_admin TO Disk('backups', 'console_admin.zip')`
  on a server with a `backups` disk configured.
- Recovery: if a policy change hides components from everyone, the Administration pages are not governed
  by the policy, so a platform administrator can still fix it on the Component Access page; with SQL,
  `INSERT INTO console_admin.component_policy (subject_type, subject, component, open, view_data, run_queries, administer)
  VALUES ('all', '', 'sql', 1, 1, 1, 0)` allows the SQL Console for everyone again, and dropping the database
  turns the policy off. A user locked out by a suspension is reactivated with
  `ALTER USER name VALID UNTIL 'infinity'` by any user with `ALTER USER` on it, or from a user defined in
  `users.xml` with `access_management`.
- Source: the change is on the branch `private/unified-web-console`; `private/main` is unchanged.
