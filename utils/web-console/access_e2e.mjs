/// Browser acceptance checks of the Administration pages of the web console (`/console/admin-*`).
///
/// This is a development tool, not part of the build, like `console_e2e.mjs` next to it (see
/// `README.md`). It drives a running server and checks every result with the server itself.
///
/// Usage: node access_e2e.mjs --url http://127.0.0.1:28123 --admin default:devpass [--cluster console_test] [--screenshots DIR]
///
/// `--admin` is a user with access management and every privilege WITH GRANT OPTION (for example the
/// `default` user with `access_management`). `--cluster` names a cluster whose `ON CLUSTER` changes
/// partly fail (one server down), to check the per-server report. The checks create users, roles,
/// profiles, quotas, and databases named `e2e_*` and remove them at the end. If the console tables do
/// not exist, they are created through the console's setup and kept; the policy rows the checks change
/// are restored.

import {chromium} from 'playwright';
import {mkdirSync} from 'node:fs';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE = arg('url', 'http://127.0.0.1:28123').replace(/\/+$/, '');
const [ADMIN_USER, ADMIN_PASSWORD] = arg('admin', 'default:devpass').split(':');
const CLUSTER = arg('cluster', null);
const SCREENSHOTS = arg('screenshots', null);
if (SCREENSHOTS) mkdirSync(SCREENSHOTS, {recursive: true});
const ADMIN_DB = 'console_admin';

const results = [];

function check(condition, message) {
    if (!condition) throw new Error(message);
}

async function test(name, body) {
    const started = Date.now();
    try {
        await body();
        results.push({name, ok: true, ms: Date.now() - started});
        console.log(`PASS  ${name}`);
    } catch (e) {
        results.push({name, ok: false, ms: Date.now() - started, error: e.message});
        console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
    }
}

/// Runs a query over HTTP. Returns the response text; errors are returned as text too (`Code: ...`).
/// `params` are bound by the server, so their values do not appear in the logged query text.
async function sql(query, user = ADMIN_USER, password = ADMIN_PASSWORD, params = {}) {
    const url = new URL(`${BASE}/`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(`param_${name}`, value);
    const response = await fetch(url, {method: 'POST', body: query, headers: {'X-ClickHouse-User': user, 'X-ClickHouse-Key': password}});
    return (await response.text()).trim();
}

function errorCode(text) {
    const match = text.match(/^Code: (\d+)/);
    return match ? Number(match[1]) : 0;
}

/// Polls `fn` in the page until it returns a truthy value. `waitForFunction` cannot be used: it evaluates
/// strings, which the Content Security Policy of the console rightly forbids.
async function waitUntil(page, fn, timeout = 30000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        if (await page.evaluate(fn)) return;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${fn.toString().slice(0, 200)}`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function screenshot(page, name) {
    if (SCREENSHOTS) await page.screenshot({path: `${SCREENSHOTS}/${name}.png`, fullPage: true});
}

const browser = await chromium.launch();
const page_errors = [];

async function signIn(user, password) {
    const context = await browser.newContext({viewport: {width: 1400, height: 1000}});
    const page = await context.newPage();
    page.on('pageerror', e => page_errors.push(`${user}: ${e.message}`));
    await page.goto(`${BASE}/console/login`);
    await page.fill('#login-user', user);
    await page.fill('#login-password', password);
    await page.click('#login-submit');
    await page.waitForSelector('#shell:not([hidden])');
    /// The capabilities are checked after sign-in; the Administration entries appear when they are known.
    await page.waitForTimeout(2500);
    return {context, page};
}

async function go(page, path) {
    await page.evaluate(target => {
        /// A dialog left open by a failed check would block the next one.
        const open_dialog = document.getElementById('admin-dialog');
        if (open_dialog.open) open_dialog.close();
        history.pushState(null, '', target);
        dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    await waitUntil(page, () => !document.querySelector('#admin-view .spinner'));
    await page.waitForTimeout(300);
}

const dialog = page => page.locator('#admin-dialog');
const view = page => page.locator('#admin-view');

/// Submits a form dialog, applies the reviewed plan, and returns the text of the result.
async function reviewAndApply(page) {
    await dialog(page).locator('button', {hasText: 'Review'}).first().click();
    await page.waitForTimeout(300);
    const form_errors = (await dialog(page).locator('form .message.error:not([hidden])').allInnerTexts()).filter(Boolean);
    if (form_errors.length) throw new Error(`form error: ${form_errors.join(' ')}`);
    return apply(page);
}

async function apply(page) {
    await dialog(page).locator('.dialog-actions button.primary').last().click();
    await dialog(page).locator('.dialog-actions button', {hasText: 'Close'}).waitFor({timeout: 90000});
    return dialog(page).innerText();
}

async function closeDialog(page) {
    await dialog(page).locator('.dialog-actions button', {hasText: 'Close'}).click();
    await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------------------------

const PASSWORD = 'E2e-Changed-Pw-5813';
let generated_password = null;
let original_policy = null;
let admin = null;

await sql(`DROP USER IF EXISTS e2e_user, e2e_scoped, e2e_app_1, e2e_outsider, e2e_doomed`);
await sql(`DROP ROLE IF EXISTS e2e_analyst, e2e_access_admin, e2e_cluster_role`);
await sql(`DROP SETTINGS PROFILE IF EXISTS e2e_limits`);
await sql(`DROP QUOTA IF EXISTS e2e_quota`);
/// Log checks look only at what this run wrote.
const STARTED = await sql('SELECT now()');
for (const statement of ['CREATE DATABASE IF NOT EXISTS e2e_sales', 'CREATE DATABASE IF NOT EXISTS e2e_hr',
    'CREATE TABLE IF NOT EXISTS e2e_sales.orders (id UInt32, amount Float64) ENGINE = MergeTree ORDER BY id',
    'CREATE TABLE IF NOT EXISTS e2e_hr.salaries (id UInt32, salary Float64) ENGINE = MergeTree ORDER BY id',
    'TRUNCATE TABLE e2e_sales.orders', 'INSERT INTO e2e_sales.orders VALUES (1, 10)']) {
    const result = await sql(statement);
    check(!errorCode(result), `${statement}: ${result}`);
}

await test('Administrator opens Users: the permitted inventory appears', async () => {
    admin = await signIn(ADMIN_USER, ADMIN_PASSWORD);
    const sidebar = await admin.page.locator('#sidebar').innerText();
    for (const title of ['Users', 'Roles & Permissions', 'Component Access', 'Profiles & Quotas', 'Audit Activity']) {
        check(sidebar.includes(title), `sidebar has no ${title}`);
    }
    await go(admin.page, '/console/admin-users');
    const users = (await sql('SELECT count() FROM system.users')).trim();
    const text = await view(admin.page).innerText();
    check(text.includes(ADMIN_USER), 'the administrator is not listed');
    check(text.includes(`of ${users}`), `the total is not ${users}`);
    await screenshot(admin.page, 'a01-users');
});

await test('Set up: the console tables exist and the setup is audited', async () => {
    const exists = await sql(`SELECT count() FROM system.tables WHERE database = '${ADMIN_DB}' AND name IN ('audit_log', 'component_policy', 'protected_accounts')`);
    if (exists !== '3') {
        await go(admin.page, '/console/admin-access');
        await view(admin.page).locator('button', {hasText: 'Set up'}).click();
        const result = await reviewAndApply(admin.page);
        check(result.includes('Applied.'), `setup: ${result}`);
        await closeDialog(admin.page);
        await admin.page.waitForTimeout(3000);
    }
    check(await sql(`SELECT count() FROM ${ADMIN_DB}.audit_log WHERE action = 'setup'`) !== '0', 'no setup record');
    original_policy = await sql(`SELECT subject_type, subject, component, open, view_data, run_queries, administer
        FROM ${ADMIN_DB}.component_policy FINAL WHERE NOT deleted FORMAT JSONEachRow`);
    await go(admin.page, '/console/admin-access');
    check((await view(admin.page).innerText()).includes('Rules for'), 'the policy editor is not shown');
});

await test('Administrator creates a role from a template and a user: the user has only the assigned access', async () => {
    const page = admin.page;
    await go(page, '/console/admin-roles');
    await view(page).locator('tr', {hasText: 'Analyst'}).locator('button', {hasText: 'Create role'}).click();
    await dialog(page).locator('input[type=text]').nth(0).fill('e2e_analyst');
    await dialog(page).locator('input[type=text]').nth(1).fill('e2e_sales');
    check((await reviewAndApply(page)).includes('Applied.'), 'the role was not created');
    await closeDialog(page);

    await go(page, '/console/admin-users');
    await view(page).locator('button', {hasText: 'Create user'}).click();
    await dialog(page).locator('input[type=text]').first().fill('e2e_user');
    await dialog(page).locator('label', {hasText: 'e2e_analyst'}).locator('input').check();
    const result = await reviewAndApply(page);
    check(result.includes('Applied.'), `create: ${result}`);
    generated_password = await dialog(page).locator('.secret').innerText();
    check(generated_password.length >= 20, 'no generated password');
    await closeDialog(page);
    check(!(await page.content()).includes(generated_password), 'the generated password stays in the page');

    check(await sql('SELECT currentUser(), count() FROM e2e_sales.orders', 'e2e_user', generated_password) === 'e2e_user\t1', 'the user cannot read its table');
    check(errorCode(await sql('SELECT * FROM e2e_hr.salaries', 'e2e_user', generated_password)) === 497, 'the analyst reads a table it has no grant for');
    await screenshot(page, 'a02-user');
});

await test('Non-administrator calls management operations directly: the server rejects them', async () => {
    for (const statement of [`CREATE USER e2e_outsider IDENTIFIED BY 'Xx-123456789'`, 'ALTER USER e2e_user HOST ANY', 'DROP ROLE e2e_analyst',
        `INSERT INTO ${ADMIN_DB}.audit_log (correlation_id, scope, target_type, target_name, action, summary, result, error, details) SELECT generateUUIDv4(), 'local', 'user', 'x', 'x', 'forged', 'success', '', ''`,
        `INSERT INTO ${ADMIN_DB}.component_policy (subject_type, subject, component, open, view_data, run_queries, administer) SELECT 'all', '', 'merges', 1, 1, 1, 1`]) {
        const result = await sql(statement, 'e2e_user', generated_password);
        check(errorCode(result) === 497, `${statement.slice(0, 40)}: ${result.slice(0, 120)}`);
    }
});

await test('Privilege escalation is rejected', async () => {
    for (const statement of ['GRANT SELECT ON e2e_hr.* TO e2e_user', 'GRANT e2e_analyst TO e2e_user WITH ADMIN OPTION', 'GRANT ALL ON *.* TO e2e_user']) {
        const result = await sql(statement, 'e2e_user', generated_password);
        check(errorCode(result) === 497, `${statement}: ${result.slice(0, 120)}`);
    }
    check(errorCode(await sql('SELECT * FROM e2e_hr.salaries', 'e2e_user', generated_password)) === 497, 'access changed');
});

await test('Password is changed: the new one works, and no secret is in logs or audit records', async () => {
    const page = admin.page;
    await go(page, '/console/admin-users/e2e_user');
    await view(page).locator('button', {hasText: 'Password'}).click();
    await dialog(page).locator('select').first().selectOption('enter');
    await dialog(page).locator('input[type=password]').nth(0).fill(PASSWORD);
    await dialog(page).locator('input[type=password]').nth(1).fill(PASSWORD);
    check((await reviewAndApply(page)).includes('Applied.'), 'not applied');
    await closeDialog(page);
    check(await sql('SELECT currentUser()', 'e2e_user', PASSWORD) === 'e2e_user', 'the new password does not work');
    check(errorCode(await sql('SELECT 1', 'e2e_user', generated_password)) === 516, 'the old password still works');
    await sql('SYSTEM FLUSH LOGS query_log, text_log');
    for (const secret of [PASSWORD, generated_password]) {
        const params = {secret, started: STARTED};
        check(await sql('SELECT count() FROM system.query_log WHERE event_time >= {started:DateTime} AND position(query, {secret:String}) > 0',
            ADMIN_USER, ADMIN_PASSWORD, params) === '0', 'a password is in system.query_log');
        check(await sql('SELECT count() FROM system.text_log WHERE event_time >= {started:DateTime} AND position(message, {secret:String}) > 0',
            ADMIN_USER, ADMIN_PASSWORD, params) === '0', 'a password is in system.text_log');
        check(await sql(`SELECT count() FROM ${ADMIN_DB}.audit_log WHERE position(concat(summary, error, details), {secret:String}) > 0`, ADMIN_USER, ADMIN_PASSWORD, params) === '0', 'a password is in the audit log');
    }
});

await test('User is suspended: new logins are rejected until reactivation', async () => {
    const page = admin.page;
    await go(page, '/console/admin-users/e2e_user');
    await view(page).locator('button', {hasText: 'Suspend'}).click();
    await dialog(page).locator('.dialog-actions button', {hasText: 'Review'}).waitFor();
    check((await dialog(page).innerText()).includes('keep working until they disconnect'), 'the session behavior is not explained');
    check((await reviewAndApply(page)).includes('Applied.'), 'not suspended');
    await closeDialog(page);
    check((await view(page).locator('.admin-head').innerText()).includes('Suspended'), 'the state is not Suspended');
    check(errorCode(await sql('SELECT 1', 'e2e_user', PASSWORD)) === 516, 'a suspended user can log in');
    check(await sql(`SELECT arrayMap(t -> toUnixTimestamp(t), valid_until) FROM system.users WHERE name = 'e2e_user'`) === '[946684800]', 'unexpected VALID UNTIL');
    await view(page).locator('button', {hasText: 'Reactivate'}).click();
    check((await reviewAndApply(page)).includes('Applied.'), 'not reactivated');
    await closeDialog(page);
    check(await sql('SELECT currentUser()', 'e2e_user', PASSWORD) === 'e2e_user', 'the reactivated user cannot log in');
});

await test('Role is revoked: access ends at the next query', async () => {
    const page = admin.page;
    await go(page, '/console/admin-users/e2e_user?tab=roles');
    await view(page).locator('tr', {hasText: 'e2e_analyst'}).locator('button', {hasText: 'Revoke'}).click();
    check((await apply(page)).includes('Applied.'), 'not revoked');
    await closeDialog(page);
    check(errorCode(await sql('SELECT count() FROM e2e_sales.orders', 'e2e_user', PASSWORD)) === 497, 'access remains after the revocation');
    await view(page).locator('button', {hasText: 'Assign role'}).click();
    await dialog(page).locator('select').first().selectOption('e2e_analyst');
    check((await reviewAndApply(page)).includes('Applied.'), 'not assigned again');
    await closeDialog(page);
    check(await sql('SELECT count() FROM e2e_sales.orders', 'e2e_user', PASSWORD) === '1', 'access did not come back');
});

await test('Configuration-managed user: the source is shown and changes are blocked', async () => {
    const name = await sql(`SELECT name FROM system.users WHERE storage IN (SELECT name FROM system.user_directories WHERE type = 'users_xml') ORDER BY name LIMIT 1`);
    check(name && !errorCode(name), 'no user from a configuration file');
    await go(admin.page, `/console/admin-users/${encodeURIComponent(name)}`);
    const text = await view(admin.page).innerText();
    check(text.includes('Configuration') && text.includes('Managed outside of SQL'), 'the source is not shown');
    for (const action of ['Edit', 'Password', 'Suspend', 'Delete']) {
        check(await view(admin.page).locator('.admin-head button', {hasText: action}).isDisabled(), `${action} is enabled`);
    }
});

await test('Profiles and quotas: limits apply to the affected user', async () => {
    const page = admin.page;
    await go(page, '/console/admin-limits');
    await view(page).locator('button', {hasText: 'Create profile'}).click();
    await dialog(page).locator('input[type=text]').first().fill('e2e_limits');
    await dialog(page).getByLabel('Value').first().fill('1');
    await dialog(page).getByLabel('Writability').first().selectOption('CONST');
    check((await reviewAndApply(page)).includes('Applied.'), 'profile not created');
    await closeDialog(page);
    await view(page).locator('tr', {hasText: 'e2e_limits'}).locator('button', {hasText: 'Assign'}).click();
    await dialog(page).locator('select').first().selectOption('USER:e2e_user');
    check((await reviewAndApply(page)).includes('Applied.'), 'profile not assigned');
    await closeDialog(page);
    check(errorCode(await sql('SELECT sleepEachRow(0.5) FROM numbers(4) FORMAT Null SETTINGS max_block_size = 1', 'e2e_user', PASSWORD)) === 159, 'max_execution_time does not apply');
    check(errorCode(await sql('SELECT 1 SETTINGS max_execution_time = 100', 'e2e_user', PASSWORD)) === 452, 'the constraint does not apply');

    await go(page, '/console/admin-limits?tab=quotas');
    await view(page).locator('button', {hasText: 'Create quota'}).click();
    await dialog(page).locator('input[type=text]').first().fill('e2e_quota');
    await dialog(page).getByLabel('queries', {exact: true}).fill('2');
    await dialog(page).locator('label', {hasText: /^e2e_user$/}).locator('input').check();
    check((await reviewAndApply(page)).includes('Applied.'), 'quota not created');
    await closeDialog(page);
    const codes = [];
    for (let i = 0; i < 3; ++i) codes.push(errorCode(await sql('SELECT count() FROM e2e_sales.orders', 'e2e_user', PASSWORD)));
    check(codes.join(',') === '0,0,201', `quota results: ${codes}`);
    await sql('DROP QUOTA e2e_quota');
});

await test('Component access denied: hidden in the UI and on its route; native privileges still decide', async () => {
    const page = admin.page;
    await sql(`INSERT INTO ${ADMIN_DB}.component_policy (subject_type, subject, component, open, view_data, run_queries, administer, deleted) FORMAT JSONEachRow
        {"subject_type": "all", "subject": "", "component": "merges", "open": false, "view_data": false, "run_queries": false, "administer": false, "deleted": false}
        {"subject_type": "user", "subject": "${ADMIN_USER}", "component": "merges", "open": true, "view_data": true, "run_queries": false, "administer": false, "deleted": false}`);
    await sql(`GRANT SELECT ON system.part_log TO e2e_user`);
    const user = await signIn('e2e_user', PASSWORD);
    check(!(await user.page.locator('#sidebar').innerText()).includes('Merges'), 'Merges is listed for e2e_user');
    check(!(await user.page.locator('#home-view').innerText()).includes('Merges visualizer'), 'Merges has a card for e2e_user');
    await go(user.page, '/console/merges');
    check((await user.page.locator('#panel-state').innerText()).includes('is not allowed'), 'the route does not explain the policy');
    check(!errorCode(await sql('SELECT count() FROM system.part_log', 'e2e_user', PASSWORD)), 'the native privilege should still allow the query');
    await screenshot(user.page, 'a03-denied');
    await user.context.close();

    await go(page, '/console/admin-access?tab=user:e2e_user');
    await page.waitForTimeout(2000);
    const row = await view(page).locator('tr', {hasText: 'Merges visualizer'}).innerText();
    check(row.includes('reachable outside of the console'), `the mismatch is not reported: ${row}`);
    await sql(`REVOKE SELECT ON system.part_log FROM e2e_user`);
});

await test('Resources links are governed too: an administrator hides one in the matrix, and the user no longer sees it', async () => {
    const page = admin.page;
    await go(page, '/console/admin-access');
    await page.waitForTimeout(1500);
    const row = await view(page).locator('tr', {hasText: 'Documentation'}).first().innerText();
    check(row.includes('Resources') && row.includes('external website'), `the link is not in the matrix: ${row}`);
    check((await view(page).locator('tr', {hasText: 'Documentation'}).first().locator('input[type=checkbox]').count()) === 1, 'a link has more than the Open capability');
    await view(page).getByLabel('Open Documentation').uncheck();
    await view(page).locator('button', {hasText: 'Save rules'}).click();
    check((await apply(page)).includes('Applied.'), 'the rules were not saved');
    await closeDialog(page);
    check(await sql(`SELECT open FROM ${ADMIN_DB}.component_policy FINAL WHERE subject_type = 'all' AND component = 'documentation' AND NOT deleted`) === 'false', 'no rule for the link');

    const user = await signIn('e2e_user', PASSWORD);
    check(!(await user.page.locator('#sidebar').innerText()).includes('Documentation'), 'Documentation is listed for e2e_user');
    check(!(await user.page.$('.card[data-component="documentation"]')), 'Documentation has a card for e2e_user');
    check(!!(await user.page.$('#sidebar a[data-component="website"]')), 'another link disappeared');
    await go(user.page, '/console/documentation');
    check((await user.page.locator('#panel-state').innerText()).includes('is not allowed'), 'the route does not explain the policy');
    await screenshot(user.page, 'a07-link-denied');
    await user.context.close();
});

await test('Scoped access administrator: manages users in its scope only, and only with its roles', async () => {
    const page = admin.page;
    await go(page, '/console/admin-roles');
    await view(page).locator('tr', {hasText: 'ClickHouse Access Administrator'}).locator('button', {hasText: 'Create role'}).click();
    await dialog(page).locator('input[type=text]').nth(0).fill('e2e_access_admin');
    await dialog(page).locator('input[type=text]').nth(1).fill('e2e_app_*');
    await dialog(page).locator('label', {hasText: 'e2e_analyst'}).locator('input').check();
    check((await reviewAndApply(page)).includes('Applied.'), 'role not created');
    await closeDialog(page);
    await sql(`CREATE USER e2e_scoped IDENTIFIED BY '${PASSWORD}'`);
    await sql('GRANT e2e_access_admin TO e2e_scoped');

    const scoped = await signIn('e2e_scoped', PASSWORD);
    await go(scoped.page, '/console/admin-users');
    check((await view(scoped.page).innerText()).includes('You can manage users whose names match: e2e_app_*'), 'the scope is not shown');
    await view(scoped.page).locator('button', {hasText: 'Create user'}).click();
    await dialog(scoped.page).locator('input[type=text]').first().fill('e2e_app_1');
    await dialog(scoped.page).locator('label', {hasText: 'e2e_analyst'}).locator('input').check();
    check((await reviewAndApply(scoped.page)).includes('Applied.'), 'the user in scope was not created');
    await closeDialog(scoped.page);
    await go(scoped.page, '/console/admin-users');
    await view(scoped.page).locator('button', {hasText: 'Create user'}).click();
    await dialog(scoped.page).locator('input[type=text]').first().fill('e2e_outsider');
    const result = await reviewAndApply(scoped.page);
    check(result.includes('Not applied') && result.includes('CREATE USER ON e2e_outsider'), `out of scope: ${result}`);
    await closeDialog(scoped.page);
    await go(scoped.page, `/console/admin-users/${ADMIN_USER}`);
    check(await view(scoped.page).locator('.admin-head button', {hasText: 'Edit'}).isDisabled(), 'Edit is enabled for a user out of scope');
    await screenshot(scoped.page, 'a04-scoped');
    await scoped.context.close();
    check(await sql(`SELECT count() FROM system.users WHERE name = 'e2e_outsider'`) === '0', 'the user out of scope exists');
});

await test('User is changed outside the console: a refresh shows the server state, and the audit marks it', async () => {
    const page = admin.page;
    check(!errorCode(await sql(`ALTER USER e2e_user HOST IP '10.11.12.0/24'`)), 'ALTER USER failed');
    await go(page, '/console/admin-users/e2e_user');
    check((await view(page).innerText()).includes('10.11.12.0/24'), 'the new hosts are not shown');
    await sql(`ALTER USER e2e_user HOST ANY`);
    await sql('SYSTEM FLUSH LOGS query_log');
    await go(page, '/console/admin-audit?tab=server');
    const row = await view(page).locator('tr', {hasText: "e2e_user HOST IP '10.11.12.0/24'"}).first().innerText();
    check(row.includes('Outside the console'), `not marked: ${row}`);
    const console_row = await view(page).locator('tr', {hasText: 'e2e_user'}).filter({hasText: 'Console'}).count();
    check(console_row > 0, 'no statement of the console is marked');
    await go(page, '/console/admin-audit');
    const text = await view(page).innerText();
    check(text.includes('Suspend e2e_user') && text.includes('Create user e2e_user'), 'console actions are missing');
    await screenshot(page, 'a05-audit');
});

if (CLUSTER) {
    await test('Cluster change partially fails: every server is reported with its result', async () => {
        const page = admin.page;
        await go(page, '/console/admin-roles');
        await view(page).locator('select#admin-scope').selectOption(CLUSTER);
        await view(page).locator('.admin-head button', {hasText: 'Create role'}).click();
        await dialog(page).locator('input[type=text]').first().fill('e2e_cluster_role');
        const result = await reviewAndApply(page);
        check(result.includes('Partially applied'), `result: ${result}`);
        check(result.includes('Done') && result.includes('Unfinished'), `per-server results: ${result}`);
        await screenshot(page, 'a06-cluster');
        await closeDialog(page);
        const record = await sql(`SELECT result, scope FROM ${ADMIN_DB}.audit_log WHERE target_name = 'e2e_cluster_role' ORDER BY event_time DESC LIMIT 1`);
        check(record === `partial\tcluster:${CLUSTER}`, `audit: ${record}`);
        await view(page).locator('select#admin-scope').selectOption('');
    });
}

await test('Delete a user after reviewing its dependencies', async () => {
    const page = admin.page;
    await sql(`CREATE USER e2e_doomed IDENTIFIED BY '${PASSWORD}'`);
    await sql('GRANT e2e_analyst TO e2e_doomed');
    await go(page, '/console/admin-users/e2e_doomed');
    await view(page).locator('.admin-head button', {hasText: 'Delete'}).click();
    await dialog(page).locator('input[type=text]').waitFor();
    check((await dialog(page).innerText()).includes('e2e_analyst'), 'the granted role is not listed');
    await dialog(page).locator('input[type=text]').fill('e2e_doome');
    await dialog(page).locator('button', {hasText: 'Review'}).click();
    check((await dialog(page).innerText()).includes('The name does not match.'), 'a wrong confirmation is accepted');
    await dialog(page).locator('input[type=text]').fill('e2e_doomed');
    await dialog(page).locator('button', {hasText: 'Review'}).click();
    check((await apply(page)).includes('Applied.'), 'not deleted');
    await closeDialog(page);
    check(await sql(`SELECT count() FROM system.users WHERE name = 'e2e_doomed'`) === '0', 'the user exists');
    check(page.url().endsWith('/console/admin-users'), `URL: ${page.url()}`);
});

// Cleanup: the e2e entities, and the policy rows changed above.
await sql(`DROP USER IF EXISTS e2e_user, e2e_scoped, e2e_app_1, e2e_outsider, e2e_doomed`);
await sql(`DROP ROLE IF EXISTS e2e_analyst, e2e_access_admin, e2e_cluster_role`);
await sql(`DROP SETTINGS PROFILE IF EXISTS e2e_limits`);
await sql(`DROP QUOTA IF EXISTS e2e_quota`);
await sql('DROP DATABASE IF EXISTS e2e_sales');
await sql('DROP DATABASE IF EXISTS e2e_hr');
if (original_policy !== null) {
    /// Remove the rules the checks added, then insert the original ones again. Two inserts: the version of
    /// a row is the time of its insert, and rows of the same key and time have no defined order.
    const removed = [];
    for (const component of ['merges', 'documentation']) {
        for (const [type, subject] of [['all', ''], ['user', ADMIN_USER]]) {
            removed.push(JSON.stringify({subject_type: type, subject, component, open: false, view_data: false, run_queries: false, administer: false, deleted: true}));
        }
    }
    const restored = original_policy.split('\n').filter(line => line.includes('"merges"') || line.includes('"documentation"'));
    const columns = '(subject_type, subject, component, open, view_data, run_queries, administer, deleted)';
    await sql(`INSERT INTO ${ADMIN_DB}.component_policy ${columns} FORMAT JSONEachRow\n${removed.join('\n')}`);
    if (restored.length) {
        await new Promise(resolve => setTimeout(resolve, 50));
        await sql(`INSERT INTO ${ADMIN_DB}.component_policy ${columns} FORMAT JSONEachRow\n${restored.join('\n')}`);
    }
}

await test('No script errors in the pages', async () => {
    check(!page_errors.length, page_errors.join('\n'));
});

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
