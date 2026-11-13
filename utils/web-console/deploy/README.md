# Deploying the ClickHouse web console

This directory is shipped with the image archives made by `utils/web-console/package_images.sh`. It deploys the
ClickHouse server with the web console, and its helper processes, in an environment: on one Docker host with
`compose.yaml` and its optional `compose.*.yaml` files, or on Kubernetes with `kubernetes.yaml` and the optional
`kubernetes.sso.yaml`.

| Feature | Docker Compose | Kubernetes |
|---|---|---|
| Server, backup worker, access policy worker | `compose.yaml` | `kubernetes.yaml` |
| Cluster agent | `compose.cluster-agent.yaml` (docker-compose and kubernetes providers) | `kubernetes.yaml` (kubernetes provider) |
| Server bundles (section 5) | `compose.bundles.yaml` | `kubernetes.yaml`, with the ConfigMap `backup-worker-bundles` |
| Recovery rehearsal (section 7) | `compose.rehearsal.yaml` | `kubernetes.yaml`, the CronJob `recovery-rehearsal` |
| User attributes from LDAP (section 8) | `compose.ldap-attributes.yaml` | `kubernetes.yaml`, with the ConfigMap `access-policy-ldap` |
| Single sign-on (section 9) | `compose.sso.yaml` and `config.d/sso.xml` | `kubernetes.sso.yaml` |

| Image | Contents |
|---|---|
| `clickhouse-server-console:<version>` | The official `clickhouse/clickhouse-server` image of the same release, with the server binary of this build, which serves the console at `/console`. Every setting and environment variable of the official image applies. |
| `clickhouse-console-tools:<version>` | Node.js with the backup worker, the cluster agent (with the `docker` CLI, Compose, and `kubectl`), the access policy worker, the token authenticator of single sign-on, and the recovery rehearsal. The first argument chooses the process: `backup-worker`, `cluster-agent`, `access-policy-worker`, `sso-authenticator`, or `recovery-rehearsal`. |

The version is `<ClickHouse release>-console.<commit>`; `MANIFEST.txt` lists the commit, the base image digest, and the image IDs.

## 1. Load and verify the images

```bash
sha256sum -c SHA256SUMS
docker load -i clickhouse-server-console-<version>-amd64.tar.gz
docker load -i clickhouse-console-tools-<version>-amd64.tar.gz
```

To use a registry instead, tag and push both images, then use the registry names in `compose.yaml` or `kubernetes.yaml`:

```bash
docker tag clickhouse-server-console:<version> registry.example.com/clickhouse/clickhouse-server-console:<version>
docker push registry.example.com/clickhouse/clickhouse-server-console:<version>
```

## 2. Configure the environment

Each environment differs only in its settings; the images are the same everywhere.

| File | What to set |
|---|---|
| `.env` (from `.env.example`) | The version, the published address and ports, the passwords, and the settings of the helpers. Keep it readable by its owner only. |
| `config.d/web-console.xml` | The Resources links (internal mirrors or empty on a network without Internet access), the admin database, and the S3 endpoints allowed for backups. |
| `backup-destinations.env` (optional) | S3 credentials of backup destinations, named after their credential reference: `<REF>_ACCESS_KEY_ID`, `<REF>_SECRET_ACCESS_KEY`. |

Further server configuration goes into more files mounted into `/etc/clickhouse-server/config.d/` and
`/etc/clickhouse-server/users.d/`, as for the official image.

## 3. Start with Docker Compose

```bash
cp .env.example .env && chmod 600 .env    # then fill it in
docker compose up -d clickhouse
```

Open `http://<host>:<CONSOLE_HTTP_PORT>/console` and sign in as `default` with `CLICKHOUSE_ADMIN_PASSWORD`. Then:

1. On **Administration**, select **Set up** on Component Access, Backup & Restore, Clusters, and the tabs of Data
   Access Policies that you use. This creates the console tables.
2. Create the service accounts of the helpers. Edit the placeholders of `service-accounts.sql` (the role of the backup
   worker, the users the agent and the access policy worker impersonate), then run:

   ```bash
   set -a; . ./.env; set +a
   docker compose exec -T clickhouse clickhouse-client --password "$CLICKHOUSE_ADMIN_PASSWORD" \
       --param_backup_pw="$BACKUP_WORKER_PASSWORD" --param_policy_pw="$ACCESS_POLICY_WORKER_PASSWORD" \
       --param_agent_pw="$CLUSTER_AGENT_PASSWORD" --multiquery < service-accounts.sql
   ```
3. Start the helpers:

   ```bash
   docker compose up -d                              # backup worker and access policy worker
   docker compose -f compose.yaml -f compose.cluster-agent.yaml up -d   # and the cluster agent, if you manage clusters
   ```

The workers' heartbeats appear on the Backup & Restore Overview and on the Cluster Inventory.

### Cluster agent on a Docker host

The agent uses the host network and the Docker socket. Access to the socket is equivalent to root on the host: run
the agent only where that is acceptable. Its state directory (`CLUSTER_AGENT_STATE_DIR`) is mounted at the same path
as on the host and must be writable by `CLUSTER_AGENT_UID`:

```bash
sudo mkdir -p /var/lib/clickhouse-console/clusters && sudo chown 1000 /var/lib/clickhouse-console/clusters
stat -c %g /var/run/docker.sock                    # DOCKER_GID
```

On Docker Desktop, the host network is that of Docker Desktop's virtual machine: enable host networking in its
settings (Resources → Network), and note that the agent then reaches the published ports of the server, not services
listening only inside WSL or on the Windows host.

Back up that directory: it holds the agent's key pair (`agent-key.pem`) and the secrets of the clusters it created.
The images of the lab clusters (`clickhouse/clickhouse-server:<version>`, and `contentsquareplatform/chproxy:<version>`
for client routing) must be on the host: the agent does not pull images. Set `CLUSTER_AGENT_KUBECONFIG` to a kubeconfig
on the host to enable the kubernetes provider as well.

## 4. Start on Kubernetes

`kubernetes.yaml` runs the server as a StatefulSet with a 20 GiB volume, the two workers, the cluster agent with
the kubernetes provider (it manages clusters with the ClickHouse operator in the same Kubernetes cluster, through a
service account limited to what it uses), and the recovery rehearsal as a suspended CronJob. Follow the steps at the top
of the file: make the images available to the nodes, create the Secret, and apply. Then open the console through the
Service:

```bash
kubectl -n clickhouse-console port-forward svc/clickhouse 8123:8123     # http://localhost:8123/console
```

and continue with steps 1 and 2 of the previous section, with `kubectl -n clickhouse-console exec -i clickhouse-0 --`
in place of `docker compose exec -T clickhouse`. For access from outside the cluster, put an Ingress with TLS in front
of the Service: the console sends passwords in HTTP headers.

The optional features are off until their ConfigMap or Secret exists, so `kubernetes.yaml` applies as it is
everywhere, and each environment adds only what it uses. The sections below say what to create; after creating or
changing one, restart the workload that reads it (`kubectl -n clickhouse-console rollout restart deployment/<name>`, or
`statefulset/clickhouse` for the server).

## 5. Server bundles

`BACKUP` copies databases, tables, and access entities, but not the server's configuration files, the secrets in them,
TLS keys, scripts, or Keeper's own state. The backup worker backs those up as **server bundles**: it reads the files on
the server host, encrypts them, and stores the ciphertext at a destination of Backup & Restore. They appear on
**Administration → Backup & Restore → Server state**.

Each bundle has its own random 256-bit data key (AES-256-GCM); the master key of the worker wraps that data key. The
master key is never stored with a bundle, and the destination and the server only ever hold ciphertext. Choose where
the master key lives with `BUNDLE_KEY_PROVIDER`:

| Provider | Where the master key is | Bundles from the console and on a schedule | What you must do |
|---|---|---|---|
| `file` | A file on the worker host, readable by its owner only | Yes | Create it with `bundle-key-init`, then keep a copy **out of band**, away from this host and from the backups (a password manager, a sealed envelope), with its fingerprint. Without the key, no bundle can be decrypted. |
| `vault` | The Transit secrets engine of HashiCorp Vault; the key never leaves Vault | Yes | Create a Transit key, and give the worker a token whose policy allows only `encrypt` and `decrypt` on it. Vault must be reachable to restore. |
| `passphrase` | Nowhere: derived from a passphrase with scrypt | No: a person makes and restores bundles on the worker host | Keep the passphrase out of band. |

With Docker Compose, `compose.bundles.yaml` mounts the deployment's `config.d`, a key directory, and a staging
directory into the worker; its header has the commands. Create the key, copy it out of band, then start the worker:

```bash
mkdir -p bundle-keys restore-staging && sudo chown 101:101 bundle-keys restore-staging && sudo chmod 700 bundle-keys restore-staging
docker compose -f compose.yaml -f compose.bundles.yaml run --rm backup-worker backup-worker bundle-key-init --key-file /keys/bundle.key
docker compose -f compose.yaml -f compose.bundles.yaml up -d backup-worker
```

Also grant the worker its bundle tables (the line in `service-accounts.sql`):
`GRANT CREATE TABLE, DROP TABLE, INSERT, SELECT, BACKUP ON console_admin.server_bundle* TO backup_worker`.

| Variable | Meaning |
|---|---|
| `BUNDLE_PATHS` | Files and directories to include, comma-separated (default `/etc/clickhouse-server`). Add TLS keys, `user_scripts`, format schemas, dictionary files, the named collections directory, and the cluster agent's state directory where they are on this host. A file the worker cannot read fails the bundle. |
| `BUNDLE_KEEPER`, `BUNDLE_KEEPER_SNAPSHOTS` | `host:port` of Keeper and its snapshot directory: the worker asks Keeper for a new snapshot (`csnp`, allowed by default in `four_letter_word_white_list`) and includes it. |
| `BUNDLE_DESTINATION`, `BUNDLE_EVERY_HOURS` | Automatic bundles to that destination (not with a passphrase). |
| `BUNDLE_STAGING_DIR` | Where restores put files (default `/var/lib/clickhouse-console/restore-staging`). |

**On Kubernetes**, the worker reads the deployment's configuration from the ConfigMap `web-console-config`, and the
key from the Secret `clickhouse-console-bundle-key`. Create the key with the tools image on a trusted host, keep its copy
out of band, and store it in the Secret; then set the choices in the ConfigMap `backup-worker-bundles`:

```bash
docker run --rm -v "$PWD":/out clickhouse-console-tools:<version> backup-worker bundle-key-init --key-file /out/bundle.key
kubectl -n clickhouse-console create secret generic clickhouse-console-bundle-key --from-file=bundle.key
kubectl -n clickhouse-console create configmap backup-worker-bundles \
  --from-literal=BUNDLE_KEY_PROVIDER=file --from-literal=BUNDLE_DESTINATION=<destination> --from-literal=BUNDLE_EVERY_HOURS=24
kubectl -n clickhouse-console rollout restart deployment/backup-worker
```

For Vault, put `vault-token` in the Secret instead, and `VAULT_ADDR` and `VAULT_TRANSIT_KEY` in the ConfigMap. Staged
restores go to a volume of the pod (`emptyDir`): copy them out with `kubectl cp` before the pod restarts.

**Restoring.** A restore never writes into the server. On the Server state tab, **Compare** decrypts a bundle and
reports, by checksum, which files on the worker host are the same, changed, missing, or not in the bundle; only names
are recorded. **Stage** writes the files into a new directory under `BUNDLE_STAGING_DIR`, readable by their owner only,
with a `RESTORE.txt`. To apply them: stop the server, compare and copy the files you need, restore their owners and
modes, and start the server; for Keeper, put the snapshot into its snapshot directory with Keeper stopped and its newer
snapshots and logs moved aside. Then delete the staging directory: it holds secrets in clear. With a passphrase, run
`backup-worker bundle-restore --bundle <ID> --mode compare|stage` on the worker host instead.

**Testing the key.** Compare the latest bundle with the host regularly, for example after every change of the
configuration: it proves that the master key, the bundle, and the destination all still work.

## 6. Protect the backups

**Administration → Backup & Restore → Overview** checks the backups of the last 7 days against the 3-2-1-1 rule, and
**Destinations** shows what protects each destination:

| Rule | How |
|---|---|
| Two copies | Give each schedule a **Second copy to** destination: after each full backup, the worker makes a new, independent full backup of the same databases there. Retention keeps the same number at each destination. |
| One off-site | Make the second destination an S3 bucket in another place: another region, account, or provider. A disk of the server, and an endpoint on this host, are the same site. |
| One immutable | Enable Object Lock with a default retention on that bucket. Nothing, not even the worker, can then delete a backup before its retention ends: a deletion only adds delete markers, and the console says so. Keep the console retention at least as long as the lock. |
| Encrypted at rest | Enable default encryption on the bucket (SSE-KMS, or SSE-S3); the server then needs no encryption setting. For a disk destination, use an `encrypted` disk. Server bundles are always encrypted by the worker. |
| Least privilege | Give the server a key that can write and read backups but not delete them, and the worker a separate key that can delete. **Destinations → Recommended S3 permissions** has both policies. |

The worker reads the encryption, Object Lock, and versioning of each S3 bucket after every destination test and every
6 hours, with its own key, which needs `s3:GetEncryptionConfiguration`, `s3:GetBucketObjectLockConfiguration`, and
`s3:GetBucketVersioning`. A setting it cannot read is shown as unknown, never as met.

## 7. Recover a whole server

Prepare before you need it, and keep this list with the key of the server bundles:

- the version of the images (`CONSOLE_VERSION`) and of the server;
- the master key of the server bundles (or access to Vault, or the passphrase), stored out of band;
- the credentials of at least one destination, readable without the lost server.

To recover:

1. Start a new server from the same images (step 3 or 4), with an empty data volume.
2. Restore the configuration: on the new host, run the worker with the same key settings, and stage the latest server
   bundle (`backup-worker bundle-restore --bundle <ID> --mode stage`; the bundle IDs are on the Server state tab of any
   console that still sees the destination, or in the destination under `server/`). Copy the staged configuration into
   place, restore owners and modes, and restart the server.
3. Restore Keeper: stop Keeper, move its snapshots and logs aside, put the staged snapshot into its snapshot directory,
   and start it.
4. In the console, set up Backup & Restore if needed, add the destinations again with the same names, and restore the
   latest backup of each database into its own name (rename the suggested target), with the access entities and the
   functions, workloads, and resources.
5. Check: compare the server bundle with the host (**Compare**), and run a restore test of the latest backups.

**Rehearse it.** The recovery rehearsal (`recovery-rehearsal` in the tools image) proves the procedure without
touching production: it starts an isolated server (127.0.0.1, its own ports, data, and Keeper), optionally from a
staged configuration with its storage, Keeper, clusters, and paths replaced, restores the latest backup of each
database from its real destination, compares the row counts and fingerprints recorded when the backups were made, and
records the result with each backup (**Recovery rehearsed** in the inventory) and in the audit log. The isolated server
runs the `clickhouse` binary of the server image. Run it regularly, for example monthly:

```bash
# Docker Compose: reads disk destinations in the server's data volume, and S3 ones with backup-destinations.env.
docker compose -f compose.yaml -f compose.rehearsal.yaml run --rm recovery-rehearsal
# One backup:
docker compose -f compose.yaml -f compose.rehearsal.yaml run --rm recovery-rehearsal \
    recovery-rehearsal --binary /rehearsal-bin/clickhouse --backup <operation ID>

# Kubernetes: the CronJob recovery-rehearsal (suspended; `suspend: false` runs it monthly). S3 destinations only.
kubectl -n clickhouse-console create job --from=cronjob/recovery-rehearsal recovery-rehearsal-now
kubectl -n clickhouse-console logs -f job/recovery-rehearsal-now
```

It runs as the backup worker's account, whose role (the Backup Administrator template) may read the backups and record
the results. Starting from a staged server bundle (`--staged`) needs a bundle that includes `/etc/clickhouse-server`;
the bundles of `compose.bundles.yaml` include only `/deploy/config.d`, so here the rehearsal restores the backups on the
configuration of the server image.

## 8. Directory sign-in (LDAP)

Users are managed in the console with SQL. Optionally, the users of an LDAP directory (OpenLDAP, Active Directory) can
sign in as well, with their directory password: an **LDAP user directory**. They are not created in ClickHouse. Their
roles come from default roles and from their LDAP groups, and they appear on the Users page, read-only, once they have
signed in. The users of `users.xml` and those created with SQL keep working, and the console is the same for both.

1. **Generate the configuration.** On **Identity Providers → LDAP**, select **Configure LDAP…** (or **Add a directory…**)
   and fill in the LDAP server, the bind DN (`uid={user_name},ou=users,dc=example,dc=org`, or
   `{user_name}@corp.example.com` for Active Directory), and the group mapping. The configuration is secure by default:
   LDAPS (or StartTLS), TLS 1.2 or later, the certificate of the LDAP server always checked
   (`tls_require_cert demand`, with your certificate authority in `tls_ca_cert_file`), and a verification cooldown.
2. **Create the roles** the groups stand for: with the prefix `clickhouse-`, the group `clickhouse-analysts` gives the
   role `analysts`, which must exist (Roles & Permissions). Groups without the prefix are ignored.
3. **Install it.** Save the text as a file in `config.d` (with Compose, `config.d/ldap.xml` next to `web-console.xml`,
   mounted like it; on Kubernetes, a key of the ConfigMap), with the CA certificate, and **restart the server**: a new
   user directory is created only when the server starts. Later changes of the LDAP server settings take effect with
   `SYSTEM RELOAD CONFIG`.
4. **Check it** with **Test sign-in…**: it signs in once as a directory user, without storing the password, and shows
   the roles and the directory that accepted the user.

| Setting | Why |
|---|---|
| `verification_cooldown` (300 s) | The server checks a password with the directory on every request unless a check succeeded within this many seconds; the console sends a request for every action, about 80 when signing in. A user disabled in the directory keeps access for at most this long. |
| Precedence | The directories are tried in order: `users.xml`, then the users created with SQL, then LDAP. A local user with the same name as a directory user comes first. |
| Offboarding | Disable the user, or remove them from the groups, in the directory: it takes effect after the cooldown. Directory users cannot be suspended or deleted in the console. |
| Access reviews | ClickHouse cannot list the directory: review group membership in LDAP. The Users page shows directory users that have signed in since the server started. |
| Transport | Passwords travel with every request: serve the console over HTTPS, and never use LDAP without TLS. |

### Attributes from the directory

The rules of **Data Access Policies** can grant roles, filter rows, and require clearances from user attributes. The
access policy worker can read those attributes from the LDAP directory instead of a feed file, so that the directory is
the trusted source of, for example, the department or branch of each user:

1. On **Data Access Policies → Attributes & Classifications**, define each attribute with the source `ldap`, the access
   policy worker's account as its writer, and a freshness limit (for example 86400 s).
2. Give the worker a read-only service account of the directory, and put its password in `ldap/password` (mode 600)
   and the certificate authority of the directory in `ldap/ca.crt`.
3. Set `LDAP_ATTRIBUTES_URL`, `LDAP_ATTRIBUTES_BIND_DN`, `LDAP_ATTRIBUTES_BASE_DN`, `LDAP_ATTRIBUTES_USER` (the LDAP
   attribute that is the ClickHouse user name: `uid`, or `sAMAccountName` for Active Directory), and
   `LDAP_ATTRIBUTES_MAP` (for example `department=departmentNumber,branch=l`) in `.env`, and start the worker with
   `docker compose -f compose.yaml -f compose.ldap-attributes.yaml up -d access-policy-worker`.

   On Kubernetes, put the password and the certificate authority in the Secret `clickhouse-console-ldap`, and the
   settings in the ConfigMap `access-policy-ldap`:

   ```bash
   kubectl -n clickhouse-console create secret generic clickhouse-console-ldap --from-file=password=ldap/password --from-file=ca.crt=ldap/ca.crt
   kubectl -n clickhouse-console create configmap access-policy-ldap --from-literal=ATTRIBUTE_FEED_SOURCE=ldap \
     --from-literal=LDAP_ATTRIBUTES_URL=ldaps://ldap.example.com --from-literal=LDAP_ATTRIBUTES_BIND_DN=<bind DN> \
     --from-literal=LDAP_ATTRIBUTES_BASE_DN=<base DN> --from-literal=LDAP_ATTRIBUTES_USER=uid \
     --from-literal=LDAP_ATTRIBUTES_MAP=department=departmentNumber
   kubectl -n clickhouse-console rollout restart deployment/access-policy-worker
   ```

Each cycle, the worker reads the users of the directory over LDAPS or StartTLS (plain LDAP is refused, and the
certificate of the directory is always checked), with paged results for directories that cap a search. A changed
attribute changes the value; a user who leaves the directory, or loses an attribute, loses the value, and rules on it
close for them. A multi-valued LDAP attribute gives its first value. A search that finds no user while values exist is
refused, not applied, so that a wrong filter or base DN cannot remove every value at once: the values then age and
become untrusted after their freshness limit.

## 9. Single sign-on (Keycloak)

Users can sign in with Keycloak (or another OpenID Connect provider): the console signs them in with the Authorization
Code flow and PKCE, as a public client, and sends the access token to the server as the password. This build of
ClickHouse does not check tokens itself, so the **token authenticator** (`sso-authenticator` in the tools image) does,
as an HTTP authentication server of the server: for the users `IDENTIFIED WITH http SERVER 'sso'`, it checks the
signature with the keys of the provider, the issuer, the client, the audience, the expiry, and that the user name claim
is the user name. Its **user sync** creates those users from the members of the groups `clickhouse-<role>`, grants the
roles, and drops the users who left or were disabled. Passwords and LDAP keep working next to it.

1. **The client of the console in Keycloak**: client authentication off (public), standard flow only, PKCE S256
   (Advanced settings), the valid redirect URI `https://<console>/console/oidc-callback`, the valid post logout redirect
   URI `https://<console>/console/login`, the web origin `https://<console>`. Mappers: Group Membership named `groups`,
   without the full path, and an Audience mapper that adds `clickhouse-console` to the access token. The access tokens
   last 5 minutes by default; the console refreshes them.
2. **The client of the user sync**: a confidential client with only a service account, and the roles `view-users` and
   `query-groups` of `realm-management`. Put its secret in `sso/sync-secret`.
3. **The account `sso_sync`** in ClickHouse: uncomment its section of `service-accounts.sql`, grant it the roles of the
   groups `WITH ADMIN OPTION`, put its password in `.env` (`SSO_SYNC_PASSWORD`), and add
   `--param_sso_pw="$SSO_SYNC_PASSWORD"` to the command of step 2 of "Start with Docker Compose".
4. **The roles** the groups stand for, on the server: the group `clickhouse-analysts` gives the role `analysts`.
5. **Start it** with `.env` (`SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_SYNC_CLIENT_ID`):

   ```bash
   docker compose -f compose.yaml -f compose.sso.yaml up -d
   docker compose -f compose.yaml -f compose.sso.yaml run --rm sso-authenticator sso-authenticator --check-config   # issuer, keys, sync
   ```

   On Kubernetes, set the values in `kubernetes.sso.yaml` (the ConfigMap `web-console-sso`), create the Secret its
   header describes for the user sync, and apply it. `kubernetes.yaml` already gives the server `sso.xml`, which reads
   the ConfigMap; restart the server once:

   ```bash
   kubectl apply -f kubernetes.sso.yaml
   kubectl -n clickhouse-console rollout restart statefulset/clickhouse
   kubectl -n clickhouse-console exec deploy/sso-authenticator -- clickhouse-console-tools sso-authenticator --check-config
   ```

   The sign-in page shows **Sign in with Keycloak**. **Identity Providers → SSO (Keycloak)** tests the provider and a
   sign-in, and lists the users of single sign-on.

| Setting | Why |
|---|---|
| Revocation | A token is accepted until it expires. A user disabled in Keycloak cannot refresh, so the console signs out at the next refresh, and the sync drops the user within its interval: access ends within the token lifespan (5 minutes). |
| Network | Only the server should reach the authenticator (port 29700 on the Compose network, not published; on Kubernetes, a NetworkPolicy of `kubernetes.sso.yaml` allows only the server's pods). It refuses whatever it cannot check, including when the provider's keys are unavailable. |
| Panels | The native panels receive each refreshed token. The SQL Console, the Web Terminal, and ClickStack keep the token they started with: reload them after it expires. |
| Transport | Serve the console and Keycloak over HTTPS: the authenticator accepts plain HTTP only for a provider on localhost. |
| Names | A user created with a password, or another method, is never changed by the sync: give SSO users their own names. |

## Upgrade and rollback

Load the new archives, change `CONSOLE_VERSION` in `.env` (or the image tags), and run `docker compose up -d` with the
same `-f` files as before (or `kubectl apply -f kubernetes.yaml`, and `-f kubernetes.sso.yaml` when you use it). The data stays in the volumes. To roll back, set the previous version again. Rolling back to a server older than the ClickHouse release of the
data is not supported by ClickHouse: keep the release of the base image when you roll back the console.
