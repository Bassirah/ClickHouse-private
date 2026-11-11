#!/usr/bin/env node
/// Recovery rehearsal of the web console (Administration → Backup & Restore): proves that a whole server can be
/// recovered from its backups, and from its staged server bundle when one is given, on an isolated server that is
/// started for the rehearsal and removed after it.
///
/// Production is read (destinations, backups, and the values recorded when they were made) and receives only the
/// result, as a check `rehearsal` of each backup, shown in the inventory, and an audit record. The rehearsal server:
/// - listens on 127.0.0.1 only, on its own ports, with its own data directory and its own embedded Keeper;
/// - starts from the staged configuration when `--staged` is given, which checks that the configuration of the bundle
///   starts, with the storage, Keeper, clusters, and paths replaced, so that it can never write to production;
/// - restores each backup from its real destination, which it only reads: the backup disks are in no storage policy, and
///   the restored tables go to the rehearsal server's own disk (`storage_policy = 'default'`);
/// - compares every table that has recorded values: row count and fingerprint (`groupBitXor(cityHash64(*))`).
///
/// Usage:
///   node recovery_rehearsal.mjs --url http://<server>:8123 --user <user> --password <password> \
///       [--backup <operation ID>]... [--staged <staging directory of a bundle>] [--binary <clickhouse>] [--work-dir <dir>] [--keep]
///
/// Without --backup, the latest successful backup of each database is rehearsed. The user needs SELECT on the console
/// tables and INSERT on backup_events and audit_log. S3 destinations are read with the worker's credentials:
/// <REF>_ACCESS_KEY_ID and <REF>_SECRET_ACCESS_KEY in the environment. A disk destination is read from its path on this
/// host, so run the rehearsal on the server host (or a host that mounts the backups).
///
/// Node.js 18 or later, no packages.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';

const args = process.argv.slice(2);
const option = name => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : null;
};
const options = name => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
const URL_BASE = (option('url') || process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const USER = option('user') || process.env.CLICKHOUSE_USER || 'default';
const PASSWORD = option('password') || process.env.CLICKHOUSE_PASSWORD || '';
const DB = process.env.ADMIN_DATABASE || 'console_admin';
const BINARY = option('binary') || 'clickhouse';
const STAGED = option('staged');
const KEEP = args.includes('--keep');
const WORK = path.resolve(option('work-dir') || path.join(process.cwd(), 'tmp', `recovery-rehearsal-${Date.now()}`));
/// Ports of the rehearsal server: REHEARSAL_<NAME>_PORT, or free ones chosen by the system, so that a rehearsal on a busy
/// host does not depend on any particular port being free.
const PORTS = {};

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            server.close(() => resolve(port));
        });
    });
}

const q = name => '`' + String(name).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
const s = value => "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const log = message => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

async function query(base, user, password, sql, {json = true, timeout = 600000} = {}) {
    const response = await fetch(`${base}/`, {method: 'POST', body: json ? `${sql}\nFORMAT JSON` : sql, signal: AbortSignal.timeout(timeout),
        headers: {'X-ClickHouse-User': user, 'X-ClickHouse-Key': password}});
    const text = await response.text();
    if (!response.ok) throw new Error(text.trim().split('\n')[0].slice(0, 500));
    return json ? (text ? JSON.parse(text).data : []) : text;
}
const production = (sql, opts) => query(URL_BASE, USER, PASSWORD, sql, opts);

const parse = text => {
    try {
        return text ? JSON.parse(text) : {};
    } catch (e) {
        return {};
    }
};

/// The backups to rehearse, with their destinations and the values recorded when they were made.
async function loadBackups() {
    const destinations = new Map((await production(`SELECT id, name, toString(type) AS type, disk, named_collection, endpoint, bucket, prefix, credential_ref
        FROM ${q(DB)}.backup_destinations FINAL WHERE NOT deleted`)).map(d => [d.id, d]));
    const operations = await production(`SELECT op_id, toUnixTimestamp64Milli(requested_at) AS requested_ms, destination_id, artifact, scope, strategy, base_op_id, parameters, expected
        FROM ${q(DB)}.backup_operations WHERE kind = 'backup' ORDER BY requested_at LIMIT 1 BY op_id`);
    const events = await production(`SELECT op_id, toString(kind) AS kind, toString(state) AS state, name, details FROM ${q(DB)}.backup_events
        WHERE op_id IN (SELECT op_id FROM ${q(DB)}.backup_operations WHERE kind = 'backup') ORDER BY at`);
    const ops = new Map(operations.map(o => [o.op_id, {...o, requested_ms: Number(o.requested_ms), scope: parse(o.scope), parameters: parse(o.parameters),
        expected: parse(o.expected), state: 'queued', deleted: false, recorded: null}]));
    for (const e of events) {
        const op = ops.get(e.op_id);
        if (!op) continue;
        if (e.kind === 'state') {
            op.state = e.state;
            if (e.state === 'deleted') op.deleted = true;
        } else if (e.name === 'expected_values' && e.state === 'passed') {
            const details = parse(e.details);
            if (details.stable) op.recorded = details.tables;
        }
    }
    const usable = [...ops.values()].filter(o => o.state === 'succeeded' && !o.deleted && destinations.has(o.destination_id));
    let chosen;
    const wanted = options('backup');
    if (wanted.length) {
        chosen = wanted.map(id => {
            const op = usable.find(o => o.op_id === id);
            if (!op) throw new Error(`No successful backup ${id} with an existing destination.`);
            return op;
        });
    } else {
        /// The latest backup of each database.
        const latest = new Map();
        for (const op of usable.sort((a, b) => b.requested_ms - a.requested_ms)) {
            for (const db of [...new Set([...(op.scope.databases || []), ...(op.scope.tables || []).map(([d]) => d)])]) {
                if (!latest.has(db)) latest.set(db, op);
            }
        }
        chosen = [...new Set(latest.values())];
    }
    if (!chosen.length) throw new Error('There is no successful backup to rehearse.');
    return {chosen, destinations};
}

/// The configuration of the rehearsal server: the staged one, or none, with everything that could reach production
/// replaced. Loaded last, so it overrides the staged files.
function prepareServer(disks) {
    const config_dir = path.join(WORK, 'config');
    const data = path.join(WORK, 'data');
    fs.mkdirSync(path.join(config_dir, 'config.d'), {recursive: true});
    fs.mkdirSync(path.join(config_dir, 'users.d'), {recursive: true});
    fs.mkdirSync(data, {recursive: true});
    let main = path.join(config_dir, 'config.xml');
    if (STAGED) {
        const staged_config = path.join(STAGED, 'etc', 'clickhouse-server');
        if (!fs.existsSync(path.join(staged_config, 'config.xml'))) {
            throw new Error(`${staged_config}/config.xml does not exist: --staged is the staging directory of a server bundle that includes /etc/clickhouse-server.`);
        }
        fs.cpSync(staged_config, config_dir, {recursive: true});
        main = path.join(config_dir, 'config.xml');
    } else {
        fs.writeFileSync(main, '<clickhouse><users_config>users.xml</users_config></clickhouse>\n');
        fs.writeFileSync(path.join(config_dir, 'users.xml'), '<clickhouse><profiles><default/></profiles><quotas><default/></quotas><users/></clickhouse>\n');
    }
    const password = crypto.randomBytes(18).toString('base64url');
    const disk_xml = disks.map(d => `<${d.name}><type>local</type><path>${d.path}</path></${d.name}>`).join('');
    fs.writeFileSync(path.join(config_dir, 'config.d', 'zz-rehearsal.xml'), `<clickhouse>
    <http_port replace="1">${PORTS.http}</http_port>
    <tcp_port replace="1">${PORTS.tcp}</tcp_port>
    <https_port remove="1"/><tcp_port_secure remove="1"/><interserver_http_port remove="1"/><interserver_https_port remove="1"/>
    <mysql_port remove="1"/><postgresql_port remove="1"/><prometheus remove="1"/><grpc_port remove="1"/>
    <listen_host replace="1">127.0.0.1</listen_host>
    <path replace="1">${data}/</path>
    <tmp_path replace="1">${data}/tmp/</tmp_path>
    <user_files_path replace="1">${data}/user_files/</user_files_path>
    <format_schema_path replace="1">${data}/format_schemas/</format_schema_path>
    <logger replace="1"><level>information</level><log>${WORK}/server.log</log><errorlog>${WORK}/server.err.log</errorlog></logger>
    <user_directories replace="1"><users_xml><path>users.xml</path></users_xml><local_directory><path>${data}/access/</path></local_directory></user_directories>
    <storage_configuration replace="1"><disks>${disk_xml}</disks></storage_configuration>
    <backups replace="1"><allowed_disk>${disks.map(d => d.name).join('</allowed_disk><allowed_disk>') || 'default'}</allowed_disk></backups>
    <keeper_server replace="1">
        <tcp_port>${PORTS.keeper}</tcp_port><server_id>1</server_id>
        <log_storage_path>${data}/coordination/log</log_storage_path><snapshot_storage_path>${data}/coordination/snapshots</snapshot_storage_path>
        <raft_configuration><server><id>1</id><hostname>127.0.0.1</hostname><port>${PORTS.raft}</port></server></raft_configuration>
    </keeper_server>
    <zookeeper replace="1"><node><host>127.0.0.1</host><port>${PORTS.keeper}</port></node></zookeeper>
    <auxiliary_zookeepers remove="1"/>
    <remote_servers replace="1"/>
    <named_collections_storage remove="1"/>
    <openSSL remove="1"/>
</clickhouse>
`);
    fs.writeFileSync(path.join(config_dir, 'users.d', 'zz-rehearsal.xml'), `<clickhouse><users><rehearsal>
    <password_sha256_hex>${crypto.createHash('sha256').update(password).digest('hex')}</password_sha256_hex>
    <networks><ip>127.0.0.1</ip></networks><profile>default</profile><quota>default</quota>
    <access_management>1</access_management><named_collection_control>1</named_collection_control>
</rehearsal></users></clickhouse>
`);
    return {main, password};
}

async function startServer(main, password) {
    const child = spawn(BINARY, ['server', `--config-file=${main}`], {cwd: WORK, stdio: ['ignore', 'ignore', 'pipe'], detached: false});
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    const base = `http://127.0.0.1:${PORTS.http}`;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
            if ((await fetch(`${base}/ping`, {signal: AbortSignal.timeout(2000)})).ok) return {child, run: (sql, opts) => query(base, 'rehearsal', password, sql, opts)};
        } catch (e) {
            /// Not listening yet.
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    child.kill('SIGKILL');
    const err_log = fs.existsSync(path.join(WORK, 'server.err.log')) ? fs.readFileSync(path.join(WORK, 'server.err.log'), 'utf8') : '';
    /// The first error, not the stack trace that follows it.
    const lines = `${err_log}\n${stderr}`.split('\n');
    const error = lines.find(l => /<Error>|<Fatal>|Code: \d+|Exception/.test(l)) || lines.filter(Boolean).slice(-3).join(' | ');
    throw new Error(`The rehearsal server did not start${STAGED ? ' with the staged configuration' : ''}: ${error.replace(/^.*?(<Error>|<Fatal>)\s*/, '').slice(0, 600)}`);
}

function location(destination, artifact) {
    if (destination.type === 'disk') return `Disk(${s(destination.disk)}, ${s(destination.prefix ? `${destination.prefix}/${artifact}` : artifact)})`;
    return `S3(${q(`rehearsal_${destination.id.replace(/-/g, '').slice(0, 12)}`)}, ${s(artifact)})`;
}

/// Restores one backup into the rehearsal server and compares its tables with the values recorded at backup time.
async function rehearse(run, op, destination) {
    const scope = op.scope;
    const items = [...(scope.databases || []).map(db => `DATABASE ${q(db)}`), ...(scope.tables || []).map(([db, t]) => `TABLE ${q(db)}.${q(t)}`)];
    if (scope.access_entities) items.push(...['users', 'roles', 'settings_profiles', 'row_policies', 'quotas'].map(t => `TABLE system.${t}`));
    if (scope.sql_objects) items.push(...['functions', 'workloads', 'resources'].map(t => `TABLE system.${t}`));
    for (const db of new Set((scope.tables || []).map(([d]) => d))) await run(`CREATE DATABASE IF NOT EXISTS ${q(db)}`, {json: false});
    const started = Date.now();
    await run(`RESTORE ${items.join(', ')} FROM ${location(destination, op.artifact)} SETTINGS storage_policy = 'default', allow_non_empty_tables = 0`, {json: false, timeout: 3600000});
    const restore_s = Math.round((Date.now() - started) / 100) / 10;
    const recorded = Object.keys(op.expected || {}).length ? op.expected : op.recorded;
    const tables = [];
    for (const [name, expected] of Object.entries(recorded || {})) {
        const [db, table] = name.split('.');
        const got = (await run(`SELECT count() AS n, toString(groupBitXor(cityHash64(*))) AS fp FROM ${q(db)}.${q(table)}`).catch(e => [{error: e.message}]))[0];
        const ok = !got.error && Number(got.n) === Number(expected.rows) && (!expected.fingerprint || got.fp === expected.fingerprint);
        tables.push({table: name, ok, rows: got.error ? null : Number(got.n), expected_rows: expected.rows, error: got.error || (ok ? undefined : 'rows or fingerprint differ')});
    }
    const restored = await run(`SELECT count() AS n FROM system.tables WHERE database IN (${[...new Set([...(scope.databases || []), ...(scope.tables || []).map(([d]) => d)])].map(s).join(', ')})`);
    return {ok: tables.every(t => t.ok), restore_s, tables_restored: Number(restored[0].n), compared: tables.length, tables: tables.filter(t => !t.ok).concat(tables.filter(t => t.ok)).slice(0, 200),
        note: tables.length ? undefined : 'No values were recorded for this backup: the tables were restored, but not compared.'};
}

async function main() {
    for (const name of ['http', 'tcp', 'keeper', 'raft']) PORTS[name] = Number(process.env[`REHEARSAL_${name.toUpperCase()}_PORT`] || await freePort());
    const {chosen, destinations} = await loadBackups();
    log(`Rehearsing ${chosen.length} backups: ${chosen.map(o => o.op_id.slice(0, 8)).join(', ')}`);
    const used = [...new Set(chosen.map(o => o.destination_id))].map(id => destinations.get(id));
    const disk_names = [...new Set(used.filter(d => d.type === 'disk').map(d => d.disk))];
    const disks = disk_names.length ? await production(`SELECT name, path FROM system.disks WHERE name IN (${disk_names.map(s).join(', ')})`) : [];
    for (const name of disk_names) {
        const disk = disks.find(d => d.name === name);
        if (!disk || !fs.existsSync(disk.path)) throw new Error(`The backups of the disk ${name} are not readable here (${disk ? disk.path : 'unknown path'}): run the rehearsal on the server host.`);
    }
    fs.mkdirSync(WORK, {recursive: true});
    const {main: config, password} = prepareServer(disks);
    log(`Starting the rehearsal server in ${WORK}${STAGED ? ` with the configuration staged in ${STAGED}` : ''}`);
    let server = null;
    const results = [];
    let failure = null;
    try {
        server = await startServer(config, password);
        for (const destination of used.filter(d => d.type === 's3')) {
            const id = process.env[`${destination.credential_ref}_ACCESS_KEY_ID`];
            const secret = process.env[`${destination.credential_ref}_SECRET_ACCESS_KEY`];
            if (!destination.credential_ref || !id || !secret) throw new Error(`Set ${destination.credential_ref || '<REF>'}_ACCESS_KEY_ID and _SECRET_ACCESS_KEY to read the destination ${destination.name}.`);
            await server.run(`CREATE NAMED COLLECTION ${q(`rehearsal_${destination.id.replace(/-/g, '').slice(0, 12)}`)} AS url = ${s(`${destination.endpoint}/${destination.bucket}/${destination.prefix}/`)}, `
                + `access_key_id = ${s(id)}, secret_access_key = ${s(secret)}`, {json: false});
        }
        for (const op of chosen) {
            const destination = destinations.get(op.destination_id);
            log(`Restoring ${op.op_id.slice(0, 8)} from ${destination.name}`);
            try {
                const result = await rehearse(server.run, op, destination);
                results.push({op, result});
                log(`  ${result.ok ? 'passed' : 'FAILED'}: ${result.tables_restored} tables restored in ${result.restore_s} s, ${result.compared} compared`);
            } catch (e) {
                results.push({op, result: {ok: false, error: e.message}});
                log(`  FAILED: ${e.message}`);
            }
        }
    } catch (e) {
        failure = e.message;
        log(`FAILED: ${failure}`);
    } finally {
        if (server) server.child.kill('SIGTERM');
        if (server) await new Promise(resolve => server.child.once('exit', resolve));
        if (!KEEP) fs.rmSync(WORK, {recursive: true, force: true});
        else log(`Kept ${WORK}`);
    }
    /// The result, recorded with each backup in production.
    const context = {host: os.hostname(), staged: STAGED || null, config_started: !failure || !/did not start/.test(failure)};
    for (const op of chosen) {
        const own = results.find(r => r.op === op);
        const result = own ? own.result : {ok: false, error: failure};
        const row = {op_id: op.op_id, kind: 'check', state: result.ok ? 'passed' : 'failed', name: 'rehearsal', error: result.error || '', details: JSON.stringify({...result, ...context})};
        await production(`INSERT INTO ${q(DB)}.backup_events (op_id, kind, state, name, error, details) FORMAT JSONEachRow\n${JSON.stringify(row)}`, {json: false});
    }
    const passed = results.filter(r => r.result.ok).length;
    const summary = failure ? `Recovery rehearsal failed: ${failure}` : `Recovery rehearsal: ${passed} of ${chosen.length} backups restored and matched`;
    await production(`INSERT INTO ${q(DB)}.audit_log (correlation_id, scope, target_type, target_name, action, summary, result, error, details) FORMAT JSONEachRow\n${JSON.stringify({
        correlation_id: crypto.randomUUID(), scope: 'local', target_type: 'backup', target_name: chosen.map(o => o.op_id).join(','), action: 'recovery_rehearsal', summary,
        result: !failure && passed === chosen.length ? 'success' : 'failure', error: failure || '', details: JSON.stringify(context)})}`, {json: false}).catch(e => log(`audit record not written: ${e.message}`));
    log(summary);
    process.exitCode = !failure && passed === chosen.length ? 0 : 1;
}

main().catch(e => {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
});
