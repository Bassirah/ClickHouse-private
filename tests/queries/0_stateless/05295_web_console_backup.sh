#!/usr/bin/env bash
# Tags: no-fasttest
# Tag no-fasttest: needs the `backups` disk.

CUR_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../shell_config.sh
. "$CUR_DIR"/../shell_config.sh

# The server behavior that Backup & Restore of the web console (`programs/server/console.html`) and its
# worker (`utils/web-console/backup_worker.mjs`) rely on: the operation ID of `BACKUP ... ASYNC`, the refusal
# of a second backup with the same ID or location (so that a run is never submitted twice), a missing base,
# restores that never write into existing tables, `RESTORE ... AS` rewriting views, opening a backup with
# the `Backup` database engine, and the privilege checks.

DB="${CLICKHOUSE_DATABASE}"
TARGET="${DB}_restored"
INSPECT="${DB}_inspect"
USER="web_console_backup_${DB}"
PASSWORD="Console-Test-Pw-${DB}"
PREFIX="${CLICKHOUSE_TEST_UNIQUE_NAME}"
ID="${CLICKHOUSE_TEST_UNIQUE_NAME}_full"

error_code() {
    # Prints "ok" or the exception code of a failed query.
    local output
    output=$(${CLICKHOUSE_CLIENT} -q "$1" 2>&1 >/dev/null) && { echo ok; return; }
    echo "error $(echo "$output" | grep -oE 'Code: [0-9]+' | head -1 | cut -d' ' -f2)"
}

wait_backup() {
    for _ in {1..600}; do
        status=$(${CLICKHOUSE_CLIENT} -q "SELECT status FROM system.backups WHERE id = '$1'")
        [[ "$status" != "CREATING_BACKUP" && "$status" != "RESTORING" ]] && break
        sleep 0.1
    done
    echo "$status"
}

${CLICKHOUSE_CLIENT} -q "DROP DATABASE IF EXISTS ${TARGET}; DROP DATABASE IF EXISTS ${INSPECT}; DROP USER IF EXISTS ${USER}"
${CLICKHOUSE_CLIENT} -m -q "
CREATE TABLE ${DB}.events (id UInt64, kind String) ENGINE = MergeTree ORDER BY id;
CREATE TABLE ${DB}.totals (kind String, n UInt64) ENGINE = SummingMergeTree ORDER BY kind;
CREATE MATERIALIZED VIEW ${DB}.totals_mv TO ${DB}.totals AS SELECT kind, count() AS n FROM ${DB}.events GROUP BY kind;
INSERT INTO ${DB}.events SELECT number, toString(number % 3) FROM numbers(1000);
"

echo "--- an asynchronous backup is listed under its ID"
${CLICKHOUSE_CLIENT} -q "BACKUP DATABASE ${DB} TO Disk('backups', '${PREFIX}/full') SETTINGS id = '${ID}', async = 1" | cut -f1 | sed "s/${ID}/<id>/"
wait_backup "${ID}"

echo "--- a second backup with the same location or the same ID is refused"
error_code "BACKUP DATABASE ${DB} TO Disk('backups', '${PREFIX}/full') SETTINGS id = '${ID}_again'"
error_code "BACKUP DATABASE ${DB} TO Disk('backups', '${PREFIX}/other') SETTINGS id = '${ID}'"

echo "--- an incremental backup on a missing base is refused"
error_code "BACKUP DATABASE ${DB} TO Disk('backups', '${PREFIX}/incr') SETTINGS base_backup = Disk('backups', '${PREFIX}/missing')"

echo "--- a missing backup cannot be opened"
error_code "CREATE DATABASE ${INSPECT} ENGINE = Backup('${DB}', Disk('backups', '${PREFIX}/missing'))"

echo "--- the Backup engine opens a backup read-only"
${CLICKHOUSE_CLIENT} -q "CREATE DATABASE ${INSPECT} ENGINE = Backup('${DB}', Disk('backups', '${PREFIX}/full'))"
${CLICKHOUSE_CLIENT} -q "SELECT name FROM system.tables WHERE database = '${INSPECT}' AND engine NOT LIKE '%View' ORDER BY name"
${CLICKHOUSE_CLIENT} -q "SELECT count() FROM ${INSPECT}.events"
${CLICKHOUSE_CLIENT} -q "DROP DATABASE ${INSPECT}"

echo "--- restore into a new database: views are rewritten, data matches"
${CLICKHOUSE_CLIENT} -q "RESTORE DATABASE ${DB} AS ${TARGET} FROM Disk('backups', '${PREFIX}/full') SETTINGS create_database = 'create', create_table = 'create'" | cut -f2
${CLICKHOUSE_CLIENT} -q "SELECT position(as_select, '${TARGET}.events') > 0, position(create_table_query, 'TO ${TARGET}.totals') > 0 FROM system.tables WHERE database = '${TARGET}' AND name = 'totals_mv'"
${CLICKHOUSE_CLIENT} -q "SELECT (SELECT count(), groupBitXor(cityHash64(*)) FROM ${DB}.events) = (SELECT count(), groupBitXor(cityHash64(*)) FROM ${TARGET}.events)"

echo "--- restoring over an existing database or table is refused, and nothing is appended"
error_code "RESTORE DATABASE ${DB} AS ${TARGET} FROM Disk('backups', '${PREFIX}/full') SETTINGS create_database = 'create', create_table = 'create'"
error_code "RESTORE TABLE ${DB}.events AS ${TARGET}.events FROM Disk('backups', '${PREFIX}/full') SETTINGS create_table = 'if-not-exists'"
${CLICKHOUSE_CLIENT} -q "SELECT count() FROM ${TARGET}.events"

echo "--- privileges"
${CLICKHOUSE_CLIENT} -q "CREATE USER ${USER} IDENTIFIED BY '${PASSWORD}'; GRANT SELECT ON ${DB}.* TO ${USER}"
user_error_code() {
    local output
    output=$(${CLICKHOUSE_CLIENT} --user "${USER}" --password "${PASSWORD}" -q "$1" 2>&1 >/dev/null) && { echo ok; return; }
    echo "error $(echo "$output" | grep -oE 'Code: [0-9]+' | head -1 | cut -d' ' -f2)"
}
user_error_code "BACKUP DATABASE ${DB} TO Disk('backups', '${PREFIX}/user')"
${CLICKHOUSE_CLIENT} -q "GRANT BACKUP ON ${DB}.* TO ${USER}"
user_error_code "BACKUP DATABASE ${DB} TO Disk('backups', '${PREFIX}/user')"
${CLICKHOUSE_CLIENT} -q "GRANT WRITE ON DISK TO ${USER}"
user_error_code "BACKUP DATABASE ${DB} TO Disk('backups', '${PREFIX}/user')"
user_error_code "RESTORE DATABASE ${DB} AS ${TARGET}_user FROM Disk('backups', '${PREFIX}/user')"

${CLICKHOUSE_CLIENT} -q "DROP DATABASE ${TARGET}; DROP USER ${USER}"
