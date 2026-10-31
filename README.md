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

The console has no separate backend: every action is a SQL statement run with the credentials of the signed-in user, so ClickHouse authorizes it, and every change is reviewed before it runs and recorded in an audit log. Two optional processes do what a browser cannot: the backup worker and the cluster agent.

### Features

| Feature | What it adds |
|---|---|
| Unified web console | One sign-in, a home page, and a sidebar for the built-in web UIs: SQL Console, Dashboard, ClickStack, Web Terminal, the Binary, Merges, Schema, Jemalloc, and Processors profile visualizers, and the reference documentation. Light and dark themes. |
| Focus mode | An open component gets the whole window; one arrow brings the console navigation back. |
| Unified design | The Dashboard and the diagnostic pages share the design of the SQL Console; the Administration pages follow the design of ClickStack. |
| Users and access management | Users, Roles & Permissions (with role templates), Profiles & Quotas, and Audit Activity, on the native ClickHouse access model, including delegation and `ON CLUSTER` changes. |
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
```

### Documentation and tests

* [`docs/concepts/features/interfaces/web-console.mdx`](docs/concepts/features/interfaces/web-console.mdx): the user and administrator documentation: configuration (the `web_console` section), security model, every page, the backup worker, the cluster agent, runbooks, and limitations.
* [`utils/web-console/README.md`](utils/web-console/README.md): building, running a development instance, testing, and packaging.
* Tests: functional tests `05293_web_console`, `05294_web_console_access_management`, and `05295_web_console_backup`; the integration test `test_web_console`; and browser acceptance checks in `utils/web-console/` (`console_e2e.mjs`, `access_e2e.mjs`, `backup_e2e.mjs`, `cluster_e2e.mjs`).

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
