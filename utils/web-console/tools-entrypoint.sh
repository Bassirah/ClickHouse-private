#!/bin/sh
# Entry point of the tools image of the web console (Dockerfile.tools): runs one helper process, chosen by the first
# argument. Further arguments are passed to it, for example `backup-worker --once`.
set -eu

DIR=/opt/clickhouse-console

case "${1:-help}" in
    backup-worker) shift; exec node "$DIR/backup_worker.mjs" "$@" ;;
    cluster-agent) shift; exec node "$DIR/cluster_agent.mjs" "$@" ;;
    access-policy-worker) shift; exec node "$DIR/access_policy_worker.mjs" "$@" ;;
    version) cat "$DIR/VERSION" ;;
    help)
        echo "Usage: <image> backup-worker | cluster-agent | access-policy-worker [--once]"
        echo "Configuration is in environment variables: CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, and those of each process."
        ;;
    *) echo "Unknown process '$1'. Choose backup-worker, cluster-agent, or access-policy-worker." >&2; exit 2 ;;
esac
