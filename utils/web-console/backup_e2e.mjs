/// Acceptance checks of Administration → Backup & Restore of the web console (`/console/admin-backups`).
///
/// A development tool, like `console_e2e.mjs` (see `README.md`). It drives a running server through the
/// browser, runs the backup worker, and checks every result with the server and the storage.
///
/// Usage:
///   node backup_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass --native-port 29000 \
///       --s3 http://127.0.0.1:29900/ch-backups:ACCESS_KEY:SECRET_KEY --minio-container console-minio \
///       --server-restart "<command that restarts the server>" --worker ./backup_worker.mjs
///
/// The server needs a disk named `backups` allowed in `backups.allowed_disk`, the S3 endpoint in
/// `web_console.backup_s3_endpoints`, and the console tables set up. The checks create the database
/// `e2e_bk_src`, destinations, schedules, and backups named `e2e…`, and remove the databases they restore.

import {chromium} from 'playwright';
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE = arg('url', 'http://127.0.0.1:28123').replace(/\/+$/, '');
const [ADMIN_USER, ADMIN_PASSWORD] = arg('admin', 'default:devpass').split(':');
const [S3_URL, S3_KEY, S3_SECRET] = (() => {
    const value = arg('s3', 'http://127.0.0.1:29900/ch-backups:consoleminio:consoleminio-secret-1');
    const i = value.lastIndexOf(':', value.lastIndexOf(':') - 1);
    return [value.slice(0, i), ...value.slice(i + 1).split(':')];
})();
const MINIO = arg('minio-container', 'console-minio');
const RESTART = arg('server-restart', null);
const WORKER = arg('worker', new URL('./backup_worker.mjs', import.meta.url).pathname);
const SCREENSHOTS = arg('screenshots', null);
const SERVER_LOG = arg('server-log', null);
if (SCREENSHOTS) mkdirSync(SCREENSHOTS, {recursive: true});
const DB = 'console_admin';

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
const code = text => Number((text.match(/^Code: (\d+)/) || [])[1] || 0);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, timeout = 120000, what = 'condition') {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(1000);
    }
}

async function opState(op_id) {
    return sql(`SELECT toString(argMax(state, at)) FROM ${DB}.backup_events WHERE op_id = {id:String} AND kind = 'state'`, ADMIN_USER, ADMIN_PASSWORD, {id: op_id});
}

function runWorker(extra_env = {}) {
    const [s3_base, bucket] = [new URL(S3_URL).origin, new URL(S3_URL).pathname.slice(1)];
    void s3_base; void bucket;
    return new Promise(resolve => {
        const child = spawn(process.execPath, [WORKER, '--once'], {env: {...process.env, CLICKHOUSE_URL: BASE, CLICKHOUSE_USER: ADMIN_USER, CLICKHOUSE_PASSWORD: ADMIN_PASSWORD,
            ADMIN_DATABASE: DB, E2E_S3_ACCESS_KEY_ID: S3_KEY, E2E_S3_SECRET_ACCESS_KEY: S3_SECRET, ...extra_env}});
        let output = '';
        child.stdout.on('data', d => { output += d; });
        child.stderr.on('data', d => { output += d; });
        child.on('close', exit => resolve({exit, output}));
    });
}

const browser = await chromium.launch();
const page_errors = [];
let page = null;

async function signIn(user = ADMIN_USER, password = ADMIN_PASSWORD) {
    if (page) await page.context().close();
    const context = await browser.newContext({viewport: {width: 1400, height: 1000}});
    page = await context.newPage();
    page.on('pageerror', e => page_errors.push(e.message));
    await page.goto(`${BASE}/console/login`);
    await page.fill('#login-user', user);
    await page.fill('#login-password', password);
    await page.click('#login-submit');
    await page.waitForSelector('#shell:not([hidden])');
    await sleep(3000);
}

async function go(target) {
    await page.evaluate(t => {
        const dialog = document.getElementById('admin-dialog');
        if (dialog.open) dialog.close();
        history.pushState(null, '', t);
        dispatchEvent(new PopStateEvent('popstate'));
    }, target);
    /// The check of unfinished operations runs in the background after the page is shown (`.reconcile-notice`).
    await until(() => page.evaluate(() => ![...document.querySelectorAll('#admin-view .spinner')].some(s => !s.closest('.reconcile-notice'))),
        120000, 'the page to load');
    await sleep(300);
}

const dialog = () => page.locator('#admin-dialog');
/// The inventory or operations row of an operation (other rows may mention it as their base).
const opRow = op_id => page.locator('#admin-view tr').filter({has: page.locator('td:first-child', {hasText: op_id.slice(0, 8)})});
async function applyPlan() {
    await dialog().locator('.dialog-actions button.primary').last().click();
    await dialog().locator('.dialog-actions button', {hasText: 'Close'}).waitFor({timeout: 120000});
    const text = await dialog().innerText();
    await dialog().locator('.dialog-actions button', {hasText: 'Close'}).click();
    await sleep(1500);
    return text;
}
async function reviewAndApply() {
    await dialog().locator('button', {hasText: 'Review'}).first().click();
    await sleep(300);
    const errors = (await dialog().locator('form .message.error:not([hidden])').allInnerTexts()).filter(Boolean);
    if (errors.length) throw new Error(`form error: ${errors.join(' ')}`);
    return applyPlan();
}
async function wizardNext() {
    await dialog().locator('.dialog-actions button.primary').click();
    await sleep(1500);
    const error = (await dialog().locator('.message.error[role="alert"]:not([hidden])').allInnerTexts()).filter(Boolean);
    return error.join(' ');
}

async function latestOp(kind) {
    return sql(`SELECT op_id FROM ${DB}.backup_operations WHERE kind = {k:String} ORDER BY requested_at DESC LIMIT 1`, ADMIN_USER, ADMIN_PASSWORD, {k: kind});
}

/// Runs the backup wizard: whole databases, a destination, full or incremental. The server objects (functions, workloads,
/// and resources; the console's own tables) are chosen explicitly, so that each check backs up what it names.
async function backupThroughWizard(databases, destination_name,
    {incremental = false, capture = true, close_early = false, sql_objects = false, console_tables = false} = {}) {
    const previous = await latestOp('backup');
    await go('/console/admin-backups?tab=backups');
    await page.locator('#admin-view button', {hasText: 'New backup'}).click();
    await dialog().locator('select').first().selectOption('databases');
    for (const db of databases) await dialog().locator('label', {hasText: new RegExp(`^${db}$`)}).locator('input').check();
    await dialog().locator('label', {hasText: 'Include SQL user-defined functions'}).locator('input').setChecked(sql_objects);
    const console_box = dialog().locator('label', {hasText: "Include the console's tables"}).locator('input');
    if (console_tables || await console_box.isEnabled()) await console_box.setChecked(console_tables);
    check(!(await wizardNext()), 'scope step');
    const destination = dialog().locator('select').first();
    const value = await destination.evaluate((el, name) => [...el.options].find(o => o.textContent.startsWith(name))?.value, destination_name);
    check(value, `destination ${destination_name} is not offered`);
    await destination.selectOption(value);
    check(!(await wizardNext()), 'destination step');
    if (incremental) await dialog().locator('select').first().selectOption('incremental');
    const capture_box = dialog().locator('label', {hasText: 'Capture validation values'}).locator('input');
    if (!capture) await capture_box.uncheck();
    const type_error = await wizardNext();
    if (type_error) return {error: type_error};
    await dialog().locator('.dialog-actions button.primary', {hasText: 'Start backup'}).click();
    const op_id = await until(async () => {
        const latest = await latestOp('backup');
        return latest !== previous ? latest : null;
    }, 60000, 'the operation to be recorded').catch(async e => {
        throw new Error(`${e.message}: ${(await dialog().innerText()).slice(0, 500)}`);
    });
    if (close_early) {
        await until(async () => (await opState(op_id)) !== 'queued', 60000, 'the submission');
        return {op_id};
    }
    await dialog().locator('.message', {hasText: /The source (did not change|changed)|failed|Failed/}).or(dialog().locator('text=Succeeded')).first().waitFor({timeout: 300000}).catch(() => {});
    await until(async () => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(await opState(op_id)), 300000, 'the backup to finish');
    await sleep(2000);
    return {op_id, text: await dialog().innerText()};
}

// ---------------------------------------------------------------------------------------------

for (const statement of ['DROP DATABASE IF EXISTS e2e_bk_src', 'CREATE DATABASE e2e_bk_src',
    'CREATE TABLE e2e_bk_src.events (id UInt64, ts DateTime, kind LowCardinality(String), amount Decimal(18, 2)) ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY id',
    'CREATE TABLE e2e_bk_src.daily (day Date, kind LowCardinality(String), total Decimal(38, 2)) ENGINE = SummingMergeTree ORDER BY (day, kind)',
    'CREATE MATERIALIZED VIEW e2e_bk_src.daily_mv TO e2e_bk_src.daily AS SELECT toDate(ts) AS day, kind, sum(amount) AS total FROM e2e_bk_src.events GROUP BY day, kind',
    "INSERT INTO e2e_bk_src.events SELECT number, toDateTime('2026-09-01 00:00:00') + number * 60, ['a','b','c'][number % 3 + 1], toDecimal64(number % 1000, 2) / 10 FROM numbers(200000)",
    "DROP USER IF EXISTS e2e_bk_reader", "CREATE USER e2e_bk_reader IDENTIFIED BY 'E2e-bk-reader-1'", 'GRANT SELECT ON e2e_bk_src.* TO e2e_bk_reader',
    /// An administrator whose backups are throttled, so that one is still running when the server is killed.
    'DROP USER IF EXISTS e2e_bk_slow', "CREATE USER e2e_bk_slow IDENTIFIED BY 'E2e-bk-slow-1' SETTINGS max_backup_bandwidth = 1000000",
    'GRANT CURRENT GRANTS ON *.* TO e2e_bk_slow']) {
    const result = await sql(statement);
    check(!code(result), `${statement}: ${result}`);
}
/// On a server without the console tables, such as a new one, they are created through the console's own setup: first
/// those of the administration pages, which keep the audit log, then those of Backup & Restore.
async function ensureSetUp() {
    await signIn();
    const exists = await sql(`SELECT count() FROM system.tables WHERE database = '${DB}' AND name IN ('audit_log', 'component_policy', 'protected_accounts')`);
    if (exists !== '3') {
        await go('/console/admin-access');
        await page.locator('#admin-view button', {hasText: 'Set up'}).click();
        check((await reviewAndApply()).includes('Applied.'), 'the setup of the administration pages failed');
        await signIn();
    }
    await go('/console/admin-backups');
    const setup = page.locator('#admin-view button', {hasText: 'Set up'});
    if (await setup.count()) {
        await setup.click();
        check((await applyPlan()).includes('Applied.'), 'the setup of Backup & Restore failed');
        await signIn();
    }
}
await ensureSetUp();

const STARTED = await sql('SELECT now()');

await test('Unauthorized user calls the backup operations directly: the server rejects them', async () => {
    const reader = ['e2e_bk_reader', 'E2e-bk-reader-1'];
    check(code(await sql("BACKUP DATABASE e2e_bk_src TO Disk('backups', 'e2e/unauthorized')", ...reader)) === 497, 'BACKUP was not rejected');
    check(code(await sql("RESTORE DATABASE e2e_bk_src AS e2e_bk_x FROM Disk('backups', 'e2e/none')", ...reader)) === 497, 'RESTORE was not rejected');
    check(code(await sql(`INSERT INTO ${DB}.backup_operations (op_id, kind) VALUES ('forged', 'backup')`, ...reader)) === 497, 'recording an operation was not rejected');
    check(code(await sql(`INSERT INTO ${DB}.backup_destinations (id, name, type, enabled) VALUES ('x', 'x', 'disk', true)`, ...reader)) === 497, 'adding a destination was not rejected');
    await signIn(...reader);
    check(!(await page.locator('#sidebar').innerText()).includes('Backup & Restore'), 'the page is listed for a user without access');
    await go('/console/admin-backups');
    check((await page.locator('#admin-view').innerText()).includes('not available for your user'), 'the page is not refused');
});

const RUN = Date.now().toString(36);
let disk_destination = `e2e disk ${RUN}`;
let s3_destination = `e2e s3 ${RUN}`;

await test('Administrator adds and tests a disk destination and an S3 destination', async () => {
    await signIn();
    await go('/console/admin-backups?tab=destinations');
    await page.locator('#admin-view button', {hasText: 'Add destination'}).click();
    await dialog().getByLabel('Name').fill(disk_destination);
    await dialog().getByLabel('Prefix').fill(`e2e-${Date.now()}`);
    check((await reviewAndApply()).includes('Applied.'), 'disk destination not added');
    await go('/console/admin-backups?tab=destinations');
    await page.locator('#admin-view tr', {hasText: disk_destination}).locator('button', {hasText: 'Test'}).click();
    await dialog().locator('button', {hasText: 'Record result'}).waitFor({timeout: 120000});
    const disk_test = await dialog().innerText();
    check(/write\s+ok/.test(disk_test) && /read\s+ok/.test(disk_test), `disk test: ${disk_test}`);
    await dialog().locator('button', {hasText: 'Record result'}).click();
    check((await applyPlan()).includes('Applied.'), 'test result not recorded');
    await go('/console/admin-backups?tab=destinations');
    await page.locator('#admin-view tr', {hasText: disk_destination}).locator('button', {hasText: 'Enable'}).click();
    check((await applyPlan()).includes('Applied.'), 'not enabled');

    const url = new URL(S3_URL);
    await go('/console/admin-backups?tab=destinations');
    await page.locator('#admin-view button', {hasText: 'Add destination'}).click();
    await dialog().getByLabel('Type').selectOption('s3');
    await dialog().getByLabel('Name').fill(s3_destination);
    await dialog().getByLabel('Endpoint').fill(url.origin);
    await dialog().getByLabel('Bucket').fill(url.pathname.slice(1));
    await dialog().getByLabel('Access key ID').fill(S3_KEY);
    await dialog().getByLabel('Secret access key').fill(S3_SECRET);
    await dialog().getByLabel('Worker credential reference').fill('E2E_S3');
    await dialog().getByLabel('Prefix').fill(`e2e-${Date.now()}`);
    await dialog().locator('button', {hasText: 'Review'}).click();
    await sleep(300);
    const review = await dialog().innerText();
    check(!review.includes(S3_SECRET) && !review.includes(S3_KEY), 'the review shows a credential');
    check((await applyPlan()).includes('Applied.'), 's3 destination not added');
    await go('/console/admin-backups?tab=destinations');
    await page.locator('#admin-view tr', {hasText: s3_destination}).locator('button', {hasText: 'Test'}).click();
    await dialog().locator('button', {hasText: 'Record result'}).waitFor({timeout: 120000});
    const s3_test = await dialog().innerText();
    check(/write\s+ok/.test(s3_test) && /read\s+ok/.test(s3_test), `s3 test: ${s3_test}`);
    await dialog().locator('button', {hasText: 'Record result'}).click();
    check((await applyPlan()).includes('Applied.'), 'test result not recorded');
    await go('/console/admin-backups?tab=destinations');
    await page.locator('#admin-view tr', {hasText: s3_destination}).locator('button', {hasText: 'Enable'}).click();
    check((await applyPlan()).includes('Applied.'), 'not enabled');
    /// The worker lists and deletes the test artifacts with its own credentials.
    const worker = await runWorker();
    check(worker.exit === 0, `worker: ${worker.output}`);
    const result = await sql(`SELECT test_result FROM ${DB}.backup_destinations FINAL WHERE name = {n:String}`, ADMIN_USER, ADMIN_PASSWORD, {n: s3_destination});
    check(/"delete":\{"ok":true\}/.test(result), `delete capability not recorded: ${result}; worker: ${worker.output.slice(-500)}`);
});

await test('External S3 endpoint: an administrator allows it from the console; metadata addresses are refused', async () => {
    const allowlist = JSON.parse(await (await fetch(`${BASE}/console/config.json`)).text()).backup_s3_endpoints.split(',').map(v => v.trim());
    /// TEST-NET-3 (RFC 5737): never reachable. A port of its own per run, so a run that stopped early leaves nothing in the way.
    const external = `http://203.0.113.10:${10000 + Date.now() % 50000}`;
    /// Set up the list of allowed endpoints when the console tables predate it.
    await go('/console/admin-backups?tab=destinations');
    const box = page.locator('#admin-view .box', {hasText: 'Allowed endpoints'});
    if (await box.locator('button', {hasText: 'Set up'}).count()) {
        await box.locator('button', {hasText: 'Set up'}).click();
        check((await applyPlan()).includes('Applied.'), 'the endpoints table was not set up');
        await go('/console/admin-backups?tab=destinations');
    }
    for (const entry of allowlist) check((await box.innerText()).includes(entry), `${entry} of the configuration is not listed`);
    /// Fills an S3 destination with `endpoint` and selects Review. Returns the form error, or the text of the review.
    const tryEndpoint = async (endpoint, name = `e2e external ${RUN}`) => {
        await go('/console/admin-backups?tab=destinations');
        await page.locator('#admin-view button', {hasText: 'Add destination'}).click();
        await dialog().getByLabel('Type').selectOption('s3');
        await dialog().getByLabel('Name').fill(name);
        await dialog().getByLabel('Endpoint').fill(endpoint);
        await dialog().getByLabel('Bucket').fill('e2e-bucket');
        await dialog().getByLabel('Access key ID').fill('e2e-key');
        await dialog().getByLabel('Secret access key').fill('e2e-secret');
        await dialog().locator('button', {hasText: 'Review'}).click();
        await sleep(300);
        const error = (await dialog().locator('form .message.error:not([hidden])').allInnerTexts()).filter(Boolean).join(' ');
        return {error, review: error ? '' : await dialog().innerText()};
    };
    for (const endpoint of ['http://169.254.169.254', 'http://metadata.google.internal', 'https://user:password@s3.example.com', 'https://s3.example.com/bucket']) {
        check((await tryEndpoint(endpoint)).error, `${endpoint} was accepted`);
    }
    const any_host = allowlist.find(v => /^https?:\/\/\*:\d+$/.test(v));
    if (any_host) check(/metadata/.test((await tryEndpoint(any_host.replace('*', '169.254.169.254'))).error), 'a pattern reached the metadata address');
    const pattern = allowlist.find(v => /^https:\/\/\*\.[a-z0-9.-]+$/.test(v));
    if (pattern) {
        const {review} = await tryEndpoint(pattern.replace('*', 'backup-e2e'));
        check(review.includes('Create the named collection') && !review.includes('Allow the S3 endpoint'), `${pattern} does not accept a matching endpoint`);
    }
    /// An endpoint that is not listed: allowed in the same change, as a separate step.
    const {error, review} = await tryEndpoint(external);
    check(!error && review.includes(`Allow the S3 endpoint ${external}`) && review.includes('becomes an allowed endpoint'), `no allow step: ${error || review.slice(0, 400)}`);
    check((await applyPlan()).includes('Applied.'), 'not applied');
    check(await sql(`SELECT count() FROM ${DB}.backup_endpoints FINAL WHERE endpoint = {e:String} AND NOT deleted`, ADMIN_USER, ADMIN_PASSWORD, {e: external}) === '1', 'the endpoint was not recorded');
    check(await sql(`SELECT endpoint FROM ${DB}.backup_destinations FINAL WHERE name = {n:String} AND NOT deleted`, ADMIN_USER, ADMIN_PASSWORD, {n: `e2e external ${RUN}`}) === external, 'the destination was not recorded');
    check(await sql(`SELECT count() FROM ${DB}.audit_log WHERE action = 'create_backup_destination' AND target_name = {n:String}`, ADMIN_USER, ADMIN_PASSWORD, {n: `e2e external ${RUN}`}) === '1', 'no audit record');
    await go('/console/admin-backups?tab=destinations');
    const row = box.locator('tr', {hasText: external});
    check((await row.innerText()).includes('Console') && (await row.innerText()).includes(`e2e external ${RUN}`), `the list does not show it: ${await row.innerText()}`);
    /// A second destination at the same endpoint needs no allow step.
    const again = await tryEndpoint(external, `e2e external 2 ${RUN}`);
    check(!again.error && !again.review.includes('Allow the S3 endpoint'), `the endpoint is not allowed now: ${again.error}`);
    await page.evaluate(() => document.getElementById('admin-dialog').close());
    /// The Allow endpoint dialog refuses metadata addresses and patterns for any host.
    await go('/console/admin-backups?tab=destinations');
    for (const entry of ['http://169.254.169.254', 'https://*', '*']) {
        await box.locator('button', {hasText: 'Allow endpoint'}).click();
        await dialog().getByLabel('Endpoint').fill(entry);
        await dialog().locator('button', {hasText: 'Review'}).click();
        await sleep(300);
        check((await dialog().locator('form .message.error:not([hidden])').allInnerTexts()).join(' '), `${entry} was accepted`);
        await page.evaluate(() => document.getElementById('admin-dialog').close());
    }
    /// Removing the endpoint and the destination.
    await box.locator('tr', {hasText: external}).locator('button', {hasText: 'Remove'}).click();
    check((await dialog().innerText()).includes('keep working'), 'no warning about the destination that uses it');
    check((await applyPlan()).includes('Applied.'), 'not removed');
    check(await sql(`SELECT count() FROM ${DB}.backup_endpoints FINAL WHERE endpoint = {e:String} AND NOT deleted`, ADMIN_USER, ADMIN_PASSWORD, {e: external}) === '0', 'the endpoint is still allowed');
    await go('/console/admin-backups?tab=destinations');
    await page.locator('#admin-view tr', {hasText: `e2e external ${RUN}`}).first().locator('button', {hasText: 'Remove'}).click();
    check((await applyPlan()).includes('Applied.'), 'the destination was not removed');
    const collection = await sql(`SELECT named_collection FROM ${DB}.backup_destinations FINAL WHERE name = {n:String}`, ADMIN_USER, ADMIN_PASSWORD, {n: `e2e external ${RUN}`});
    await sql(`DROP NAMED COLLECTION IF EXISTS ${collection}`);
});

let full_backup = null;

await test('Administrator starts a full backup: a durable operation and an artifact are created', async () => {
    const run = await backupThroughWizard(['e2e_bk_src'], disk_destination);
    full_backup = run.op_id;
    check(await opState(full_backup) === 'succeeded', `state: ${await opState(full_backup)}`);
    check(run.text.includes('did not change during the backup'), 'expected values were not captured');
    check(await sql(`SELECT count() FROM ${DB}.backup_operations WHERE op_id = {id:String}`, ADMIN_USER, ADMIN_PASSWORD, {id: full_backup}) === '1', 'no operation record');
    const artifact = await sql(`SELECT concat(d.path, dest.prefix, '/', o.artifact) FROM ${DB}.backup_operations AS o, ${DB}.backup_destinations AS dest FINAL, system.disks AS d
        WHERE o.op_id = {id:String} AND dest.id = o.destination_id AND d.name = dest.disk`, ADMIN_USER, ADMIN_PASSWORD, {id: full_backup});
    check(existsSync(path.join(artifact, '.backup')), `no artifact at ${artifact}`);
    check(await sql("SELECT toString(status) FROM system.backups WHERE id = {id:String}", ADMIN_USER, ADMIN_PASSWORD, {id: full_backup}) === 'BACKUP_CREATED', 'native id differs');
    check(await sql(`SELECT count() FROM ${DB}.audit_log WHERE correlation_id = toUUIDOrZero({id:String}) AND action = 'submit_backup'`, ADMIN_USER, ADMIN_PASSWORD, {id: full_backup}) === '1', 'no audit record');
    if (SCREENSHOTS) await page.screenshot({path: `${SCREENSHOTS}/b01-backup.png`});
});

await test('Browser disconnects during a backup: the job continues and its state is recovered', async () => {
    await sql('INSERT INTO e2e_bk_src.events SELECT 200000 + number, now(), \'d\', 1 FROM numbers(1000000)');
    const run = await backupThroughWizard(['e2e_bk_src'], s3_destination, {capture: false, close_early: true});
    await page.context().close();
    page = null;
    await until(async () => (await sql("SELECT toString(status) FROM system.backups WHERE id = {id:String}", ADMIN_USER, ADMIN_PASSWORD, {id: run.op_id})) === 'BACKUP_CREATED', 300000, 'the server to finish');
    check(await opState(run.op_id) === 'running', `recorded state before reconciliation: ${await opState(run.op_id)}`);
    await signIn();
    await go('/console/admin-backups?tab=operations');
    await until(async () => (await opState(run.op_id)) === 'succeeded', 60000, 'the reconciliation');
});

await test('Server restarts during a backup: the state is reconciled without running it again', async () => {
    check(RESTART, 'no --server-restart command given');
    await signIn('e2e_bk_slow', 'E2e-bk-slow-1');
    await sql('INSERT INTO e2e_bk_src.events SELECT 2000000 + number, now(), \'e\', 1 FROM numbers(5000000)');
    const run = await backupThroughWizard(['e2e_bk_src'], s3_destination, {capture: false, close_early: true});
    await page.context().close();
    page = null;
    check(await sql("SELECT toString(status) FROM system.backups WHERE id = {id:String}", ADMIN_USER, ADMIN_PASSWORD, {id: run.op_id}) === 'CREATING_BACKUP',
        'the backup is not running at the restart');
    execFileSync('bash', ['-c', RESTART], {stdio: 'inherit'});
    await until(async () => (await sql('SELECT 1').catch(() => '')) === '1', 180000, 'the server');
    check(await sql("SELECT count() FROM system.backups WHERE id = {id:String}", ADMIN_USER, ADMIN_PASSWORD, {id: run.op_id}) === '0', 'the operation survived the restart');
    await signIn();
    await go('/console/admin-backups?tab=operations');
    /// The first read of the interrupted S3 backup after the restart can take minutes (MinIO keeps the upload
    /// of the killed server locked): the console then records `unknown`, and a later visit records the outcome.
    await until(async () => {
        if (['failed', 'succeeded'].includes(await opState(run.op_id))) return true;
        await go('/console/admin-backups?tab=operations');
        await until(() => page.evaluate(() => !document.querySelector('.reconcile-notice .spinner')), 300000, 'the check of unfinished operations');
        return ['failed', 'succeeded'].includes(await opState(run.op_id));
    }, 600000, 'the reconciliation');
    const state = await opState(run.op_id);
    const error = await sql(`SELECT argMax(error, at) FROM ${DB}.backup_events WHERE op_id = {id:String} AND kind = 'state'`, ADMIN_USER, ADMIN_PASSWORD, {id: run.op_id});
    check(state === 'failed' && error.includes('interrupted'), `state ${state}: ${error}`);
    check(await sql(`SELECT count() FROM system.query_log WHERE query LIKE 'BACKUP%' AND has(Settings, 'log_comment') AND Settings['log_comment'] = {c:String} AND type = 'QueryStart'`,
        ADMIN_USER, ADMIN_PASSWORD, {c: `console-admin:${run.op_id}`}) <= '1', 'the backup was submitted again');
});

await test('Destination becomes unavailable: the failure is reported with its cause, a stalled backup is not shown as done', async () => {
    await signIn();
    execFileSync('docker', ['stop', MINIO], {stdio: 'ignore'});
    try {
        /// The server retries S3 requests of a backup for about an hour (`backup_restore_s3_retry_attempts`), so the
        /// backup stays running: the console must show it as running, and Cancel must stop it.
        const run = await backupThroughWizard(['e2e_bk_src'], s3_destination, {capture: false, close_early: true});
        await sleep(5000);
        await go('/console/admin-backups?tab=operations');
        const row = opRow(run.op_id);
        check((await row.innerText()).includes('Running'), `shown as: ${await row.innerText()}`);
        await row.locator('button', {hasText: 'Cancel'}).click();
        await dialog().locator('.dialog-actions button', {hasText: 'Cancel operation'}).waitFor();
        check((await applyPlan()).includes('Applied.'), 'cancel not applied');
        await go('/console/admin-backups?tab=operations');
        await until(async () => (await opState(run.op_id)) === 'cancelled', 120000, 'the cancellation to be recorded');

        /// The destination test fails in seconds with the cause.
        await go('/console/admin-backups?tab=destinations');
        const started = Date.now();
        await page.locator('#admin-view tr', {hasText: s3_destination}).locator('button', {hasText: 'Test'}).click();
        await dialog().locator('button', {hasText: 'Record result'}).waitFor({timeout: 120000});
        const text = await dialog().innerText();
        check(/write\s+failed/.test(text) && /Connection refused|connect|Poco|Timeout/i.test(text), `test result: ${text.slice(0, 600)}`);
        check(Date.now() - started < 90000, `the test took ${Math.round((Date.now() - started) / 1000)} s`);
        check(text.includes('stays disabled'), 'no consequence stated');
        await dialog().locator('button', {hasText: 'Close'}).click();
    } finally {
        execFileSync('docker', ['start', MINIO], {stdio: 'ignore'});
        await sleep(3000);
    }
});

let restore_target = null;

await test('Isolated restore completes: schema and data checks match the captured values', async () => {
    await signIn();
    await go(`/console/admin-backups?tab=restore&backup=${full_backup}`);
    await dialog().locator('.dialog-actions button.primary').waitFor();
    check(!(await wizardNext()), 'chain step');
    check(!(await wizardNext()), 'target step');
    restore_target = await dialog().locator('input[type=text]').first().inputValue();
    check(restore_target.startsWith('restore_e2e_bk_src_'), `default target ${restore_target}`);
    check(!(await wizardNext()), 'names step');
    check(!(await wizardNext()), 'conflicts step');
    await dialog().locator('input[type=text]').first().fill(restore_target);
    await dialog().locator('.dialog-actions button.primary', {hasText: 'Start restore'}).click();
    await dialog().locator('text=/checks (passed|failed)/').first().waitFor({timeout: 300000});
    const text = await dialog().innerText();
    check(/All \d+ checks passed/.test(text), `checks: ${text.slice(0, 600)}`);
    const restore = await latestOp('restore');
    check(await sql(`SELECT countIf(state = 'failed') FROM ${DB}.backup_events WHERE op_id = {id:String} AND kind = 'check'`, ADMIN_USER, ADMIN_PASSWORD, {id: restore}) === '0', 'a failed check');
    check(await sql(`SELECT count() FROM ${DB}.backup_events WHERE op_id = {id:String} AND kind = 'check' AND name LIKE '%fingerprint'`, ADMIN_USER, ADMIN_PASSWORD, {id: restore}) !== '0', 'no fingerprint check');
    check(await sql(`SELECT engine FROM system.tables WHERE database = {db:String} AND name = 'daily_mv'`, ADMIN_USER, ADMIN_PASSWORD, {db: restore_target}) === 'MaterializedView', 'the materialized view was not restored');
    if (SCREENSHOTS) await page.screenshot({path: `${SCREENSHOTS}/b02-restore.png`});
});

await test('Server objects: functions and the console tables are backed up, listed, and restored only when chosen', async () => {
    const fn = `e2e_bk_fn_${Date.now() % 100000}`;
    await sql(`CREATE FUNCTION ${fn} AS x -> x * 2`);
    const run = await backupThroughWizard(['e2e_bk_src'], disk_destination, {capture: false, sql_objects: true, console_tables: true});
    check(await opState(run.op_id) === 'succeeded', `state: ${await opState(run.op_id)}`);
    const scope = JSON.parse(await sql(`SELECT scope FROM ${DB}.backup_operations WHERE op_id = {id:String} LIMIT 1`, ADMIN_USER, ADMIN_PASSWORD, {id: run.op_id}));
    check(scope.sql_objects === true && scope.databases.includes(DB), `recorded scope: ${JSON.stringify(scope)}`);
    check(await sql(`SELECT count() FROM system.backups WHERE id = {id:String} AND num_files > 0`, ADMIN_USER, ADMIN_PASSWORD, {id: run.op_id}) === '1', 'no native backup');

    /// The inventory says what the backup contains, and what no backup made here contains.
    await go('/console/admin-backups?tab=backups');
    const row = page.locator('#admin-view tr').filter({has: page.locator('td:first-child', {hasText: run.op_id.slice(0, 8)})});
    await row.locator('details.contents summary').click();
    const contents = await row.locator('details.contents').innerText();
    check(contents.includes('SQL user-defined functions, workloads, and resources') && contents.includes(`The console's tables in ${DB}`), `contents: ${contents}`);
    check(contents.includes('The server configuration') && contents.includes("Keeper's own state") && contents.includes('Users, roles'), `not included: ${contents}`);

    /// Restored only when chosen, and never over an existing function.
    await sql(`DROP FUNCTION ${fn}`);
    const restoreTo = async choose => {
        await go(`/console/admin-backups?tab=restore&backup=${run.op_id}`);
        await dialog().locator('.dialog-actions button.primary').waitFor();
        check((await dialog().innerText()).includes('Not in this backup'), 'the restore does not say what is missing');
        check(!(await wizardNext()), 'chain step');
        check(!(await wizardNext()), 'target step');
        await dialog().locator('label', {hasText: 'Also restore the functions, workloads, and resources'}).locator('input').setChecked(choose);
        /// The suggested names are per minute: earlier checks may have restored into them.
        const suffix = Math.random().toString(36).slice(2, 7);
        for (const input of await dialog().locator('input[type=text]').all()) await input.fill(`${(await input.inputValue()).slice(0, 50)}_${suffix}`);
        check(!(await wizardNext()), 'names step');
        check(!(await wizardNext()), 'conflicts step');
        const targets = await dialog().innerText();
        await dialog().locator('input[type=text]').first().fill(targets.match(/Type (\S+) to confirm/)[1]);
        const previous = await latestOp('restore');
        await dialog().locator('.dialog-actions button.primary', {hasText: 'Start restore'}).click();
        const op = await until(async () => { const latest = await latestOp('restore'); return latest !== previous ? latest : null; }, 60000, 'the restore to be recorded');
        await until(async () => ['succeeded', 'failed', 'cancelled', 'unknown'].includes(await opState(op)), 300000, 'the restore to finish');
        const target = JSON.parse(await sql(`SELECT target FROM ${DB}.backup_operations WHERE op_id = {id:String} LIMIT 1`, ADMIN_USER, ADMIN_PASSWORD, {id: op}));
        for (const db of Object.values(target)) await sql(`DROP DATABASE IF EXISTS ${db} SYNC`);
        return {op, state: await opState(op), target};
    };
    const without = await restoreTo(false);
    check(without.state === 'succeeded', `restore without the functions: ${without.state}`);
    check(Object.keys(without.target).includes(DB), "the console's tables are not restored into their own database");
    check(await sql(`SELECT count() FROM system.functions WHERE name = {fn:String}`, ADMIN_USER, ADMIN_PASSWORD, {fn}) === '0', 'the function was restored without being chosen');
    const chosen = await restoreTo(true);
    check(chosen.state === 'succeeded', `restore with the functions: ${chosen.state}`);
    check(await sql(`SELECT count() FROM system.functions WHERE name = {fn:String}`, ADMIN_USER, ADMIN_PASSWORD, {fn}) === '1', 'the function was not restored');
    const again = await restoreTo(true);
    check(again.state === 'failed', `a restore over an existing function did not fail: ${again.state}`);
    await sql(`DROP FUNCTION IF EXISTS ${fn}`);
});

await test('Existing target objects conflict: the restore is blocked', async () => {
    await go(`/console/admin-backups?tab=restore&backup=${full_backup}`);
    await dialog().locator('.dialog-actions button.primary').waitFor();
    check(!(await wizardNext()), 'chain step');
    check(!(await wizardNext()), 'target step');
    await dialog().locator('input[type=text]').first().fill(restore_target);
    check(!(await wizardNext()), 'names step');
    const error = await wizardNext();
    check(error.includes('exist'), `no conflict reported: ${error}`);
    check((await dialog().innerText()).includes(`Drop ${restore_target}`), 'the separate drop action is not offered');
    await sql(`DROP DATABASE ${restore_target} SYNC`);
});

let incremental = null;

await test('Incremental base is missing: backup and restore fail their checks with an explanation', async () => {
    await sql("INSERT INTO e2e_bk_src.events SELECT 50000000 + number, now(), 'f', 1 FROM numbers(1000)");
    const run = await backupThroughWizard(['e2e_bk_src'], disk_destination, {incremental: true, capture: false});
    incremental = run.op_id;
    check(await opState(incremental) === 'succeeded', `incremental: ${await opState(incremental)}`);
    check(await sql(`SELECT base_op_id FROM ${DB}.backup_operations WHERE op_id = {id:String}`, ADMIN_USER, ADMIN_PASSWORD, {id: incremental}) === full_backup, 'wrong base');
    const base_path = await sql(`SELECT concat(d.path, dest.prefix, '/', o.artifact) FROM ${DB}.backup_operations AS o, ${DB}.backup_destinations AS dest FINAL, system.disks AS d
        WHERE o.op_id = {id:String} AND dest.id = o.destination_id AND d.name = dest.disk`, ADMIN_USER, ADMIN_PASSWORD, {id: full_backup});
    execFileSync('mv', [base_path, `${base_path}.moved`]);
    try {
        await go(`/console/admin-backups?tab=restore&backup=${incremental}`);
        await dialog().locator('.dialog-actions button.primary').waitFor();
        const text = await dialog().innerText();
        check(/cannot be opened/.test(text) && /not found/i.test(text), `restore step 1: ${text.slice(0, 400)}`);
        check((await wizardNext()).includes('must open'), 'the restore is not blocked');
        const again = await backupThroughWizard(['e2e_bk_src'], disk_destination, {incremental: true, capture: false});
        check(again.error && /base backup cannot be opened/.test(again.error), `incremental backup not blocked: ${JSON.stringify(again)}`);
    } finally {
        execFileSync('mv', [`${base_path}.moved`, base_path]);
    }
});

await test('Retention selects a required base: the deletion is prevented', async () => {
    await go('/console/admin-backups?tab=backups');
    const row = opRow(full_backup);
    check((await row.innerText()).includes('Protected'), 'the base is not marked protected');
    await row.locator('button', {hasText: 'Delete'}).click();
    check((await dialog().innerText()).includes('Required as the base'), 'the deletion dialog does not refuse');
    /// A deletion request recorded directly (bypassing the console) is refused by the worker.
    const op_id = `e2e-del-${Date.now()}`;
    await sql(`INSERT INTO ${DB}.backup_operations (op_id, kind, destination_id, artifact, base_op_id) SELECT {id:String}, 'delete', destination_id, artifact, op_id
        FROM ${DB}.backup_operations WHERE op_id = {b:String} LIMIT 1`, ADMIN_USER, ADMIN_PASSWORD, {id: op_id, b: full_backup});
    await sql(`INSERT INTO ${DB}.backup_events (op_id, kind, state) VALUES ({id:String}, 'state', 'queued')`, ADMIN_USER, ADMIN_PASSWORD, {id: op_id});
    await runWorker();
    check(await opState(op_id) === 'failed', `worker state: ${await opState(op_id)}`);
    check((await sql(`SELECT argMax(error, at) FROM ${DB}.backup_events WHERE op_id = {id:String}`, ADMIN_USER, ADMIN_PASSWORD, {id: op_id})).includes('required as the base'), 'no reason');
    check(await opState(full_backup) === 'succeeded', 'the base was deleted');
});

await test('Two scheduler workers see the same run: only one operation is submitted', async () => {
    const id = `e2e-sched-${Date.now()}`;
    const destination_id = await sql(`SELECT id FROM ${DB}.backup_destinations FINAL WHERE name = {n:String}`, ADMIN_USER, ADMIN_PASSWORD, {n: disk_destination});
    const minute = (new Date().getUTCMinutes() + 59) % 60;
    await sql(`INSERT INTO ${DB}.backup_schedules (id, name, enabled, destination_id, databases, tables, structure_only, strategy, full_every, frequency, minute, hour, weekday, timezone, keep_chains, on_missing_base, verify, notify_ref)
        VALUES ({id:String}, 'e2e hourly', true, {d:String}, ['e2e_bk_src'], [], false, 'full', 1, 'hourly', {m:UInt8}, 0, 0, 'UTC', 2, 'fail', false, '')`,
    ADMIN_USER, ADMIN_PASSWORD, {id, d: destination_id, m: String(minute)});
    const [a, b] = await Promise.all([runWorker({WORKER_ID: 'e2e-a'}), runWorker({WORKER_ID: 'e2e-b'})]);
    const ops = await sql(`SELECT groupArray(op_id) FROM (SELECT DISTINCT op_id FROM ${DB}.backup_operations WHERE schedule_id = {id:String} AND kind = 'backup')`, ADMIN_USER, ADMIN_PASSWORD, {id});
    const op_ids = JSON.parse(ops.replace(/'/g, '"'));
    check(op_ids.length === 1, `operations: ${ops}`);
    const submissions = await sql(`SELECT count() FROM system.backups WHERE id = {id:String}`, ADMIN_USER, ADMIN_PASSWORD, {id: op_ids[0]});
    check(submissions === '1', `native operations: ${submissions}`);
    check(/duplicate submission refused|already|postponed/.test(a.output + b.output) || !(a.output + b.output).includes('scheduled backup submitted\\"') , 'no duplicate handling observed');
    const submitted = (a.output + b.output).match(/scheduled backup submitted/g) || [];
    check(submitted.length === 1, `submitted ${submitted.length} times:\n${a.output}\n${b.output}`);
    await sql(`INSERT INTO ${DB}.backup_schedules (id, name, enabled, destination_id, databases, tables, structure_only, strategy, full_every, frequency, minute, hour, weekday, timezone, keep_chains, on_missing_base, verify, notify_ref, deleted)
        VALUES ({id:String}, 'e2e hourly', false, '', [], [], false, 'full', 1, 'hourly', 0, 0, 0, 'UTC', 2, 'fail', false, '', true)`, ADMIN_USER, ADMIN_PASSWORD, {id});
});

await test('Restore verification fails: the failure stays visible and audited', async () => {
    /// Simulate a source that does not match the backup: replace the expected values with wrong ones.
    await sql(`INSERT INTO ${DB}.backup_events (op_id, kind, state, name, details) SELECT op_id, 'check', 'passed', 'expected_values',
        replaceRegexpOne(details, '"fingerprint":"[0-9]+"', '"fingerprint":"1"') FROM ${DB}.backup_events WHERE op_id = {id:String} AND name = 'expected_values' LIMIT 1`,
    ADMIN_USER, ADMIN_PASSWORD, {id: full_backup});
    await go('/console/admin-backups?tab=backups');
    await opRow(full_backup).locator('button', {hasText: 'Test restore'}).click();
    await dialog().locator('button', {hasText: 'Run restore test'}).click();
    await dialog().locator('text=/test databases were dropped|Cleanup failed/').waitFor({timeout: 300000});
    const text = await dialog().innerText();
    check(/checks failed/.test(text), `the test did not fail: ${text.slice(0, 500)}`);
    await go('/console/admin-backups?tab=verification');
    check((await page.locator('#admin-view').innerText()).includes('checks failed'), 'the failure is not shown in Recovery verification');
    await go('/console/admin-backups?tab=backups');
    check((await opRow(full_backup).innerText()).includes('Restore test failed'), 'the inventory does not show the failed test');
    const verify = await latestOp('verify');
    check(await sql(`SELECT count() FROM ${DB}.audit_log WHERE action = 'restore_test_result' AND result = 'failure' AND correlation_id = toUUIDOrZero({id:String})`,
        ADMIN_USER, ADMIN_PASSWORD, {id: verify}) === '1', 'no audit record of the failure');
    check(await sql(`SELECT count() FROM system.databases WHERE name LIKE 'console_verify_%'`) === '0', 'the test database was not dropped');
    if (SCREENSHOTS) await page.screenshot({path: `${SCREENSHOTS}/b03-verification.png`});
});

await test('Credential-bearing requests: the secret is absent from logs, tables, and the UI', async () => {
    await sql('SYSTEM FLUSH LOGS');
    const params = {secret: S3_SECRET, started: STARTED};
    for (const [what, query] of [
        ['system.query_log', 'SELECT count() FROM system.query_log WHERE event_time >= {started:DateTime} AND position(query, {secret:String}) > 0'],
        ['system.text_log', 'SELECT count() FROM system.text_log WHERE event_time >= {started:DateTime} AND position(message, {secret:String}) > 0'],
        ['system.backups', 'SELECT count() FROM system.backups WHERE position(toString(settings), {secret:String}) > 0 OR position(name, {secret:String}) > 0 OR position(error, {secret:String}) > 0'],
        ['console tables', `SELECT (SELECT count() FROM ${DB}.backup_destinations WHERE position(toString(tuple(*)), {secret:String}) > 0) + (SELECT count() FROM ${DB}.backup_events WHERE position(concat(error, details), {secret:String}) > 0) + (SELECT count() FROM ${DB}.audit_log WHERE position(concat(summary, error, details), {secret:String}) > 0)`],
    ]) {
        check(await sql(query, ADMIN_USER, ADMIN_PASSWORD, params) === '0', `the secret is in ${what}`);
    }
    if (SERVER_LOG) check(!readFileSync(SERVER_LOG, 'utf8').includes(S3_SECRET), 'the secret is in the server log');
    for (const tab of ['destinations', 'operations', 'backups']) {
        await go(`/console/admin-backups?tab=${tab}`);
        check(!(await page.content()).includes(S3_SECRET), `the secret is in the ${tab} page`);
    }
    check(!(await sql('SHOW CREATE NAMED COLLECTION ALL').catch(() => '')).includes(S3_SECRET), 'SHOW shows the secret');
});

await test('No script errors in the pages', async () => {
    check(!page_errors.length, page_errors.join('\n'));
});

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
