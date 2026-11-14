#!/usr/bin/env bash

CUR_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../shell_config.sh
. "$CUR_DIR"/../shell_config.sh


# The SQL Console at `/ui` (`contrib/sql-console`) is sent with security headers by default (`SQLConsoleUIRequestHandler`):
# it may be framed by the console of the same origin only, and each file keeps its own `Content-Type`.
BASE="${CLICKHOUSE_PORT_HTTP_PROTO}://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT_HTTP}"

for path in /ui /ui/env.js /ui/monacoeditorwork/editor.worker.bundle.js /ui/console/newQuery; do
    echo "--- ${path}"
    HEADERS=$(${CLICKHOUSE_CURL} -sS -D - -o /dev/null "${BASE}${path}" | tr -d '\r')
    echo "$HEADERS" | grep -i '^Content-Type:' | sed -E 's/^[^:]+: (text\/html|text\/javascript|application\/javascript).*/\1/'
    echo "$HEADERS" | grep -i '^X-Frame-Options:'
    echo "$HEADERS" | grep -i '^X-Content-Type-Options:'
    echo "$HEADERS" | grep -i '^Referrer-Policy:'
    for directive in "default-src 'none'" "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'" "worker-src 'self' blob:" "frame-ancestors 'self'"; do
        echo "$HEADERS" | grep -i '^Content-Security-Policy:' | grep -o -F "$directive"
    done
done
