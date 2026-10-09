#!/usr/bin/env bash

CUR_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../shell_config.sh
. "$CUR_DIR"/../shell_config.sh

# The unified web console at `/console` (`programs/server/console.html`).
BASE="${CLICKHOUSE_PORT_HTTP_PROTO}://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT_HTTP}"

echo "--- every path under /console serves the page (client-side routing)"
for path in /console /console/ /console/login /console/sql /console/merges '/console/login?next=merges' /console/unknown; do
    BODY=$(${CLICKHOUSE_CURL} -sS -w '\n%{http_code}' "${BASE}${path}")
    echo "${path} $(echo "$BODY" | tail -n1) $(echo "$BODY" | grep -c '<title>ClickHouse Console</title>')"
done
${CLICKHOUSE_CURL} -sS -I -o /dev/null -w "HEAD %{http_code}\n" "${BASE}/console"

echo "--- sibling paths are not taken over"
${CLICKHOUSE_CURL} -sS -o /dev/null -w "/consolex %{http_code}\n" "${BASE}/consolex"

echo "--- the page is not cached, not framed by other sites, and loads nothing external"
HEADERS=$(${CLICKHOUSE_CURL} -sS -D - -o /dev/null "${BASE}/console/home" | tr -d '\r')
echo "$HEADERS" | grep -i '^Cache-Control:'
echo "$HEADERS" | grep -i '^X-Frame-Options:'
echo "$HEADERS" | grep -i '^X-Content-Type-Options:'
echo "$HEADERS" | grep -i '^Referrer-Policy:'
echo "$HEADERS" | grep -i '^Content-Security-Policy:' | grep -o "frame-ancestors 'none'"
echo "$HEADERS" | grep -i '^Content-Security-Policy:' | grep -o "script-src 'unsafe-inline';"
${CLICKHOUSE_CURL} -sS "${BASE}/console" | grep -cE '(src|href)="https?://'

echo "--- destinations come from the server configuration, with defaults"
${CLICKHOUSE_CURL} -sS -D - -o /dev/null "${BASE}/console/config.json" | tr -d '\r' | grep -i '^Content-Type:'
${CLICKHOUSE_CURL} -sS "${BASE}/console/config.json" | python3 -c '
import json, sys
config = json.load(sys.stdin)
for key in sorted(config):
    print(key, config[key])
'

echo "--- the embedded pages implement the integration contract of the console"
for path in /dashboard /binary /merges /schema /jemalloc /processors-profile /docs; do
    echo "${path} $(${CLICKHOUSE_CURL} -sS "${BASE}${path}" | grep -c 'window.parent.clickhouseConsole')"
done
