#!/usr/bin/env bash

CUR_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../shell_config.sh
. "$CUR_DIR"/../shell_config.sh

# The Console Guide of the web console: `programs/server/console_guide.json`, built from `docs/products/web-console` by
# `utils/web-console/build_guide.mjs`, and served at `/console/guide.json`.
BASE="${CLICKHOUSE_PORT_HTTP_PROTO}://${CLICKHOUSE_HOST}:${CLICKHOUSE_PORT_HTTP}"

echo "--- the pages of the guide are routes of the console"
for path in /console/guide /console/guide/overview /console/guide/how-to/configure-ldap; do
    BODY=$(${CLICKHOUSE_CURL} -sS -w '\n%{http_code}' "${BASE}${path}")
    echo "${path} $(echo "$BODY" | tail -n1) $(echo "$BODY" | grep -c '<title>ClickHouse Console</title>')"
done

echo "--- the guide is JSON, with the headers of the console"
HEADERS=$(${CLICKHOUSE_CURL} -sS -D - -o /dev/null "${BASE}/console/guide.json" | tr -d '\r')
echo "$HEADERS" | grep -i '^Content-Type:'
echo "$HEADERS" | grep -i '^Cache-Control:'
echo "$HEADERS" | grep -i '^Content-Security-Policy:' | grep -o "frame-ancestors 'none'"

echo "--- every page of the navigation is in the guide, and every link between pages resolves"
${CLICKHOUSE_CURL} -sS "${BASE}/console/guide.json" | python3 -c '
import json, re, sys
guide = json.load(sys.stdin)
print(guide["title"])
print([group["title"] for group in guide["groups"]])
listed = [key for group in guide["groups"] for key in group["pages"]]
print("listed pages exist:", all(key in guide["pages"] for key in listed), len(listed) == len(guide["pages"]))
print("overview:", guide["pages"]["overview"]["title"])
anchors = {key: set(re.findall(r"id=\"([^\"]+)\"", page["html"])) for key, page in guide["pages"].items()}
broken = []
for key, page in guide["pages"].items():
    for target, anchor in re.findall(r"href=\"/console/guide/([a-z0-9/-]+)(?:#([a-z0-9-]+))?\"", page["html"]):
        if target not in guide["pages"] or (anchor and anchor not in anchors[target]):
            broken.append(f"{key} -> {target}#{anchor}")
print("broken links:", broken)
print("scripts:", sum(len(re.findall(r"<script|\son[a-z]+=", page["html"])) for page in guide["pages"].values()))
'
