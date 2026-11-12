# Web console: build, run, test, package

The web console is served by the server at `/console`. Its documentation (quick start, tutorials, user guides, how-to
guides, and API reference) is the section `docs/products/web-console/` of the documentation site, and the same pages
are the Console Guide inside the console (**Resources** → **Console Guide**). After changing a page or
`navigation.json`, regenerate the guide, which is embedded into the binary:

```bash
node utils/web-console/build_guide.mjs           # writes programs/server/console_guide.json
node utils/web-console/build_guide.mjs --check   # fails if it is not up to date
```

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
| `utils/web-console/backup_worker.mjs` | Backup worker: schedules, reconciliation, retention, deletions, and server bundles (Node.js 18, no packages). |
| `utils/web-console/server_bundle.mjs` | Server bundles: collects the configuration, secrets, and a Keeper snapshot, and encrypts them (AES-256-GCM, a data key per bundle wrapped by a key file, HashiCorp Vault Transit, or a passphrase). See "Server bundles" in `deploy/README.md`. |
| `utils/web-console/recovery_rehearsal.mjs` | Recovery rehearsal: restores the latest backups, optionally with a staged configuration, on an isolated server, compares them with the values recorded at backup time, and records the result with each backup. See "Recover a whole server" in `deploy/README.md`. |
| `utils/web-console/server_bundle_test.mjs` | Tests of `server_bundle.mjs` without a server: round trips with each key provider, wrong keys, changed and truncated bundles. |
| `utils/web-console/backup_e2e.mjs` | Browser acceptance checks of Backup & Restore, including a server restart and an unavailable destination (Playwright; not part of the build). |
| `utils/web-console/cluster_agent.mjs` | Cluster agent: executes cluster lifecycle operations through the docker-compose and kubernetes providers, and observes clusters (Node.js 18, no packages). |
| `utils/web-console/access_policy_worker.mjs` | Access policy worker: imports user attributes from a feed, and reconciles the native grants, role memberships, and row policies of the policy rules, acting as each rule's author (Node.js 18, no packages). |
| `utils/web-console/data_access_e2e.mjs` | Browser acceptance checks of Data Access Policies with synthetic users and data, over HTTP and the native protocol, including the access policy worker (Playwright; not part of the build). |
| `utils/web-console/cluster_k8s_e2e.mjs` | Browser acceptance checks of the Kubernetes provider of Cluster Management: the wizard's choices, provisioning, configuration and drift, storage expansion, replicas, backup, retirement, and deletion (Playwright; not part of the build). |
| `utils/web-console/k8s_lab.sh` | Creates and deletes the Kubernetes lab: a k3d cluster with cert-manager, the ClickHouse operator, and an expandable storage class. |
| `utils/web-console/cluster_e2e.mjs` | Browser acceptance checks of Cluster Management against a running agent: provisioning, registration, drift, scaling, failures, and retirement (Playwright; not part of the build). |
| `programs/server/console_guide.json` | The Console Guide: the pages of `docs/products/web-console/` as HTML, generated by `build_guide.mjs`; do not edit. Served at `/console/guide.json`. |
| `utils/web-console/build_guide.mjs` | Converts `docs/products/web-console/` (the MDX pages and `navigation.json`) into `console_guide.json`, and checks the links between pages and their anchors (Node.js, no packages). |
| `utils/web-console/ldap_client.mjs` | A small LDAP v3 client (simple bind, search filters, paged results, over LDAPS or StartTLS only) with which the access policy worker reads user attributes from a directory. |
| `utils/web-console/sso_authenticator.mjs` | Token authenticator of single sign-on: the HTTP authentication server that checks the Keycloak access tokens of the users `IDENTIFIED WITH http`, and, optionally, the sync of those users and their roles from Keycloak groups (Node.js, no packages; `sso-authenticator` in the tools image). |
| `utils/web-console/sso_e2e.mjs` | Browser acceptance checks of the Identity Providers pages: the Keycloak settings and their checks, the connection test (including a wrong realm), a test sign-in with Authorization Code and PKCE in a separate window, a refused sign-in, and that no token reaches the server; with `--sign-in`, signing in to the console with Keycloak, the token refresh reaching a panel, a user without a ClickHouse user, signing out of Keycloak, and a user disabled in Keycloak losing access (Playwright; not part of the build). |
| `utils/web-console/IDENTITY_PROVIDERS.md` | Assessment of identity providers for the console and the server: what the server can check, the ways to accept OpenID Connect sign-ins, what exists, and the next steps. |
| `utils/web-console/ldap_e2e.mjs` | Browser acceptance checks of directory sign-in: the generated LDAP configuration installed on a server without one, sign-in with the directory password and roles from groups, directory changes after the cooldown, user attributes of Data Access Policies read from the directory, and the users managed with SQL next to the directory (Playwright; not part of the build). |
| `utils/web-console/run_e2e.sh` | Runs the browser suites against a server of their own, with its own MinIO, cluster agent, Vault, OpenLDAP, and Keycloak, started and removed for each run. |
| `utils/web-console/Dockerfile` | Server image: a locally built binary on top of the official image. |
| `utils/web-console/Dockerfile.tools`, `tools-entrypoint.sh` | Tools image: the backup worker, the cluster agent (with `docker`, Compose, and `kubectl`), the access policy worker, and the token authenticator. |
| `utils/web-console/build_images.sh` | Builds the images from source, end to end: checks, a Release build of the binary, then `package_images.sh`. |
| `utils/web-console/package_images.sh` | Builds, smoke-tests, and packages both images as archives for distribution, from an existing binary. |
| `utils/web-console/deploy/` | Deployment examples shipped with the archives: Docker Compose, Kubernetes, the service accounts, and their guide. |

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

The usual way to run the suites is `run_e2e.sh`, which runs them against a server of their own. Every run starts a
new server with an empty data directory (HTTP 38123, native 39000, Keeper 39181), its own MinIO container (39900),
and its own cluster agent (lab ports 32000-32999), then stops and removes them. The ldap suite has an OpenLDAP of its own
(39636), and the sso suite a Keycloak of its own (39080, the image `quay.io/keycloak/keycloak:26.7`) with a realm whose
client registers the redirect URI of this server. The results depend only on the code:
not on what a person or an earlier run left on a server, and the development instance is never touched.

```bash
cd ~/src/ClickHouse-private
utils/web-console/run_e2e.sh                                    # all suites, with the page built into the binary
utils/web-console/run_e2e.sh --page-from-source                 # with programs/server/console.html as it is now
utils/web-console/run_e2e.sh --suites console,access            # only some: console, access, data_access, backup, cluster, ldap, sso
```

| Option | Meaning |
|---|---|
| `--suites <list>` | Suites to run, comma-separated (default: all). |
| `--binary <path>` | The `clickhouse` binary (default: `build/programs/clickhouse`). |
| `--page-from-source` | Serve `programs/server/console.html` and `console_guide.json` from the working tree, with the headers of the built-in handler: try a change of the page without rebuilding. The other pages come from the binary. |
| `--e2e-dir <dir>` | The Playwright workspace (default: `~/console-e2e`). |
| `--keep` | Leave the server, MinIO, and the agent running at the end, to look at what a suite left. Stop them before the next run. |

The logs, one per suite plus the server's and the agent's, and the screenshots are in `tmp/console-e2e-run/logs/`.
The script exits with an error when a suite fails. The backup suite needs the image
`minio/minio:RELEASE.2025-07-23T15-54-02Z` on the host, and the cluster suite the images of the lab clusters. If
Chromium needs libraries that are not installed system-wide, set `LD_LIBRARY_PATH` before running it.

Each suite can also run alone against another server, such as the development instance, as below. The checks then
depend on that server's state, for example its component access policy.

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
docker-compose provider for the environment `lab`, the images `clickhouse/clickhouse-server:26.9.8.3` and
`contentsquareplatform/chproxy:v1.30.0` (the clusters of the checks use chproxy) on the Docker host, and a credential reference `PLATFORM` (the agent's `PLATFORM_USER` and `PLATFORM_PASSWORD`) for the
registration check. They create lab clusters named `e2e-*`, retire them, and delete their resources:

```bash
cd ~/src/ClickHouse-private
CLICKHOUSE_URL=http://127.0.0.1:28123 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD=devpass \
CLUSTER_AGENT_STATE_DIR=$PWD/tmp/clusterlab/state PLATFORM_USER=default PLATFORM_PASSWORD=devpass \
node utils/web-console/cluster_agent.mjs &
cp utils/web-console/cluster_e2e.mjs ~/console-e2e/ && cd ~/console-e2e
node cluster_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass --screenshots shots
```

Data Access Policies has its own checks. They create a database `dap_e2e_<run>` with synthetic users and roles, check every
result as those users over HTTP and with the native client, run the access policy worker with an attribute feed file,
and remove everything at the end. `--cluster` names a cluster with an interserver secret that contains the server, for
the distributed checks; `--partial-cluster` names a cluster with an unavailable server, for the partial deployment check:

```bash
cp utils/web-console/data_access_e2e.mjs ~/console-e2e/ && cd ~/console-e2e
node data_access_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass --native-port 29000 \
    --clickhouse ~/src/ClickHouse-private/build/programs/clickhouse \
    --worker ~/src/ClickHouse-private/utils/web-console/access_policy_worker.mjs \
    --console-html ~/src/ClickHouse-private/programs/server/console.html \
    --cluster dap_secret --partial-cluster console_test --screenshots shots
```

The Kubernetes provider has its own lab and checks. `k8s_lab.sh up` creates a k3d cluster `chlab` with cert-manager
v1.16.2, the ClickHouse operator v0.0.8, and the storage class `csi-hostpath-expandable` (the CSI host-path driver, which
allows volume expansion; k3s's `local-path` does not), and writes `tmp/k8s/kubeconfig`. Start the agent with it, then run
the checks; they create clusters `k8s-*` in namespaces `chc-k8s-*` and delete them:

```bash
utils/web-console/k8s_lab.sh up
CLUSTER_AGENT_KUBECONFIG=$PWD/tmp/k8s/kubeconfig CLUSTER_AGENT_K8S_NAMESPACES='chc-*' \
CLICKHOUSE_URL=http://127.0.0.1:28123 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD=devpass \
CLUSTER_AGENT_STATE_DIR=$PWD/tmp/clusterlab/state E2E_S3_ACCESS_KEY_ID=... E2E_S3_SECRET_ACCESS_KEY=... \
node utils/web-console/cluster_agent.mjs &
cp utils/web-console/cluster_k8s_e2e.mjs ~/console-e2e/ && cd ~/console-e2e
node cluster_k8s_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass --kubeconfig ~/src/ClickHouse-private/tmp/k8s/kubeconfig \
    --expandable csi-hostpath-expandable --fixed local-path --destination 'e2e s3' --screenshots shots
```

Without root access for `playwright install-deps`, unpack the missing libraries locally and point the loader at them:

```bash
mkdir -p ~/console-e2e/libs && cd ~/console-e2e/libs && apt-get download libnss3 libnspr4 libasound2t64
for f in *.deb; do dpkg-deb -x "$f" root; done
export LD_LIBRARY_PATH=$HOME/console-e2e/libs/root/usr/lib/x86_64-linux-gnu:$HOME/console-e2e/libs/root/usr/lib/x86_64-linux-gnu/nss
```

## Docker images

The console is distributed as two images, packaged as archives that can be copied to any environment, including
networks without access to a registry:

| Image | Contents |
|---|---|
| `clickhouse-server-console:<version>` | The official `clickhouse/clickhouse-server` image of the same release, with the binary of this build (`Dockerfile`). Everything of the official image applies: its environment variables, `config.d`, `users.d`, and `docker-entrypoint-initdb.d`. |
| `clickhouse-console-tools:<version>` | Node.js 22 with the four helper processes, `console.html` for the access policy worker, the `docker` CLI with Compose, and `kubectl` (`Dockerfile.tools`). The first argument chooses the process: `backup-worker`, `cluster-agent`, `access-policy-worker`, or `sso-authenticator`. |

The version is `<release of the base image>-console.<commit>`, for example `26.9.8.3-console.a88866202a2`.

### Building the images {#building-the-images}

Commit your changes, then run from the repository root:

```bash
utils/web-console/build_images.sh
```

It needs Docker, Git, CMake, Ninja, Clang (`clang-22` when installed, or `CC` and `CXX`), and about 60 GB free for the
build directory. It runs four steps:

1. **Checks**: the tools, Docker, the free space, and uncommitted changes in `programs/`, `src/`, or
   `utils/web-console/`, which it refuses unless `--allow-dirty` is given (the version then ends with `-dirty`).
   Everything that would otherwise fail after hours of compiling is checked first.
2. **Configure** a Release build in `build_release/`, once (`cmake.log` in it). A Debug binary is several gigabytes
   and slow, so a build directory that is not Release is refused.
3. **Build** the `clickhouse` binary, with the output in `build_release/ninja_release.log`. The first build takes
   several hours (about 6 on 22 cores); later builds compile only what changed. An interrupted build resumes where it
   stopped when the script runs again. To follow it:

   ```bash
   tail -c 300 build_release/ninja_release.log | tr '\r' '\n' | grep -o '\[[0-9]*/[0-9]*\]' | tail -1
   ```
4. **Package** with `package_images.sh` (a few minutes).

| Option | Meaning |
|---|---|
| `--build-dir <dir>` | Build directory (default `build_release`). |
| `--with-rust` | Also build the Rust components: the PRQL dialect, fuzzy history search in `clickhouse-client` (skim), WebAssembly UDFs (wasmtime), and polyglot. Needs `rustup` with the toolchain named in `contrib/corrosion-cmake/CMakeLists.txt`. Default: without them. |
| `--package-only` | Do not build: package the binary already in the build directory. |
| `--base-image <image>` | The official server image of the same release (default `clickhouse/clickhouse-server:26.9.8.3`). |
| `--out <dir>` | Output directory (default `tmp/dist/<version>/`). |
| `--allow-dirty` | Allow uncommitted changes. |

`package_images.sh` alone packages any Release binary (`--binary <path>`). It refuses a Debug build, a binary whose
release differs from the base image, and uncommitted changes (unless `--allow-dirty`). It strips the debug information
(the symbols stay, for stack traces), builds both images, smoke-tests them (the server starts, reports the release,
and serves this build's console; each helper starts; the tools are present), and writes to `tmp/dist/<version>/`:

- `clickhouse-server-console-<version>-amd64.tar.gz` and `clickhouse-console-tools-<version>-amd64.tar.gz`, loaded with `docker load -i`;
- `MANIFEST.txt` (commit, base image digest, image IDs) and `SHA256SUMS`;
- `deploy/`: `compose.yaml` and `compose.cluster-agent.yaml` for a Docker host, `kubernetes.yaml`, `.env.example`,
  `config.d/web-console.xml`, `service-accounts.sql`, and `README.md`, the guide for the operators of each environment.

Every environment gets the same images; what differs is in `.env` and `config.d/`. The console needs no Internet
access; the Binary visualizer and Jemalloc pages load libraries from public CDNs and do not work offline.

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
- Recovery: if a policy change hides components from everyone, the Component Access page is not governed by
  the policy (the other Administration pages are), so a platform administrator can still fix it there; with SQL,
  `INSERT INTO console_admin.component_policy (subject_type, subject, component, open, view_data, run_queries, administer)
  VALUES ('all', '', 'sql', 1, 1, 1, 0)` allows the SQL Console for everyone again, and dropping the database
  turns the policy off. A user locked out by a suspension is reactivated with
  `ALTER USER name VALID UNTIL 'infinity'` by any user with `ALTER USER` on it, or from a user defined in
  `users.xml` with `access_management`.
- Source: the change is on the branch `private/unified-web-console`; `private/main` is unchanged.
