# Deploying the ClickHouse web console

This directory is shipped with the image archives made by `utils/web-console/package_images.sh`. It deploys the
ClickHouse server with the web console, and its helper processes, in an environment: on one Docker host with
`compose.yaml`, or on Kubernetes with `kubernetes.yaml`.

| Image | Contents |
|---|---|
| `clickhouse-server-console:<version>` | The official `clickhouse/clickhouse-server` image of the same release, with the server binary of this build, which serves the console at `/console`. Every setting and environment variable of the official image applies. |
| `clickhouse-console-tools:<version>` | Node.js with the backup worker, the cluster agent (with the `docker` CLI, Compose, and `kubectl`), and the access policy worker. The first argument chooses the process: `backup-worker`, `cluster-agent`, or `access-policy-worker`. |

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

`kubernetes.yaml` runs the server as a StatefulSet with a 20 GiB volume, the two workers, and the cluster agent with
the kubernetes provider (it manages clusters with the ClickHouse operator in the same Kubernetes cluster, through a
service account limited to what it uses). Follow the steps at the top of the file: make the images available to the
nodes, create the Secret, and apply. Then open the console through the Service:

```bash
kubectl -n clickhouse-console port-forward svc/clickhouse 8123:8123     # http://localhost:8123/console
```

and continue with steps 1 and 2 of the previous section, with `kubectl -n clickhouse-console exec -i clickhouse-0 --`
in place of `docker compose exec -T clickhouse`. For access from outside the cluster, put an Ingress with TLS in front
of the Service: the console sends passwords in HTTP headers.

## Upgrade and rollback

Load the new archives, change `CONSOLE_VERSION` in `.env` (or the image tags), and run `docker compose up -d` (or
`kubectl apply`). The data stays in the volumes. To roll back, set the previous version again. Rolling back to a server older than the ClickHouse release of the
data is not supported by ClickHouse: keep the release of the base image when you roll back the console.
