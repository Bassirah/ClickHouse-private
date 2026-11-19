# Demo kit of the web console

This kit adds identity services and sample data to an installed web console, to demonstrate its features:

| Service | What it is for | Public address (`--public`) | Through a tunnel (`--local`) |
|---|---|---|---|
| Web console | The console, and the HTTP interface of ClickHouse | `https://<address>/console` | `http://localhost:8123/console` |
| Keycloak 26.7, realm `acme` | Single sign-on: **Sign in with Keycloak** on the console, and the user sync that creates the Keycloak users in ClickHouse with the roles of their groups | `https://<address>:8443` | `http://localhost:8180` |
| phpLDAPadmin | A web interface to add and change the users and groups of the directory | `https://<address>:8444` | `http://localhost:8380` |
| OpenLDAP (`dc=acme,dc=example`) | Directory sign-in with the directory password, roles from directory groups, and the user attributes of Data Access Policies (department and branch) | inside the Compose network only (LDAPS) | the same |
| Sample data | `sales.orders` (200,000 orders) and `hr.staff` (400 employees, with salaries and national IDs) | in ClickHouse | |
| Roles | `analysts`, `engineers`, `auditors`, made with the grants of the role templates Analyst, Developer, and Auditor | in ClickHouse | |
| Backup disk | `backups`, for disk destinations of Backup & Restore | in the server's data volume | |

Two ways to reach the demo:

- **`--public <address>`**, for people on other networks: the public IP address or DNS name of the host, over HTTPS.
  Caddy obtains a Let's Encrypt certificate for the address (also for an IP address) and renews it. Browsers trust it,
  so the console, single sign-on, and every feature work as on a production installation. Ports 80, 443, 8443, and
  8444 must be reachable from the Internet. The plain HTTP and native ports of ClickHouse move to `127.0.0.1` of the
  host: everything public is encrypted.
- **`--local`**: every address on `127.0.0.1` of the host, opened through an SSH tunnel.

Keycloak runs in development mode and every password is generated for this installation. It is a demo, not a
production setup: in public mode, anybody on the Internet reaches the sign-in pages, so keep strong passwords for
`default` and the service accounts (`.env`), and give testers the demo people, not the administrators.

## Install

The console must be installed first, with steps 1 to 10 of [`../README.md`](../README.md) (Component Access set up,
the service accounts created). Then, in the deploy directory:

```bash
sudo demo/setup.sh --public 203.0.113.10       # or a DNS name of the host
sudo demo/setup.sh --local                     # or: through an SSH tunnel only
```

It takes about two minutes. Without an option, it keeps the way chosen before. It:

1. generates the passwords (`demo/state/secrets.env`) and a certificate authority for the directory (`demo/state/ldap-tls`);
2. writes the Keycloak realm and the directory tree, with the demo users and groups;
3. sets single sign-on, the attributes from the directory, the addresses, and `COMPOSE_FILE` in `.env`, so that a plain
   `docker compose` command uses every Compose file (the first run keeps the previous `.env` as
   `demo/state/env.before-demo`);
4. creates the sample data, the roles, and the account `sso_sync` of the user sync (`demo/config/demo.sql`);
5. starts Keycloak, OpenLDAP, phpLDAPadmin, the token authenticator, and with `--public` Caddy, and restarts the
   server with the directory, single sign-on, and the backup disk;
6. sets the addresses of the console in the Keycloak client (also when the realm existed already);
7. checks single sign-on, and writes every address and password into **`demo/state/CREDENTIALS.txt`** (readable by
   root only).

Running it again is safe: it keeps the passwords, the certificates, the data, and the changes made in Keycloak and in
the directory, and sets the passwords of the demo users again.

Then, once, in the console as `default`:

- **Identity Providers → SSO (Keycloak)**: select **Set up**.
- **Data Access Policies → Attributes & Classifications**: define the user attributes `department` and `branch`, with
  the source of truth `ldap`, the writer `access_policy_worker`, and freshness 86400 seconds. Within a minute, the
  access policy worker fills them in from the directory.

## Open the demo

With `--public`, open `https://<address>/console` from anywhere. For the administrators:

| What | Address | Sign in as |
|---|---|---|
| Web console | `https://<address>/console` | `default` and `CLICKHOUSE_ADMIN_PASSWORD` of `.env`, or a person below |
| Keycloak admin console | `https://<address>:8443/admin/master/console/#/acme` | `admin` |
| phpLDAPadmin | `https://<address>:8444` | `cn=admin,dc=acme,dc=example` |

To let other people try the console, send them the address and the user name and password of one of the people below
(`CREDENTIALS.txt`): alice, bob, or carol with **Sign in with Keycloak**, or dana, eli, or fay with the user name and
password fields. Each sees what their role allows. Keep `default` and the administrators of Keycloak and of the
directory for yourself, or add people for testers (see "Manage the people"), so that you can remove them afterwards.

With `--local`, open one tunnel for the three addresses on your computer, and keep it open during the demo:

```bash
ssh -L 8123:<CONSOLE_BIND>:<CONSOLE_HTTP_PORT> -L 8180:127.0.0.1:8180 -L 8380:127.0.0.1:8380 <user>@<host>
```

`CREDENTIALS.txt` has the command with the values of this host. The console must be on port 8123 of your computer:
that is the address registered in Keycloak (`DEMO_CONSOLE_PORT` of `setup.sh` changes it).

| What | Address | Sign in as |
|---|---|---|
| Web console | `http://localhost:8123/console` | `default` and `CLICKHOUSE_ADMIN_PASSWORD` of `.env`, or a person below |
| Keycloak admin console | `http://localhost:8180/admin/master/console/#/acme` | `admin` |
| phpLDAPadmin | `http://localhost:8380` | `cn=admin,dc=acme,dc=example` |

Allow pop-ups for the address of the console: **Sign in with Keycloak** opens the sign-in in a pop-up window.

## The people

| Person | Signs in with | Groups | ClickHouse roles | Department, branch (from the directory) |
|---|---|---|---|---|
| alice | Keycloak | `clickhouse-analysts` | `analysts` | finance, london |
| bob | Keycloak | `clickhouse-engineers` | `engineers` | engineering, berlin |
| carol | Keycloak | `clickhouse-auditors` | `auditors` | hr, new_york |
| pia | Keycloak | none | none: the console refuses her | none |
| dana | the directory | `clickhouse-analysts` | `analysts` | finance, london |
| eli | the directory | `clickhouse-engineers` | `engineers` | engineering, paris |
| fay | the directory | `clickhouse-analysts` | `analysts` | sales, berlin |

Everybody also gets `console_admin_reader`, which lets the console apply Component Access to them. A group named
`clickhouse-<role>` gives the role `<role>`, in Keycloak and in the directory alike, when that role exists in
ClickHouse.

Alice, Bob, and Carol are in the directory as well, without a password, as in an HR system: it is the source of their
attributes. Their sign-in is Keycloak's.

## Manage the people

### In Keycloak

In the admin console, realm **acme**:

1. **Users → Add user**: user name, email, first and last name, then **Create**.
2. **Credentials → Set password**, with **Temporary** off.
3. **Groups → Join Group**: `clickhouse-analysts`, `clickhouse-engineers`, or `clickhouse-auditors`.

Within a minute, the user sync creates the user in ClickHouse (`IDENTIFIED WITH http SERVER 'sso'`) with the roles
of the groups, and they can sign in with Keycloak. Leaving every `clickhouse-*` group, or disabling the user, drops the
ClickHouse user within a minute. For attributes, also add the person to the directory (below), without a password.

### In the directory

With phpLDAPadmin: sign in, open `ou=users`, and select **Create a child entry** → **Default** → object class
`inetOrgPerson`, RDN `uid`. Fill in `uid`, `cn`, `sn`, `departmentNumber` (the department), and `l` (the branch), and
set **Password** (SSHA). To give a role, open the group under `ou=groups` and add the user's DN to `member`. A quicker
way: open an existing user, and **Copy or move this entry** to a new `uid`.

Or from the shell, in the deploy directory:

```bash
demo/ldap-user.sh list
demo/ldap-user.sh add gus Gus Petrov finance paris clickhouse-analysts   # prints the password
demo/ldap-user.sh set gus departmentNumber sales                           # or l (the branch)
demo/ldap-user.sh join gus clickhouse-engineers                            # leave: the opposite
demo/ldap-user.sh passwd gus
demo/ldap-user.sh group clickhouse-backup_viewer                           # a group for the role backup_viewer
demo/ldap-user.sh delete gus
```

A new directory user signs in at once. A change of a password or of the groups takes effect within
`verification_cooldown` (300 seconds of `demo/config/ldap.xml`) for a user who signed in recently. A change of an
attribute takes effect within a minute (one cycle of the access policy worker).

## Demo script

About 45 minutes; each part stands alone. Sign out between people, or use a private window per person.

### 1. Sign-in: one console, three identity sources (5 minutes)

1. On the sign-in page, select **Sign in with Keycloak** and sign in as **alice**. The console opens with her roles;
   Administration is not offered to her.
2. Sign out, and try **pia**: Keycloak accepts her, but the console refuses, because she is in no `clickhouse-*` group.
3. Sign in as **dana** with her directory password in the user name and password fields: directory sign-in.
4. Sign in as `default`. **Administration → Users** lists alice, bob, and carol (single sign-on) next to the service
   accounts; **Identity Providers → LDAP** lists the directory users seen since the start.

### 2. Identity Providers (10 minutes)

1. **Identity Providers → LDAP → Configure LDAP…**: fill in the server `acme`, the host `openldap`, LDAPS on 1636,
   the CA file `/etc/clickhouse-server/ldap/ca.crt`, the bind DN `uid={user_name},ou=users,dc=acme,dc=example`, the
   default role `console_admin_reader`, the groups under `ou=groups,dc=acme,dc=example` with the prefix
   `clickhouse-`. The generated configuration is the one installed in `demo/config/ldap.xml`. Point out the secure
   defaults: TLS 1.2, the certificate always checked, the verification cooldown.
2. **Test sign-in…** as eli: the roles and the directory that accepted him, without storing the password.
3. **Identity Providers → SSO (Keycloak) → Add Keycloak…**: the Keycloak URL (`https://<address>:8443`, or `http://localhost:8180` through a tunnel), the realm
   `acme`, the client `clickhouse-console`. **Test connection** checks discovery, the issuer, the Authorization Code
   flow, PKCE, the signing keys, and the roles of the groups; **Test sign-in…** signs in as bob in a separate window.
4. In Keycloak, add a user to `clickhouse-analysts` (see above); a minute later, they appear on the Users page, and
   sign in.

### 3. Data Access Policies: access that follows the directory (10 minutes)

The highlight: the access of each person follows their attributes in the directory, without anybody changing grants.

1. **Data Access Policies → Attributes & Classifications**: `department` and `branch`, with the source `ldap`, their
   values per person, and their freshness.
2. **Policy Rules**: open the rule `Staff read their own department`, or create it with **New rule**: the kind **Filter rows by an attribute**,
   the users `department = finance, sales, engineering, hr`, the table `hr.staff`, the column `department`, the
   attribute `department`. **Review** shows who matches, then **Apply**.
3. **Policy Deployments → Deploy**: the plan lists one row policy per department, then **Apply**. (When the rule is
   already deployed, the button is unavailable: nothing would change.)
4. Sign in as **dana**, and in the SQL Console run
   `SELECT department, count() FROM hr.staff GROUP BY department`: only `finance`.
5. In phpLDAPadmin (or `demo/ldap-user.sh set dana departmentNumber sales`), change Dana's `departmentNumber` to
   `sales`. Within a minute, the worker imports the value and reconciles the deployment, and the same query returns
   only `sales`. **Audit Activity** shows the reconciliation. Set it back to `finance`.
6. Column clearance: the rule `Personal data needs finance or hr`, or create it. On **Attributes & Classifications**,
   **Classify column** `hr.staff.salary` and `hr.staff.national_id` with the label `pii`. Then **New rule** of the kind
   **Columns of a label need a clearance**: the users `department = finance, sales, engineering, hr`, the label `pii`,
   the clearance attribute `department`, the values that clear `finance, hr`. Deploy: dana (finance) reads the
   salaries, fay (sales) gets `Not enough privileges` for them and still reads the other columns.
7. **Effective Access** and **Access Tests**: what each person can read, and saved tests that prove it (**Add test**,
   for example "fay cannot read national_id").

A rule of the kind **Grant a role** applies to the users of Keycloak (they are users of ClickHouse), not to directory
users, whose roles come from the directory groups.

### 4. Control what each person sees (5 minutes)

1. **Component Access**: hide, for example, **Web Terminal** and **Play UI** from the role `analysts`, then sign in as
   alice: they are gone from her sidebar.
2. **Roles & Permissions → Role templates**: create a role from a template (for example **Backup Viewer**), see its
   exact grants before it is created, and assign it to a person.
3. **Profiles & Quotas**: limit the analysts, for example the memory of a query or the queries per hour.

### 5. Work with data (10 minutes)

1. **SQL Console**: query `sales.orders`, for example revenue per branch and month. The menu of a table offers
   **Table properties** and **Import data**, which open as tabs of the SQL Console.
2. **Tables**: the structure, size, parts, and properties of `sales.orders` and `hr.staff`.
3. **Import data**: load a CSV, JSON, or Parquet file into a new table, with a preview and the inferred types.
4. **Play UI**: the same queries in the classic interface, as a panel of the workspace.
5. **Running queries**, **Dashboard**, and the visualizers under **Diagnostics**.

### 6. Backup & Restore (5 minutes)

1. **Destinations → Add destination**: a disk destination on the disk `backups`, for example with the path `demo/`.
   **Test** it.
2. **New backup** of the databases `sales` and `hr`, then **Add schedule** with retention.
3. **Restore** the latest backup of `hr` into a new name, for example `restore_hr`, and compare.
4. **Overview**: the heartbeat of the backup worker and the 3-2-1-1 check of the last 7 days, which says what is missing
   (a second copy, off-site, immutable). For these, add an S3 destination (another host, MinIO for example) with Object
   Lock.

`setup.sh` adds `sales` and `hr` to the role `backup_admin` of the backup worker (step 7 of the installation), so that
schedules can back them up. For other databases, add them to the role on **Roles & Permissions**.

### 7. Clusters (optional, 5 minutes)

**Clusters → Create cluster**: a lab cluster with the docker-compose provider, in the environment `lab`, with the image
`clickhouse/clickhouse-server:26.9.8.3` (and `chproxy` for client routing). Both images are on the host. The cluster
agent starts the nodes on this host; each needs about 2 CPUs and 2 GiB of memory. Then show its inventory, topology,
health, and configuration history, and retire it at the end.

### 8. Audit (2 minutes)

**Audit Activity** lists every change of the demo, with who made it, when, and the statements. Sign in as **carol**
(the role `auditors`): she reads the audit log, users, and roles, and cannot change anything.

## Reset or remove the demo

Start the identities from scratch (the realm and the directory are created again; ClickHouse keeps its data):

```bash
docker compose rm -sf keycloak openldap phpldapadmin sso-authenticator
docker volume rm clickhouse-console_keycloak-data clickhouse-console_openldap-data
sudo demo/setup.sh
```

The Keycloak users of ClickHouse are dropped by the next sync if they are no longer in the realm. Remove the demo
entirely: stop and remove those services (and `caddy`) and their volumes, restore the `.env` you backed up (or delete
`COMPOSE_FILE` and the `SSO_*`, `LDAP_ATTRIBUTES_*`, and `DEMO_*` lines), run `docker compose up -d`, and drop the demo
objects if you like (`DROP DATABASE sales`, `DROP DATABASE hr`, `DROP ROLE analysts, engineers, auditors`,
`DROP USER sso_sync`).

## How it works

| Part | Detail |
|---|---|
| Public addresses | `compose.demo-public.yaml` runs Caddy on ports 80, 443, 8443, and 8444, with `demo/state/Caddyfile`. Let's Encrypt issues certificates for IP addresses only with its short-lived profile (about 6 days; Caddy renews them), and clients send no server name (SNI) for an IP address, so the Caddyfile sets `default_sni`. Keycloak's issuer is `https://<address>:8443/realms/acme` (`KC_HOSTNAME`, with the `X-Forwarded-*` headers of Caddy), and the token authenticator reaches it at that public address from the Compose network. `CONSOLE_BIND` is `127.0.0.1`: the plain ports of ClickHouse are not public, and the cluster agent connects there. |
| Single sign-on through a tunnel | The token authenticator accepts a provider over plain HTTP only on `localhost`. With `--local`, Keycloak's issuer is `http://localhost:8180/realms/acme`, and the authenticator shares the network of the Keycloak container (`network_mode: service:keycloak` in `compose.demo-local.yaml`), so `localhost:8180` is Keycloak both for the browser (through the tunnel) and for the authenticator. The server reaches the authenticator at `http://keycloak:29700` (`demo/config/sso.xml`). |
| Directory | The server and the access policy worker use LDAPS with the certificate authority of `demo/state/ldap-tls`, and check the certificate of `openldap`. phpLDAPadmin uses plain LDAP inside the Compose network. |
| Attributes | The worker reads `departmentNumber` and `l` of every person under `ou=users` with the read-only account `cn=attribute-reader,ou=services`, every minute. |
| Impersonation | The worker applies each rule as its author, and the cluster agent acts as the requester: both may impersonate `default` (`demo/config/demo.sql`). Rules written by other administrators need `GRANT IMPERSONATE ON <author> TO access_policy_worker`. |
| Files | `compose.demo.yaml` (the services), `compose.demo-public.yaml` and `compose.demo-local.yaml` (the two ways to reach them), `setup.sh`, `ldap-user.sh`, `config/` (server configuration and SQL), and `state/` (generated, private: passwords, certificates, the realm, the tree). |
