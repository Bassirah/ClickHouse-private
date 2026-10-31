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

This is a private fork of ClickHouse 26.9 (upstream commit `b7bbb4e80c8`) that adds a **unified web console**, served by the ClickHouse server itself at `/console`. Everything below this section is the upstream README.

The console has no separate backend: every action is a SQL statement run with the credentials of the signed-in user, so ClickHouse authorizes it, and every change is reviewed before it runs and recorded in an audit log. Three optional processes do what a browser cannot: the backup worker, the cluster agent, and the access policy worker.

### Features

| Feature | What it adds |
|---|---|
| Unified web console | One sign-in, a home page, and a sidebar for the built-in web UIs: SQL Console, Dashboard, ClickStack, Web Terminal, the Binary, Merges, Schema, Jemalloc, and Processors profile visualizers, and the reference documentation. Light and dark themes. |
| Focus mode | An open component gets the whole window; one arrow brings the console navigation back. |
| Unified design | The Dashboard and the diagnostic pages share the design of the SQL Console; the Administration pages follow the design of ClickStack. |
| Users and access management | Users, Roles & Permissions (with role templates), Profiles & Quotas, and Audit Activity, on the native ClickHouse access model, including delegation and `ON CLUSTER` changes. |
| Data Access Policies | Column permissions and row policies with their combined effect, effective access per user, access tests run as the user, and attribute-driven rules that provision native roles, grants, and row policies, deployed from the console and reconciled by the access policy worker. |
| Component Access | A policy of which components, Resources links, and Administration pages each user or role can open, compared with the native privileges that govern them. |
| Backup & Restore | Approved destinations (disks and S3, including external S3 servers allowed in the console), a backup wizard, durable operations, restores into new databases, restore tests, schedules with retention, and recovery verification. |
| Cluster Management | The lifecycle of ClickHouse deployments: create (with an optional chproxy load balancer), register, monitor, configure, scale, upgrade, back up, decommission, and retire. One provider is implemented: a Docker Compose lab. |

### Where to find it

Each feature was developed on its own branch, each based on the previous one. The newest branch contains all of them:

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

`private/main` is the unchanged upstream base.

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

### Documentation and tests

* [`docs/concepts/features/interfaces/web-console.mdx`](docs/concepts/features/interfaces/web-console.mdx): the user and administrator documentation: configuration (the `web_console` section), security model, every page, the backup worker, the cluster agent, the access policy worker, runbooks, and limitations.
* [`utils/web-console/README.md`](utils/web-console/README.md): building, running a development instance, testing, and packaging.
* Tests: functional tests `05293_web_console`, `05294_web_console_access_management`, and `05295_web_console_backup`; the integration test `test_web_console`; and browser acceptance checks in `utils/web-console/` (`console_e2e.mjs`, `access_e2e.mjs`, `backup_e2e.mjs`, `cluster_e2e.mjs`, `data_access_e2e.mjs`).

## How To Install (Linux, macOS, FreeBSD)

```
curl https://clickhouse.com/ | sh
```

## Useful Links

* [Official website](https://clickhouse.com/) has a quick high-level overview of ClickHouse on the main page.
* [ClickHouse Cloud](https://clickhouse.com/cloud) ClickHouse as a service, built by the creators and maintainers.
* [Tutorial](https://clickhouse.com/docs/getting_started/tutorial/) shows how to set up and query a small ClickHouse cluster.
* [Documentation](https://clickhouse.com/docs/) provides more in-depth information.
* [YouTube channel](https://www.youtube.com/c/ClickHouseDB) has a lot of content about ClickHouse in video format.
* [ClickHouse Theater](https://presentations.clickhouse.com/) contains presentations and videos about ClickHouse.
* [Slack](https://clickhouse.com/slack) and [Telegram](https://telegram.me/clickhouse_en) allow chatting with ClickHouse users in real-time.
* [Blog](https://clickhouse.com/blog/) contains various ClickHouse-related articles, as well as announcements and reports about events.
* [Bluesky](https://bsky.app/profile/clickhouse.com) and [X](https://x.com/ClickHouseDB) for short news.
* [Code Browser (github.dev)](https://github.dev/ClickHouse/ClickHouse) with syntax highlighting, powered by github.dev.
* [Contacts](https://clickhouse.com/company/contact) can help to get your questions answered if there are any.

## Monthly Release & Community Call
The [ClickHouse **26.8** Release Call](https://www.youtube.com/watch?v=5A9gRYE0v2M) took place on August 27, 2026 — watch the recording and the [slides](https://presentations.clickhouse.com/2026-release-26.8/).

The [ClickHouse **26.7** Release Call](https://www.youtube.com/watch?v=mKBNLaFOVDA) took place on July 23, 2026 — watch the recording and the [slides](https://presentations.clickhouse.com/2026-release-26.7/).

The [ClickHouse **26.6** special "10 Year Anniversary" Release Call](https://www.youtube.com/watch?v=-NmqMH9y4EY) — recording and [slides](https://presentations.clickhouse.com/2026-release-26.6/).

Watch all release presentations and videos at [ClickHouse Theater](https://presentations.clickhouse.com/) and [YouTube Playlist](https://www.youtube.com/playlist?list=PL0Z2YDlm0b3jAlSy1JxyP8zluvXaN3nxU).

## Upcoming Events

Keep an eye out for upcoming meetups and events around the world.
Want to speak? Apply [here](https://forms.gle/3h4XCEENJZ3eaVGy7)
You can also peruse [ClickHouse Events](https://clickhouse.com/company/news-events) for a list of all upcoming trainings, meetups, speaking engagements, etc.

Upcoming meetups
* [Boston Hands-on training: Building agents with ClickHouse and LibreChat Boston](https://luma.com/clickh-nw1d) - September 14th, 2026
* [Amsterdam Meetup](https://luma.com/clickh-vu1p) - September 15th, 2026
* [Cape Town Meetup](https://luma.com/clickh-dw1v) - September 15th, 2026
* [DET New York](https://luma.com/xf3wghdh) - September 17th, 2026
* [The Agentic Data Stack: Paris](https://luma.com/clickh-s2a1) - September 17th, 2026
* [The Agentic Data Stack: Zurich](https://luma.com/clickh-oo1l) - September 17th, 2026
* [Rows And Columns Summit](https://luma.com/event/evt-bQcR6tDKi8OmTXu) - September 22nd, 2026
* [PyData Seattle Meetup](https://luma.com/clickh-ttgg) - September 24th, 2026
* [Mountain view Meetup](https://luma.com/clickh-5ms6) - September 24th, 2026
* [Chicago Meetup](https://luma.com/clickh-8tnc) - September 28th, 2026
* [Paris Meetup](https://luma.com/clickh-gsz1) - September 29th, 2026
* [Open House London](https://luma.com/ggnwajnd) - September 30th, 2026
* [Open House Munich](https://luma.com/6xorx3qw) - October 6th, 2026
* [AI Builders and Databases Stockholm](https://luma.com/clickh-ku2p) - October 8th, 2026


Recent meetups
* [Bangalore Iceberg Community Meetup](https://luma.com/clickh-t3iz) - August 22nd, 2026
* [Vancouver Meetup](https://luma.com/jr8tc94e) - August 25th, 2026
* [Boston Trivia](https://luma.com/clickh-thmi) - August 31st, 2026
* [Bangkok Meetup](https://luma.com/clickh-ct1j) - September 1st, 2026
* [Agentic Data Stack: Berlin](https://luma.com/clickh-2ccj) - September 2nd, 2026


## Recent Recordings

* **Recent Meetup Videos**: [Meetup Playlist](https://www.youtube.com/playlist?list=PL0Z2YDlm0b3iNDUzpY1S3L_iV4nARda_U) Whenever possible recordings of the ClickHouse Community Meetups are edited and presented as individual talks. 

## Interested in joining ClickHouse and making it your full-time job?

ClickHouse is a nice DBMS, and it's a good place to work.

Check out our **current openings** here: https://clickhouse.com/company/careers

Email: careers@clickhouse.com!
