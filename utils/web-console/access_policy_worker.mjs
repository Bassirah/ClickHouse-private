#!/usr/bin/env node
/// Access policy worker of the web console (`/console`, Administration → Data Access Policies).
///
/// Keeps the native access controls of the server in line with the policy rules when nobody has the console
/// open:
/// - imports user attributes from a feed (an export of an identity provider or HR system), when configured;
/// - computes the desired state of every enabled rule with the same functions as the console, which it loads
///   from `console.html`;
/// - applies the difference: creates, changes, and removes only entities the platform owns (`dap_owned`), and
///   never restores an owned entity that was removed outside the platform (that needs an explicit deployment);
/// - records ownership, the deployment, and an audit record.
///
/// The worker is not an escalation path: it holds no privilege to grant anything. Each statement runs as
/// `EXECUTE AS <author>`, the user who wrote the current revision of the rule (recorded by the server), so the
/// server checks that user's own privileges; the worker needs only `IMPERSONATE` on the rule authors.
///
/// Revocation latency: an attribute change reaches the server within one interval after the value is written
/// (or after the feed reports it), plus the feed's own delay. Grants are checked when a query starts; queries
/// already running finish with the access they started with.
///
/// It needs Node.js 18 or later and no packages. Configuration (environment variables):
///   CLICKHOUSE_URL        HTTP interface of the server (default http://127.0.0.1:8123)
///   CLICKHOUSE_USER       service account (see "Access policy worker" in the documentation for its privileges)
///   CLICKHOUSE_PASSWORD   its password
///   ADMIN_DATABASE        database of the console tables (default console_admin)
///   CLUSTER               apply the statements ON CLUSTER this cluster (default: this server only)
///   INTERVAL_SECONDS      time between cycles (default 60)
///   CONSOLE_HTML          path of console.html (default: programs/server/console.html of this repository)
///   ATTRIBUTE_FEED        a JSON file or an https:// URL: [{"user": "...", "attributes": {"department": "..."}}]
///   ATTRIBUTE_FEED_SOURCE name of the feed's source, as in the attribute definitions (default: feed)
///   ATTRIBUTE_FEED_TOKEN  bearer token for an https feed
/// Arguments: --once runs one cycle and exits.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const URL_BASE = (process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const USER = process.env.CLICKHOUSE_USER || 'default';
const PASSWORD = process.env.CLICKHOUSE_PASSWORD || '';
const DB = process.env.ADMIN_DATABASE || 'console_admin';
const CLUSTER = process.env.CLUSTER || '';
const INTERVAL = Number(process.env.INTERVAL_SECONDS || 60) * 1000;
const CONSOLE_HTML = process.env.CONSOLE_HTML || path.join(path.dirname(fileURLToPath(import.meta.url)), '../../programs/server/console.html');
const FEED = process.env.ATTRIBUTE_FEED || '';
const FEED_SOURCE = process.env.ATTRIBUTE_FEED_SOURCE || 'feed';
const FEED_TOKEN = process.env.ATTRIBUTE_FEED_TOKEN || '';
const ONCE = process.argv.includes('--once');
const WORKER_ID = `${os.hostname()}-${process.pid}`;

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(DB)) throw new Error(`Invalid ADMIN_DATABASE: ${DB}`);

function log(message, fields = {}) {
    console.log(JSON.stringify({time: new Date().toISOString(), worker: WORKER_ID, message, ...fields}));
}

// ---------------------------------------------------------------------------------------------
// The access model of the console

/// The functions the worker shares with the console. They are pure: no DOM, no queries.
const MODEL_FUNCTIONS = ['quoteIdentifier', 'quoteString', 'roleClosure', 'dapGrantLevel', 'dapGrantCovers', 'dapGrantees', 'dapColumnAccess',
    'dapPolicyApplies', 'dapRowFilter', 'dapRuleShort', 'dapValueKey', 'dapAttributeIndex', 'dapRuleProblem', 'dapSelectUsers', 'dapRuleEntities',
    'dapObservedKeys', 'dapCluster', 'dapPlan', 'dapDesired'];
const MODEL_CONSTANTS = ['DAP_PREFIX', 'DAP_DISABLED_STATUSES'];

/// Extracts the named top-level functions and constants of the console page and evaluates them in a context of
/// their own. A function starts with `function name(` at the beginning of a line and ends at the first line
/// that is just `}`, which is how the page is formatted.
function loadModel(file) {
    const source = fs.readFileSync(file, 'utf8');
    const pieces = [];
    for (const name of MODEL_CONSTANTS) {
        const match = source.match(new RegExp(`^const ${name} = [^\\n]*;$`, 'm'));
        if (!match) throw new Error(`${file}: the constant ${name} is missing`);
        pieces.push(match[0]);
    }
    for (const name of MODEL_FUNCTIONS) {
        const start = source.search(new RegExp(`^function ${name}\\(`, 'm'));
        if (start < 0) throw new Error(`${file}: the function ${name} is missing`);
        const end = source.indexOf('\n}\n', start);
        pieces.push(source.slice(start, end + 2));
    }
    const context = vm.createContext({TextEncoder});
    vm.runInContext(`${pieces.join('\n')}\nthis.model = {${[...MODEL_FUNCTIONS, ...MODEL_CONSTANTS].join(', ')}};`, context, {filename: file});
    return context.model;
}

const model = loadModel(CONSOLE_HTML);
const q = model.quoteIdentifier;

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
        throw new QueryError(text.trim().split('\n')[0].slice(0, 500), code);
    }
    return raw ? text : (text ? JSON.parse(text).data : []);
}

const table = name => `${q(DB)}.${q(name)}`;

// ---------------------------------------------------------------------------------------------
// Attribute feed

/// Writes the attributes of the feed as values of its source, and removes the values of this source that the
/// feed no longer reports (a user who left the feed loses the attributes, and rules revoke what they gave).
/// When the feed cannot be read, nothing is written: the values age, and become stale after the freshness limit
/// of their attribute.
async function importFeed() {
    let text;
    if (/^https:\/\//.test(FEED)) {
        const response = await fetch(FEED, {headers: FEED_TOKEN ? {Authorization: `Bearer ${FEED_TOKEN}`} : {}, signal: AbortSignal.timeout(30000)});
        if (!response.ok) throw new Error(`The attribute feed answered ${response.status}`);
        text = await response.text();
    } else {
        text = fs.readFileSync(FEED, 'utf8');
    }
    const entries = JSON.parse(text);
    if (!Array.isArray(entries)) throw new Error('The attribute feed must be a JSON array');
    const definitions = await query(`SELECT attribute FROM ${table('dap_attributes')} FINAL WHERE NOT deleted AND source = {source:String} AND category = 'user'`, {params: {source: FEED_SOURCE}});
    const known = new Set(definitions.map(d => d.attribute));
    const now = Math.floor(Date.now() / 1000);
    const rows = [];
    const reported = new Set();
    for (const entry of entries) {
        if (typeof entry.user !== 'string' || typeof entry.attributes !== 'object') continue;
        for (const [attribute, value] of Object.entries(entry.attributes)) {
            if (!known.has(attribute) || value === null || value === undefined) continue;
            rows.push({user_name: entry.user, attribute, value: String(value), source: FEED_SOURCE, observed_at: now});
            reported.add(`${entry.user}\u0000${attribute}`);
        }
    }
    const current = await query(`SELECT user_name, attribute FROM ${table('dap_user_attributes')} FINAL WHERE NOT deleted AND source = {source:String}`, {params: {source: FEED_SOURCE}});
    for (const row of current.filter(r => known.has(r.attribute) && !reported.has(`${r.user_name}\u0000${r.attribute}`))) {
        rows.push({user_name: row.user_name, attribute: row.attribute, value: '', source: FEED_SOURCE, observed_at: now, deleted: true});
    }
    if (rows.length) {
        await query(`INSERT INTO ${table('dap_user_attributes')} (user_name, attribute, value, source, observed_at, deleted) FORMAT JSONEachRow\n`
            + rows.map(r => JSON.stringify({deleted: false, ...r})).join('\n'), {raw: true});
    }
    return {values: rows.filter(r => !r.deleted).length, removed: rows.filter(r => r.deleted).length};
}

// ---------------------------------------------------------------------------------------------
// Reconciliation

async function loadState() {
    const [rules, definitions, values, classifications, owned, users, roles, role_grants, grants, policies] = await Promise.all([
        /// The aliases differ from the column names: an alias named like a column would replace it inside the other aggregates.
        query(`SELECT rule_id, max(revision) AS last_revision, argMax(name, revision) AS last_name, argMax(spec, revision) AS last_spec,
            argMax(enabled, revision) AS last_enabled, argMax(deleted, revision) AS last_deleted, argMax(created_by, revision) AS last_created_by
            FROM ${table('dap_rules')} GROUP BY rule_id`),
        query(`SELECT attribute, toString(category) AS category, dynamic, source, writer, max_age_seconds FROM ${table('dap_attributes')} FINAL WHERE NOT deleted`),
        query(`SELECT user_name, attribute, value, source, toUnixTimestamp(observed_at) AS observed_at, updated_by FROM ${table('dap_user_attributes')} FINAL WHERE NOT deleted`),
        query(`SELECT database, table, column, label FROM ${table('dap_classifications')} FINAL WHERE NOT deleted`),
        query(`SELECT key, rule_id, revision FROM ${table('dap_owned')} FINAL WHERE NOT deleted`),
        query('SELECT name FROM system.users'),
        query('SELECT name FROM system.roles'),
        query('SELECT user_name, role_name, granted_role_name, granted_role_is_default FROM system.role_grants'),
        query('SELECT user_name, role_name, access_type, database, table, column, is_partial_revoke, grant_option FROM system.grants'),
        query('SELECT short_name, database, table, select_filter, is_restrictive, apply_to_all, apply_to_list, apply_to_except FROM system.row_policies'),
    ]);
    return {rules: rules.map(r => ({rule_id: r.rule_id, revision: r.last_revision, name: r.last_name, spec: JSON.parse(r.last_spec), enabled: r.last_enabled,
        deleted: r.last_deleted, created_by: r.last_created_by})), definitions, values, classifications, owned,
        users: users.map(u => u.name), observed: {roles, role_grants, grants, policies}};
}

async function cycle() {
    if (FEED) {
        try {
            const result = await importFeed();
            log('attribute feed imported', result);
        } catch (e) {
            log('attribute feed failed: values keep aging and become stale after their freshness limit', {error: e.message});
        }
    }
    const state = await loadState();
    const {desired, rejected} = model.dapDesired(state.rules, state.definitions, state.values, state.classifications, state.users, state.owned, Date.now() / 1000);
    for (const r of rejected) log('rule not representable', {rule: r.rule.name, problem: r.problem});
    const plan = model.dapPlan(desired, state.observed, state.owned, CLUSTER, false);
    for (const c of plan.conflicts) log('left alone', {key: c.key, reason: c.message});
    for (const r of plan.removed_outside) log('removed outside the platform, not restored', {key: r.key});
    if (!plan.steps.length) return;

    const deployment_id = crypto.randomUUID();
    const authors = new Map(state.rules.map(r => [r.rule_id, r]));
    const results = [];
    const owned_rows = [];
    for (const step of plan.steps) {
        const rule = authors.get(step.rule_id);
        if (step.op === 'forget') {
            owned_rows.push({key: step.key, rule_id: step.rule_id, revision: rule ? rule.revision : 0, deployment_id, deleted: true});
            results.push({description: step.description, key: step.key, status: 'ok'});
            continue;
        }
        if (!rule) {
            results.push({description: step.description, key: step.key, status: 'failed', error: 'The rule that owns it is unknown: no author to act as.'});
            continue;
        }
        /// The statement runs with the privileges of the author of the rule's current revision.
        const sql = `EXECUTE AS ${q(rule.created_by)} ${step.sql}`;
        try {
            const settings = {log_comment: `console-admin:${deployment_id}`};
            if (CLUSTER) Object.assign(settings, {distributed_ddl_output_mode: 'never_throw', distributed_ddl_task_timeout: '30'});
            const text = await query(sql, {raw: true, settings});
            const hosts = CLUSTER ? text.trim().split('\n').filter(Boolean).map(line => {
                const [host, port, status, error] = line.split('\t');
                return {host: `${host}:${port}`, status: status === '' || status === '\\N' ? 'unfinished' : (Number(status) === 0 ? 'ok' : 'failed'), error: error || ''};
            }) : null;
            const failed = hosts ? hosts.filter(h => h.status !== 'ok') : [];
            const status = !failed.length ? 'ok' : (failed.length === hosts.length ? 'failed' : 'partial');
            results.push({description: step.description, key: step.key, status, hosts, author: rule.created_by});
            if (status !== 'failed') owned_rows.push({key: step.key, rule_id: step.rule_id, revision: rule.revision, deployment_id, deleted: step.op === 'remove'});
        } catch (e) {
            results.push({description: step.description, key: step.key, status: 'failed', error: e.message, author: rule.created_by});
        }
    }
    if (owned_rows.length) {
        await query(`INSERT INTO ${table('dap_owned')} (key, rule_id, revision, deployment_id, deleted) FORMAT JSONEachRow\n${owned_rows.map(r => JSON.stringify(r)).join('\n')}`, {raw: true});
    }
    const ok = results.filter(r => r.status === 'ok').length;
    const result = ok === results.length ? 'success' : (results.some(r => r.status !== 'failed') ? 'partial' : 'failure');
    const rules = desired.map(d => ({rule_id: d.rule.rule_id, revision: d.rule.revision, name: d.rule.name}));
    await query(`INSERT INTO ${table('dap_deployments')} (deployment_id, kind, scope, rules, steps, result, verification) FORMAT JSONEachRow\n`
        + JSON.stringify({deployment_id, kind: 'reconcile', scope: CLUSTER, rules: JSON.stringify(rules), steps: JSON.stringify(results), result, verification: ''}), {raw: true});
    await query(`INSERT INTO ${table('audit_log')} (correlation_id, scope, target_type, target_name, action, summary, result, error, details) FORMAT JSONEachRow\n`
        + JSON.stringify({correlation_id: deployment_id, scope: CLUSTER ? `cluster:${CLUSTER}` : 'local', target_type: 'data_access', target_name: CLUSTER || os.hostname(),
            action: 'dap_reconcile', summary: `Reconcile ${rules.length} policy rules (${results.length} changes)`, result,
            error: results.filter(r => r.status !== 'ok').map(r => `${r.description}: ${r.error || r.status}`).join(' | ').slice(0, 2000),
            details: JSON.stringify({deployment_id, rules, steps: results})}), {raw: true});
    log('reconciled', {deployment_id, result, changes: results.length, failed: results.filter(r => r.status !== 'ok').map(r => r.key)});
}

async function main() {
    log('started', {server: URL_BASE, database: DB, cluster: CLUSTER || null, interval_seconds: INTERVAL / 1000, feed: FEED ? FEED_SOURCE : null});
    for (;;) {
        try {
            await cycle();
        } catch (e) {
            log('cycle failed', {error: e.message});
            if (ONCE) process.exitCode = 1;
        }
        if (ONCE) return;
        await new Promise(resolve => setTimeout(resolve, INTERVAL));
    }
}

main();
