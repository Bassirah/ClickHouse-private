#!/usr/bin/env bash

CUR_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../shell_config.sh
. "$CUR_DIR"/../shell_config.sh

# The server behavior that the administration pages of the web console (`programs/server/console.html`)
# rely on: suspension with `VALID UNTIL`, scoped `CHECK GRANT`, delegation checks, the audit table that
# rejects records in another user's name, and passwords kept out of the query log.

SUFFIX="${CLICKHOUSE_DATABASE}"
SCOPED="web_console_scoped_${SUFFIX}"
TARGET="web_console_app_${SUFFIX}"
OTHER="web_console_other_${SUFFIX}"
ROLE="web_console_role_${SUFFIX}"
PASSWORD="Console-Test-Pw-${SUFFIX}"
URL="${CLICKHOUSE_URL}"

http_as() {
    # Prints the result, "ok" for a statement without a result, or the exception code of a failed request.
    local user=$1 password=$2 query=$3 result
    result=$(${CLICKHOUSE_CURL} -sS -H "X-ClickHouse-User: ${user}" -H "X-ClickHouse-Key: ${password}" "${URL}" --data-binary "${query}" \
        | sed -E 's/^Code: ([0-9]+)\..*/error \1/')
    echo "${result:-ok}"
}

${CLICKHOUSE_CLIENT} -q "DROP USER IF EXISTS ${SCOPED}, ${TARGET}, ${OTHER}; DROP ROLE IF EXISTS ${ROLE}"
${CLICKHOUSE_CLIENT} -q "CREATE USER ${TARGET} IDENTIFIED BY '${PASSWORD}'; CREATE USER ${OTHER} IDENTIFIED BY '${PASSWORD}'"

echo "--- suspension: every authentication method expires on 2000-01-01 UTC"
${CLICKHOUSE_CLIENT} -q "ALTER USER ${TARGET} VALID UNTIL '2000-01-01 00:00:00 UTC'"
${CLICKHOUSE_CLIENT} -q "SELECT arrayMap(t -> toUnixTimestamp(t), valid_until) FROM system.users WHERE name = '${TARGET}'"
http_as "${TARGET}" "${PASSWORD}" "SELECT 'login while suspended'"
${CLICKHOUSE_CLIENT} -q "ALTER USER ${TARGET} VALID UNTIL 'infinity'"
${CLICKHOUSE_CLIENT} -q "SELECT arrayMap(t -> toUnixTimestamp(t), valid_until) FROM system.users WHERE name = '${TARGET}'"
http_as "${TARGET}" "${PASSWORD}" "SELECT 'login after reactivation'"

echo "--- user management scoped by name, checked with CHECK GRANT"
${CLICKHOUSE_CLIENT} -q "CREATE USER ${SCOPED} IDENTIFIED BY '${PASSWORD}'; GRANT ALTER USER ON web_console_app_* TO ${SCOPED}"
http_as "${SCOPED}" "${PASSWORD}" "CHECK GRANT ALTER USER ON ${TARGET}"
http_as "${SCOPED}" "${PASSWORD}" "CHECK GRANT ALTER USER ON ${OTHER}"
http_as "${SCOPED}" "${PASSWORD}" "CHECK GRANT ALTER USER ON *.*"
http_as "${SCOPED}" "${PASSWORD}" "ALTER USER ${TARGET} DEFAULT DATABASE NONE"
http_as "${SCOPED}" "${PASSWORD}" "ALTER USER ${OTHER} DEFAULT DATABASE NONE"

echo "--- delegation: a role WITH ADMIN OPTION, and no privilege without the grant option"
${CLICKHOUSE_CLIENT} -q "CREATE ROLE ${ROLE}; GRANT SELECT ON system.one TO ${ROLE}; GRANT ${ROLE} TO ${SCOPED} WITH ADMIN OPTION"
http_as "${SCOPED}" "${PASSWORD}" "GRANT ${ROLE} TO ${TARGET}"
http_as "${SCOPED}" "${PASSWORD}" "GRANT SELECT ON system.one TO ${TARGET}"
http_as "${SCOPED}" "${PASSWORD}" "GRANT ALTER USER ON *.* TO ${TARGET}"
${CLICKHOUSE_CLIENT} -q "SELECT granted_role_name = '${ROLE}', with_admin_option FROM system.role_grants WHERE user_name = '${TARGET}'"

echo "--- audit table: the server fills in the actor, and rejects other values"
${CLICKHOUSE_CLIENT} -q "
    CREATE TABLE audit_log
    (
        event_time DateTime64(3, 'UTC') MATERIALIZED now64(3),
        actor String MATERIALIZED currentUser(),
        server_host LowCardinality(String) MATERIALIZED hostName(),
        summary String,
        CONSTRAINT actor_is_writer CHECK actor = currentUser(),
        CONSTRAINT host_is_server CHECK server_host = hostName()
    )
    ENGINE = MergeTree ORDER BY event_time"
${CLICKHOUSE_CLIENT} -q "GRANT INSERT, SELECT ON ${CLICKHOUSE_DATABASE}.audit_log TO ${SCOPED}"
http_as "${SCOPED}" "${PASSWORD}" "INSERT INTO ${CLICKHOUSE_DATABASE}.audit_log (summary) FORMAT JSONEachRow {\"summary\": \"written\"}"
http_as "${SCOPED}" "${PASSWORD}" "INSERT INTO ${CLICKHOUSE_DATABASE}.audit_log (actor, summary) SELECT 'default', 'forged'"
${CLICKHOUSE_CURL} -sS -H "X-ClickHouse-User: ${SCOPED}" -H "X-ClickHouse-Key: ${PASSWORD}" "${URL}&insert_allow_materialized_columns=1" \
    --data-binary "INSERT INTO ${CLICKHOUSE_DATABASE}.audit_log (actor, summary) SELECT 'default', 'forged'" | grep -o 'VIOLATED_CONSTRAINT'
${CLICKHOUSE_CLIENT} -q "SELECT actor = '${SCOPED}', server_host = hostName(), summary FROM audit_log"

echo "--- passwords are not in the query log"
${CLICKHOUSE_CURL} -sS "${URL}&log_comment=console-admin:${SUFFIX}" --data-binary "ALTER USER ${OTHER} IDENTIFIED BY 'Secret-${SUFFIX}-42'"
http_as "${OTHER}" "Secret-${SUFFIX}-42" "SELECT 'login with the new password'"
${CLICKHOUSE_CLIENT} -q "SYSTEM FLUSH LOGS query_log"
${CLICKHOUSE_CLIENT} -q "
    SELECT count() > 0, countIf(position(query, 'Secret-${SUFFIX}-42') > 0)
    FROM system.query_log
    WHERE current_database = currentDatabase() AND log_comment = 'console-admin:${SUFFIX}' AND event_date >= yesterday()"

${CLICKHOUSE_CLIENT} -q "DROP USER IF EXISTS ${SCOPED}, ${TARGET}, ${OTHER}; DROP ROLE IF EXISTS ${ROLE}"
