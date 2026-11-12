/// Acceptance checks of Administration → Data Access Policies of the web console (`/console/admin-data-access`).
///
/// A development tool, like `cluster_e2e.mjs` (see `README.md`). It creates a synthetic database `dap_e2e_<run>` with
/// synthetic users and roles, drives the console in a browser, and checks every result through the server itself:
/// over HTTP and with the native client (`clickhouse client`), as the synthetic users. It also runs the access policy
/// worker (`access_policy_worker.mjs --once`) with an attribute feed file. Everything it creates is removed at the end.
///
/// Usage:
///   node data_access_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass --native-port 29000 \
///       --clickhouse ../../build/programs/clickhouse [--cluster dap_secret] [--partial-cluster console_test] [--screenshots dir]
///
/// `--cluster` names a cluster with an interserver secret that contains this server, for the distributed checks.
/// `--partial-cluster` names a cluster with an unavailable server, for the partial deployment check.
/// The admin user must be able to create users, roles, row policies, and grant with the grant option, and must have
/// IMPERSONATE on the synthetic users (a user of users.xml with access_management has it).

import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = arg('url', 'http://127.0.0.1:28123').replace(/\/+$/, '');
const [ADMIN_USER, ADMIN_PASSWORD] = arg('admin', 'default:devpass').split(':');
const NATIVE_PORT = arg('native-port', '29000');
const CLICKHOUSE = arg('clickhouse', path.join(HERE, '../../build/programs/clickhouse'));
const CLUSTER = arg('cluster', null);
const PARTIAL_CLUSTER = arg('partial-cluster', null);
const SCREENSHOTS = arg('screenshots', null);
const WORKER = arg('worker', path.join(HERE, 'access_policy_worker.mjs'));
const CONSOLE_HTML = arg('console-html', path.join(HERE, '../../programs/server/console.html'));
const ADMIN_DB = 'console_admin';
const RUN = Date.now().toString(36);
const DB = `dap_e2e_${RUN}`;
const PASSWORD = 'E2e-synthetic-pass-1';
const U = name => `dap_e2e_${RUN}_${name}`;
if (SCREENSHOTS) fs.mkdirSync(SCREENSHOTS, {recursive: true});
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dap-e2e-'));
const FEED = path.join(TMP, 'feed.json');

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

/// A query over HTTP. Returns the text, or `ERROR <code>` for an exception.
async function http(query, user = ADMIN_USER, password = ADMIN_PASSWORD, params = {}) {
    const url = new URL(`${BASE}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const response = await fetch(url, {method: 'POST', body: query, headers: {'X-ClickHouse-User': user, 'X-ClickHouse-Key': password}});
    const text = (await response.text()).trim();
    return response.ok ? text : `ERROR ${response.headers.get('X-ClickHouse-Exception-Code') || '?'} ${text.split('\n')[0]}`;
}
const admin = query => http(query);
async function must(query) {
    const text = await admin(query);
    if (text.startsWith('ERROR')) throw new Error(`${query.slice(0, 120)}: ${text}`);
    return text;
}
/// The same query with the native protocol, as `clickhouse client` would run it for a BI tool or driver.
function native(query, user) {
    try {
        return execFileSync(CLICKHOUSE, ['client', '--port', NATIVE_PORT, '--user', user, '--password', PASSWORD, '-q', query], {stdio: ['ignore', 'pipe', 'pipe']}).toString().trim();
    } catch (e) {
        const code = (String(e.stderr).match(/Code: (\d+)/) || [])[1];
        return `ERROR ${code || '?'}`;
    }
}
/// Ids a user sees, through both protocols, which must agree.
async function visibleIds(user, table = 'staff') {
    const query = `SELECT arrayStringConcat(arraySort(groupArray(toString(id))), ',') FROM ${DB}.${table}`;
    const over_http = await http(query, user, PASSWORD);
    const over_native = native(query, user);
    check(over_http === over_native, `${user}: HTTP (${over_http}) and native (${over_native}) disagree`);
    return over_http;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 60000, what = 'condition') {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(1000);
    }
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
async function go(tab) {
    await page.evaluate(t => {
        const dialog = document.getElementById('admin-dialog');
        if (dialog.open) dialog.close();
        history.pushState(null, '', t);
        dispatchEvent(new PopStateEvent('popstate'));
    }, `/console/admin-data-access?tab=${tab}`);
    await idle();
}
async function idle() {
    await sleep(300);
    await until(() => page.evaluate(() => !document.querySelector('#admin-view .spinner, #admin-dialog[open] .spinner')), 60000, 'the page to load');
    await sleep(300);
}
const view = () => page.locator('#admin-view');
const dialog = () => page.locator('#admin-dialog');
async function shot(name) {
    if (SCREENSHOTS) await page.screenshot({path: path.join(SCREENSHOTS, `${name}.png`), fullPage: true});
}
async function chooseTable(scope, database, table) {
    await scope.locator('.filter-bar select').first().selectOption(database);
    await idle();
    await scope.locator('.filter-bar select').nth(1).selectOption(table);
    await idle();
}
async function review() {
    await dialog().locator('.dialog-actions button', {hasText: 'Review'}).click();
    await sleep(600);
    const errors = (await dialog().locator('form .message.error:not([hidden])').allInnerTexts()).filter(Boolean);
    if (errors.length) throw new Error(`form error: ${errors.join(' ')}`);
}
async function formError() {
    await dialog().locator('.dialog-actions button', {hasText: 'Review'}).click();
    await sleep(600);
    return (await dialog().locator('form .message.error:not([hidden])').allInnerTexts()).filter(Boolean).join(' ');
}
async function applyPlan() {
    const plan = await dialog().innerText();
    await dialog().locator('.dialog-actions button.primary').last().click();
    await dialog().locator('.dialog-actions button', {hasText: 'Close'}).waitFor({timeout: 90000});
    const text = await dialog().innerText();
    await page.evaluate(() => document.getElementById('admin-dialog').close());
    await idle();
    return {plan, text};
}
async function clickIn(scope, text) {
    await scope.locator('button', {hasText: text}).first().click();
    await idle();
}
function runWorker(env = {}) {
    const output = execFileSync(process.execPath, [WORKER, '--once'], {env: {...process.env, CLICKHOUSE_URL: BASE, CLICKHOUSE_USER: U('worker'), CLICKHOUSE_PASSWORD: PASSWORD,
        ADMIN_DATABASE: ADMIN_DB, CONSOLE_HTML, ATTRIBUTE_FEED: FEED, ATTRIBUTE_FEED_SOURCE: 'hr', ...env}}).toString();
    return output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function writeFeed(entries) {
    fs.writeFileSync(FEED, JSON.stringify(Object.entries(entries).map(([user, attributes]) => ({user: U(user), attributes}))));
}

// ---------------------------------------------------------------------------------------------
// Synthetic data and identities

const STAFF = [[1, 'Ada', 'north', 'acme', 100, '111-11'], [2, 'Bo', 'north', 'acme', 200, '222-22'], [3, 'Cy', 'south', 'acme', 300, '333-33'],
    [4, 'Di', 'south', 'globex', 400, '444-44'], [5, 'Ed', 'east', 'globex', 500, '555-55']];
const USERS = ['analyst', 'north', 'south', 'nopolicy', 'mixed', 'limited_admin', 'worker', 'fin_a', 'fin_b', 'fin_c', 'outsider'];

async function setUp() {
    await must(`CREATE DATABASE ${DB}`);
    await must(`CREATE TABLE ${DB}.staff (id UInt32, name String, branch String, company String, salary UInt32, ssn String) ENGINE = MergeTree ORDER BY id`);
    await must(`INSERT INTO ${DB}.staff VALUES ${STAFF.map(r => `(${r[0]}, '${r[1]}', '${r[2]}', '${r[3]}', ${r[4]}, '${r[5]}')`).join(', ')}`);
    for (const name of USERS) await must(`CREATE USER ${U(name)} IDENTIFIED BY '${PASSWORD}'`);
    for (const role of ['col_reader', 'wide_reader', 'low_salary', 'fin']) await must(`CREATE ROLE ${U(role)}`);
    await must(`GRANT SELECT ON ${DB}.staff TO ${U('north')}, ${U('south')}, ${U('nopolicy')}, ${U('mixed')}, ${U('fin_a')}, ${U('fin_b')}, ${U('fin_c')}, ${U('outsider')}`);
    await must(`REVOKE SELECT(ssn) ON ${DB}.staff FROM ${U('fin_a')}, ${U('fin_b')}, ${U('fin_c')}, ${U('outsider')}`);
    await must(`GRANT SELECT ON ${DB}.* TO ${U('wide_reader')}`);
    /// The finance role reads the table except the classified column: only the clearance rule gives that column.
    await must(`GRANT SELECT ON ${DB}.staff TO ${U('fin')}`);
    await must(`REVOKE SELECT(ssn) ON ${DB}.staff FROM ${U('fin')}`);
    /// An administrator who can read the access tables but not change grants or policies.
    await must(`GRANT SELECT ON system.* TO ${U('limited_admin')}`);
    await must(`GRANT SHOW USERS, SHOW ROLES, SHOW ROW POLICIES, SHOW COLUMNS, SHOW TABLES, SHOW DATABASES ON *.* TO ${U('limited_admin')}`);
    await must(`GRANT SELECT ON ${DB}.* TO ${U('limited_admin')}`);
    /// Every console user needs to read the component policy, or the console hides the pages it governs.
    await must(`GRANT ${ADMIN_DB}_reader TO ${U('limited_admin')}`);
    /// The access policy worker: reads, writes its records and the feed's attribute values, and impersonates the rule
    /// author. It cannot grant anything itself.
    await must(`GRANT SELECT ON ${ADMIN_DB}.* TO ${U('worker')}`);
    await must(`GRANT INSERT ON ${ADMIN_DB}.dap_owned TO ${U('worker')}`);
    await must(`GRANT INSERT ON ${ADMIN_DB}.dap_deployments TO ${U('worker')}`);
    await must(`GRANT INSERT ON ${ADMIN_DB}.dap_user_attributes TO ${U('worker')}`);
    await must(`GRANT INSERT ON ${ADMIN_DB}.audit_log TO ${U('worker')}`);
    for (const table of ['users', 'roles', 'role_grants', 'grants', 'row_policies']) await must(`GRANT SELECT ON system.${table} TO ${U('worker')}`);
    await must(`GRANT SHOW USERS, SHOW ROLES, SHOW ROW POLICIES ON *.* TO ${U('worker')}`);
    await must(`GRANT IMPERSONATE ON ${ADMIN_USER} TO ${U('worker')}`);
}

async function tearDown() {
    const policies = (await admin(`SELECT short_name, database, table FROM system.row_policies WHERE database = '${DB}' FORMAT JSONEachRow`)).split('\n').filter(Boolean).map(l => JSON.parse(l));
    for (const p of policies) await admin(`DROP ROW POLICY IF EXISTS \`${p.short_name}\` ON ${p.database}.${p.table || '*'}`);
    const roles = (await admin(`SELECT name FROM system.roles WHERE startsWith(name, 'dap_e2e_${RUN}_') OR name IN (SELECT DISTINCT splitByChar(':', key)[2] FROM ${ADMIN_DB}.dap_owned
        WHERE startsWith(key, 'role:') AND rule_id IN (SELECT rule_id FROM ${ADMIN_DB}.dap_rules WHERE startsWith(name, 'e2e ${RUN}')))`)).split('\n').filter(Boolean);
    for (const role of roles) await admin(`DROP ROLE IF EXISTS \`${role}\``);
    for (const name of USERS) await admin(`DROP USER IF EXISTS ${U(name)}`);
    /// The console records of the run are retired like the console does it, with a row marked deleted; the audit log stays.
    await admin(`INSERT INTO ${ADMIN_DB}.dap_access_tests (test_id, name, user_name, database, table, columns, expect, expected_rows, deleted)
        SELECT test_id, name, user_name, database, table, columns, expect, expected_rows, true FROM ${ADMIN_DB}.dap_access_tests FINAL WHERE startsWith(name, 'e2e ${RUN} ')`);
    await admin(`INSERT INTO ${ADMIN_DB}.dap_attributes (attribute, category, dynamic, source, writer, owner, max_age_seconds, description, deleted)
        SELECT attribute, category, dynamic, source, writer, owner, max_age_seconds, description, true FROM ${ADMIN_DB}.dap_attributes FINAL
        WHERE startsWith(attribute, 'e2e_${RUN}_') OR (attribute = 'employment_status' AND writer = '${U('worker')}')`);
    await admin(`INSERT INTO ${ADMIN_DB}.dap_classifications (database, table, column, label, source, owner, deleted)
        SELECT database, table, column, label, source, owner, true FROM ${ADMIN_DB}.dap_classifications FINAL WHERE database = '${DB}'`);
    await admin(`DROP DATABASE IF EXISTS ${DB}`);
    fs.rmSync(TMP, {recursive: true, force: true});
}

// ---------------------------------------------------------------------------------------------
// Stage 1: native column permissions and row policies

/// On a server without the console tables, such as a new one, those of the administration pages (the audit log and the
/// role console_admin_reader, which the users of the checks get) are created first, through the console's own setup.
if (await admin(`SELECT count() FROM system.tables WHERE database = '${ADMIN_DB}' AND name IN ('audit_log', 'component_policy', 'protected_accounts')`) !== '3') {
    await signIn();
    await page.evaluate(() => { history.pushState(null, '', '/console/admin-access'); dispatchEvent(new PopStateEvent('popstate')); });
    await idle();
    await view().locator('button', {hasText: 'Set up'}).first().click();
    await dialog().locator('.dialog-actions button', {hasText: 'Review'}).click();
    await sleep(400);
    check((await applyPlan()).text.includes('Applied.'), 'the setup of the administration pages failed');
}

try {
    await setUp();
} catch (e) {
    await tearDown();
    throw e;
}
await signIn();

await test('Column grant from the console: allowed columns are readable, restricted ones are rejected, over HTTP and native', async () => {
    await go('columns');
    await chooseTable(view(), DB, 'staff');
    await clickIn(view(), 'Grant columns');
    await dialog().getByLabel('To').selectOption(`role:${U('col_reader')}`);
    await dialog().getByLabel('id (UInt32)').check();
    await dialog().getByLabel('name (String)').check();
    await dialog().getByLabel('branch (String)').check();
    await review();
    check((await dialog().innerText()).includes('SELECT * will fail'), 'the review does not explain SELECT *');
    check((await applyPlan()).text.includes('Applied.'), 'not applied');
    await must(`GRANT ${U('col_reader')} TO ${U('analyst')}`);
    check(await http(`SELECT count() FROM (SELECT id, name, branch FROM ${DB}.staff)`, U('analyst'), PASSWORD) === '5', 'the granted columns are not readable over HTTP');
    check(native(`SELECT count() FROM (SELECT id, name, branch FROM ${DB}.staff)`, U('analyst')) === '5', 'the granted columns are not readable with the native client');
    for (const query of [`SELECT salary FROM ${DB}.staff`, `SELECT * FROM ${DB}.staff`, `SELECT id FROM ${DB}.staff WHERE salary > 100`]) {
        check((await http(query, U('analyst'), PASSWORD)).startsWith('ERROR 497'), `HTTP allowed: ${query}`);
        check(native(query, U('analyst')) === 'ERROR 497', `native allowed: ${query}`);
    }
    await go('columns');
    await chooseTable(view(), DB, 'staff');
    const row = view().locator('tr', {hasText: U('analyst')}).first();
    check(await row.locator('.badge', {hasText: '✓'}).count() === 3, 'the matrix does not show three column grants for the analyst');
    await shot('s1-columns');
});

await test('A broader grant that overrides the column restriction is detected', async () => {
    await must(`GRANT ${U('wide_reader')} TO ${U('analyst')}`);
    check(!(await http(`SELECT salary FROM ${DB}.staff LIMIT 1`, U('analyst'), PASSWORD)).startsWith('ERROR'), 'the broader grant does not give salary');
    await go('columns');
    await chooseTable(view(), DB, 'staff');
    const broad = view().locator('table[aria-label="Broader grants"] tr', {hasText: U('analyst')});
    check(await broad.count() >= 1, 'the broader grant of the analyst is not listed');
    check((await broad.first().innerText()).includes('Yes'), 'the override of column grants is not flagged');
    check((await broad.first().innerText()).includes(U('wide_reader')), 'the role path of the broader grant is not shown');
    await go('effective');
    const pickers = view().locator('.filter-bar select');
    await pickers.nth(0).selectOption(U('analyst'));
    await idle();
    await pickers.nth(1).selectOption(DB);
    await idle();
    await pickers.nth(2).selectOption('staff');
    await idle();
    check((await view().innerText()).includes('Column grants restrict nothing'), 'Effective Access does not report the conflict');
    await shot('s1-effective-conflict');
    await must(`REVOKE ${U('wide_reader')} FROM ${U('analyst')}`);
    check((await http(`SELECT salary FROM ${DB}.staff LIMIT 1`, U('analyst'), PASSWORD)).startsWith('ERROR 497'), 'salary readable after the revoke');
});

async function createPolicy({name, conditions, targets, kind = 'permissive'}) {
    await go('rows');
    await clickIn(view(), 'Create row policy');
    await dialog().getByLabel('Name').fill(name);
    await dialog().getByLabel('Database', {exact: true}).selectOption(DB);
    await idle();
    await dialog().getByLabel('Table', {exact: true}).selectOption('staff');
    await idle();
    await dialog().getByLabel('Kind').selectOption(kind);
    for (const target of targets) await dialog().getByLabel(target, {exact: true}).check();
    for (const [i, c] of conditions.entries()) {
        if (i > 0) await dialog().locator('button', {hasText: 'Add condition'}).click();
        const row = dialog().locator('.dap-condition').nth(i);
        await row.getByLabel('Column').selectOption(c.column);
        await row.getByLabel('Condition').selectOption(c.op);
        if (c.values) await row.getByLabel('Values').fill(c.values);
    }
    await review();
    return applyPlan();
}

await test('Row policies from the structured editor return the intended subset, over HTTP and native', async () => {
    const north = await createPolicy({name: `e2e_${RUN}_north`, targets: [`user ${U('north')}`], conditions: [{column: 'branch', op: 'eq', values: 'north'}]});
    check(north.text.includes('Applied.'), 'the north policy was not created');
    check(north.plan.includes(U('north')) && north.plan.includes("`branch` = 'north'"), 'the review does not show the statement and the affected user');
    const south = await createPolicy({name: `e2e_${RUN}_south`, targets: [`user ${U('south')}`], conditions: [{column: 'branch', op: 'in', values: 'south, east'}]});
    check(south.text.includes('Applied.'), 'the south policy was not created');
    check(await visibleIds(U('north')) === '1,2', 'north does not see exactly the north rows');
    check(await visibleIds(U('south')) === '3,4,5', 'south does not see exactly the south and east rows');
});

await test('Several roles and policies combine as documented: permissive with OR, restrictive with AND', async () => {
    await must(`GRANT ${U('low_salary')} TO ${U('mixed')}`);
    const a = await createPolicy({name: `e2e_${RUN}_mixed_acme`, targets: [`user ${U('mixed')}`], conditions: [{column: 'company', op: 'eq', values: 'acme'}]});
    const b = await createPolicy({name: `e2e_${RUN}_mixed_east`, targets: [`user ${U('mixed')}`], conditions: [{column: 'branch', op: 'eq', values: 'east'}]});
    const c = await createPolicy({name: `e2e_${RUN}_low`, kind: 'restrictive', targets: [`role ${U('low_salary')}`], conditions: [{column: 'salary', op: 'in', values: '100, 300, 500'}]});
    check(a.text.includes('Applied.') && b.text.includes('Applied.') && c.text.includes('Applied.'), 'a policy was not created');
    /// (company = acme OR branch = east) AND salary IN (100, 300, 500): ids 1, 3, 5.
    check(await visibleIds(U('mixed')) === '1,3,5', `mixed sees ${await visibleIds(U('mixed'))}`);
    await go('rows');
    await chooseTable(view().locator('.box').nth(1), DB, 'staff');
    const row = view().locator('table[aria-label^="Row filters"] tr', {hasText: U('mixed')}).first();
    const text = await row.innerText();
    check(text.includes(' OR ') && text.includes(' AND '), `the combined filter is not explained: ${text}`);
    await shot('s1-row-policies');
});

await test('A user without a matching policy sees every row, and the console says so', async () => {
    check(await visibleIds(U('nopolicy')) === '1,2,3,4,5', 'the unmatched user does not see every row');
    const row = view().locator('table[aria-label^="Row filters"] tr', {hasText: U('nopolicy')}).first();
    check((await row.innerText()).includes('no policy applies'), 'the unmatched user is not flagged');
    const users_section = await view().innerText();
    check(users_section.includes('Users who can change rows'), 'the write paths are not listed');
});

await test('Bypass paths are listed: a view that runs as its definer, and a Distributed table', async () => {
    await must(`CREATE VIEW ${DB}.all_staff DEFINER = ${ADMIN_USER} SQL SECURITY DEFINER AS SELECT id, branch FROM ${DB}.staff`);
    await must(`GRANT SELECT ON ${DB}.all_staff TO ${U('north')}`);
    check(await http(`SELECT count() FROM ${DB}.all_staff`, U('north'), PASSWORD) === '5', 'the definer view does not bypass the policy, the check is wrong');
    await go('rows');
    await chooseTable(view().locator('.box').nth(1), DB, 'staff');
    const paths = view().locator('table[aria-label="Bypass paths"]');
    check((await paths.innerText()).includes(`${DB}.all_staff`), 'the definer view is not listed as a bypass path');
    await must(`DROP VIEW ${DB}.all_staff`);
});

if (CLUSTER) {
    await test('Distributed reads keep the row filter on the shards (interserver secret)', async () => {
        await must(`CREATE TABLE ${DB}.staff_all AS ${DB}.staff ENGINE = Distributed(${CLUSTER}, ${DB}, staff)`);
        await must(`GRANT SELECT ON ${DB}.staff_all TO ${U('north')}`);
        const ids = await http(`SELECT arrayStringConcat(arraySort(groupArray(toString(id))), ',') FROM ${DB}.staff_all SETTINGS prefer_localhost_replica = 0`, U('north'), PASSWORD);
        check(ids === '1,2', `north reads ${ids} through the Distributed table`);
        await go('rows');
        await chooseTable(view().locator('.box').nth(1), DB, 'staff');
        check((await view().locator('table[aria-label="Bypass paths"]').innerText()).includes('staff_all'), 'the Distributed table is not listed');
    });
}

await test('An administrator without the privileges cannot change policies: the server refuses, and the console records it', async () => {
    await signIn(U('limited_admin'), PASSWORD);
    try {
        const result = await createPolicy({name: `e2e_${RUN}_rogue`, targets: [`user ${U('nopolicy')}`], conditions: [{column: 'branch', op: 'eq', values: 'north'}]});
        check(result.text.includes('Not applied'), 'the change was not refused');
        check(await admin(`SELECT count() FROM system.row_policies WHERE short_name = 'e2e_${RUN}_rogue'`) === '0', 'the policy exists');
        await go('rows');
        await clickIn(view(), 'Create row policy');
        await dialog().getByLabel('Filter').selectOption('advanced');
        check(await dialog().getByLabel('Expression').isDisabled(), 'the expression editor is open to an administrator without global policy privileges');
        await page.evaluate(() => document.getElementById('admin-dialog').close());
    } finally {
        await signIn();
    }
});

await test('Advanced expressions are checked with the server parser: subqueries are refused', async () => {
    await go('rows');
    await clickIn(view(), 'Create row policy');
    await dialog().getByLabel('Name').fill(`e2e_${RUN}_adv`);
    await dialog().getByLabel('Database', {exact: true}).selectOption(DB);
    await idle();
    await dialog().getByLabel('Table', {exact: true}).selectOption('staff');
    await idle();
    await dialog().getByLabel(`user ${U('outsider')}`, {exact: true}).check();
    await dialog().getByLabel('Filter').selectOption('advanced');
    await dialog().getByLabel('Expression').fill(`branch IN (SELECT branch FROM ${DB}.staff)`);
    check((await formError()).includes('subqueries'), 'a subquery was accepted');
    await dialog().getByLabel('Expression').fill('no_such_column = 1');
    check((await formError()).length > 0, 'an unknown column was accepted');
    await page.evaluate(() => document.getElementById('admin-dialog').close());
});

// ---------------------------------------------------------------------------------------------
// Access tests

async function ensureSetUp() {
    await go('tests');
    const setup = view().locator('button', {hasText: 'Set up'});
    if (await setup.count()) {
        await setup.click();
        await sleep(400);
        check((await applyPlan()).text.includes('Applied.'), 'the setup failed');
        await sleep(2000);
        await go('tests');
    }
}

async function addTest(name, user, columns, expect, rows) {
    await go('tests');
    await clickIn(view(), 'Add test');
    await dialog().getByLabel('Name').fill(name);
    await dialog().getByLabel('As user').selectOption(U(user));
    await dialog().getByLabel('Database', {exact: true}).selectOption(DB);
    await idle();
    await dialog().getByLabel('Table', {exact: true}).selectOption('staff');
    await dialog().getByLabel('Columns').fill(columns);
    await dialog().getByLabel('Expected', {exact: true}).selectOption(expect);
    if (rows !== undefined) await dialog().getByLabel('Expected rows').fill(String(rows));
    await review();
    check((await applyPlan()).text.includes('Applied.'), `the test ${name} was not added`);
}

await test('Access tests: approved positive and negative tests run as the users and record only the outcome', async () => {
    await ensureSetUp();
    await addTest(`e2e ${RUN} north rows`, 'north', 'id, branch', 'allowed', 2);
    await addTest(`e2e ${RUN} analyst salary`, 'analyst', 'salary', 'denied');
    await addTest(`e2e ${RUN} wrong expectation`, 'south', 'id', 'allowed', 1);
    await go('tests');
    await clickIn(view(), 'Run all');
    await sleep(1500);
    await go('tests');
    const row = name => view().locator('tr', {hasText: name}).first().innerText();
    check((await row(`e2e ${RUN} north rows`)).includes('Pass'), 'the positive test did not pass');
    check((await row(`e2e ${RUN} analyst salary`)).includes('Pass'), 'the negative test did not pass');
    check((await row(`e2e ${RUN} wrong expectation`)).includes('Fail'), 'a wrong expectation passed');
    const observed = await admin(`SELECT groupArray(observed) FROM ${ADMIN_DB}.dap_test_runs WHERE user_name LIKE 'dap_e2e_${RUN}_%'`);
    check(!/111-11|Ada|north/.test(observed), `test runs recorded data: ${observed}`);
    await shot('s1-access-tests');
});

await test('Running a test without IMPERSONATE on its user is an error, not a pass', async () => {
    await must(`GRANT SELECT ON ${ADMIN_DB}.* TO ${U('limited_admin')}`);
    await must(`GRANT INSERT ON ${ADMIN_DB}.dap_test_runs TO ${U('limited_admin')}`);
    await signIn(U('limited_admin'), PASSWORD);
    try {
        await go('tests');
        await view().locator('tr', {hasText: `e2e ${RUN} north rows`}).locator('button', {hasText: 'Run'}).click();
        await sleep(1500);
        await go('tests');
        const text = await view().locator('tr', {hasText: `e2e ${RUN} north rows`}).first().innerText();
        check(text.includes('Error') && text.includes('IMPERSONATE'), `the run without IMPERSONATE was not an error: ${text}`);
    } finally {
        await signIn();
    }
});

// ---------------------------------------------------------------------------------------------
// Stage 2: attributes, rules, deployments, reconciliation

async function defineAttribute(name, {category = 'user', dynamic = false, source = 'hr', writer = U('worker'), max_age = 0} = {}) {
    await go('attributes');
    await clickIn(view(), 'Define attribute');
    await dialog().getByLabel('Attribute', {exact: true}).fill(name);
    await dialog().getByLabel('Category').selectOption(category);
    if (dynamic) await dialog().getByLabel(/Evaluated per request/).check();
    await dialog().getByLabel('Source of truth').fill(source);
    await dialog().getByLabel('Writer').fill(writer);
    await dialog().getByLabel('Owner').fill('e2e identity team');
    await dialog().getByLabel('Fresh for (seconds)').fill(String(max_age));
    await review();
    check((await applyPlan()).text.includes('Applied.'), `the attribute ${name} was not defined`);
}

/// Attribute names are global in the console tables: the run's names avoid clashes with other runs.
const A = name => `e2e_${RUN}_${name}`;

async function createRule(name, kind, fields) {
    await go('rules');
    await clickIn(view(), 'New rule');
    await dialog().getByLabel('Name').fill(`e2e ${RUN} ${name}`);
    await dialog().getByLabel('Kind').selectOption(kind);
    await dialog().getByLabel('Users').fill(fields.selector || '');
    if (fields.role) await dialog().getByLabel('Role', {exact: true}).selectOption(fields.role);
    if (kind === 'row_filter') {
        await dialog().getByLabel('Database', {exact: true}).selectOption(DB);
        await idle();
        await dialog().getByLabel('Table', {exact: true}).selectOption('staff');
        await idle();
        await dialog().getByLabel('Column', {exact: true}).selectOption(fields.column);
        await dialog().getByLabel('Attribute', {exact: true}).selectOption(fields.attribute);
    }
    if (kind === 'column_clearance') {
        await dialog().getByLabel('Label').selectOption(fields.label);
        await dialog().getByLabel('Clearance attribute').selectOption(fields.attribute);
        await dialog().getByLabel('Values that clear').fill(fields.values);
    }
    if (fields.on_stale) await dialog().getByLabel('Missing or stale attribute').selectOption(fields.on_stale);
    if (fields.expect_error) {
        const error = await formError();
        await page.evaluate(() => document.getElementById('admin-dialog').close());
        return error;
    }
    await review();
    const result = await applyPlan();
    check(result.text.includes('Applied.'), `the rule ${name} was not saved`);
    return result.plan;
}

async function deploy() {
    await go('deployments');
    const deploy_button = view().locator('button', {hasText: 'Deploy'}).first();
    if (await deploy_button.isDisabled()) return null;
    await deploy_button.click();
    await sleep(500);
    return applyPlan();
}

let feed;

await test('Attributes and classifications are defined with their source, writer, owner, and freshness', async () => {
    await defineAttribute(A('department'));
    await defineAttribute(A('branch'), {max_age: 3600});
    await defineAttribute(A('clearance'));
    await defineAttribute('employment_status');
    await defineAttribute(A('purpose'), {category: 'environment', dynamic: true, source: 'request', writer: ''});
    await go('attributes');
    await clickIn(view(), 'Classify column');
    await dialog().getByLabel('Database', {exact: true}).selectOption(DB);
    await idle();
    await dialog().getByLabel('Table', {exact: true}).selectOption('staff');
    await idle();
    await dialog().getByLabel('Column', {exact: true}).selectOption('ssn');
    await dialog().getByLabel('Label').fill(`secret_${RUN}`);
    await dialog().getByLabel('Owner').fill('e2e data owner');
    await review();
    check((await applyPlan()).text.includes('Applied.'), 'the classification was not saved');
    feed = {
        fin_a: {[A('department')]: 'Finance', [A('branch')]: 'north', [A('clearance')]: 'secret', employment_status: 'active'},
        fin_b: {[A('department')]: 'Finance', [A('branch')]: 'south', [A('clearance')]: 'public', employment_status: 'active'},
        fin_c: {[A('department')]: 'Finance', [A('branch')]: 'east', [A('clearance')]: 'secret', employment_status: 'active'},
        outsider: {[A('department')]: 'Sales', [A('branch')]: 'north', employment_status: 'active'},
    };
    writeFeed(feed);
    const log = runWorker();
    check(log.some(l => l.message === 'attribute feed imported' && l.values >= 13), `the feed was not imported: ${JSON.stringify(log)}`);
    await go('attributes');
    const text = await view().innerText();
    check(text.includes(U('fin_a')) && text.includes('Fresh'), 'the imported values are not shown as fresh');
});

await test('A value written by someone other than the attribute\'s writer is not trusted', async () => {
    await go('attributes');
    await clickIn(view(), 'Set value');
    const options = await dialog().getByLabel('Attribute', {exact: true}).locator('option').allInnerTexts();
    check(!options.some(o => o.startsWith(A('department'))), 'the console offers an attribute written by the import');
    await page.evaluate(() => document.getElementById('admin-dialog').close());
    /// Written directly: the server records the real writer, and the model does not trust it.
    await must(`INSERT INTO ${ADMIN_DB}.dap_user_attributes (user_name, attribute, value, source, observed_at) VALUES ('${U('outsider')}', '${A('clearance')}', 'secret', 'hr', now())`);
    await go('attributes');
    const row = view().locator('tr', {hasText: U('outsider')}).filter({hasText: A('clearance')}).first();
    check((await row.innerText()).includes('Not trusted'), 'the value written by another user is trusted');
});

await test('Rules that native controls cannot represent are refused, not approximated', async () => {
    const error = await createRule('purpose', 'role_membership', {selector: `${A('purpose')} = audit`, role: U('fin'), expect_error: true});
    check(error.includes('evaluated per request'), `the dynamic rule was not refused: ${error}`);
});

await test('Rules provision native controls: role membership, row filter per branch, and clearance for classified columns', async () => {
    await createRule('finance role', 'role_membership', {selector: `${A('department')} = Finance`, role: U('fin')});
    await createRule('branch rows', 'row_filter', {selector: `${A('department')} = Finance`, column: 'branch', attribute: A('branch')});
    const plan = await createRule('secret columns', 'column_clearance', {selector: `${A('department')} = Finance`, label: `secret_${RUN}`, attribute: A('clearance'), values: 'secret'});
    check(plan.includes('3 users matched'), `the rule preview does not resolve the users: ${plan.slice(0, 300)}`);
    await go('rules');
    await view().locator('tr', {hasText: `e2e ${RUN} branch rows`}).locator('button', {hasText: 'Explain'}).click();
    await sleep(500);
    const explain = await dialog().innerText();
    check(explain.includes('Resolved attributes') && explain.includes('Generated controls') && explain.includes('Target nodes and verification'), 'the rule explanation is incomplete');
    check(explain.includes(U('fin_a')) && explain.includes(`${A('branch')} = north`), 'the resolved attributes are not shown');
    await page.evaluate(() => document.getElementById('admin-dialog').close());
    const result = await deploy();
    check(result && result.text.includes('Applied.'), `the deployment failed: ${result && result.text.slice(0, 500)}`);
    check(await visibleIds(U('fin_a')) === '1,2', 'fin_a does not see the north rows');
    check(await visibleIds(U('fin_b')) === '3,4', 'fin_b does not see the south rows');
    check(await visibleIds(U('fin_c')) === '5', 'fin_c does not see the east rows');
    check(!(await http(`SELECT ssn FROM ${DB}.staff`, U('fin_a'), PASSWORD)).startsWith('ERROR'), 'the cleared user cannot read the secret column');
    check((await http(`SELECT ssn FROM ${DB}.staff`, U('fin_b'), PASSWORD)).startsWith('ERROR 497'), 'a user without clearance reads the secret column');
    check(native(`SELECT ssn FROM ${DB}.staff`, U('fin_b')) === 'ERROR 497', 'a user without clearance reads the secret column with the native client');
    check(await visibleIds(U('outsider')) === '1,2,3,4,5', 'the outsider is affected by the rules');
    await go('deployments');
    check((await view().locator('button', {hasText: 'Deploy'}).first().isDisabled()), 'a second deployment would change something: not idempotent');
    await shot('s2-deployments');
});

await test('Department and branch changes update access through the worker', async () => {
    feed.fin_b[A('branch')] = 'east';
    feed.fin_c[A('department')] = 'Sales';
    writeFeed(feed);
    const started = Date.now();
    const log = runWorker();
    check(log.some(l => l.message === 'reconciled' && l.result === 'success'), `the worker did not reconcile: ${JSON.stringify(log.slice(-3))}`);
    check(await visibleIds(U('fin_b')) === '5', 'fin_b does not see the east rows after the change');
    check(await visibleIds(U('fin_c')) === '1,2,3,4,5', 'fin_c keeps a branch filter after leaving Finance');
    check(!(await admin(`SELECT groupArray(granted_role_name) FROM system.role_grants WHERE user_name = '${U('fin_c')}'`)).includes(U('fin')), 'fin_c keeps the finance role');
    console.log(`      reconciliation took ${Date.now() - started} ms after the feed changed`);
});

await test('Clearance reduction removes the entitlement to classified columns', async () => {
    feed.fin_a[A('clearance')] = 'public';
    writeFeed(feed);
    runWorker();
    check((await http(`SELECT ssn FROM ${DB}.staff`, U('fin_a'), PASSWORD)).startsWith('ERROR 497'), 'fin_a still reads the secret column');
    check(await http(`SELECT count() FROM ${DB}.staff`, U('fin_a'), PASSWORD) === '2', 'fin_a lost the other columns');
});

await test('A disabled identity loses what the rules gave, and the console says what remains', async () => {
    feed.fin_a.employment_status = 'terminated';
    writeFeed(feed);
    runWorker();
    check(!(await admin(`SELECT groupArray(granted_role_name) FROM system.role_grants WHERE user_name = '${U('fin_a')}'`)).includes(U('fin')), 'fin_a keeps the finance role');
    /// fin_a can still sign in with its own credentials: the branch filter fails closed instead of disappearing,
    /// so the direct grant on the table does not show more rows than before.
    check(await http('SELECT 1', U('fin_a'), PASSWORD) === '1', 'the authentication model differs from the documentation');
    check(await visibleIds(U('fin_a')) === '', `the disabled identity sees rows: ${await visibleIds(U('fin_a'))}`);
    await go('deployments');
    check((await view().innerText()).includes('Disabled identities'), 'the deployments page does not report the disabled identity');
});

await test('A grant made outside the platform is reported and survives the rule', async () => {
    await must(`GRANT ${U('fin')} TO ${U('outsider')}`);
    await go('deployments');
    const text = await view().innerText();
    check(!text.includes(`${U('outsider')} already has the role`), 'the outsider is not in scope, there should be no conflict');
    feed.outsider[A('department')] = 'Finance';
    writeFeed(feed);
    runWorker();
    await go('deployments');
    check((await view().innerText()).includes(`${U('outsider')} already has the role ${U('fin')}`), 'the manual grant is not reported');
    feed.outsider[A('department')] = 'Sales';
    writeFeed(feed);
    runWorker();
    check((await admin(`SELECT groupArray(granted_role_name) FROM system.role_grants WHERE user_name = '${U('outsider')}'`)).includes(U('fin')), 'the manual grant was removed');
    await go('deployments');
    await clickIn(view(), 'Verify');
    const verification = await dialog().innerText();
    check(verification.includes(`${U('outsider')} still has ${U('fin')}`) && verification.includes('revocation is not complete'), 'the verification does not report the alternative access');
    await page.evaluate(() => document.getElementById('admin-dialog').close());
    await must(`REVOKE ${U('fin')} FROM ${U('outsider')}`);
});

await test('Reconciliation does not recreate an entitlement revoked outside the platform', async () => {
    await must(`REVOKE ${U('fin')} FROM ${U('fin_b')}`);
    runWorker();
    check(!(await admin(`SELECT groupArray(granted_role_name) FROM system.role_grants WHERE user_name = '${U('fin_b')}'`)).includes(U('fin')), 'the worker restored the revoked role');
    await go('deployments');
    check((await view().innerText()).includes('removed outside'), 'the removal outside the platform is not reported');
});

await test('Stale attributes trigger the configured behavior: the row filter fails closed', async () => {
    /// The branch attribute is fresh for one hour: an observation time older than that makes it stale.
    /// Written by the attribute's writer (the worker's account), as the feed would, but confirmed two hours ago.
    const stale = await http(`INSERT INTO ${ADMIN_DB}.dap_user_attributes (user_name, attribute, value, source, observed_at)
        VALUES ('${U('fin_b')}', '${A('branch')}', 'east', 'hr', now() - INTERVAL 2 HOUR)`, U('worker'), PASSWORD);
    check(!stale.startsWith('ERROR'), stale);
    /// The feed is unavailable (the import fails), so nothing confirms the value again.
    const log = runWorker({ATTRIBUTE_FEED: path.join(TMP, 'missing.json')});
    check(log.some(l => l.message.startsWith('attribute feed failed')), 'the feed outage is not logged');
    check(await visibleIds(U('fin_b')) === '', `fin_b still sees rows with a stale branch: ${await visibleIds(U('fin_b'))}`);
    await go('attributes');
    const row = view().locator('tr', {hasText: U('fin_b')}).filter({hasText: A('branch')}).first();
    check((await row.innerText()).includes('Not trusted'), 'the stale value is not flagged');
});

if (PARTIAL_CLUSTER) {
    await test('A partial deployment on a cluster is visible per server, and deploying again is safe', async () => {
        /// A fresh branch for fin_b, written as the feed would: the next deployment changes its row policy.
        const write = await http(`INSERT INTO ${ADMIN_DB}.dap_user_attributes (user_name, attribute, value, source, observed_at)
            VALUES ('${U('fin_b')}', '${A('branch')}', 'north', 'hr', now())`, U('worker'), PASSWORD);
        check(!write.startsWith('ERROR'), write);
        await go('deployments');
        await page.locator('#admin-scope').selectOption(PARTIAL_CLUSTER);
        const result = await deploy();
        check(result, 'nothing to deploy');
        check(result.text.includes('Partially applied') || result.text.includes('Unfinished'), `the unavailable server is not reported: ${result.text.slice(0, 400)}`);
        await go('deployments');
        const history = await view().locator('table[aria-label="Deployments"] tr').nth(1).innerText();
        check(history.includes('partial'), `the history does not show the partial deployment: ${history}`);
        await page.locator('#admin-scope').selectOption('');
        check(await visibleIds(U('fin_b')) === '1,2', 'the change was not applied on this server');
    });
}

await test('Policy changes are attributable to an actor and a revision', async () => {
    const audit = await admin(`SELECT count() FROM ${ADMIN_DB}.audit_log WHERE action = 'dap_rule_revision' AND actor = '${ADMIN_USER}' AND target_name LIKE 'e2e ${RUN}%'`);
    check(Number(audit) >= 3, `rule revisions are not audited: ${audit}`);
    const revisions = await admin(`SELECT count() FROM ${ADMIN_DB}.dap_rules WHERE name LIKE 'e2e ${RUN}%' AND created_by = '${ADMIN_USER}'`);
    check(Number(revisions) >= 3, 'rule revisions do not record their author');
    const reconciles = await admin(`SELECT count() FROM ${ADMIN_DB}.audit_log WHERE action = 'dap_reconcile' AND actor = '${U('worker')}'`);
    check(Number(reconciles) >= 1, 'reconciliations are not audited with the worker as actor');
    await must('SYSTEM FLUSH LOGS query_log');
    const executed = await admin(`SELECT count() FROM system.query_log WHERE user = '${U('worker')}' AND query LIKE 'EXECUTE AS \`${ADMIN_USER}\` %' AND type = 'QueryFinish'`);
    check(Number(executed) >= 1, 'the worker did not act as the rule author');
    const leaked = await admin(`SELECT count() FROM ${ADMIN_DB}.audit_log WHERE positionCaseInsensitive(details, '${PASSWORD}') > 0 OR positionCaseInsensitive(details, '111-11') > 0`);
    check(leaked === '0', 'the audit log contains a password or data');
    await page.evaluate(t => { history.pushState(null, '', t); dispatchEvent(new PopStateEvent('popstate')); }, '/console/admin-audit?tab=decisions');
    await idle();
    const decisions = await view().innerText();
    check(decisions.includes(U('analyst')) && decisions.includes('Denied'), 'the refused reads are not in the access decisions');
    check(!decisions.includes("'111-11'"), 'the decisions show literals of queries');
    await shot('s2-decisions');
});

await test('Deleting the rules removes the generated controls on the next deployment', async () => {
    await go('rules');
    for (const name of ['finance role', 'branch rows', 'secret columns']) {
        await view().locator('tr', {hasText: `e2e ${RUN} ${name}`}).locator('button', {hasText: 'Delete'}).click();
        await sleep(400);
        check((await applyPlan()).text.includes('Applied.'), `the rule ${name} was not deleted`);
        await go('rules');
    }
    const result = await deploy();
    check(result && result.text.includes('Applied.'), 'the cleanup deployment failed');
    check(await admin(`SELECT count() FROM system.row_policies WHERE database = '${DB}' AND startsWith(short_name, 'dap_')`) === '0', 'generated row policies remain');
    check(await visibleIds(U('fin_b')) === '1,2,3,4,5', 'fin_b keeps a filter after the rules are deleted');
});

await test('No script errors in the pages', async () => {
    check(!page_errors.length, page_errors.join('\n'));
});

await browser.close();
await tearDown();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
