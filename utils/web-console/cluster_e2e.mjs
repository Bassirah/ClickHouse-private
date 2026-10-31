/// Acceptance checks of Administration → Clusters of the web console (`/console/admin-clusters`).
///
/// A development tool, like `backup_e2e.mjs` (see `README.md`). It drives a running server through the browser while a
/// cluster agent runs with the docker-compose provider, and checks every result in the console tables and on Docker.
/// It creates lab clusters named `e2e-*` (containers labeled with their cluster), and retires and deletes them at the end.
///
/// Usage:
///   node cluster_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass [--register http://127.0.0.1:28123] [--screenshots dir]
///
/// The agent must serve the environment `lab` with the docker-compose provider, and the admin user must be able to create users.

import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE = arg('url', 'http://127.0.0.1:28123').replace(/\/+$/, '');
const [ADMIN_USER, ADMIN_PASSWORD] = arg('admin', 'default:devpass').split(':');
const REGISTER = arg('register', BASE);
const SCREENSHOTS = arg('screenshots', null);
const DB = 'console_admin';
const RUN = Date.now().toString(36);
if (SCREENSHOTS) fs.mkdirSync(SCREENSHOTS, {recursive: true});

const results = [];
function check(condition, message) {
    if (!condition) throw new Error(message);
}
async function test(name, body) {
    const started = Date.now();
    try {
        await body();
        results.push({name, ok: true});
        console.log(`PASS  ${name} (${Math.round((Date.now() - started) / 1000)} s)`);
    } catch (e) {
        results.push({name, ok: false});
        console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
    }
}

async function sql(query, user = ADMIN_USER, password = ADMIN_PASSWORD, params = {}) {
    const url = new URL(`${BASE}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, v);
    const response = await fetch(url, {method: 'POST', body: query, headers: {'X-ClickHouse-User': user, 'X-ClickHouse-Key': password}});
    return (await response.text()).trim();
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 120000, what = 'condition') {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(2000);
    }
}

const opState = op_id => sql(`SELECT argMax(state, at) FROM ${DB}.cluster_events WHERE op_id = {id:String} AND kind = 'state'`, ADMIN_USER, ADMIN_PASSWORD, {id: op_id});
const opMessage = op_id => sql(`SELECT argMax(message, at) FROM ${DB}.cluster_events WHERE op_id = {id:String} AND kind = 'state'`, ADMIN_USER, ADMIN_PASSWORD, {id: op_id});
const latestOp = (cluster_id, kind) => sql(`SELECT op_id FROM ${DB}.cluster_operations WHERE cluster_id = {c:String} AND kind = {k:String} ORDER BY requested_at DESC LIMIT 1`,
    ADMIN_USER, ADMIN_PASSWORD, {c: cluster_id, k: kind});
const clusterId = name => sql(`SELECT cluster_id FROM ${DB}.clusters FINAL WHERE name = {n:String} AND NOT deleted`, ADMIN_USER, ADMIN_PASSWORD, {n: name});
const lifecycle = cluster_id => sql(`SELECT argMax(state, at) FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND kind = 'lifecycle'`, ADMIN_USER, ADMIN_PASSWORD, {c: cluster_id});
async function finished(op_id, timeout = 600000) {
    await until(async () => ['succeeded', 'failed', 'rejected', 'cancelled', 'blocked'].includes(await opState(op_id)), timeout, `operation ${op_id}`);
    return opState(op_id);
}

const browser = await chromium.launch();
const page_errors = [];
let page = null;

async function signIn(user = ADMIN_USER, password = ADMIN_PASSWORD) {
    if (page) await page.context().close();
    page = await (await browser.newContext({viewport: {width: 1400, height: 1000}})).newPage();
    page.on('pageerror', e => page_errors.push(e.message));
    await page.goto(`${BASE}/console/login`);
    await page.fill('#login-user', user);
    await page.fill('#login-password', password);
    await page.click('#login-submit');
    await page.waitForSelector('#shell:not([hidden])');
    await sleep(2500);
    await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(d => d.close()));
}
async function go(target) {
    await page.evaluate(t => {
        const dialog = document.getElementById('admin-dialog');
        if (dialog.open) dialog.close();
        history.pushState(null, '', t);
        dispatchEvent(new PopStateEvent('popstate'));
    }, target);
    await until(() => page.evaluate(() => !document.querySelector('#admin-view .spinner')), 60000, 'the page to load');
    await sleep(300);
}
const dialog = () => page.locator('#admin-dialog');
async function applyPlan() {
    await dialog().locator('.dialog-actions button.primary').last().click();
    await dialog().locator('.dialog-actions button', {hasText: 'Close'}).waitFor({timeout: 60000});
    const text = await dialog().innerText();
    await page.evaluate(() => document.getElementById('admin-dialog').close());
    await sleep(800);
    return text;
}
async function review() {
    await dialog().locator('.dialog-actions button', {hasText: 'Review'}).click();
    await sleep(400);
    const errors = (await dialog().locator('form .message.error:not([hidden])').allInnerTexts()).filter(Boolean);
    if (errors.length) throw new Error(`form error: ${errors.join(' ')}`);
}
async function wizardNext() {
    await dialog().locator('.dialog-actions button.primary').click();
    await sleep(600);
    return (await dialog().locator('.message.error[role="alert"]:not([hidden])').allInnerTexts()).filter(Boolean).join(' ');
}
/// Opens a tab of a cluster. Closing a plan dialog navigates to the Operations tab, which can land after this
/// navigation: open the tab again until it is the one shown.
async function tab(id, name) {
    await until(async () => {
        await go(`/console/admin-clusters/${id}?tab=${name}`);
        await sleep(700);
        return page.evaluate(n => location.search.includes(`tab=${n}`), name);
    }, 30000, `the ${name} tab`);
}
/// Clicks a button of the page; on failure, reports the buttons that are there and whether they are enabled.
async function clickButton(text) {
    const target = page.locator('#admin-view button', {hasText: text});
    try {
        await target.first().click({timeout: 20000});
    } catch (e) {
        const buttons = await page.locator('#admin-view button').evaluateAll(list => list.map(b => `${b.textContent}${b.disabled ? ' (disabled)' : ''}`));
        throw new Error(`Cannot click "${text}". Buttons: ${buttons.join(', ')}. ${e.message.split('\n')[0]}`);
    }
}
const shot = async name => { if (SCREENSHOTS) await page.screenshot({path: path.join(SCREENSHOTS, `${name}.png`), fullPage: true}); };

// ---------------------------------------------------------------------------------------------

const NAME = `e2e-${RUN}`;
/// The administrator password typed in the wizard: it must not appear anywhere in the console tables or logs.
const ADMIN_SECRET = `E2e-Admin-${RUN}-Pw`;
let cluster = null;

for (const statement of ['DROP USER IF EXISTS e2e_cluster_viewer', "CREATE USER e2e_cluster_viewer IDENTIFIED BY 'E2e-cluster-viewer-1'",
    `GRANT SELECT ON ${DB}.* TO e2e_cluster_viewer`, `GRANT INSERT ON ${DB}.cluster_operations TO e2e_cluster_viewer`, `GRANT INSERT ON ${DB}.cluster_events TO e2e_cluster_viewer`,
    `GRANT INSERT(view_clusters) ON ${DB}.cluster_capabilities TO e2e_cluster_viewer`, 'GRANT console_admin_reader TO e2e_cluster_viewer']) {
    const result = await sql(statement);
    check(!/^Code: \d+/.test(result) || /console_admin_reader/.test(statement), `${statement}: ${result}`);
}

await test('Create a cluster in the wizard: provisioned by the agent and ready only after validation', async () => {
    await signIn();
    await go('/console/admin-clusters?tab=create');
    await page.locator('#admin-view button', {hasText: 'Create cluster'}).click();
    await dialog().getByLabel('Name').fill(NAME);
    await dialog().getByLabel('Environment').selectOption('lab');
    check(!(await wizardNext()), 'purpose step');
    check((await dialog().innerText()).includes('Not available'), 'unimplemented providers are not marked');
    check(!(await wizardNext()), 'provider step');
    await dialog().getByLabel('Shards').fill('1');
    await dialog().getByLabel('Replicas per shard').fill('2');
    await dialog().getByLabel('Keeper members').selectOption('3');
    await dialog().getByLabel('Client routing').selectOption('chproxy');
    check((await dialog().innerText()).includes('Clients connect to chproxy'), 'the routing is not explained');
    const tolerance = await dialog().innerText();
    check(tolerance.includes('one failure domain') && tolerance.includes('survives 1'), 'the topology does not explain what it tolerates');
    check(!(await wizardNext()), 'topology step');
    await dialog().getByLabel('CPUs per node').fill('1');
    await dialog().getByLabel('Memory per node (MiB)').fill('1536');
    check(!(await wizardNext()), 'storage step');
    await dialog().getByLabel('Administrator user').fill('e2e_admin');
    await dialog().getByLabel('Administrator password').fill(ADMIN_SECRET);
    await dialog().getByLabel('Confirm the password').fill(`${ADMIN_SECRET}x`);
    check((await wizardNext()).includes('do not match'), 'mismatched passwords accepted');
    await dialog().getByLabel('Confirm the password').fill(ADMIN_SECRET);
    check(!(await wizardNext()), 'security step');
    check(!(await wizardNext()), 'policies step');
    const plan = await dialog().innerText();
    check(plan.includes('Containers to create') && plan.includes('If provisioning fails'), 'the plan is incomplete');
    await wizardNext();
    const statements = await dialog().innerText();
    check(!statements.includes(ADMIN_SECRET) && statements.includes('encrypted for the agent'), 'the plan shows the administrator password, or does not say it is encrypted');
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    cluster = await clusterId(NAME);
    check(cluster, 'no cluster recorded');
    const op = await latestOp(cluster, 'provision');
    check(await finished(op) === 'succeeded', `provisioning: ${await opState(op)} ${await opMessage(op)}`);
    const steps = await sql(`SELECT groupArray(step) FROM (SELECT step FROM ${DB}.cluster_events WHERE op_id = {id:String} AND kind = 'step' AND state = 'done' ORDER BY at)`,
        ADMIN_USER, ADMIN_PASSWORD, {id: op});
    check(steps.includes('replication') && steps.includes('topology') && steps.includes('routing'), `validation steps missing: ${steps}`);
    /// Clients reach the cluster through chproxy with the generated proxy password, on every node.
    const spec = JSON.parse(await sql(`SELECT spec FROM ${DB}.cluster_revisions WHERE cluster_id = {c:String} ORDER BY revision DESC LIMIT 1`, ADMIN_USER, ADMIN_PASSWORD, {c: cluster}));
    const dir = await sql(`SELECT JSONExtractString(data, 'directory') FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND step = 'render' AND state = 'done' AND data LIKE '%directory%' LIMIT 1`,
        ADMIN_USER, ADMIN_PASSWORD, {c: cluster});
    const proxy_password = fs.readFileSync(path.join(dir, 'secrets.env'), 'utf8').match(/CH_PROXY_PASSWORD=(.*)/)[1];
    check(!fs.readFileSync(path.join(dir, 'chproxy', 'config.yml'), 'utf8').includes(proxy_password), 'the chproxy configuration contains a password');
    const hosts = new Set();
    for (let i = 0; i < 12; i++) {
        hosts.add((await (await fetch(`http://127.0.0.1:${spec.routing.port}/?query=SELECT+hostName()`, {headers: {'X-ClickHouse-User': 'app', 'X-ClickHouse-Key': proxy_password}})).text()).trim());
    }
    check(JSON.stringify([...hosts].sort()) === '["s1r1","s1r2"]', `chproxy routed to ${[...hosts].join(', ')}`);
    /// The administrator user signs in with the password typed in the wizard; chproxy forwards to it.
    for (const r of spec.shards[0].replicas) {
        const who = (await (await fetch(`http://127.0.0.1:${r.http_port}/?query=SELECT+currentUser()`, {headers: {'X-ClickHouse-User': 'e2e_admin', 'X-ClickHouse-Key': ADMIN_SECRET}})).text()).trim();
        check(who === 'e2e_admin', `${r.name}: the administrator cannot sign in: ${who}`);
    }
    const via_proxy = (await (await fetch(`http://127.0.0.1:${spec.routing.port}/?query=SELECT+currentUser()`, {headers: {'X-ClickHouse-User': 'app', 'X-ClickHouse-Key': proxy_password}})).text()).trim();
    check(via_proxy === 'e2e_admin', `chproxy forwards as ${via_proxy}`);
    await sql('SYSTEM FLUSH LOGS');
    for (const table of ['clusters', 'cluster_revisions', 'cluster_operations', 'cluster_events', 'cluster_observations', 'audit_log']) {
        check(await sql(`SELECT count() FROM ${DB}.${table} WHERE position(toString(tuple(*)), {p:String}) > 0`, ADMIN_USER, ADMIN_PASSWORD, {p: ADMIN_SECRET}) === '0', `the password is in ${table}`);
    }
    check(await sql(`SELECT count() FROM system.query_log WHERE event_time > now() - 3600 AND position(query, {p:String}) > 0`, ADMIN_USER, ADMIN_PASSWORD, {p: ADMIN_SECRET}) === '0', 'the password is in the query log');
    check(!fs.readFileSync(path.join(dir, 'compose.yaml'), 'utf8').includes(ADMIN_SECRET) && !fs.readFileSync(path.join(dir, 's1r1', 'console-users.xml'), 'utf8').includes(ADMIN_SECRET),
        'the password is in a generated configuration file');
    check((await fetch(`http://127.0.0.1:${spec.routing.port}/?query=SELECT+1`, {headers: {'X-ClickHouse-User': 'app', 'X-ClickHouse-Key': 'wrong'}})).status !== 200, 'chproxy accepted a wrong password');
    await tab(cluster, 'nodes');
    const routing = await page.locator('#admin-view .box', {hasText: 'Client routing'}).innerText();
    check(routing.includes('s1r1: healthy') || routing.includes('Not observed'), `routing view: ${routing.slice(0, 300)}`);
    check(await lifecycle(cluster) === 'ready', `lifecycle ${await lifecycle(cluster)}`);
    check(execFileSync('docker', ['ps', '--filter', `label=io.clickhouse.console.cluster=${cluster}`, '--format', '{{.Names}}']).toString().trim().split('\n').length === 6, 'not 6 containers (2 nodes, 3 Keeper members, chproxy)');
    await tab(cluster, 'operations');
    check((await page.locator('#admin-view').innerText()).includes('Succeeded'), 'the operation is not shown as succeeded');
    await shot('c01-provisioned');
});

await test('Submit the same creation twice: one deployment is provisioned', async () => {
    const op_id = crypto.randomUUID();
    await sql(`INSERT INTO ${DB}.cluster_operations (op_id, cluster_id, kind, revision, parameters) VALUES ({o:String}, {c:String}, 'provision', 1, '{}')`, ADMIN_USER, ADMIN_PASSWORD, {o: op_id, c: cluster});
    await sql(`INSERT INTO ${DB}.cluster_events (op_id, cluster_id, kind, state) VALUES ({o:String}, {c:String}, 'state', 'queued')`, ADMIN_USER, ADMIN_PASSWORD, {o: op_id, c: cluster});
    check(await finished(op_id) === 'rejected', `second provisioning: ${await opState(op_id)}`);
    check((await opMessage(op_id)).includes('already provisioned'), 'no reason');
    check(execFileSync('docker', ['ps', '-a', '--filter', `label=io.clickhouse.console.cluster=${cluster}`, '--format', '{{.Names}}']).toString().trim().split('\n').length === 6, 'resources were duplicated');
});

await test('Unauthorized user calls a lifecycle operation: it is rejected', async () => {
    const viewer = ['e2e_cluster_viewer', 'E2e-cluster-viewer-1'];
    await signIn(...viewer);
    await tab(cluster, 'nodes');
    check(await page.locator('#admin-view button', {hasText: 'Restart'}).first().isDisabled(), 'Restart is enabled for a viewer');
    const op_id = crypto.randomUUID();
    await sql(`INSERT INTO ${DB}.cluster_operations (op_id, cluster_id, kind, revision, parameters) VALUES ({o:String}, {c:String}, 'restart_node', 2, '{"nodes":["s1r1"]}')`, ...viewer, {o: op_id, c: cluster});
    await sql(`INSERT INTO ${DB}.cluster_events (op_id, cluster_id, kind, state) VALUES ({o:String}, {c:String}, 'state', 'queued')`, ...viewer, {o: op_id, c: cluster});
    check(await finished(op_id) === 'rejected', `state ${await opState(op_id)}`);
    check((await opMessage(op_id)).includes('does not have the capability maintain'), await opMessage(op_id));
    check(/Code: 497/.test(await sql(`INSERT INTO ${DB}.clusters (cluster_id, name) VALUES ('forged', 'forged')`, ...viewer)), 'a viewer could register a cluster');
});

await test('Register an existing deployment: it is inventoried in Observe mode without changes', async () => {
    await signIn();
    const before = await sql(`SELECT count() FROM system.query_log WHERE type = 'QueryFinish' AND query_kind IN ('Create', 'Alter', 'Drop', 'System') AND user = {u:String} AND event_time > now() - 3600`,
        ADMIN_USER, ADMIN_PASSWORD, {u: ADMIN_USER});
    await go('/console/admin-clusters?tab=register');
    await page.locator('#admin-view button', {hasText: 'Register deployment'}).click();
    await dialog().getByLabel('Name').fill(`${NAME}-reg`);
    await dialog().getByLabel('Endpoints').fill(REGISTER);
    await dialog().getByLabel('Credential reference').fill('PLATFORM');
    await review();
    check((await applyPlan()).includes('Applied.'), 'not registered');
    const id = await clusterId(`${NAME}-reg`);
    const op = await latestOp(id, 'register');
    check(await finished(op) === 'succeeded', `discovery: ${await opMessage(op)}`);
    check(await sql(`SELECT argMax(state, at) FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND kind = 'mode'`, ADMIN_USER, ADMIN_PASSWORD, {c: id}) === 'observe', 'not in Observe mode');
    await tab(id, 'nodes');
    const text = await page.locator('#admin-view').innerText();
    check(text.includes('not proof of membership'), 'the provenance of the topology is not shown');
    await sql('SYSTEM FLUSH LOGS');
    const after = await sql(`SELECT count() FROM system.query_log WHERE type = 'QueryFinish' AND query_kind IN ('Create', 'Alter', 'Drop', 'System') AND user = {u:String} AND event_time > now() - 3600
        AND query NOT LIKE '%FLUSH LOGS%'`, ADMIN_USER, ADMIN_PASSWORD, {u: ADMIN_USER});
    check(Number(after) <= Number(before) + 1, `discovery changed the registered server (${before} → ${after} DDL/SYSTEM statements)`);
    await tab(id, 'scaling');
    check((await page.locator('#admin-view').innerText()).includes('needs a managed cluster'), 'scaling offered for an observed deployment');
    await shot('c02-registered');
});

await test('Change configuration, then change it outside the console: drift is detected', async () => {
    await signIn();
    await tab(cluster, 'configuration');
    await page.locator('#admin-view button', {hasText: 'Change settings'}).click();
    await dialog().getByLabel('max_concurrent_queries (server)').fill('120');
    await dialog().getByLabel('keep_alive_timeout (server)').fill('15');
    await review();
    check((await dialog().innerText()).includes('rolling restart'), 'no restart warning');
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'configure');
    check(await finished(op) === 'succeeded', `configure: ${await opMessage(op)}`);
    const restarts = await sql(`SELECT count() FROM ${DB}.cluster_events WHERE op_id = {id:String} AND kind = 'step' AND state = 'done' AND step LIKE 'restart:%'`, ADMIN_USER, ADMIN_PASSWORD, {id: op});
    check(restarts === '2', `keep_alive_timeout needs a restart of both nodes, restarted ${restarts}`);
    const state_dir = (await sql(`SELECT JSONExtractString(data, 'directory') FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND step = 'render' AND state = 'done' AND data LIKE '%directory%' LIMIT 1`,
        ADMIN_USER, ADMIN_PASSWORD, {c: cluster}));
    const file = path.join(state_dir, 's1r1', 'console-settings.xml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<max_concurrent_queries>120</max_concurrent_queries>', '<max_concurrent_queries>77</max_concurrent_queries>'));
    await until(async () => (await sql(`SELECT argMax(state, at) FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND kind = 'drift'`, ADMIN_USER, ADMIN_PASSWORD, {c: cluster})) === 'drift',
        180000, 'drift to be detected');
    await until(async () => (await sql(`SELECT argMax(data, at) FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND kind = 'drift'`, ADMIN_USER, ADMIN_PASSWORD, {c: cluster})).includes('"observed":"77"'),
        180000, 'the observed value in the drift');
    await tab(cluster, 'configuration');
    const text = await page.locator('#admin-view').innerText();
    check(text.includes('edited outside the console') && text.includes('77'), 'drift not shown');
    await shot('c03-drift');
    await page.locator('#admin-view button', {hasText: 'Apply the desired configuration'}).click();
    check((await applyPlan()).includes('Applied.'), 'reconcile not submitted');
    const reconcile = await latestOp(cluster, 'reconcile');
    check(await finished(reconcile) === 'succeeded', `reconcile: ${await opMessage(reconcile)}`);
});

await test('Add a replica: synchronization completes before readiness', async () => {
    const ports = JSON.parse(await sql(`SELECT spec FROM ${DB}.cluster_revisions WHERE cluster_id = {c:String} ORDER BY revision DESC LIMIT 1`, ADMIN_USER, ADMIN_PASSWORD, {c: cluster}));
    const dir = await sql(`SELECT JSONExtractString(data, 'directory') FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND step = 'render' AND state = 'done' AND data LIKE '%directory%' LIMIT 1`,
        ADMIN_USER, ADMIN_PASSWORD, {c: cluster});
    const secrets = fs.readFileSync(path.join(dir, 'secrets.env'), 'utf8');
    const password = secrets.match(/CH_ADMIN_PASSWORD=(.*)/)[1];
    const node = q => fetch(`http://127.0.0.1:${ports.shards[0].replicas[0].http_port}/`, {method: 'POST', body: q, headers: {'X-ClickHouse-User': 'console_service', 'X-ClickHouse-Key': password}}).then(r => r.text());
    await node('CREATE DATABASE IF NOT EXISTS app ON CLUSTER main');
    await node("CREATE TABLE IF NOT EXISTS app.events ON CLUSTER main (id UInt64, v String) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/app/events', '{replica}') ORDER BY id");
    await node("INSERT INTO app.events SELECT number, toString(number) FROM numbers(50000)");
    await tab(cluster, 'scaling');
    await page.locator('#admin-view button', {hasText: 'Add replica'}).click();
    await review();
    check((await dialog().innerText()).includes('caught up'), 'no readiness condition in the plan');
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'add_replica');
    check(await finished(op) === 'succeeded', `add replica: ${await opMessage(op)}`);
    const sync = await sql(`SELECT data FROM ${DB}.cluster_events WHERE op_id = {id:String} AND step = 'sync' AND state = 'done'`, ADMIN_USER, ADMIN_PASSWORD, {id: op});
    check(sync.includes('"replicated_tables":1'), `sync evidence: ${sync}`);
    const order = await sql(`SELECT groupArray(step) FROM (SELECT step FROM ${DB}.cluster_events WHERE op_id = {id:String} AND kind = 'step' AND state = 'done' ORDER BY at)`, ADMIN_USER, ADMIN_PASSWORD, {id: op});
    check(order.indexOf('sync') < order.indexOf('topology'), `readiness declared before synchronization: ${order}`);
    check(order.includes('routing'), `the new replica was not added to chproxy: ${order}`);
    const spec = JSON.parse(await sql(`SELECT spec FROM ${DB}.cluster_revisions WHERE cluster_id = {c:String} ORDER BY revision DESC LIMIT 1`, ADMIN_USER, ADMIN_PASSWORD, {c: cluster}));
    const proxyNodes = async () => [...(await (await fetch(`http://127.0.0.1:${spec.routing.port}/metrics`)).text()).matchAll(/^host_health\{[^}]*cluster_node="([^":]+):\d+"[^}]*\} 1/gm)].map(m => m[1]).sort();
    check(JSON.stringify(await proxyNodes()) === '["s1r1","s1r2","s1r3"]', `chproxy routes to ${await proxyNodes()}`);
    /// Decommissioning the new replica takes it out of chproxy before it stops.
    await tab(cluster, 'nodes');
    await page.locator('#admin-view tr', {hasText: 's1r3'}).locator('button', {hasText: 'Decommission'}).click();
    check((await dialog().innerText()).includes('chproxy stops routing queries to the node'), 'the decommission dialog does not mention chproxy');
    await dialog().getByLabel('Type s1r3 to confirm').fill('s1r3');
    await review();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const removal = await latestOp(cluster, 'remove_replica');
    check(await finished(removal) === 'succeeded', `decommission: ${await opMessage(removal)}`);
    const steps = await sql(`SELECT groupArray(step) FROM (SELECT step FROM ${DB}.cluster_events WHERE op_id = {id:String} AND kind = 'step' AND state = 'done' ORDER BY at)`, ADMIN_USER, ADMIN_PASSWORD, {id: removal});
    check(steps.indexOf('routing') >= 0 && steps.indexOf('routing') < steps.indexOf('stop'), `the node was stopped before it left the routing: ${steps}`);
    check(JSON.stringify(await proxyNodes()) === '["s1r1","s1r2"]', `chproxy still routes to ${await proxyNodes()}`);
});

await test('Remove a required replica or Keeper member: the unsafe plan is rejected', async () => {
    const revision = await sql(`SELECT max(revision) FROM ${DB}.cluster_revisions WHERE cluster_id = {c:String}`, ADMIN_USER, ADMIN_PASSWORD, {c: cluster});
    const submit = async (kind, parameters) => {
        const op_id = crypto.randomUUID();
        await sql(`INSERT INTO ${DB}.cluster_operations (op_id, cluster_id, kind, revision, parameters) VALUES ({o:String}, {c:String}, {k:String}, {r:UInt32}, {p:String})`,
            ADMIN_USER, ADMIN_PASSWORD, {o: op_id, c: cluster, k: kind, r: revision, p: JSON.stringify(parameters)});
        await sql(`INSERT INTO ${DB}.cluster_events (op_id, cluster_id, kind, state) VALUES ({o:String}, {c:String}, 'state', 'queued')`, ADMIN_USER, ADMIN_PASSWORD, {o: op_id, c: cluster});
        return op_id;
    };
    const keeper = await submit('remove_replica', {node: 'keeper1'});
    check(await finished(keeper) === 'rejected', `Keeper member: ${await opState(keeper)}`);
    const change = await submit('keeper_change', {remove: 'keeper2'});
    check(await finished(change) === 'rejected' && /not implement/.test(await opMessage(change)), 'Keeper membership change not refused');
    await tab(cluster, 'nodes');
    await shot('c04-nodes');
});

await test('Add a shard: the historical data placement is explicit', async () => {
    await tab(cluster, 'scaling');
    await page.locator('#admin-view button', {hasText: 'Add shard'}).click();
    await dialog().getByLabel('Replicas of the new shard').fill('1');
    await dialog().locator('.dialog-actions button', {hasText: 'Review'}).click();
    await sleep(300);
    check((await dialog().innerText()).includes('Confirm that you understand the data placement'), 'submitted without the acknowledgement');
    check((await dialog().innerText()).includes('nothing is redistributed'), 'no data placement explanation');
    await dialog().locator('label', {hasText: 'existing rows stay on their shards'}).locator('input').check();
    await review();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'add_shard');
    check(await finished(op) === 'succeeded', `add shard: ${await opMessage(op)}`);
    const schema = await sql(`SELECT data FROM ${DB}.cluster_events WHERE op_id = {id:String} AND step = 'schema' AND state = 'done'`, ADMIN_USER, ADMIN_PASSWORD, {id: op});
    check(schema.includes('Existing rows stay on their shards'), 'no placement evidence');
    /// The new shard has one replica: decommissioning it would remove the shard's data, which is refused.
    await tab(cluster, 'nodes');
    await page.locator('#admin-view tr', {hasText: 's2r1'}).locator('button', {hasText: 'Decommission'}).click();
    check((await dialog().innerText()).includes('last replica of shard 2'), 'no warning in the dialog');
    await dialog().getByLabel('Type s2r1 to confirm').fill('s2r1');
    await review();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const removal = await latestOp(cluster, 'remove_replica');
    check(await finished(removal) === 'rejected' && (await opMessage(removal)).includes('last replica'), `last replica: ${await opState(removal)} ${await opMessage(removal)}`);
});

await test('A node becomes unreachable: its state is failed or unreachable, never fabricated healthy', async () => {
    const container = execFileSync('docker', ['ps', '--filter', `label=io.clickhouse.console.cluster=${cluster}`, '--filter', 'name=s1r2', '--format', '{{.Names}}']).toString().trim();
    execFileSync('docker', ['stop', container]);
    try {
        await until(async () => (await sql(`SELECT argMax(status, at) FROM ${DB}.cluster_observations WHERE cluster_id = {c:String} AND JSONExtractString(data, 'name') = 's1r2'`,
            ADMIN_USER, ADMIN_PASSWORD, {c: cluster})) === 'failed', 180000, 'the stopped node to be observed as failed');
        await until(async () => (await lifecycle(cluster)) === 'degraded', 120000, 'the cluster to become degraded');
        await tab(cluster, 'nodes');
        check((await page.locator('#admin-view').innerText()).includes('Failed (confirmed)'), 'the stopped node is not shown as failed');
        await shot('c05-degraded');
    } finally {
        execFileSync('docker', ['start', container]);
    }
    await until(async () => (await lifecycle(cluster)) === 'ready', 240000, 'the cluster to be ready again');
});

await test('Retire with unresolved dependencies or without protection: the gates hold', async () => {
    await tab(cluster, 'retirement');
    await page.locator('#admin-view button', {hasText: 'Start retirement'}).click();
    const error = await wizardNext();
    check(error.includes('needs a disposition'), `dependencies not required: ${error}`);
    for (const select of await dialog().locator('select').all()) await select.selectOption('none');
    check(!(await wizardNext()), 'dependency step');
    await dialog().getByLabel('Final backup').selectOption('');
    await dialog().getByLabel('Reason no backup is needed').fill('e2e: the data is synthetic');
    check(!(await wizardNext()), 'protection step');
    await wizardNext();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'retire');
    check(await finished(op) === 'rejected', `retirement of a cluster with data and no backup: ${await opState(op)}`);
    check((await opMessage(op)).includes('a final backup is required'), await opMessage(op));
    check(await sql(`SELECT argMax(state, at) FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND kind = 'mode'`, ADMIN_USER, ADMIN_PASSWORD, {c: cluster}) === 'manage', 'the cluster changed mode');
});

await test('Retire a cluster, then delete only the approved resources: records remain', async () => {
    /// The synthetic data is dropped, so that the cluster can be retired without a final backup.
    const spec = JSON.parse(await sql(`SELECT spec FROM ${DB}.cluster_revisions WHERE cluster_id = {c:String} ORDER BY revision DESC LIMIT 1`, ADMIN_USER, ADMIN_PASSWORD, {c: cluster}));
    const dir = await sql(`SELECT JSONExtractString(data, 'directory') FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND step = 'render' AND state = 'done' AND data LIKE '%directory%' LIMIT 1`,
        ADMIN_USER, ADMIN_PASSWORD, {c: cluster});
    const password = fs.readFileSync(path.join(dir, 'secrets.env'), 'utf8').match(/CH_ADMIN_PASSWORD=(.*)/)[1];
    await fetch(`http://127.0.0.1:${spec.shards[0].replicas[0].http_port}/`, {method: 'POST', body: 'DROP DATABASE app ON CLUSTER main SYNC',
        headers: {'X-ClickHouse-User': 'console_service', 'X-ClickHouse-Key': password}}).then(r => r.text());
    await tab(cluster, 'retirement');
    await page.locator('#admin-view button', {hasText: 'Start retirement'}).click();
    for (const select of await dialog().locator('select').all()) await select.selectOption('none');
    await wizardNext();
    await dialog().getByLabel('Reason no backup is needed').fill('e2e: the data is synthetic');
    await dialog().getByLabel('Keep retained resources until').fill('2026-01-01');
    await wizardNext();
    await wizardNext();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'retire');
    check(await finished(op) === 'succeeded', `retire: ${await opMessage(op)}`);
    check(execFileSync('docker', ['ps', '--filter', `label=io.clickhouse.console.cluster=${cluster}`, '--format', '{{.Names}}']).toString().trim() === '', 'containers still running');
    await tab(cluster, 'retirement');
    await shot('c06-retired');
    const volumes = () => execFileSync('docker', ['volume', 'ls', '--filter', `label=io.clickhouse.console.cluster=${cluster}`, '--format', '{{.Name}}']).toString().trim().split('\n').filter(Boolean);
    const before = volumes();
    check(before.length >= 5, `volumes: ${before.join(', ')}`);
    await clickButton('Delete resources');
    for (const label of await dialog().locator('label', {hasText: /^container /}).all()) await label.locator('input').check();
    await dialog().locator('label', {hasText: /^network /}).locator('input').check();
    await dialog().getByLabel(`Type ${NAME} to confirm`).fill(NAME);
    await review();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const destroy = await latestOp(cluster, 'destroy');
    check(await finished(destroy) === 'succeeded', `destroy: ${await opMessage(destroy)}`);
    check(execFileSync('docker', ['ps', '-a', '--filter', `label=io.clickhouse.console.cluster=${cluster}`, '--format', '{{.Names}}']).toString().trim() === '', 'containers remain');
    check(JSON.stringify(volumes()) === JSON.stringify(before), 'volumes that were not approved were deleted');
    check(Number(await sql(`SELECT count() FROM ${DB}.audit_log WHERE details LIKE {c:String}`, ADMIN_USER, ADMIN_PASSWORD, {c: `%${cluster}%`})) > 0, 'no audit records');
    check(Number(await sql(`SELECT count() FROM ${DB}.cluster_revisions WHERE cluster_id = {c:String}`, ADMIN_USER, ADMIN_PASSWORD, {c: cluster})) > 0, 'configuration history lost');
    /// Cleanup: the volumes of the test cluster.
    await tab(cluster, 'retirement');
    await clickButton('Delete resources');
    for (const label of await dialog().locator('label', {hasText: /^(volume|directory) /}).all()) await label.locator('input').check();
    await dialog().getByLabel(`Type ${NAME} to confirm`).fill(NAME);
    await review();
    await applyPlan();
    check(await finished(await latestOp(cluster, 'destroy')) === 'succeeded', 'cleanup failed');
});

await test('No script errors in the pages', async () => {
    check(!page_errors.length, page_errors.join('\n'));
});

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
