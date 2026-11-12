<div align=center>

[![Website](https://img.shields.io/website?up_message=AVAILABLE&down_message=DOWN&url=https%3A%2F%2Fclickhouse.com&style=for-the-badge)](https://clickhouse.com)
[![Apache 2.0 License](https://img.shields.io/badge/license-Apache%202.0-blueviolet?style=for-the-badge)](https://www.apache.org/licenses/LICENSE-2.0)

<picture align=center>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/ClickHouse/clickhouse-docs/assets/9611008/4ef9c104-2d3f-4646-b186-507358d2fe28">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/ClickHouse/clickhouse-docs/assets/9611008/b001dc7b-5a45-4dcd-9275-e03beb7f9177">
    <img alt="The ClickHouse company logo." src="https://github.com/ClickHouse/clickhouse-docs/assets/9611008/b001dc7b-5a45-4dcd-9275-e03beb7f9177">
</picture>

<h4>ClickHouse® is an open-source column-oriented database management system that allows generating analytical data reports in real-time.</h4>

</div>

## About this repository

This is a private fork of ClickHouse 26.10 (`v26.10.2.103-stable`, with the fixes of the 26.9 branch that 26.10.2 does not have yet) that adds a **unified web console**, served by the ClickHouse server itself at `/console`. Everything below this section is the upstream README.

The console has no separate backend: every action is a SQL statement run with the credentials of the signed-in user, so ClickHouse authorizes it, and every change is reviewed before it runs and recorded in an audit log. Three optional processes do what a browser cannot: the backup worker, the cluster agent, and the access policy worker.

### Features

| Feature | What it adds |
|---|---|
| Unified web console | One sign-in, a home page, and a sidebar for the built-in web UIs: SQL Console, Dashboard, ClickStack, Web Terminal, the Binary, Merges, Schema, Jemalloc, and Processors profile visualizers, and the reference documentation. Light and dark themes. |
| Focus mode | An open component gets the whole window; one arrow brings the console navigation back. |
| Unified design | The Dashboard and the diagnostic pages share the design of the SQL Console; the Administration pages follow the design of ClickStack. |
| Users and access management | Users, Roles & Permissions (with role templates), Profiles & Quotas, and Audit Activity, on the native ClickHouse access model, including delegation and `ON CLUSTER` changes. |
| Identity Providers: LDAP | Optional: the users of an LDAP directory or Active Directory sign in with their directory password and get roles from their groups, next to the users managed with SQL. The LDAP page generates a secure configuration (LDAPS or StartTLS, certificate checked, verification cooldown), shows each directory and its group mapping, and tests a sign-in. |
| Identity Providers: SSO (Keycloak) | The settings of a Keycloak provider (OpenID Connect), a connection test (discovery, issuer, PKCE, signing keys), and a test sign-in with Authorization Code and PKCE that checks the tokens and shows the user, groups, and mapped roles. **Sign in with Keycloak** on the sign-in page: the token authenticator checks the access tokens for the server, and its user sync creates the users and roles from Keycloak groups. See [`utils/web-console/IDENTITY_PROVIDERS.md`](utils/web-console/IDENTITY_PROVIDERS.md). |
| Data Access Policies | Column permissions and row policies with their combined effect, effective access per user, access tests run as the user, and attribute-driven rules that provision native roles, grants, and row policies, deployed from the console and reconciled by the access policy worker. |
| Component Access | A policy of which components, Resources links, and Administration pages each user or role can open, compared with the native privileges that govern them. A box in the header of each capability (Open, View data, Run queries, Administer) selects or clears it for every component. |
| Backup & Restore | Approved destinations (disks and S3, including external S3 servers allowed in the console), a backup wizard, durable operations, restores into new databases, restore tests, schedules with retention, and recovery verification. A backup can include the access entities, SQL user-defined functions, workloads, and resources, and the console's own tables, and lists what it contains and what it leaves out. |
| Server state | Encrypted server bundles, made by the backup worker, of what `BACKUP` cannot reach: the configuration files, the secrets in them, TLS keys, scripts, and a Keeper snapshot. Each bundle has its own AES-256-GCM key, wrapped by a master key in a key file, in HashiCorp Vault (Transit), or derived from a passphrase. Restores compare a bundle with the host or stage its files; they never write into the server. |
| Backup protection and recovery | The protection of each destination (bucket default encryption, Object Lock, versioning, encrypted disks, off-site), a 3-2-1-1 summary, second copies of scheduled backups at another destination, recommended S3 permissions, and a recovery rehearsal that restores the latest backups, optionally with a staged configuration, on an isolated server and compares them with the values recorded at backup time. |
| Cluster Management | The lifecycle of ClickHouse deployments: create (with an optional chproxy load balancer), register, monitor, configure, scale, upgrade, back up, decommission, and retire. Two providers are implemented: a Docker Compose lab, and Kubernetes with the ClickHouse operator (namespace, storage class, volume reclaim policy, volume sizes, and client Service chosen in the wizard; storage expansion). |
| Docker images | A server image (the official image of the same release with this build's binary) and a tools image (the three helper processes), built from source and packaged as verified archives, with deployment examples for Docker Compose and Kubernetes. |

The home page decides its panels as soon as the component policy and the session's roles arrive, without waiting for every administration check, which keeps it fast over a remote connection.

### Where to find it

All features are merged into `private/main`, the default branch. Each was developed on its own branch, each based on the
previous one. The branches up to `private/console-docker-images` were removed from GitHub after the merge; the last
commit of each is kept as the tag `archive/2026-11-09/<branch>` (`git switch -c <branch> archive/2026-11-09/<branch>`
recreates one).

| Branch | Adds |
|---|---|
| `private/unified-web-console` | The unified web console |
| `private/console-access-management` | Users and access management |
| `private/console-focus-mode` | Focus mode |
| `private/console-ui-unification` | Unified design of the built-in web UIs |
| `private/console-backup-restore` | Backup & Restore |
| `private/console-admin-clickstack-ui` | Administration pages in the ClickStack design |
| `private/console-s3-external-endpoint` | External S3 endpoints for backups |
| `private/console-cluster-management` | Cluster Management |
| `private/console-admin-access` | Administration pages in Component Access |
| `private/console-backup-ddl-check` | Fix of the backup wizard's schema-change check |
| `private/console-cluster-wizard-layout` | Fix of the cluster wizard's layout |
| `private/console-cluster-chproxy` | chproxy as an option of cluster creation |
| `private/console-login-clusters-ui` | Simpler login, Cluster Inventory filters, cluster administrator credentials |
| `private/console-data-access-policies` | Data Access Policies |
| `private/console-cluster-kubernetes` | Kubernetes provider of Cluster Management |
| `private/console-docker-images` | Docker images for distribution, and the script that builds them |
| `upgrade/26.10` | The upgrade to ClickHouse 26.10 (`v26.10.2.103-stable`), and the browser checks made independent of the server state |
| `private/console-access-select-all` | Select-all boxes in Component Access, the faster home page, two fixes found on a new server, and `run_e2e.sh` |
| `private/console-backup-scope` | Backup & Restore: functions, workloads, resources, and the console's tables; server bundles; protection, second copies, and the recovery rehearsal |

`private/main` holds everything above; new work starts from it.

### Quick start

Build the server as usual. The console is embedded in the binary, so changes to its pages need a rebuild:

```bash
mkdir build && cd build && cmake .. && ninja clickhouse
./programs/clickhouse server
```

Then open `http://localhost:8123/console` and sign in as a ClickHouse user. The **Set up** buttons of Component Access, Backup & Restore, and Clusters create the console tables in the `console_admin` database.

For schedules, retention, and backup deletions, run the backup worker; for Cluster Management, run the cluster agent on the Docker host. Both need Node.js 18 or later and no packages:

```bash
CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_USER=<service account> CLICKHOUSE_PASSWORD=<password> \
    node utils/web-console/backup_worker.mjs
CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_USER=<service account> CLICKHOUSE_PASSWORD=<password> \
    CLUSTER_AGENT_STATE_DIR=/var/lib/clickhouse-console/clusters node utils/web-console/cluster_agent.mjs
CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_USER=<service account> CLICKHOUSE_PASSWORD=<password> \
    node utils/web-console/access_policy_worker.mjs
```

For server bundles, give the backup worker a master key: create a key file with
`node utils/web-console/backup_worker.mjs bundle-key-init --key-file <path>` and keep a copy out of band, or use
HashiCorp Vault or a passphrase (`BUNDLE_KEY_PROVIDER`; see "Server bundles" in `utils/web-console/deploy/README.md`).

To distribute the console, `utils/web-console/build_images.sh` builds a Release binary and packages the server and tools
images with their deployment examples.

### Documentation and tests

* [`docs/concepts/features/interfaces/web-console.mdx`](docs/concepts/features/interfaces/web-console.mdx): the user and administrator documentation: configuration (the `web_console` section), security model, every page, the backup worker, the cluster agent, the access policy worker, runbooks, and limitations.
* [`utils/web-console/README.md`](utils/web-console/README.md): building, running a development instance, testing, and packaging.
* [`utils/web-console/deploy/README.md`](utils/web-console/deploy/README.md): deploying the images, server bundles, protecting the backups, recovering a whole server, and directory sign-in (LDAP).
* [`docs/custom_dev/`](docs/custom_dev/): the features and user guide (Word) and the solution overview (PowerPoint).
* Tests: functional tests `05293_web_console`, `05294_web_console_access_management`, and `05295_web_console_backup`; the integration test `test_web_console`; the tests of the server bundles (`server_bundle_test.mjs`); and browser acceptance checks in `utils/web-console/` (`console_e2e.mjs`, `access_e2e.mjs`, `backup_e2e.mjs`, `cluster_e2e.mjs`, `cluster_k8s_e2e.mjs`, `data_access_e2e.mjs`, `ldap_e2e.mjs`, `sso_e2e.mjs`). `utils/web-console/run_e2e.sh` runs the browser checks on a server of their own, with its own MinIO, cluster agent, Vault, OpenLDAP, and Keycloak, so that the results depend only on the code.

## How To Install (Linux, macOS, FreeBSD)

```
curl https://clickhouse.com/ | sh
```
Or skip the install: try [ClickHouse Cloud](https://console.clickhouse.cloud/signUp?utm_medium=referral&utm_source=github) for free and start querying in minutes.

## Useful Links

* [Official website](https://clickhouse.com/) has a quick high-level overview of ClickHouse on the main page.
* [ClickHouse Cloud](https://clickhouse.com/cloud) ClickHouse as a service, built by the creators and maintainers.
* [Tutorial](https://clickhouse.com/docs/getting_started/tutorial/) shows how to set up and query a small ClickHouse cluster.
* [Documentation](https://clickhouse.com/docs/) provides more in-depth information.
* [YouTube channel](https://www.youtube.com/c/ClickHouseDB) has a lot of content about ClickHouse in video format.
* [Slack](https://clickhouse.com/slack) and [Telegram](https://telegram.me/clickhouse_en) allow chatting with ClickHouse users in real-time.
* [Blog](https://clickhouse.com/blog/) contains various ClickHouse-related articles, as well as announcements and reports about events.
* [X](https://x.com/ClickHouseDB) and [LinkedIn](https://www.linkedin.com/company/clickhouseinc/) for short news.
* [Code Browser (github.dev)](https://github.dev/ClickHouse/ClickHouse) with syntax highlighting, powered by github.dev.
* [Contact us](https://clickhouse.com/company/contact) to discuss your use case with a ClickHouse expert.

## Monthly Release & Community Call
The [ClickHouse **26.9** Release Call](https://www.youtube.com/watch?v=wLrTlU5LLWI) took place on September 17, 2026 — watch the recording and the [slides](https://presentations.clickhouse.com/2026-release-26.9/).

The [ClickHouse **26.8** Release Call](https://www.youtube.com/watch?v=5A9gRYE0v2M) took place on August 27, 2026 — watch the recording and the [slides](https://presentations.clickhouse.com/2026-release-26.8/).

The [ClickHouse **26.7** Release Call](https://www.youtube.com/watch?v=mKBNLaFOVDA) took place on July 23, 2026 — watch the recording and the [slides](https://presentations.clickhouse.com/2026-release-26.7/).

The [ClickHouse **26.6** special "10 Year Anniversary" Release Call](https://www.youtube.com/watch?v=-NmqMH9y4EY) — recording and [slides](https://presentations.clickhouse.com/2026-release-26.6/).

Watch all release presentations and videos at [ClickHouse Theater](https://presentations.clickhouse.com/) and [YouTube Playlist](https://www.youtube.com/playlist?list=PL0Z2YDlm0b3jAlSy1JxyP8zluvXaN3nxU).

## Upcoming Events

Keep an eye out for upcoming meetups and events around the world.
Want to speak? Apply [here](https://forms.gle/3h4XCEENJZ3eaVGy7)
You can also peruse [ClickHouse Events](https://clickhouse.com/company/news-events) for a list of all upcoming trainings, meetups, speaking engagements, etc.

Upcoming meetups
* [AI Builders and Databases Tel Aviv](https://luma.com/clickh-satv) - October 12th, 2026
* [Hands-on training: Agent Observability with Langfuse in New York](https://luma.com/piww2zyw) - October 15th, 2026
* [Hands-on training: Agent Observability with Langfuse in Menlo Park](https://luma.com/clickh-3qe8) - October 19th, 2026
* [AI Builders and Databases London](https://luma.com/clickh-ykgp) - October 21st, 2026
* [AI Builders and Databases Dubai](https://luma.com/clickh-vtzf) - October 22nd, 2026
* [AI Builders Night New York @ Modal](https://luma.com/clickh-qu9s) - November 3rd, 2026
* [LibreChat Meetup New York](https://luma.com/clickh-3qx0) - November 5th, 2026
* [Observability with ClickStack Fundamentals Kubecon Training](https://luma.com/clickh-migc) - November 9th, 2026
* [San Francisco Data Engineering Meetup with ClickHouse](https://luma.com/clickh-z0ty) - November 17th, 2026
* [Toronto Data Engineering Meetup with ClickHouse](https://luma.com/clickh-4120) - November 18th, 2026



Recent meetups
* [Open House London](https://luma.com/ggnwajnd) - September 30th, 2026
* [Grok Bot Montreal Build Day](https://luma.com/ggnwajnd) - October 3rd, 2026
* [Open House Munich](https://luma.com/6xorx3qw) - October 6th, 2026
* [SF Tech Week AI Night](https://luma.com/clickh-zngw) - October 6th, 2026
* [AI Builders and Databases Stockholm](https://luma.com/clickh-ku2p) - October 8th, 2026
* [Mountain View Meetup](https://luma.com/clickh-5ms6) - October 8th, 2026


## Recent Recordings

* **Recent Meetup Videos**: [Meetup Playlist](https://www.youtube.com/playlist?list=PL0Z2YDlm0b3iNDUzpY1S3L_iV4nARda_U) Whenever possible recordings of the ClickHouse Community Meetups are edited and presented as individual talks. 

## Interested in joining ClickHouse and making it your full-time job?

ClickHouse is a nice DBMS, and it's a good place to work.

Check out our **current openings** here: https://clickhouse.com/company/careers

Email: careers@clickhouse.com!
