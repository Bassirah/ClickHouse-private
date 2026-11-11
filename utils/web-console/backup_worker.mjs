#!/usr/bin/env node
/// Backup worker of the web console (`/console`, Administration → Backup & Restore).
///
/// The console submits backups and restores to the server, which runs them (`BACKUP ... ASYNC`). What a
/// browser cannot do is done by this worker, a long-running process next to the server:
/// - runs the schedules of `backup_schedules`;
/// - reconciles unfinished operations (after a browser closed, or the server restarted);
/// - applies retention, and executes deletions requested in the console (SQL cannot delete a backup);
/// - checks listing and deleting at destinations, and removes the artifacts of destination tests;
/// - runs restore tests of scheduled backups that ask for them;
/// - calls a webhook when a scheduled operation fails.
///
/// It needs Node.js 18 or later and no packages. Configuration (environment variables):
///   CLICKHOUSE_URL        HTTP interface of the server (default http://127.0.0.1:8123)
///   CLICKHOUSE_USER       service account (see "Backup worker" in the documentation for its privileges)
///   CLICKHOUSE_PASSWORD   its password
///   ADMIN_DATABASE        database of the console tables (default console_admin)
///   WORKER_ID             name in the heartbeat (default: host name and process ID)
///   INTERVAL_SECONDS      time between cycles (default 30)
///   <REF>_ACCESS_KEY_ID, <REF>_SECRET_ACCESS_KEY, <REF>_REGION
///                         S3 credentials of a destination whose credential reference is <REF>
///   <NOTIFY_REF>          webhook URL of a schedule whose failure notification is <NOTIFY_REF>
///
/// Server bundles (see server_bundle.mjs): the configuration, secrets, and Keeper state that BACKUP cannot reach.
///   BUNDLE_KEY_PROVIDER   file, vault, or passphrase (unset: no bundles)
///   BUNDLE_KEY_FILE       file provider: the master key, made with `bundle-key-init`, readable by its owner only
///   VAULT_ADDR, VAULT_TOKEN or VAULT_TOKEN_FILE, VAULT_TRANSIT_KEY, VAULT_TRANSIT_MOUNT (default transit), VAULT_NAMESPACE
///                         vault provider: the Transit key that wraps the data keys
///   BUNDLE_PATHS          files and directories to include, comma-separated (default /etc/clickhouse-server)
///   BUNDLE_KEEPER, BUNDLE_KEEPER_SNAPSHOTS
///                         host:port of Keeper and its snapshot directory, to include a new snapshot (`csnp`)
///   BUNDLE_STAGING_DIR    where restores stage files (default /var/lib/clickhouse-console/restore-staging)
///   BUNDLE_COMPARE_ROOT   the root the paths of a bundle are compared under (default /)
///   BUNDLE_DESTINATION, BUNDLE_EVERY_HOURS
///                         make a bundle to this destination every so many hours (not with a passphrase)
/// Arguments: --once runs one cycle and exits. Commands, for a person on the worker host:
///   bundle-key-init --key-file <path>      create a master key file
///   bundle --destination <name>            make a server bundle now
///   bundle-restore --bundle <id> --mode compare|stage
///                                          compare a bundle with this host, or stage its files
///
/// Several workers can run at the same time: a scheduled run has a deterministic operation ID and
/// artifact path, and the server refuses a second backup with the same ID or location.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collectFiles, createKeyFile, fileKeyProvider, keeperSnapshot, passphraseKeyProvider, readBundle, stagedPath, vaultKeyProvider, writeBundle} from './server_bundle.mjs';

const URL_BASE = (process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const USER = process.env.CLICKHOUSE_USER || 'default';
const PASSWORD = process.env.CLICKHOUSE_PASSWORD || '';
const DB = process.env.ADMIN_DATABASE || 'console_admin';
const WORKER_ID = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
const INTERVAL = Number(process.env.INTERVAL_SECONDS || 30) * 1000;
const ONCE = process.argv.includes('--once');

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(DB)) throw new Error(`Invalid ADMIN_DATABASE: ${DB}`);

function log(message, fields = {}) {
    console.log(JSON.stringify({time: new Date().toISOString(), worker: WORKER_ID, message, ...fields}));
}

// ---------------------------------------------------------------------------------------------
// ClickHouse

class QueryError extends Error {
    constructor(text, code) {
        super(text);
        this.code = code;
    }
}

/// Runs a query; `params` are bound by the server. Returns the parsed JSON rows, or the text with `raw`.
async function query(sql, {params = {}, raw = false, settings = {}, timeout = 120000} = {}) {
    const url = new URL(`${URL_BASE}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, v);
    for (const [k, v] of Object.entries(settings)) url.searchParams.set(k, v);
    const response = await fetch(url, {method: 'POST', body: raw ? sql : `${sql}\nFORMAT JSON`,
        headers: {'X-ClickHouse-User': USER, 'X-ClickHouse-Key': PASSWORD}, signal: AbortSignal.timeout(timeout)});
    const text = await response.text();
    if (!response.ok) {
        const code = Number(response.headers.get('X-ClickHouse-Exception-Code') || (text.match(/Code: (\d+)/) || [])[1] || 0);
        throw new QueryError(maskSecrets(text.trim().split('\n')[0].slice(0, 500)), code);
    }
    return raw ? text : (text ? JSON.parse(text).data : []);
}

const q = name => '`' + name.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
const s = value => "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const arrayParam = values => '[' + values.map(s).join(',') + ']';

function maskSecrets(text) {
    return String(text || '').replace(/\b(BY|HASH|SALT|PASSWORD|secret_access_key|access_key_id)(\s*=?\s*)'(?:[^'\\]|\\.)*'/gi, "$1$2'[HIDDEN]'");
}

function parseJSON(text, fallback) {
    try {
        return text ? JSON.parse(text) : fallback;
    } catch (e) {
        return fallback;
    }
}

async function recordEvent(op_id, event) {
    const row = {op_id, kind: event.kind || 'state', state: event.state, name: event.name || '', native_id: event.native_id || '', query_id: event.query_id || '',
        error: maskSecrets(event.error || ''), num_files: event.num_files || 0, total_size: event.total_size || 0, details: JSON.stringify(event.details || {})};
    await query(`INSERT INTO ${q(DB)}.backup_events (op_id, kind, state, name, native_id, query_id, error, num_files, total_size, details) FORMAT JSONEachRow\n${JSON.stringify(row)}`, {raw: true});
}

async function recordOperation(op) {
    const row = {op_id: op.op_id, kind: op.kind, server: op.server || os.hostname(), destination_id: op.destination_id || '', artifact: op.artifact || '',
        scope: JSON.stringify(op.scope || {}), strategy: op.strategy || '', base_op_id: op.base_op_id || '', schedule_id: op.schedule_id || '',
        scheduled_for: op.scheduled_for || null, target: JSON.stringify(op.target || {}), parameters: JSON.stringify(op.parameters || {}), expected: ''};
    await query(`INSERT INTO ${q(DB)}.backup_operations (op_id, kind, server, destination_id, artifact, scope, strategy, base_op_id, schedule_id, scheduled_for, target, parameters, expected) FORMAT JSONEachRow\n${JSON.stringify(row)}`, {raw: true});
}

async function audit(action, target_name, summary, result, error, correlation_id, details = {}) {
    const row = {correlation_id, scope: 'local', target_type: 'backup', target_name, action, summary, result, error: maskSecrets(error || ''),
        details: JSON.stringify({worker: WORKER_ID, ...details})};
    await query(`INSERT INTO ${q(DB)}.audit_log (correlation_id, scope, target_type, target_name, action, summary, result, error, details) FORMAT JSONEachRow\n${JSON.stringify(row)}`, {raw: true})
        .catch(e => log('audit record not written', {error: e.message}));
}

// ---------------------------------------------------------------------------------------------
// State (the same model as the console)

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'deleted'];
const NATIVE = {CREATING_BACKUP: 'running', RESTORING: 'running', BACKUP_CREATED: 'succeeded', RESTORED: 'succeeded',
    BACKUP_FAILED: 'failed', RESTORE_FAILED: 'failed', BACKUP_CANCELLED: 'cancelled', RESTORE_CANCELLED: 'cancelled'};

async function loadState() {
    /// Tables set up before second copies have no copy_destination_id: their schedules have none.
    const has_copy = (await query(`SELECT count() AS n FROM system.columns WHERE database = {db:String} AND table = 'backup_schedules' AND name = 'copy_destination_id'`,
        {params: {db: DB}}))[0].n > 0;
    const [destinations, schedules, operations] = await Promise.all([
        query(`SELECT id, name, toString(type) AS type, disk, named_collection, endpoint, bucket, prefix, credential_ref, allow_http, enabled, allowed_databases, test_result,
            if(tested_at IS NULL, '', toString(tested_at)) AS tested_at, description
            FROM ${q(DB)}.backup_destinations FINAL WHERE NOT deleted`),
        query(`SELECT id, name, enabled, destination_id, databases, tables, structure_only, toString(strategy) AS strategy, full_every, toString(frequency) AS frequency,
            minute, hour, weekday, timezone, keep_chains, toString(on_missing_base) AS on_missing_base, verify, notify_ref,
            ${has_copy ? 'copy_destination_id' : "'' AS copy_destination_id"} FROM ${q(DB)}.backup_schedules FINAL WHERE NOT deleted`),
        query(`SELECT op_id, toString(kind) AS kind, toUnixTimestamp64Milli(requested_at) AS requested_ms, requested_by, destination_id, artifact, scope, strategy, base_op_id,
            schedule_id, target, parameters FROM ${q(DB)}.backup_operations ORDER BY requested_at LIMIT 1 BY op_id`),
    ]);
    const events = operations.length ? await query(`SELECT op_id, toUnixTimestamp64Milli(at) AS at_ms, toString(kind) AS kind, toString(state) AS state, name, native_id, error, details
        FROM ${q(DB)}.backup_events WHERE op_id IN {ops:Array(String)} ORDER BY at`, {params: {ops: arrayParam(operations.map(o => o.op_id))}}) : [];
    const ops = new Map(operations.map(o => [o.op_id, {...o, requested_ms: Number(o.requested_ms), scope: parseJSON(o.scope, {}), target: parseJSON(o.target, {}),
        parameters: parseJSON(o.parameters, {}), state: 'queued', checks: [], deleted: false}]));
    for (const e of events) {
        const op = ops.get(e.op_id);
        if (!op) continue;
        if (e.kind === 'state') {
            op.state = e.state;
            op.state_ms = Number(e.at_ms);
            op.result = parseJSON(e.details, {});
            if (e.state === 'deleted') op.deleted = true;
        } else {
            op.checks.push({...e, details: parseJSON(e.details, {})});
        }
    }
    return {destinations, destinations_by_id: new Map(destinations.map(d => [d.id, d])), schedules, operations: [...ops.values()]};
}

function scopeDatabases(scope) {
    return [...new Set([...(scope.databases || []), ...(scope.tables || []).map(([db]) => db)])];
}

function location(destination, artifact) {
    if (destination.type === 'disk') return `Disk(${s(destination.disk)}, ${s(destination.prefix ? `${destination.prefix}/${artifact}` : artifact)})`;
    return `S3(${q(destination.named_collection)}, ${s(artifact)})`;
}

function backupChain(state, op) {
    const ops = new Map(state.operations.map(o => [o.op_id, o]));
    const chain = [op];
    let current = op;
    while (current.base_op_id) {
        const base = ops.get(current.base_op_id);
        if (!base) return {chain, missing: `the base ${current.base_op_id} has no record`};
        if (base.deleted) return {chain, missing: `the base ${base.op_id} was deleted`};
        if (base.state !== 'succeeded') return {chain, missing: `the base ${base.op_id} did not succeed`};
        chain.push(base);
        if (chain.length > 1000) return {chain, missing: 'the chain has a cycle'};
        current = base;
    }
    return {chain, missing: null};
}

function descendants(state, op) {
    const result = [];
    const queue = [op.op_id];
    while (queue.length) {
        const id = queue.shift();
        for (const child of state.operations.filter(o => o.kind === 'backup' && o.base_op_id === id && !o.deleted && o.state !== 'failed')) {
            result.push(child);
            queue.push(child.op_id);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------------------------
// Reconciliation

async function probeArtifact(destination, op) {
    for (const source_db of scopeDatabases(op.scope)) {
        const name = `console_inspect_w${crypto.randomBytes(5).toString('hex')}`;
        try {
            /// Fail in seconds when S3 is unreachable: backups retry S3 requests for about an hour by default.
            await query(`CREATE DATABASE ${q(name)} ENGINE = Backup(${s(source_db)}, ${location(destination, op.artifact)})`,
                {raw: true, settings: destination.type === 's3' ? {backup_restore_s3_retry_attempts: 2} : {}});
        } catch (e) {
            /// After a timeout, the server may still create the database.
            if (e.name === 'TimeoutError') await query(`DROP DATABASE IF EXISTS ${q(name)} SYNC`, {raw: true});
            return {ok: false, not_found: e.code === 599 || /not found/i.test(e.message), error: e.message};
        }
        await query(`DROP DATABASE IF EXISTS ${q(name)}`, {raw: true});
    }
    return {ok: true};
}

async function reconcile(state) {
    for (const op of state.operations.filter(o => !TERMINAL.includes(o.state) && ['backup', 'restore', 'verify'].includes(o.kind))) {
        let row = (await query(`SELECT toString(status) AS status, error, query_id, num_files, total_size,
                dateDiff('millisecond', start_time, if(end_time > start_time, end_time, now64(6))) / 1000 AS duration_s FROM system.backups WHERE id = {id:String}`,
            {params: {id: op.op_id}}))[0];
        let source = 'system.backups';
        if (!row) {
            row = (await query(`SELECT toString(status) AS status, error, query_id, num_files, total_size,
                    dateDiff('millisecond', start_time, if(end_time > start_time, end_time, start_time)) / 1000 AS duration_s
                FROM system.backup_log WHERE id = {id:String} ORDER BY event_time_microseconds DESC LIMIT 1`, {params: {id: op.op_id}}))[0];
            source = 'system.backup_log';
            /// Logged as started but not listed by the server: the server stopped before it finished.
            if (row && NATIVE[row.status] === 'running') row = undefined;
        }
        let event = null;
        if (row) {
            const state_now = NATIVE[row.status] || 'unknown';
            if (state_now !== op.state && !(state_now === 'running' && op.state === 'running')) {
                event = {state: state_now, native_id: op.op_id, query_id: row.query_id, error: row.error ? row.error.split('\n')[0] : '', num_files: Number(row.num_files),
                    total_size: Number(row.total_size), details: {source, duration_s: Number(row.duration_s), native_status: row.status}};
            }
        } else if (Date.now() - op.requested_ms > 60000) {
            if (op.kind === 'backup' && state.destinations_by_id.get(op.destination_id)) {
                const probe = await probeArtifact(state.destinations_by_id.get(op.destination_id), op);
                if (probe.ok) event = {state: 'succeeded', native_id: op.op_id, details: {source: 'artifact', note: 'No server record; the backup opens.'}};
                else if (probe.not_found) {
                    event = {state: 'failed', native_id: op.op_id, details: {source: 'artifact'},
                        error: 'The operation is not running, has no log record, and no complete backup exists at its location: it was interrupted, most likely by a server restart.'};
                } else if (op.state !== 'unknown') event = {state: 'unknown', native_id: op.op_id, error: `The state cannot be determined: ${probe.error}`, details: {source: 'artifact'}};
            } else if (op.state !== 'unknown') {
                event = {state: 'unknown', native_id: op.op_id, error: 'The server has no record of this operation (it may have restarted).', details: {source: 'none'}};
            }
        }
        if (!event) continue;
        await recordEvent(op.op_id, event);
        op.state = event.state;
        op.error = event.error;
        log('reconciled', {op: op.op_id, state: event.state, source: event.details.source});
        if (TERMINAL.includes(event.state) || event.state === 'unknown') {
            await audit(`${op.kind}_${event.state}`, op.op_id, `${op.kind} ${op.op_id} ${event.state}`, event.state === 'succeeded' ? 'success' : 'failure', event.error, op.op_id);
            if (op.schedule_id && event.state !== 'succeeded') await notify(state, op, event);
        }
    }
}

async function notify(state, op, event) {
    const schedule = state.schedules.find(sch => sch.id === op.schedule_id);
    if (!schedule || !schedule.notify_ref) return;
    const url = process.env[schedule.notify_ref];
    if (!url) {
        log('notification not sent: the environment variable is not set', {variable: schedule.notify_ref});
        return;
    }
    const body = {schedule: schedule.name, operation: op.op_id, kind: op.kind, state: event.state, error: maskSecrets(event.error || ''), worker: WORKER_ID};
    try {
        const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)});
        log('notification sent', {schedule: schedule.name, status: response.status});
    } catch (e) {
        log('notification failed', {schedule: schedule.name, error: e.message});
    }
}

// ---------------------------------------------------------------------------------------------
// Schedules

const formatters = new Map();

function zonedParts(ms, timezone) {
    if (!formatters.has(timezone)) {
        formatters.set(timezone, new Intl.DateTimeFormat('en-US', {timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', weekday: 'short'}));
    }
    const p = Object.fromEntries(formatters.get(timezone).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return {date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)};
}

/// The runs of a schedule in (from, to], as `{key, at}`. The same function is in `console.html`: for each
/// local day (hour), the run is the first minute at or after the scheduled local time.
export function scheduleRuns(schedule, from_ms, to_ms) {
    const runs = [];
    const seen = new Set();
    for (let t = Math.floor(from_ms / 60000) * 60000 + 60000; t <= to_ms; t += 60000) {
        const p = zonedParts(t, schedule.timezone);
        let key = null;
        if (schedule.frequency === 'hourly') {
            if (p.minute >= schedule.minute) key = `${p.date}T${String(p.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
        } else if (schedule.frequency === 'daily' || (schedule.frequency === 'weekly' && p.weekday === Number(schedule.weekday))) {
            if (p.hour * 60 + p.minute >= schedule.hour * 60 + schedule.minute) key = `${p.date}T${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
        }
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const prev = zonedParts(t - 60000, schedule.timezone);
        const reached = schedule.frequency === 'hourly'
            ? prev.date === p.date && prev.hour === p.hour && prev.minute >= schedule.minute
            : prev.date === p.date && prev.hour * 60 + prev.minute >= schedule.hour * 60 + schedule.minute;
        if (reached) continue;
        runs.push({key, at: t});
    }
    return runs;
}

const PERIOD = {hourly: 3600000, daily: 86400000, weekly: 7 * 86400000};

/// The run that is due now: the latest run of the last period (older missed runs are not made up).
function dueRun(schedule, now) {
    const runs = scheduleRuns(schedule, now - PERIOD[schedule.frequency], now);
    return runs.length ? runs[runs.length - 1] : null;
}

function scheduledOpId(schedule, run) {
    return `sched-${schedule.id.replace(/-/g, '').slice(0, 12)}-${run.key.replace(/[-:]/g, '').replace('T', '-')}`;
}

async function fingerprints(scope) {
    const dbs = scopeDatabases(scope);
    const tables = await query(`SELECT database, name, engine FROM system.tables WHERE database IN {dbs:Array(String)} AND match(engine, 'MergeTree|Log$|^Memory$')`,
        {params: {dbs: arrayParam(dbs)}});
    const result = {};
    for (const t of tables) {
        if ((scope.tables || []).length && !scope.tables.some(([db, name]) => db === t.database && name === t.name)) continue;
        const r = (await query(`SELECT count() AS n, toString(groupBitXor(cityHash64(*))) AS fp FROM ${q(t.database)}.${q(t.name)}`))[0];
        const columns = await query('SELECT name, type FROM system.columns WHERE database = {db:String} AND table = {t:String} ORDER BY position', {params: {db: t.database, t: t.name}});
        result[`${t.database}.${t.name}`] = {rows: Number(r.n), fingerprint: r.fp, columns: columns.map(c => `${c.name} ${c.type}`)};
    }
    return result;
}

async function runSchedules(state, now) {
    for (const schedule of state.schedules.filter(sch => sch.enabled)) {
        const run = dueRun(schedule, now);
        if (!run) continue;
        const op_id = scheduledOpId(schedule, run);
        if (state.operations.some(o => o.op_id === op_id)) continue;
        const destination = state.destinations_by_id.get(schedule.destination_id);
        const scope = {databases: schedule.databases, tables: schedule.tables.map(t => t.split('.')), structure_only: schedule.structure_only};
        const busy = state.operations.find(o => !TERMINAL.includes(o.state) && o.state !== 'unknown' && ['backup', 'restore', 'verify'].includes(o.kind)
            && (o.schedule_id === schedule.id || o.destination_id === schedule.destination_id || scopeDatabases(o.scope).some(db => scopeDatabases(scope).includes(db))));
        if (busy) {
            log('run postponed: an operation on the same schedule, destination, or databases is running', {schedule: schedule.name, run: run.key, running: busy.op_id});
            continue;
        }
        const op = {op_id, kind: 'backup', destination_id: schedule.destination_id, scope, schedule_id: schedule.id, scheduled_for: new Date(run.at).toISOString().replace('T', ' ').replace('Z', ''),
            artifact: `schedules/${schedule.id}/${run.key.replace(/:/g, '')}`, strategy: 'full', base_op_id: '', parameters: {worker: WORKER_ID, run: run.key, timezone: schedule.timezone}};
        if (!destination || !destination.enabled) {
            await recordOperation(op);
            await recordEvent(op_id, {state: 'failed', error: destination ? 'The destination is disabled.' : 'The destination no longer exists.'});
            await notify(state, op, {state: 'failed', error: 'destination unavailable'});
            continue;
        }
        if (schedule.strategy === 'incremental') {
            const backups = state.operations.filter(o => o.kind === 'backup' && o.schedule_id === schedule.id && o.destination_id === schedule.destination_id
                && o.state === 'succeeded' && !o.deleted)
                .sort((a, b) => b.requested_ms - a.requested_ms);
            const last_full = backups.findIndex(o => o.strategy !== 'incremental');
            if (backups.length && last_full >= 0 && last_full + 1 < schedule.full_every) {
                const base = backups[0];
                const {missing} = backupChain(state, base);
                const probe = missing ? {ok: false, error: missing} : await probeArtifact(destination, base);
                if (probe.ok) {
                    op.strategy = 'incremental';
                    op.base_op_id = base.op_id;
                } else if (schedule.on_missing_base === 'fail') {
                    await recordOperation(op);
                    const error = `The base backup ${base.op_id} is not available (${probe.error}), and the schedule fails in that case. Make a full backup, or let the schedule make one.`;
                    await recordEvent(op_id, {state: 'failed', error});
                    await audit('backup_failed', op_id, `Scheduled backup of ${schedule.name}: base missing`, 'failure', error, op_id);
                    await notify(state, op, {state: 'failed', error});
                    continue;
                } else {
                    op.parameters.note = `The base backup ${base.op_id} is not available (${probe.error}): a full backup is made instead.`;
                }
            }
        }
        const before = schedule.verify && !scope.structure_only ? await fingerprints(scope) : null;
        op.parameters.server_version = (await query('SELECT version() AS v'))[0].v;
        op.parameters.objects = await query(`SELECT database, name, engine FROM system.tables WHERE database IN {dbs:Array(String)}`, {params: {dbs: arrayParam(scopeDatabases(scope))}});
        await recordOperation(op);
        const items = [...scope.databases.map(db => `DATABASE ${q(db)}`), ...scope.tables.map(([db, t]) => `TABLE ${q(db)}.${q(t)}`)];
        const settings = [`id = ${s(op_id)}`, 'async = 1'];
        if (scope.structure_only) settings.push('structure_only = 1');
        if (op.base_op_id) {
            const base = state.operations.find(o => o.op_id === op.base_op_id);
            settings.push(`base_backup = ${location(destination, base.artifact)}`);
        }
        try {
            await query(`BACKUP ${items.join(', ')} TO ${location(destination, op.artifact)} SETTINGS ${settings.join(', ')}`, {raw: true, settings: {log_comment: `console-admin:${op_id}`}});
        } catch (e) {
            if (e.code === 598 || (e.code === 36 && /same ID/.test(e.message))) {
                /// Another worker submitted this run first: the server refused the duplicate.
                log('duplicate submission refused by the server', {schedule: schedule.name, run: run.key});
                continue;
            }
            const uncertain = !e.code;
            await recordEvent(op_id, {state: uncertain ? 'unknown' : 'failed', native_id: op_id, error: e.message});
            await audit('submit_backup', op_id, `Scheduled backup of ${schedule.name}`, 'failure', e.message, op_id);
            await notify(state, op, {state: 'failed', error: e.message});
            continue;
        }
        await recordEvent(op_id, {state: 'running', native_id: op_id, details: {submitted_by: WORKER_ID}});
        await audit('submit_backup', op_id, `Scheduled backup of ${schedule.name} (${op.strategy})`, 'success', '', op_id, {schedule: schedule.name, run: run.key});
        log('scheduled backup submitted', {schedule: schedule.name, run: run.key, op: op_id, strategy: op.strategy});
        if (before) {
            pending_fingerprints.set(op_id, {before, scope});
        }
        state.operations.push({...op, requested_ms: Date.now(), state: 'running', checks: [], deleted: false});
    }
}

/// Fingerprints taken before scheduled backups that will be tested, compared after they finish.
const pending_fingerprints = new Map();

// ---------------------------------------------------------------------------------------------
// Restore tests

async function verify(state, backup) {
    const destination = state.destinations_by_id.get(backup.destination_id);
    const mapping = Object.fromEntries(scopeDatabases(backup.scope).map(db => [db, `console_verify_${backup.op_id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}_${db}`.slice(0, 60)]));
    const op = {op_id: crypto.randomUUID(), kind: 'verify', destination_id: backup.destination_id, artifact: backup.artifact, scope: {...backup.scope, access_entities: false},
        base_op_id: backup.op_id, target: mapping, parameters: {worker: WORKER_ID, target_version: (await query('SELECT version() AS v'))[0].v}};
    await recordOperation(op);
    const items = [...(backup.scope.databases || []).map(db => `DATABASE ${q(db)} AS ${q(mapping[db])}`),
        ...(backup.scope.tables || []).map(([db, t]) => `TABLE ${q(db)}.${q(t)} AS ${q(mapping[db])}.${q(t)}`)];
    const started = Date.now();
    const checks = [];
    let state_now = 'failed';
    let error = '';
    try {
        for (const db of new Set((backup.scope.tables || []).map(([db]) => mapping[db]))) await query(`CREATE DATABASE ${q(db)}`, {raw: true});
        await query(`RESTORE ${items.join(', ')} FROM ${location(destination, backup.artifact)} SETTINGS id = ${s(op.op_id)}, restore_access_entities = 0`,
            {raw: true, timeout: 6 * 3600 * 1000, settings: {log_comment: `console-admin:${op.op_id}`}});
        state_now = 'succeeded';
        const expected_check = [...backup.checks].reverse().find(c => c.name === 'expected_values');
        const expected = expected_check && expected_check.details.stable ? expected_check.details.tables : null;
        const restored_scope = {tables: [], databases: []};
        for (const [source_db, target_db] of Object.entries(mapping)) restored_scope.databases.push(target_db);
        const restored = await fingerprints(restored_scope);
        for (const [key, value] of Object.entries(restored)) {
            const [target_db, table] = key.split('.');
            const source_db = Object.keys(mapping).find(db => mapping[db] === target_db);
            const source_key = `${source_db}.${table}`;
            if (expected && expected[source_key]) {
                const e = expected[source_key];
                checks.push({name: `${source_key}: schema`, state: JSON.stringify(e.columns) === JSON.stringify(value.columns) ? 'passed' : 'failed'});
                checks.push({name: `${source_key}: row count`, state: e.rows === value.rows ? 'passed' : 'failed', details: {expected: e.rows, restored: value.rows}});
                checks.push({name: `${source_key}: content fingerprint`, state: e.fingerprint === value.fingerprint ? 'passed' : 'failed', details: {expected: e.fingerprint, restored: value.fingerprint}});
            } else {
                checks.push({name: `${source_key}: row count`, state: 'passed', details: {restored: value.rows, note: 'No stable source values were captured.'}});
            }
        }
        for (const view of (backup.parameters.objects || []).filter(o => /View/.test(o.engine))) {
            const exists = await query('SELECT engine FROM system.tables WHERE database = {db:String} AND name = {t:String}', {params: {db: mapping[view.database], t: view.name}});
            checks.push({name: `${view.database}.${view.name}: ${view.engine}`, state: exists.length ? 'passed' : 'failed'});
        }
    } catch (e) {
        error = e.message;
    }
    const duration_s = (Date.now() - started) / 1000;
    await recordEvent(op.op_id, {state: state_now, native_id: op.op_id, error, details: {duration_s, source: 'worker'}});
    for (const check of checks) await recordEvent(op.op_id, {kind: 'check', state: check.state, name: check.name, details: check.details || {}});
    const cleanup = [];
    for (const db of Object.values(mapping)) await query(`DROP DATABASE IF EXISTS ${q(db)} SYNC`, {raw: true}).catch(e => cleanup.push(`${db}: ${e.message}`));
    await recordEvent(op.op_id, {kind: 'check', state: cleanup.length ? 'failed' : 'passed', name: 'cleanup', error: cleanup.join('; '), details: {dropped: Object.values(mapping)}});
    const failed = state_now !== 'succeeded' || checks.some(c => c.state === 'failed');
    await audit('restore_test_result', backup.op_id, `Restore test of ${backup.op_id}: ${failed ? 'failed' : 'passed'}`, failed ? 'failure' : 'success', error, op.op_id);
    log('restore test finished', {backup: backup.op_id, failed, duration_s});
    if (failed) await notify(state, backup, {state: 'failed', error: error || 'restore test checks failed'});
}

async function afterBackups(state) {
    for (const [op_id, captured] of pending_fingerprints) {
        const op = state.operations.find(o => o.op_id === op_id);
        if (!op || !TERMINAL.includes(op.state)) continue;
        pending_fingerprints.delete(op_id);
        if (op.state !== 'succeeded') continue;
        const after = await fingerprints(captured.scope);
        const stable = JSON.stringify(after) === JSON.stringify(captured.before);
        await recordEvent(op_id, {kind: 'check', state: stable ? 'passed' : 'unknown', name: 'expected_values', details: {stable, tables: stable ? captured.before : {}}});
        op.checks.push({name: 'expected_values', details: {stable, tables: stable ? captured.before : {}}});
    }
    for (const op of state.operations.filter(o => o.kind === 'backup' && o.state === 'succeeded' && !o.deleted && o.schedule_id)) {
        const schedule = state.schedules.find(sch => sch.id === op.schedule_id);
        if (!schedule || !schedule.verify || pending_fingerprints.has(op.op_id)) continue;
        if (state.operations.some(o => o.kind === 'verify' && o.base_op_id === op.op_id)) continue;
        if (Date.now() - op.requested_ms > 2 * PERIOD[schedule.frequency]) continue;
        await verify(state, op);
    }
}

// ---------------------------------------------------------------------------------------------
// Retention and deletion

/// The backups of `schedule` at `destination_id` that its retention deletes: the first destination and the second copies
/// are retained separately, each keeping `keep_chains`.
export function retentionDeletions(state, schedule, destination_id = schedule.destination_id) {
    const backups = state.operations.filter(o => o.kind === 'backup' && o.schedule_id === schedule.id && o.destination_id === destination_id && o.state === 'succeeded' && !o.deleted)
        .sort((a, b) => b.requested_ms - a.requested_ms);
    const fulls = backups.filter(o => o.strategy !== 'incremental');
    const kept = new Set(fulls.slice(0, schedule.keep_chains).map(o => o.op_id));
    const keep = new Set(backups.filter(o => kept.has(backupChain(state, o).chain.at(-1).op_id)).map(o => o.op_id));
    /// Delete from the newest descendants towards the bases: never a base before its incremental backups.
    return backups.filter(o => !keep.has(o.op_id) && !descendants(state, o).some(d => keep.has(d.op_id))).sort((a, b) => b.requested_ms - a.requested_ms);
}

async function applyRetention(state) {
    for (const schedule of state.schedules.filter(sch => sch.enabled)) {
        const deletions = [schedule.destination_id, schedule.copy_destination_id].filter(Boolean).flatMap(id => retentionDeletions(state, schedule, id));
        for (const backup of deletions) {
            if (state.operations.some(o => o.kind === 'delete' && o.base_op_id === backup.op_id)) continue;
            const op = {op_id: `ret-${backup.op_id}`.slice(0, 64), kind: 'delete', destination_id: backup.destination_id, artifact: backup.artifact, scope: backup.scope,
                base_op_id: backup.op_id, schedule_id: schedule.id, parameters: {reason: `retention of ${schedule.name}: keep ${schedule.keep_chains}`}};
            await recordOperation(op);
            await recordEvent(op.op_id, {state: 'queued'});
            state.operations.push({...op, requested_ms: Date.now(), state: 'queued', checks: []});
            log('retention deletion queued', {schedule: schedule.name, backup: backup.op_id});
        }
    }
}

/// The files of an artifact are deleted only under `<disk path>/<prefix>/<artifact>` (disk) or
/// `<bucket>/<prefix>/<artifact>/` (S3).
async function deleteArtifact(destination, artifact) {
    if (!/^[A-Za-z0-9._\/-]+$/.test(artifact) || artifact.split('/').some(x => !x || x === '..' || x === '.')) throw new Error(`Refusing an unexpected artifact path: ${artifact}`);
    if (destination.type === 'disk') {
        const disk = (await query('SELECT path FROM system.disks WHERE name = {d:String}', {params: {d: destination.disk}}))[0];
        if (!disk) throw new Error(`No disk ${destination.disk} on the server.`);
        const root = path.resolve(disk.path, destination.prefix || '.');
        const target = path.resolve(root, artifact);
        if (!target.startsWith(root + path.sep)) throw new Error('The artifact path leaves the destination prefix.');
        if (!fs.existsSync(path.dirname(root))) throw new Error(`This worker has no access to ${disk.path}: run it on the server host.`);
        if (!fs.existsSync(target)) return {deleted: 0, note: 'nothing to delete'};
        let count = 0;
        const walk = dir => {
            for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
                if (entry.isDirectory()) walk(path.join(dir, entry.name));
                else count++;
            }
        };
        walk(target);
        fs.rmSync(target, {recursive: true, force: false});
        return {deleted: count};
    }
    const creds = s3Credentials(destination);
    const prefix = `${destination.prefix}/${artifact}/`;
    let deleted = 0;
    const failures = [];
    let token = null;
    do {
        const list = await s3Request(destination, creds, 'GET', '', {'list-type': '2', prefix, ...(token ? {'continuation-token': token} : {})});
        const keys = [...list.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => decodeXml(m[1]));
        token = (list.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || null;
        for (const key of keys) {
            if (!key.startsWith(prefix)) continue;
            try {
                await s3Request(destination, creds, 'DELETE', key, {});
                deleted++;
            } catch (e) {
                failures.push(`${key}: ${e.message}`);
            }
        }
    } while (token);
    if (failures.length) {
        const error = new Error(`Deleted ${deleted} objects, ${failures.length} failed (object lock or retention can prevent deletion): ${failures.slice(0, 3).join('; ')}`);
        error.partial = {deleted, failed: failures.length};
        throw error;
    }
    return {deleted};
}

function decodeXml(text) {
    return text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function s3Credentials(destination) {
    const ref = destination.credential_ref;
    if (!ref) throw new Error('The destination has no worker credential reference: the worker cannot list or delete there.');
    const id = process.env[`${ref}_ACCESS_KEY_ID`];
    const secret = process.env[`${ref}_SECRET_ACCESS_KEY`];
    if (!id || !secret) throw new Error(`The environment variables ${ref}_ACCESS_KEY_ID and ${ref}_SECRET_ACCESS_KEY are not set for the worker.`);
    return {id, secret, region: process.env[`${ref}_REGION`] || 'us-east-1'};
}

/// An S3 request signed with AWS Signature Version 4, path-style (`<endpoint>/<bucket>/<key>`).
export async function s3Request(destination, creds, method, key, params) {
    const endpoint = new URL(destination.endpoint);
    const canonical_uri = `/${destination.bucket}${key ? '/' + key.split('/').map(encodeRFC3986).join('/') : '/'}`;
    const query_string = Object.keys(params).sort().map(k => `${encodeRFC3986(k)}=${encodeRFC3986(params[k])}`).join('&');
    const now = new Date();
    const amz_date = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const date = amz_date.slice(0, 8);
    const payload_hash = crypto.createHash('sha256').update('').digest('hex');
    const headers = {host: endpoint.host, 'x-amz-content-sha256': payload_hash, 'x-amz-date': amz_date};
    const signed_headers = Object.keys(headers).sort().join(';');
    const canonical_headers = Object.keys(headers).sort().map(h => `${h}:${headers[h]}\n`).join('');
    const canonical = [method, canonical_uri, query_string, canonical_headers, signed_headers, payload_hash].join('\n');
    const scope = `${date}/${creds.region}/s3/aws4_request`;
    const to_sign = ['AWS4-HMAC-SHA256', amz_date, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
    const hmac = (k, v) => crypto.createHmac('sha256', k).update(v).digest();
    const signing_key = hmac(hmac(hmac(hmac(`AWS4${creds.secret}`, date), creds.region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', signing_key).update(to_sign).digest('hex');
    const url = `${endpoint.origin}${canonical_uri}${query_string ? '?' + query_string : ''}`;
    const response = await fetch(url, {method, headers: {...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${creds.id}/${scope}, SignedHeaders=${signed_headers}, Signature=${signature}`},
        signal: AbortSignal.timeout(60000)});
    const text = await response.text();
    if (!response.ok) throw new Error(`S3 ${method} ${response.status}: ${(text.match(/<Code>([^<]+)<\/Code>/) || [])[1] || text.slice(0, 120)}`);
    return text;
}

function encodeRFC3986(value) {
    return encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

async function processDeletions(state) {
    for (const op of state.operations.filter(o => ['delete', 'test'].includes(o.kind) && o.state === 'queued')) {
        const destination = state.destinations_by_id.get(op.destination_id);
        if (!destination) {
            await recordEvent(op.op_id, {state: 'failed', error: 'The destination no longer exists.'});
            continue;
        }
        if (op.kind === 'delete') {
            const backup = state.operations.find(o => o.op_id === op.base_op_id);
            const blocking = backup ? descendants(state, backup) : [];
            const in_use = state.operations.find(o => ['restore', 'verify', 'bundle_restore'].includes(o.kind) && o.base_op_id === op.base_op_id && !TERMINAL.includes(o.state));
            if (blocking.length || in_use) {
                const error = blocking.length ? `Refused: required as the base of ${blocking.map(b => b.op_id).join(', ')}.` : `Refused: in use by ${in_use.op_id}.`;
                await recordEvent(op.op_id, {state: 'failed', error});
                await audit('delete_backup', op.base_op_id, `Deletion of ${op.base_op_id} refused`, 'failure', error, op.op_id);
                continue;
            }
        }
        await recordEvent(op.op_id, {state: 'running', details: {worker: WORKER_ID}});
        try {
            const result = await deleteArtifact(destination, op.artifact);
            /// On a bucket that keeps versions (always with Object Lock), a deletion without a version only adds delete
            /// markers: the backup disappears from listings, but its data stays until the bucket's retention ends.
            const reported = parseJSON(destination.test_result, {}).protection;
            if (destination.type === 's3' && reported && (reported.versioning.state === 'on' || reported.object_lock.state === 'on')) {
                result.note = 'The bucket keeps versions: delete markers hide the objects, and their data stays until the bucket\'s retention ends.';
            }
            await recordEvent(op.op_id, {state: 'succeeded', details: result});
            if (op.kind === 'delete') {
                await recordEvent(op.base_op_id, {state: 'deleted', details: {deletion: op.op_id, ...result}});
                await audit('delete_backup', op.base_op_id, `Deleted backup ${op.base_op_id}`, 'success', '', op.op_id, result);
            } else {
                await recordDestinationCapabilities(destination, {list: {ok: true}, delete: {ok: true}, ...(destination.type === 's3' ? {protection: await destinationProtection(destination)} : {})});
            }
            log('artifact deleted', {op: op.op_id, artifact: op.artifact, ...result});
        } catch (e) {
            /// A partial deletion is a failure of the operation: the files that remain are listed in the error.
            await recordEvent(op.op_id, {state: 'failed', error: e.message, details: e.partial || {}});
            if (op.kind === 'delete') await audit('delete_backup', op.base_op_id, `Deletion of ${op.base_op_id} failed`, e.partial ? 'partial' : 'failure', e.message, op.op_id);
            else await recordDestinationCapabilities(destination, {delete: {ok: false, error: e.message}});
            log('deletion failed', {op: op.op_id, error: e.message});
        }
    }
}

/// Adds `results` to the test result of a destination. The row is read again right before the write, so that a
/// change made in the console since this cycle started (enabling, disabling, editing) is not overwritten.
async function recordDestinationCapabilities(destination, results) {
    const current = (await query(`SELECT id, name, toString(type) AS type, disk, named_collection, endpoint, bucket, prefix, credential_ref, allow_http, enabled,
            allowed_databases, test_result, if(tested_at IS NULL, '', toString(tested_at)) AS tested_at, description, deleted
        FROM ${q(DB)}.backup_destinations FINAL WHERE id = {id:String}`, {params: {id: destination.id}}))[0];
    if (!current || current.deleted) return;
    const merged = {...parseJSON(current.test_result, {}), ...results};
    const row = {...current, test_result: JSON.stringify(merged), tested_at: current.tested_at || null, deleted: false};
    await query(`INSERT INTO ${q(DB)}.backup_destinations (id, name, description, type, disk, named_collection, endpoint, bucket, prefix, credential_ref, allow_http, enabled, allowed_databases, test_result, tested_at, deleted) FORMAT JSONEachRow\n${JSON.stringify(row)}`, {raw: true});
}

// ---------------------------------------------------------------------------------------------
// Protection of destinations, and second copies

/// What protects the backups at an S3 destination, as the bucket reports it to the worker's credentials: its default
/// encryption, its Object Lock configuration, and versioning. A setting the bucket does not report is `unknown`, with
/// the reason, never assumed.
export async function destinationProtection(destination) {
    const result = {checked_at: new Date().toISOString().replace('T', ' ').slice(0, 19)};
    let creds;
    try {
        creds = s3Credentials(destination);
    } catch (e) {
        return {...result, encryption: {state: 'unknown', error: e.message}, object_lock: {state: 'unknown', error: e.message}, versioning: {state: 'unknown', error: e.message}};
    }
    const ask = async parameter => {
        try {
            return {xml: await s3Request(destination, creds, 'GET', '', {[parameter]: ''})};
        } catch (e) {
            return {error: e.message, missing: /\b404\b|NotFound|NoSuch/.test(e.message)};
        }
    };
    const tag = (xml, name) => (xml.match(new RegExp(`<${name}>([^<]*)</${name}>`)) || [])[1] || '';
    const [encryption, lock, versioning] = await Promise.all([ask('encryption'), ask('object-lock'), ask('versioning')]);
    result.encryption = encryption.xml ? {state: 'on', algorithm: tag(encryption.xml, 'SSEAlgorithm'), kms_key: tag(encryption.xml, 'KMSMasterKeyID')}
        : encryption.missing ? {state: 'off'} : {state: 'unknown', error: encryption.error};
    if (lock.xml && tag(lock.xml, 'ObjectLockEnabled') === 'Enabled') {
        const days = Number(tag(lock.xml, 'Days')) || Number(tag(lock.xml, 'Years')) * 365 || 0;
        result.object_lock = days ? {state: 'on', mode: tag(lock.xml, 'Mode'), days} : {state: 'no default retention'};
    } else {
        result.object_lock = lock.xml || lock.missing ? {state: 'off'} : {state: 'unknown', error: lock.error};
    }
    const status = versioning.xml ? tag(versioning.xml, 'Status') : '';
    result.versioning = versioning.xml ? {state: status === 'Enabled' ? 'on' : status === 'Suspended' ? 'suspended' : 'off'} : {state: 'unknown', error: versioning.error};
    return result;
}

/// Checks the protection of each enabled S3 destination every 6 hours, so that a change of the bucket shows.
async function checkProtection(state) {
    for (const destination of state.destinations.filter(d => d.enabled && d.type === 's3')) {
        const previous = parseJSON(destination.test_result, {}).protection;
        if (previous && Date.now() - Date.parse(`${previous.checked_at}Z`) < 6 * 3600000) continue;
        await recordDestinationCapabilities(destination, {protection: await destinationProtection(destination)});
    }
}

/// Second copies of the scheduled backups that have a second destination (3-2-1: two copies, one of them elsewhere).
/// A copy is a new full backup of the same scope, made after the backup at the first destination succeeded; it is not
/// a copy of its files, so damage at one destination cannot reach the other. Copies are made of full backups only: for
/// an incremental schedule, one per chain.
async function copyBackups(state) {
    for (const schedule of state.schedules.filter(sch => sch.enabled && sch.copy_destination_id)) {
        const latest = state.operations.filter(o => o.kind === 'backup' && o.schedule_id === schedule.id && o.destination_id === schedule.destination_id
            && o.strategy !== 'incremental' && o.state === 'succeeded' && !o.deleted).sort((a, b) => b.requested_ms - a.requested_ms)[0];
        if (!latest || Date.now() - latest.requested_ms > 2 * PERIOD[schedule.frequency] * Math.max(1, schedule.strategy === 'incremental' ? schedule.full_every : 1)) continue;
        const op_id = periodOpId(`copy:${latest.op_id}`);
        if (state.operations.some(o => o.op_id === op_id)) continue;
        const destination = state.destinations_by_id.get(schedule.copy_destination_id);
        const scope = latest.scope;
        const op = {op_id, kind: 'backup', destination_id: schedule.copy_destination_id, scope, schedule_id: schedule.id, strategy: 'full', base_op_id: '',
            artifact: `schedules/${schedule.id}/copies/${(latest.parameters.run || latest.op_id).replace(/:/g, '')}`,
            parameters: {worker: WORKER_ID, copy_of: latest.op_id, run: latest.parameters.run, timezone: schedule.timezone}};
        if (!destination || !destination.enabled) {
            await recordOperation(op);
            await recordEvent(op_id, {state: 'failed', error: destination ? 'The second destination is disabled.' : 'The second destination no longer exists.'});
            await notify(state, op, {state: 'failed', error: 'second destination unavailable'});
            continue;
        }
        const busy = state.operations.find(o => !TERMINAL.includes(o.state) && o.state !== 'unknown' && ['backup', 'restore', 'verify'].includes(o.kind)
            && (o.destination_id === destination.id || scopeDatabases(o.scope).some(db => scopeDatabases(scope).includes(db))));
        if (busy) continue;
        op.parameters.server_version = (await query('SELECT version() AS v'))[0].v;
        op.parameters.objects = await query(`SELECT database, name, engine FROM system.tables WHERE database IN {dbs:Array(String)}`, {params: {dbs: arrayParam(scopeDatabases(scope))}});
        await recordOperation(op);
        const items = [...(scope.databases || []).map(db => `DATABASE ${q(db)}`), ...(scope.tables || []).map(([db, t]) => `TABLE ${q(db)}.${q(t)}`)];
        const settings = [`id = ${s(op_id)}`, 'async = 1', ...(scope.structure_only ? ['structure_only = 1'] : [])];
        try {
            await query(`BACKUP ${items.join(', ')} TO ${location(destination, op.artifact)} SETTINGS ${settings.join(', ')}`, {raw: true, settings: {log_comment: `console-admin:${op_id}`}});
        } catch (e) {
            if (e.code === 598 || (e.code === 36 && /same ID/.test(e.message))) continue;
            await recordEvent(op_id, {state: e.code ? 'failed' : 'unknown', native_id: op_id, error: e.message});
            await audit('submit_backup', op_id, `Second copy of ${latest.op_id} (${schedule.name})`, 'failure', e.message, op_id);
            await notify(state, op, {state: 'failed', error: e.message});
            continue;
        }
        await recordEvent(op_id, {state: 'running', native_id: op_id, details: {submitted_by: WORKER_ID}});
        await audit('submit_backup', op_id, `Second copy of ${latest.op_id} to ${destination.name} (${schedule.name})`, 'success', '', op_id, {copy_of: latest.op_id});
        log('second copy submitted', {schedule: schedule.name, of: latest.op_id, op: op_id});
        state.operations.push({...op, requested_ms: Date.now(), state: 'running', checks: [], deleted: false});
    }
}

// ---------------------------------------------------------------------------------------------
// Server bundles: the state of the server that BACKUP cannot reach (see server_bundle.mjs).
//
// A bundle is encrypted here, then stored through the server: its parts go into a table of its own, which is backed up
// with BACKUP TABLE to the destination like any backup, and dropped. The server only ever holds ciphertext. A restore
// brings the table back under another name, decrypts it, and either compares the files with this host or writes them
// to a staging directory. It never writes into the server's configuration: applying the files is an operator's step.

const BUNDLE = {
    provider: process.env.BUNDLE_KEY_PROVIDER || '',
    paths: (process.env.BUNDLE_PATHS || '/etc/clickhouse-server').split(',').map(p => p.trim()).filter(Boolean),
    keeper: process.env.BUNDLE_KEEPER || '',
    keeper_snapshots: process.env.BUNDLE_KEEPER_SNAPSHOTS || '',
    staging: process.env.BUNDLE_STAGING_DIR || '/var/lib/clickhouse-console/restore-staging',
    compare_root: process.env.BUNDLE_COMPARE_ROOT || '/',
    destination: process.env.BUNDLE_DESTINATION || '',
    every_hours: Number(process.env.BUNDLE_EVERY_HOURS || 0),
};

/// The key provider of this worker, or an explanation of why there is none. A passphrase is only read from a terminal,
/// by the bundle commands: the long-running worker never has one.
async function bundleKeyProvider({interactive = false} = {}) {
    switch (BUNDLE.provider) {
        case '': return {error: 'BUNDLE_KEY_PROVIDER is not set: this worker makes no server bundles.'};
        case 'file':
            if (!process.env.BUNDLE_KEY_FILE) return {error: 'BUNDLE_KEY_PROVIDER is file, but BUNDLE_KEY_FILE is not set.'};
            return {provider: fileKeyProvider(process.env.BUNDLE_KEY_FILE)};
        case 'vault': {
            const token = process.env.VAULT_TOKEN || (process.env.VAULT_TOKEN_FILE ? fs.readFileSync(process.env.VAULT_TOKEN_FILE, 'utf8').trim() : '');
            return {provider: vaultKeyProvider({addr: process.env.VAULT_ADDR, token, mount: process.env.VAULT_TRANSIT_MOUNT || 'transit',
                key: process.env.VAULT_TRANSIT_KEY, namespace: process.env.VAULT_NAMESPACE || ''})};
        }
        case 'passphrase':
            if (!interactive) return {error: 'The key is a passphrase: bundles are made and restored on the worker host with `backup_worker.mjs bundle` and `bundle-restore`.'};
            return {provider: passphraseKeyProvider(await readSecret('Passphrase of the server bundles: '))};
        default: return {error: `Unknown BUNDLE_KEY_PROVIDER ${BUNDLE.provider}: use file, vault, or passphrase.`};
    }
}

/// Reads a line from the terminal without echoing it.
async function readSecret(prompt) {
    if (!process.stdin.isTTY) throw new Error('A passphrase is read from a terminal only.');
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    try {
        for await (const chunk of process.stdin) {
            for (const char of chunk.toString('utf8')) {
                if (char === '\r' || char === '\n') return value;
                if (char === '\u0003') throw new Error('Cancelled.');
                if (char === '\u007f') value = value.slice(0, -1);
                else value += char;
            }
        }
        return value;
    } finally {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
    }
}

/// What this worker reports in its heartbeat about bundles: never a key, only how to recognize it.
async function bundleCapability() {
    if (!BUNDLE.provider) return null;
    const base = {provider: BUNDLE.provider, paths: BUNDLE.paths, keeper: !!BUNDLE.keeper, staging: BUNDLE.staging,
        schedule: BUNDLE.every_hours && BUNDLE.destination ? {every_hours: BUNDLE.every_hours, destination: BUNDLE.destination} : null};
    try {
        const {provider, error} = await bundleKeyProvider();
        return {...base, key_id: provider ? provider.key_id : null, from_console: !!provider, error: BUNDLE.provider === 'passphrase' ? null : error || null};
    } catch (e) {
        return {...base, key_id: null, from_console: false, error: e.message};
    }
}

/// `RowBinary` of rows `(part UInt32, kind Enum8, data String)`.
function bundleRows(rows) {
    const out = [];
    for (const {part, kind, data} of rows) {
        const head = Buffer.alloc(5);
        head.writeUInt32LE(part, 0);
        head.writeInt8(kind, 4);
        let length = data.length;
        const varint = [];
        do {
            varint.push((length & 0x7f) | (length > 0x7f ? 0x80 : 0));
            length = Math.floor(length / 128);
        } while (length);
        out.push(head, Buffer.from(varint), data);
    }
    return Buffer.concat(out);
}

function parseBundleRows(buffer) {
    const rows = [];
    let at = 0;
    while (at < buffer.length) {
        const part = buffer.readUInt32LE(at);
        const kind = buffer.readInt8(at + 4);
        at += 5;
        let length = 0;
        let shift = 0;
        for (;;) {
            const byte = buffer[at++];
            length += (byte & 0x7f) * 2 ** shift;
            if (!(byte & 0x80)) break;
            shift += 7;
        }
        rows.push({part, kind, data: buffer.subarray(at, at + length)});
        at += length;
    }
    return rows;
}

const BUNDLE_KIND = {header: 1, data: 2, tag: 3};

async function binaryQuery(sql, body) {
    const url = new URL(`${URL_BASE}/`);
    url.searchParams.set('query', sql);
    const response = await fetch(url, {method: 'POST', body, headers: {'X-ClickHouse-User': USER, 'X-ClickHouse-Key': PASSWORD}, signal: AbortSignal.timeout(600000)});
    const data = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new QueryError(maskSecrets(data.toString('utf8').trim().split('\n')[0].slice(0, 500)), Number(response.headers.get('X-ClickHouse-Exception-Code') || 0));
    return data;
}

const bundleTable = op_id => `server_bundle_${op_id.replace(/-/g, '').slice(0, 16)}`;

/// Makes the bundle of `op` (kind `bundle`) and backs it up to its destination.
async function runBundle(state, op, provider) {
    const destination = state.destinations_by_id.get(op.destination_id);
    if (!destination) throw new Error('The destination no longer exists.');
    await recordEvent(op.op_id, {state: 'running', details: {worker: WORKER_ID}});
    const table = bundleTable(op.op_id);
    try {
        /// The master key never goes into the bundles it protects, even when it lies under one of the paths.
        const key_file = process.env.BUNDLE_KEY_FILE && fs.existsSync(process.env.BUNDLE_KEY_FILE) ? fs.realpathSync(process.env.BUNDLE_KEY_FILE) : null;
        const files = collectFiles(BUNDLE.paths).filter(f => !key_file || fs.realpathSync(f.absolute) !== key_file);
        let keeper = null;
        if (BUNDLE.keeper) {
            if (!BUNDLE.keeper_snapshots) throw new Error('BUNDLE_KEEPER is set, but BUNDLE_KEEPER_SNAPSHOTS (the snapshot directory of Keeper) is not.');
            const [host, port] = BUNDLE.keeper.split(':');
            const snapshot = await keeperSnapshot({host, port: Number(port), snapshot_dir: BUNDLE.keeper_snapshots});
            files.push(snapshot);
            keeper = {index: snapshot.index, size: snapshot.size, path: snapshot.path};
        }
        await query(`CREATE TABLE ${q(DB)}.${q(table)} (part UInt32, kind Enum8('header' = 1, 'data' = 2, 'tag' = 3), data String) ENGINE = MergeTree ORDER BY part`, {raw: true});
        let part = 1;
        const written = await writeBundle({files, roots: BUNDLE.paths, provider, meta: {server: os.hostname(), bundle_id: op.op_id},
            onPart: async data => binaryQuery(`INSERT INTO ${q(DB)}.${q(table)} FORMAT RowBinary`, bundleRows([{part: part++, kind: BUNDLE_KIND.data, data}]))});
        await binaryQuery(`INSERT INTO ${q(DB)}.${q(table)} FORMAT RowBinary`, bundleRows([
            {part: 0, kind: BUNDLE_KIND.header, data: Buffer.from(written.header)}, {part, kind: BUNDLE_KIND.tag, data: written.tag}]));
        await query(`BACKUP TABLE ${q(DB)}.${q(table)} TO ${location(destination, op.artifact)} SETTINGS id = ${s(op.op_id)}`, {raw: true, timeout: 3600000});
        const result = {files: written.files, bytes: written.bytes, ciphertext_size: written.ciphertext_size, provider: provider.type, key_id: provider.key_id,
            roots: BUNDLE.paths, keeper, table};
        await recordEvent(op.op_id, {state: 'succeeded', num_files: written.files, total_size: written.ciphertext_size, details: result});
        await audit('server_bundle', op.op_id, `Backed up the server state (${written.files} files) to ${destination.name}`, 'success', '', op.op_id,
            {provider: provider.type, key_id: provider.key_id, files: written.files, keeper});
        log('server bundle made', {op: op.op_id, files: written.files, bytes: written.bytes});
    } finally {
        await query(`DROP TABLE IF EXISTS ${q(DB)}.${q(table)} SYNC`, {raw: true}).catch(e => log('bundle table not dropped', {table, error: e.message}));
    }
}

/// The result of a bundle operation, recorded with its last state.
function bundleResult(op) {
    return op.result || {};
}

/// Restores the bundle of `op.base_op_id` in the mode `op.parameters.mode`: `compare` with the files of this host, or
/// `stage` into a new directory under BUNDLE_STAGING_DIR. Nothing is reported or kept until the whole bundle has passed
/// authentication.
async function runBundleRestore(state, op, provider) {
    const bundle = state.operations.find(o => o.op_id === op.base_op_id && o.kind === 'bundle');
    if (!bundle || bundle.state !== 'succeeded') throw new Error('The bundle does not exist or did not succeed.');
    const destination = state.destinations_by_id.get(bundle.destination_id);
    if (!destination) throw new Error("The bundle's destination no longer exists.");
    const mode = op.parameters.mode;
    if (!['compare', 'stage'].includes(mode)) throw new Error(`Unknown restore mode ${mode}.`);
    await recordEvent(op.op_id, {state: 'running', details: {worker: WORKER_ID, mode}});
    const source = bundleResult(bundle).table || bundleTable(bundle.op_id);
    const table = `server_bundle_restore_${op.op_id.replace(/-/g, '').slice(0, 16)}`;
    const staging = path.join(BUNDLE.staging, `${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${op.op_id.slice(0, 8)}`);
    const pending = path.join(BUNDLE.staging, `.incomplete-${op.op_id}`);
    try {
        await query(`RESTORE TABLE ${q(DB)}.${q(source)} AS ${q(DB)}.${q(table)} FROM ${location(destination, bundle.artifact)} SETTINGS id = ${s(op.op_id)}`,
            {raw: true, timeout: 3600000});
        const rows = parseBundleRows(await binaryQuery(`SELECT part, kind, data FROM ${q(DB)}.${q(table)} ORDER BY part FORMAT RowBinary`, ''));
        const header = rows.find(r => r.kind === BUNDLE_KIND.header);
        const tag = rows.find(r => r.kind === BUNDLE_KIND.tag);
        if (!header || !tag) throw new Error('The restored bundle has no header or no tag: it is incomplete.');
        const entries = [];
        if (mode === 'stage') fs.mkdirSync(pending, {recursive: true, mode: 0o700});
        const {end} = await readBundle({header: header.data.toString('utf8'), tag: tag.data, provider,
            parts: rows.filter(r => r.kind === BUNDLE_KIND.data).map(r => r.data),
            onFile: async (entry, data) => {
                if (mode === 'stage') {
                    const target = stagedPath(pending, entry.path);
                    fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
                    fs.writeFileSync(target, data, {mode: 0o600});
                    entries.push({path: entry.path, kind: entry.kind, size: entry.size, mode: (entry.mode & 0o7777).toString(8)});
                    return;
                }
                if (entry.kind === 'keeper-snapshot') {
                    entries.push({path: entry.path, kind: entry.kind, status: 'snapshot, not compared'});
                    return;
                }
                const local = path.join(BUNDLE.compare_root, entry.path);
                const current = fs.existsSync(local) ? crypto.createHash('sha256').update(fs.readFileSync(local)).digest('hex') : null;
                entries.push({path: entry.path, kind: entry.kind, status: current === null ? 'missing on this host' : current === entry.sha256 ? 'same' : 'changed'});
            }});
        let summary;
        if (mode === 'compare') {
            /// Files under the bundle's roots on this host that the bundle does not have.
            const known = new Set(entries.map(e => e.path));
            for (const root of end.roots) {
                const local_root = path.join(BUNDLE.compare_root, root);
                if (!fs.existsSync(local_root)) continue;
                for (const file of collectFiles([local_root])) {
                    const bundle_path = path.join('/', path.relative(BUNDLE.compare_root, file.absolute));
                    if (!known.has(bundle_path)) entries.push({path: bundle_path, kind: 'file', status: 'not in the bundle'});
                }
            }
            const count = status => entries.filter(e => e.status === status).length;
            summary = {mode, same: count('same'), changed: count('changed'), missing: count('missing on this host'), extra: count('not in the bundle'),
                entries: entries.filter(e => e.status !== 'same').slice(0, 500)};
        } else {
            fs.renameSync(pending, staging);
            fs.writeFileSync(path.join(staging, 'RESTORE.txt'), [
                `Server bundle ${bundle.op_id}, made on ${bundle.server}, staged ${new Date().toISOString()} by ${WORKER_ID}.`,
                'The files are under their original absolute paths, readable by their owner only; their original modes are in the console. Nothing was written to the server.',
                'To apply them: stop the server (and Keeper), compare each file with the one in place, copy what you need, and restore owners and modes.',
                'A Keeper snapshot goes into the snapshot directory of Keeper, with Keeper stopped and its newer snapshots and logs moved aside.',
                'Delete this directory when you are done: it holds secrets in clear.', ''].join('\n'), {mode: 0o600});
            summary = {mode, staging_dir: staging, files: entries.length, entries: entries.slice(0, 500)};
        }
        await recordEvent(op.op_id, {state: 'succeeded', num_files: entries.length, details: summary});
        await audit('server_bundle_restore', bundle.op_id, mode === 'stage' ? `Staged the server bundle ${bundle.op_id} in ${staging}` : `Compared the server bundle ${bundle.op_id} with this host`,
            'success', '', op.op_id, {mode, files: entries.length});
        log('server bundle restored', {op: op.op_id, mode, files: entries.length});
    } catch (e) {
        fs.rmSync(pending, {recursive: true, force: true});
        throw e;
    } finally {
        await query(`DROP TABLE IF EXISTS ${q(DB)}.${q(table)} SYNC`, {raw: true}).catch(e => log('bundle table not dropped', {table, error: e.message}));
    }
}

/// An operation ID that is the same for every worker in one period, like the runs of schedules.
function periodOpId(key) {
    const h = crypto.createHash('sha256').update(key).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function bundleArtifact(op_id) {
    return `server/${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}-${op_id.slice(0, 8)}`;
}

async function runBundles(state, provider) {
    if (BUNDLE.every_hours > 0 && BUNDLE.destination && provider) {
        const destination = state.destinations.find(d => d.name === BUNDLE.destination && d.enabled);
        const period = Math.floor(Date.now() / (BUNDLE.every_hours * 3600000));
        const op_id = periodOpId(`bundle:${DB}:${BUNDLE.destination}:${BUNDLE.every_hours}:${period}`);
        if (!destination) log('no bundle: the destination is not enabled', {destination: BUNDLE.destination});
        else if (!state.operations.some(o => o.op_id === op_id)) {
            const op = {op_id, kind: 'bundle', destination_id: destination.id, artifact: bundleArtifact(op_id), parameters: {scheduled: true, every_hours: BUNDLE.every_hours}};
            await recordOperation(op);
            state.operations.push({...op, state: 'queued', checks: [], deleted: false});
        }
    }
    for (const op of state.operations.filter(o => ['bundle', 'bundle_restore'].includes(o.kind) && o.state === 'queued')) {
        if (!provider) {
            await recordEvent(op.op_id, {state: 'failed', error: (await bundleKeyProvider()).error});
            continue;
        }
        try {
            if (op.kind === 'bundle') await runBundle(state, op, provider);
            else await runBundleRestore(state, op, provider);
        } catch (e) {
            await recordEvent(op.op_id, {state: 'failed', error: e.message});
            await audit(op.kind === 'bundle' ? 'server_bundle' : 'server_bundle_restore', op.base_op_id || op.op_id,
                `The server ${op.kind === 'bundle' ? 'bundle' : 'bundle restore'} failed`, 'failure', e.message, op.op_id);
            log('server bundle failed', {op: op.op_id, error: e.message});
        }
    }
}

/// The bundle commands, run by a person on the worker host (the only way with a passphrase):
///   backup_worker.mjs bundle-key-init --key-file <path>
///   backup_worker.mjs bundle --destination <name>
///   backup_worker.mjs bundle-restore --bundle <operation ID> --mode compare|stage
async function bundleCommand(command) {
    const option = name => {
        const at = process.argv.indexOf(`--${name}`);
        return at > 0 ? process.argv[at + 1] : null;
    };
    if (command === 'bundle-key-init') {
        const file = option('key-file') || process.env.BUNDLE_KEY_FILE;
        if (!file) throw new Error('Give --key-file <path>.');
        const fingerprint = createKeyFile(file);
        console.log(`Created ${file} (readable by its owner only), fingerprint ${fingerprint}.`);
        console.log('Copy the key now to a place outside this host and outside the backups, for example a password manager or a sealed envelope,');
        console.log('and record the fingerprint with it. Without this key the server bundles cannot be decrypted. The worker never copies it.');
        return;
    }
    const {provider, error} = await bundleKeyProvider({interactive: true});
    if (!provider) throw new Error(error);
    const state = await loadState();
    let op;
    if (command === 'bundle') {
        const name = option('destination') || BUNDLE.destination;
        const destination = state.destinations.find(d => d.name === name && d.enabled);
        if (!destination) throw new Error(`No enabled destination named ${name}: give --destination <name>.`);
        const op_id = crypto.randomUUID();
        op = {op_id, kind: 'bundle', destination_id: destination.id, artifact: bundleArtifact(op_id), parameters: {from_command: true}};
    } else if (command === 'bundle-restore') {
        const bundle = state.operations.find(o => o.op_id === option('bundle') && o.kind === 'bundle');
        if (!bundle) throw new Error(`No server bundle ${option('bundle')}: give --bundle <operation ID>.`);
        op = {op_id: crypto.randomUUID(), kind: 'bundle_restore', base_op_id: bundle.op_id, destination_id: bundle.destination_id, artifact: bundle.artifact,
            parameters: {mode: option('mode') || 'compare', from_command: true}};
    } else {
        throw new Error(`Unknown command ${command}: use bundle-key-init, bundle, or bundle-restore.`);
    }
    await recordOperation(op);
    state.operations.push({...op, state: 'queued', checks: [], deleted: false});
    try {
        if (op.kind === 'bundle') await runBundle(state, op, provider);
        else await runBundleRestore(state, op, provider);
    } catch (e) {
        await recordEvent(op.op_id, {state: 'failed', error: e.message});
        throw e;
    }
    const result = (await loadState()).operations.find(o => o.op_id === op.op_id);
    console.log(`${op.kind} ${op.op_id}: ${result.state}${result.result && result.result.staging_dir ? `, staged in ${result.result.staging_dir}` : ''}`);
}

// ---------------------------------------------------------------------------------------------
// Main loop

async function cycle() {
    const bundle = await bundleCapability();
    await recordEvent(`worker:${WORKER_ID}`, {kind: 'check', state: 'passed', name: 'heartbeat', details: {pid: process.pid, ...(bundle ? {bundle} : {})}});
    let state = await loadState();
    await reconcile(state);
    await runSchedules(state, Date.now());
    state = await loadState();
    await afterBackups(state);
    await copyBackups(state);
    await applyRetention(state);
    await checkProtection(state);
    state = await loadState();
    await processDeletions(state);
    if (BUNDLE.provider) {
        const {provider} = await bundleKeyProvider().catch(e => ({error: e.message}));
        await runBundles(await loadState(), provider || null);
    }
}

async function main() {
    const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
    if (command) {
        try {
            await bundleCommand(command);
        } catch (e) {
            console.error(`error: ${maskSecrets(e.message)}`);
            process.exitCode = 1;
        }
        return;
    }
    log('started', {url: URL_BASE, database: DB, interval_s: INTERVAL / 1000, bundle_provider: BUNDLE.provider || null});
    for (;;) {
        try {
            await cycle();
        } catch (e) {
            log('cycle failed', {error: maskSecrets(e.message)});
        }
        if (ONCE) break;
        await new Promise(resolve => setTimeout(resolve, INTERVAL));
    }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
