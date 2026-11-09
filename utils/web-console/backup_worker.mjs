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
/// Arguments: --once runs one cycle and exits.
///
/// Several workers can run at the same time: a scheduled run has a deterministic operation ID and
/// artifact path, and the server refuses a second backup with the same ID or location.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    const [destinations, schedules, operations] = await Promise.all([
        query(`SELECT id, name, toString(type) AS type, disk, named_collection, endpoint, bucket, prefix, credential_ref, allow_http, enabled, allowed_databases, test_result,
            if(tested_at IS NULL, '', toString(tested_at)) AS tested_at, description
            FROM ${q(DB)}.backup_destinations FINAL WHERE NOT deleted`),
        query(`SELECT id, name, enabled, destination_id, databases, tables, structure_only, toString(strategy) AS strategy, full_every, toString(frequency) AS frequency,
            minute, hour, weekday, timezone, keep_chains, toString(on_missing_base) AS on_missing_base, verify, notify_ref FROM ${q(DB)}.backup_schedules FINAL WHERE NOT deleted`),
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
            const backups = state.operations.filter(o => o.kind === 'backup' && o.schedule_id === schedule.id && o.state === 'succeeded' && !o.deleted)
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

export function retentionDeletions(state, schedule) {
    const backups = state.operations.filter(o => o.kind === 'backup' && o.schedule_id === schedule.id && o.state === 'succeeded' && !o.deleted)
        .sort((a, b) => b.requested_ms - a.requested_ms);
    const fulls = backups.filter(o => o.strategy !== 'incremental');
    const kept = new Set(fulls.slice(0, schedule.keep_chains).map(o => o.op_id));
    const keep = new Set(backups.filter(o => kept.has(backupChain(state, o).chain.at(-1).op_id)).map(o => o.op_id));
    /// Delete from the newest descendants towards the bases: never a base before its incremental backups.
    return backups.filter(o => !keep.has(o.op_id) && !descendants(state, o).some(d => keep.has(d.op_id))).sort((a, b) => b.requested_ms - a.requested_ms);
}

async function applyRetention(state) {
    for (const schedule of state.schedules.filter(sch => sch.enabled)) {
        for (const backup of retentionDeletions(state, schedule)) {
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
            const in_use = state.operations.find(o => ['restore', 'verify'].includes(o.kind) && o.base_op_id === op.base_op_id && !TERMINAL.includes(o.state));
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
            await recordEvent(op.op_id, {state: 'succeeded', details: result});
            if (op.kind === 'delete') {
                await recordEvent(op.base_op_id, {state: 'deleted', details: {deletion: op.op_id, ...result}});
                await audit('delete_backup', op.base_op_id, `Deleted backup ${op.base_op_id}`, 'success', '', op.op_id, result);
            } else {
                await recordDestinationCapabilities(destination, {list: {ok: true}, delete: {ok: true}});
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

async function recordDestinationCapabilities(destination, results) {
    const merged = {...parseJSON(destination.test_result, {}), ...results};
    const row = {...destination, test_result: JSON.stringify(merged), tested_at: destination.tested_at || null, deleted: false};
    delete row.updated_by;
    await query(`INSERT INTO ${q(DB)}.backup_destinations (id, name, description, type, disk, named_collection, endpoint, bucket, prefix, credential_ref, allow_http, enabled, allowed_databases, test_result, tested_at, deleted) FORMAT JSONEachRow\n${JSON.stringify(row)}`, {raw: true});
}

// ---------------------------------------------------------------------------------------------
// Main loop

async function cycle() {
    await recordEvent(`worker:${WORKER_ID}`, {kind: 'check', state: 'passed', name: 'heartbeat', details: {pid: process.pid}});
    let state = await loadState();
    await reconcile(state);
    await runSchedules(state, Date.now());
    state = await loadState();
    await afterBackups(state);
    await applyRetention(state);
    state = await loadState();
    await processDeletions(state);
}

async function main() {
    log('started', {url: URL_BASE, database: DB, interval_s: INTERVAL / 1000});
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
