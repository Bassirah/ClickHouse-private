/// Acceptance checks of the Kubernetes provider of Administration → Clusters (`/console/admin-clusters`).
///
/// A development tool, like `cluster_e2e.mjs` (see `README.md`). It drives a running server through the browser while a
/// cluster agent runs with the Kubernetes provider (CLUSTER_AGENT_KUBECONFIG) against a Kubernetes cluster with the
/// ClickHouse operator, and checks every result in Kubernetes with kubectl and in ClickHouse. It creates clusters named
/// `k8s-*` in namespaces `chc-k8s-*`, retires them, and deletes their resources.
///
/// Usage:
///   node cluster_k8s_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass --kubeconfig <path>
///       --expandable csi-hostpath-expandable --fixed local-path [--destination 'e2e s3'] [--screenshots dir]
///
/// `--expandable` is a storage class that allows volume expansion, `--fixed` one that does not. `--destination` is the
/// name of an S3 destination of Backup & Restore that the pods can reach, for the backup and the protected retirement.

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
const KUBECONFIG = arg('kubeconfig', process.env.KUBECONFIG || '');
const EXPANDABLE = arg('expandable', 'csi-hostpath-expandable');
const FIXED = arg('fixed', 'local-path');
const DESTINATION = arg('destination', null);
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

async function sql(query, params = {}) {
    const url = new URL(`${BASE}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, v);
    const response = await fetch(url, {method: 'POST', body: query, headers: {'X-ClickHouse-User': ADMIN_USER, 'X-ClickHouse-Key': ADMIN_PASSWORD}});
    return (await response.text()).trim();
}
function kubectl(...args) {
    return execFileSync('kubectl', ['--kubeconfig', KUBECONFIG, ...args], {stdio: ['ignore', 'pipe', 'pipe']}).toString();
}
const kubeJSON = (...args) => JSON.parse(kubectl(...args, '-o', 'json'));
/// A query on a pod as the administrator, with the client in the pod (not through the agent).
function podQuery(namespace, pod, user, password, query) {
    try {
        return execFileSync('kubectl', ['--kubeconfig', KUBECONFIG, '-n', namespace, 'exec', pod, '--', 'clickhouse-client', '--user', user, '--password', password, '-q', query],
            {stdio: ['ignore', 'pipe', 'pipe']}).toString().trim();
    } catch (e) {
        return `ERROR ${String(e.stderr).split('\n')[0]}`;
    }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 120000, what = 'condition') {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(3000);
    }
}
const opState = op_id => sql(`SELECT argMax(state, at) FROM ${DB}.cluster_events WHERE op_id = {id:String} AND kind = 'state'`, {id: op_id});
const opMessage = op_id => sql(`SELECT argMax(message, at) FROM ${DB}.cluster_events WHERE op_id = {id:String} AND kind = 'state'`, {id: op_id});
const latestOp = (cluster_id, kind) => sql(`SELECT op_id FROM ${DB}.cluster_operations WHERE cluster_id = {c:String} AND kind = {k:String} ORDER BY requested_at DESC LIMIT 1`, {c: cluster_id, k: kind});
const clusterId = name => sql(`SELECT cluster_id FROM ${DB}.clusters FINAL WHERE name = {n:String} AND NOT deleted`, {n: name});
const lifecycle = cluster_id => sql(`SELECT argMax(state, at) FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND kind = 'lifecycle'`, {c: cluster_id});
const specOf = async cluster_id => JSON.parse(await sql(`SELECT spec FROM ${DB}.cluster_revisions WHERE cluster_id = {c:String} ORDER BY revision DESC LIMIT 1`, {c: cluster_id}));
async function finished(op_id, timeout = 1500000) {
    await until(async () => ['succeeded', 'failed', 'rejected', 'cancelled', 'blocked', 'unknown'].includes(await opState(op_id)), timeout, `operation ${op_id}`);
    return opState(op_id);
}
const resource = cluster_id => `chc-${cluster_id.replace(/-/g, '').slice(0, 10)}`;

const browser = await chromium.launch();
const page_errors = [];
let page = null;

async function signIn() {
    if (page) await page.context().close();
    page = await (await browser.newContext({viewport: {width: 1400, height: 1000}})).newPage();
    page.on('pageerror', e => page_errors.push(e.message));
    await page.goto(`${BASE}/console/login`);
    await page.fill('#login-user', ADMIN_USER);
    await page.fill('#login-password', ADMIN_PASSWORD);
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
    await sleep(500);
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
    await sleep(500);
    const errors = (await dialog().locator('form .message.error:not([hidden])').allInnerTexts()).filter(Boolean);
    if (errors.length) throw new Error(`form error: ${errors.join(' ')}`);
}
async function wizardNext() {
    await dialog().locator('.dialog-actions button.primary').click();
    await sleep(700);
    return (await dialog().locator('.message.error[role="alert"]:not([hidden])').allInnerTexts()).filter(Boolean).join(' ');
}
async function tab(id, name) {
    await until(async () => {
        await go(`/console/admin-clusters/${id}?tab=${name}`);
        await sleep(700);
        return page.evaluate(n => location.search.includes(`tab=${n}`), name);
    }, 30000, `the ${name} tab`);
}
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

/// Creates a cluster with the wizard and the Kubernetes provider.
async function createCluster(name, {storage_class, reclaim, service, replicas = 2, keepers = 3, data_gi = 1}) {
    await go('/console/admin-clusters?tab=create');
    await page.locator('#admin-view button', {hasText: 'Create cluster'}).click();
    await dialog().getByLabel('Name').fill(name);
    await dialog().getByLabel('Environment').selectOption('lab');
    check(!(await wizardNext()), 'purpose step');
    await dialog().locator('input[value="kubernetes"]').check();
    await dialog().getByLabel('Storage class').selectOption(storage_class);
    await dialog().getByLabel('Volume reclaim policy').selectOption(reclaim);
    await dialog().getByLabel('Client Service').selectOption(service);
    check(!(await wizardNext()), 'provider step');
    check(await dialog().getByLabel('Client routing').isDisabled(), 'chproxy is offered on Kubernetes');
    await dialog().getByLabel('Shards').fill('1');
    await dialog().getByLabel('Replicas per shard').fill(String(replicas));
    await dialog().getByLabel('Keeper members').selectOption(String(keepers));
    check(!(await wizardNext()), 'topology step');
    await dialog().getByLabel('CPUs per node').fill('1');
    await dialog().getByLabel('Memory per node (MiB)').fill('1536');
    await dialog().getByLabel('Data volume per node (GiB)').fill(String(data_gi));
    await dialog().getByLabel('Keeper volume per member (GiB)').fill('1');
    check(!(await wizardNext()), 'storage step');
    await dialog().getByLabel('Administrator user').fill('k8s_admin');
    await dialog().getByLabel('Administrator password').fill(ADMIN_SECRET);
    await dialog().getByLabel('Confirm the password').fill(ADMIN_SECRET);
    check(!(await wizardNext()), 'security step');
    check(!(await wizardNext()), 'policies step');
    const plan = await dialog().innerText();
    check(plan.includes('KeeperCluster') && plan.includes(`reclaim policy ${reclaim}`) && plan.includes(`class ${storage_class}`), `the plan does not show the choices: ${plan.slice(0, 400)}`);
    await wizardNext();
    const statements = await dialog().innerText();
    check(!statements.includes(ADMIN_SECRET), 'the plan shows the administrator password');
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const id = await clusterId(name);
    check(id, 'no cluster recorded');
    return id;
}

const ADMIN_SECRET = `K8s-Admin-${RUN}-Pw`;
const NAME = `k8s-${RUN}`;
const NAMESPACE = `chc-${NAME}`;
let cluster = null;

await signIn();

await test('The wizard refuses a namespace the agent may not use', async () => {
    await go('/console/admin-clusters?tab=create');
    await page.locator('#admin-view button', {hasText: 'Create cluster'}).click();
    await dialog().getByLabel('Name').fill(`k8s-refused-${RUN}`);
    check(!(await wizardNext()), 'purpose step');
    await dialog().locator('input[value="kubernetes"]').check();
    check((await dialog().innerText()).includes('Verified'), 'the operator version is not shown as verified');
    await dialog().getByLabel('Namespace', {exact: true}).first().selectOption('create');
    await dialog().locator('input[placeholder^="chc-"]').fill('kube-system');
    const error = await wizardNext();
    check(error.includes('may not use the namespace kube-system'), `the namespace was accepted: ${error}`);
    await shot('k01-namespace-refused');
    await page.evaluate(() => document.getElementById('admin-dialog').close());
});

await test('Create a cluster on Kubernetes with the chosen storage class, reclaim policy, and client Service', async () => {
    cluster = await createCluster(NAME, {storage_class: EXPANDABLE, reclaim: 'Retain', service: 'ClusterIP'});
    const op = await latestOp(cluster, 'provision');
    check(await finished(op) === 'succeeded', `provisioning: ${await opState(op)} ${await opMessage(op)}`);
    const name = resource(cluster);
    const ch = kubeJSON('-n', NAMESPACE, 'get', 'clickhousecluster', name);
    check(ch.spec.dataVolumeClaimSpec.storageClassName === EXPANDABLE, 'the storage class was not applied');
    check(!JSON.stringify(ch).includes(ADMIN_SECRET) && !JSON.stringify(kubeJSON('-n', NAMESPACE, 'get', 'keepercluster', name)).includes(ADMIN_SECRET), 'the password is in the operator resources');
    const claims = kubeJSON('-n', NAMESPACE, 'get', 'pvc').items.filter(c => c.metadata.name.includes(name));
    const volumes = kubeJSON('get', 'pv').items.filter(v => claims.some(c => c.spec.volumeName === v.metadata.name));
    check(volumes.length === claims.length && volumes.length === 5, `expected 5 volumes (2 nodes, 3 Keeper members), found ${volumes.length}`);
    check(volumes.every(v => v.spec.persistentVolumeReclaimPolicy === 'Retain'), 'not every volume has reclaim policy Retain');
    const service = kubeJSON('-n', NAMESPACE, 'get', 'service', `${name}-client`);
    check(service.spec.type === 'ClusterIP', `client Service of type ${service.spec.type}`);
    for (const pod of [`${name}-clickhouse-0-0-0`, `${name}-clickhouse-0-1-0`]) {
        check(podQuery(NAMESPACE, pod, 'k8s_admin', ADMIN_SECRET, 'SELECT currentUser()') === 'k8s_admin', `${pod}: the administrator cannot sign in`);
    }
    await sql('SYSTEM FLUSH LOGS');
    for (const table of ['clusters', 'cluster_revisions', 'cluster_operations', 'cluster_events', 'cluster_observations', 'cluster_resources', 'audit_log']) {
        check(await sql(`SELECT count() FROM ${DB}.${table} WHERE position(toString(tuple(*)), {p:String}) > 0`, {p: ADMIN_SECRET}) === '0', `the password is in ${table}`);
    }
    check(await lifecycle(cluster) === 'ready', `lifecycle ${await lifecycle(cluster)}`);
    await tab(cluster, 'overview');
    const overview = await page.locator('#admin-view').innerText();
    check(overview.includes(NAMESPACE) && overview.includes(`${EXPANDABLE}`) && overview.includes('Retain'), 'the overview does not show the Kubernetes choices');
    await shot('k02-overview');
});

await test('Observation reports every node and Keeper member from the pods', async () => {
    await until(async () => Number(await sql(`SELECT countIf(status = 'ok') FROM (SELECT node_id, argMax(status, at) AS status FROM ${DB}.cluster_observations WHERE cluster_id = {c:String} GROUP BY node_id)`, {c: cluster})) === 5,
        120000, 'observations of 5 members');
    await tab(cluster, 'nodes');
    const badges = await page.locator('#admin-view .badge').allInnerTexts();
    check(badges.filter(b => b === 'Answers').length >= 2 && !badges.some(b => /^(Unreachable|Failed)/.test(b)), `node states: ${badges.join(', ')}`);
});

await test('Change a setting, then change the resource outside the console: drift is detected', async () => {
    const name = resource(cluster);
    /// Synthetic data in an ordinary database: the operator synchronizes only Replicated databases, so a new replica
    /// gets this table from the agent's schema copy. (`default` is Replicated, where ON CLUSTER is not allowed.)
    for (const statement of ['CREATE DATABASE app ON CLUSTER default',
        "CREATE TABLE app.events ON CLUSTER default (id UInt64) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/app/events', '{replica}') ORDER BY id",
        'INSERT INTO app.events SELECT number FROM numbers(3000)']) {
        const result = podQuery(NAMESPACE, `${name}-clickhouse-0-0-0`, 'k8s_admin', ADMIN_SECRET, statement);
        check(!result.startsWith('ERROR'), `${statement}: ${result}`);
    }
    await until(() => podQuery(NAMESPACE, `${name}-clickhouse-0-1-0`, 'k8s_admin', ADMIN_SECRET, 'SELECT count() FROM app.events') === '3000', 60000, 'the rows to replicate');
    await tab(cluster, 'configuration');
    await clickButton('Change settings');
    await dialog().getByLabel('max_concurrent_queries (server)').fill('140');
    await review();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'configure');
    check(await finished(op) === 'succeeded', `configure: ${await opState(op)} ${await opMessage(op)}`);
    check(podQuery(NAMESPACE, `${name}-clickhouse-0-1-0`, 'k8s_admin', ADMIN_SECRET, "SELECT value FROM system.server_settings WHERE name = 'max_concurrent_queries'") === '140', 'the setting is not applied');
    kubectl('-n', NAMESPACE, 'patch', 'clickhousecluster', name, '--type', 'merge', '-p', JSON.stringify({spec: {settings: {extraConfig: {max_concurrent_queries: 77}}}}));
    await until(async () => (await sql(`SELECT argMax(data, at) FROM ${DB}.cluster_events WHERE cluster_id = {c:String} AND kind = 'drift'`, {c: cluster})).includes('77'), 180000, 'the drift');
    await tab(cluster, 'configuration');
    check((await page.locator('#admin-view').innerText()).includes('77'), 'the drift is not shown');
    await shot('k03-drift');
    kubectl('-n', NAMESPACE, 'patch', 'clickhousecluster', name, '--type', 'merge', '-p', JSON.stringify({spec: {settings: {extraConfig: {max_concurrent_queries: 140}}}}));
});

await test('Expand the storage on a class that allows it', async () => {
    await tab(cluster, 'scaling');
    await clickButton('Expand');
    await dialog().getByLabel('Data volume per node (GiB)').fill('2');
    await review();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'resize_storage');
    check(await finished(op) === 'succeeded', `resize_storage: ${await opState(op)} ${await opMessage(op)}`);
    const claims = kubeJSON('-n', NAMESPACE, 'get', 'pvc').items.filter(c => c.metadata.name.includes(`${resource(cluster)}-clickhouse-`));
    check(claims.every(c => c.status.capacity.storage === '2Gi'), `capacities: ${claims.map(c => c.status.capacity.storage).join(', ')}`);
});

await test('Add a replica to every shard: synchronized before ready', async () => {
    await tab(cluster, 'scaling');
    await clickButton('Add replicas');
    await sleep(500);
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'add_replica');
    check(await finished(op) === 'succeeded', `add_replica: ${await opState(op)} ${await opMessage(op)}`);
    check(podQuery(NAMESPACE, `${resource(cluster)}-clickhouse-0-2-0`, 'k8s_admin', ADMIN_SECRET, 'SELECT count() FROM app.events') === '3000', 'the new replica does not have the rows');
});

await test('Remove a replica from every shard: the claim is kept and the replica leaves Keeper', async () => {
    await tab(cluster, 'scaling');
    await clickButton('Remove replicas');
    await dialog().getByLabel(`Type ${NAME} to confirm`).fill(NAME);
    await review();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'remove_replica');
    check(await finished(op) === 'succeeded', `remove_replica: ${await opState(op)} ${await opMessage(op)}`);
    const pods = kubeJSON('-n', NAMESPACE, 'get', 'pods').items.map(p => p.metadata.name);
    check(!pods.includes(`${resource(cluster)}-clickhouse-0-2-0`), 'the pod of the removed replica remains');
    check(kubeJSON('-n', NAMESPACE, 'get', 'pvc').items.some(c => c.metadata.name.endsWith(`${resource(cluster)}-clickhouse-0-2-0`)), 'the claim of the removed replica was deleted');
    const replicas = podQuery(NAMESPACE, `${resource(cluster)}-clickhouse-0-0-0`, 'k8s_admin', ADMIN_SECRET, "SELECT arraySort(mapKeys(replica_is_active)) FROM system.replicas WHERE database = 'app' AND table = 'events'");
    check(replicas === "['0','1']", `Keeper replicas: ${replicas}`);
});

if (DESTINATION) {
    await test('Back up the cluster to S3 from the pods, and verify the backup', async () => {
        await tab(cluster, 'protection');
        await clickButton('Back up now');
        const id = await sql(`SELECT id FROM ${DB}.backup_destinations FINAL WHERE name = {n:String} AND NOT deleted LIMIT 1`, {n: DESTINATION});
        await dialog().getByLabel('Destination').selectOption(id);
        await review();
        check((await applyPlan()).includes('Applied.'), 'not submitted');
        const op = await latestOp(cluster, 'backup');
        check(await finished(op) === 'succeeded', `backup: ${await opState(op)} ${await opMessage(op)}`);
    });
}

await test('Retire the cluster: the pods stop, the volumes and the Secret stay', async () => {
    const backup = DESTINATION ? await latestOp(cluster, 'backup') : '';
    if (!DESTINATION) podQuery(NAMESPACE, `${resource(cluster)}-clickhouse-0-0-0`, 'k8s_admin', ADMIN_SECRET, 'DROP DATABASE app ON CLUSTER default SYNC');
    await tab(cluster, 'retirement');
    await clickButton('Start retirement');
    for (const select of await dialog().locator('select').all()) await select.selectOption('none');
    await wizardNext();
    if (DESTINATION && await opState(backup) === 'succeeded') await dialog().getByLabel('Final backup').selectOption(backup);
    else await dialog().getByLabel('Reason no backup is needed').fill('e2e: the data is synthetic');
    await wizardNext();
    await wizardNext();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'retire');
    check(await finished(op) === 'succeeded', `retire: ${await opState(op)} ${await opMessage(op)}`);
    await until(() => !kubeJSON('-n', NAMESPACE, 'get', 'pods').items.some(p => p.metadata.name.startsWith(resource(cluster)) && !p.metadata.name.includes('version-probe')), 180000, 'the pods to stop');
    check(kubeJSON('-n', NAMESPACE, 'get', 'clickhousecluster').items.length === 0, 'the ClickHouseCluster remains');
    check(kubeJSON('-n', NAMESPACE, 'get', 'pvc').items.length >= 5, 'claims were deleted by the retirement');
    check(kubeJSON('-n', NAMESPACE, 'get', 'secret', `${resource(cluster)}-console`).metadata.name, 'the Secret was deleted by the retirement');
    await tab(cluster, 'retirement');
    await shot('k04-retired');
});

await test('Delete all resources of the retired cluster: claims, Retain volumes, the Secret, and the namespace', async () => {
    const before = kubeJSON('get', 'pv').items.filter(v => v.spec.claimRef && v.spec.claimRef.namespace === NAMESPACE).map(v => v.metadata.name);
    check(before.length >= 5, `volumes before: ${before.length}`);
    await tab(cluster, 'retirement');
    await clickButton('Delete resources');
    await dialog().locator('label', {hasText: /^Select all /}).locator('input').check();
    await dialog().getByLabel(`Type ${NAME} to confirm`).fill(NAME);
    await review();
    check((await applyPlan()).includes('Applied.'), 'not submitted');
    const op = await latestOp(cluster, 'destroy');
    check(await finished(op) === 'succeeded', `destroy: ${await opState(op)} ${await opMessage(op)}`);
    const remaining = kubeJSON('get', 'pv').items.filter(v => before.includes(v.metadata.name)).map(v => v.metadata.name);
    check(!remaining.length, `volumes remain: ${remaining.join(', ')}`);
    check(!kubectl('get', 'namespace', '-o', 'name').includes(`namespace/${NAMESPACE}`), 'the namespace remains');
    check(Number(await sql(`SELECT count() FROM ${DB}.cluster_revisions WHERE cluster_id = {c:String}`, {c: cluster})) > 0, 'the configuration history was lost');
});

await test('A class without expansion: the storage cannot be resized, and Delete volumes go with their claims', async () => {
    const name = `k8s-fixed-${RUN}`;
    const id = await createCluster(name, {storage_class: FIXED, reclaim: 'Delete', service: 'none', replicas: 1, keepers: 1});
    const op = await latestOp(id, 'provision');
    check(await finished(op) === 'succeeded', `provisioning: ${await opState(op)} ${await opMessage(op)}`);
    const namespace = `chc-${name}`;
    const volumes = kubeJSON('get', 'pv').items.filter(v => v.spec.claimRef && v.spec.claimRef.namespace === namespace);
    check(volumes.length === 2 && volumes.every(v => v.spec.persistentVolumeReclaimPolicy === 'Delete'), 'the volumes do not have reclaim policy Delete');
    await tab(id, 'scaling');
    check(await page.locator('#admin-view button', {hasText: 'Expand'}).isDisabled(), 'Expand is offered on a class without expansion');
    check((await page.locator('#admin-view').innerText()).includes('does not allow volume expansion'), 'the reason is not shown');
    await tab(id, 'retirement');
    await clickButton('Start retirement');
    for (const select of await dialog().locator('select').all()) await select.selectOption('none');
    await wizardNext();
    await dialog().getByLabel('Reason no backup is needed').fill('e2e: empty cluster');
    await wizardNext();
    await wizardNext();
    check((await applyPlan()).includes('Applied.'), 'retirement not submitted');
    check(await finished(await latestOp(id, 'retire')) === 'succeeded', 'retirement failed');
    await tab(id, 'retirement');
    await clickButton('Delete resources');
    await dialog().locator('label', {hasText: /^Select all /}).locator('input').check();
    await dialog().getByLabel(`Type ${name} to confirm`).fill(name);
    await review();
    check((await applyPlan()).includes('Applied.'), 'deletion not submitted');
    check(await finished(await latestOp(id, 'destroy')) === 'succeeded', 'deletion failed');
    await until(() => !kubeJSON('get', 'pv').items.some(v => volumes.some(x => x.metadata.name === v.metadata.name)), 120000, 'the Delete volumes to be deleted with their claims');
});

await test('No script errors in the pages', async () => {
    check(!page_errors.length, page_errors.join('\n'));
});

await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
