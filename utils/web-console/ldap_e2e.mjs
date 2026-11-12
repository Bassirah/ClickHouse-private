/// Browser acceptance checks of directory sign-in (an LDAP user directory) in the web console (`/console/admin-users`).
///
/// A development tool, like `access_e2e.mjs` (see `README.md`). It starts from a server without an LDAP directory, takes
/// the configuration that the console generates, installs it, restarts the server, and checks that the users of the
/// directory sign in with their directory password and get the roles of their groups, while the users managed with SQL
/// keep working. `run_e2e.sh` provides the directory: an OpenLDAP server with LDAPS and its own certificate authority.
///
/// Usage:
///   node ldap_e2e.mjs --url http://127.0.0.1:38123 --admin default:<password> --config-dir <config.d of the server> \
///       --server-restart <command> --ldap-port 39636 --ldap-ca <ca.crt> --ldap-container <name> --ldap-admin-password <password>
///
/// The directory has the users dana (in the group console-analysts) and eli (in no group), with the passwords
/// Dana-Ldap-Pw-1 and Eli-Ldap-Pw-1, under ou=users,dc=example,dc=org; groups are under ou=groups,dc=example,dc=org.

import {chromium} from 'playwright';
import {execFileSync, spawn} from 'node:child_process';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE = arg('url', 'http://127.0.0.1:38123').replace(/\/+$/, '');
const [ADMIN_USER, ADMIN_PASSWORD] = arg('admin', 'default:e2e-admin-pass').split(':');
const CONFIG_DIR = arg('config-dir', null);
const RESTART = arg('server-restart', null);
const LDAP_PORT = arg('ldap-port', '39636');
const LDAP_CA = arg('ldap-ca', null);
const LDAP_CONTAINER = arg('ldap-container', 'console-e2e-ldap');
const LDAP_ADMIN_PASSWORD = arg('ldap-admin-password', null);
const LDAP_STARTTLS_PORT = arg('ldap-starttls-port', '39389');
const POLICY_WORKER = arg('policy-worker', null);
const CONSOLE_HTML = arg('console-html', null);
const SCREENSHOTS = arg('screenshots', null);
if (SCREENSHOTS) mkdirSync(SCREENSHOTS, {recursive: true});
const COOLDOWN = 3;
const USERS = 'ou=users,dc=example,dc=org';
const GROUPS = 'ou=groups,dc=example,dc=org';

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

async function sql(query, user = ADMIN_USER, password = ADMIN_PASSWORD) {
    const response = await fetch(`${BASE}/`, {method: 'POST', body: query, headers: {'X-ClickHouse-User': user, 'X-ClickHouse-Key': password}});
    return (await response.text()).trim();
}

const code = text => Number((text.match(/^Code: (\d+)/) || [])[1] || 0);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(fn, timeout, what) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(500);
    }
}

/// An LDIF change in the directory, as its administrator.
function ldapModify(ldif) {
    execFileSync('docker', ['exec', '-i', LDAP_CONTAINER, 'ldapmodify', '-x', '-H', 'ldap://localhost:1389', '-D', 'cn=admin,dc=example,dc=org', '-w', LDAP_ADMIN_PASSWORD],
        {input: ldif, stdio: ['pipe', 'ignore', 'pipe']});
}

const browser = await chromium.launch();
const page_errors = [];
let page = null;

async function signIn(user, password) {
    if (page) await page.context().close();
    page = await (await browser.newContext({viewport: {width: 1400, height: 1000}})).newPage();
    page.on('pageerror', e => page_errors.push(`${user}: ${e.message}`));
    await page.goto(`${BASE}/console/login`);
    await page.fill('#login-user', user);
    await page.fill('#login-password', password);
    await page.click('#login-submit');
    await page.waitForSelector('#shell:not([hidden])', {timeout: 30000});
    await sleep(2500);
}

async function go(target) {
    await page.evaluate(t => {
        const dialog = document.getElementById('admin-dialog');
        if (dialog.open) dialog.close();
        history.pushState(null, '', t);
        dispatchEvent(new PopStateEvent('popstate'));
    }, target);
    await until(() => page.evaluate(() => !document.querySelector('#admin-view .spinner')), 30000, 'the page to load');
    await sleep(300);
}

async function screenshot(name) {
    if (SCREENSHOTS) await page.screenshot({path: path.join(SCREENSHOTS, `${name}.png`), fullPage: true});
}

const view = () => page.locator('#admin-view');
const dialog = () => page.locator('#admin-dialog');
const box = () => view().locator('.box', {hasText: 'Directory sign-in (LDAP)'}).first();

// ---------------------------------------------------------------------------------------------

check(CONFIG_DIR && RESTART && LDAP_CA && LDAP_ADMIN_PASSWORD, 'give --config-dir, --server-restart, --ldap-ca, and --ldap-admin-password (run_e2e.sh does)');
const LDAP_FILE = path.join(CONFIG_DIR, 'zz-e2e-ldap.xml');
rmSync(LDAP_FILE, {force: true});
for (const statement of ['DROP DATABASE IF EXISTS e2e_ldap', 'CREATE DATABASE e2e_ldap', 'CREATE TABLE e2e_ldap.facts (id UInt32) ENGINE = MergeTree ORDER BY id',
    'INSERT INTO e2e_ldap.facts SELECT number FROM numbers(42)', 'DROP ROLE IF EXISTS analysts', 'DROP USER IF EXISTS dana, e2e_local']) {
    const result = await sql(statement);
    check(!code(result), `${statement}: ${result}`);
}

await test('Without a directory: users are managed here, and the Users page offers to configure LDAP', async () => {
    check((await sql("SELECT count() FROM system.user_directories WHERE type = 'ldap'")) === '0', 'the server already has an LDAP directory');
    await signIn(ADMIN_USER, ADMIN_PASSWORD);
    await go('/console/admin-users');
    const text = await box().innerText();
    check(text.includes('Users are managed here') && text.includes('Configure LDAP'), `box: ${text}`);
    check(code(await sql('SELECT 1', 'dana', 'Dana-Ldap-Pw-1')) === 516, 'a directory user signs in without a directory');
});

await test('The configuration generated by the console turns directory sign-in on after a restart', async () => {
    await go('/console/admin-users');
    await box().locator('button', {hasText: 'Configure LDAP'}).click();
    const fill = async (label, value) => dialog().getByLabel(label, {exact: true}).fill(value);
    await fill('Host', '127.0.0.1');
    await fill('Port', LDAP_PORT);
    await fill('CA certificate file', LDAP_CA);
    await fill('Bind DN', `uid={user_name},${USERS}`);
    await fill('Verification cooldown (seconds)', String(COOLDOWN));
    await fill('Base DN of the groups', GROUPS);
    await fill('Prefix', 'console-');
    const xml = await dialog().locator('pre').innerText();
    check(xml.includes('<enable_tls>yes</enable_tls>') && xml.includes('<tls_require_cert>demand</tls_require_cert>') && xml.includes(`<verification_cooldown>${COOLDOWN}<`),
        `the configuration is not secure by default:\n${xml}`);
    await fill('Bind DN', 'uid=alice');
    check((await dialog().innerText()).includes('must contain {user_name}'), 'a bind DN without {user_name} is accepted');
    await fill('Bind DN', `uid={user_name},${USERS}`);
    writeFileSync(LDAP_FILE, await dialog().locator('pre').innerText());
    await screenshot('l01-configure');
    execFileSync('bash', ['-c', RESTART], {stdio: 'inherit'});
    await until(async () => (await sql('SELECT 1').catch(() => '')) === '1', 180000, 'the server to restart');
    check((await sql("SELECT count() FROM system.user_directories WHERE type = 'ldap'")) === '1', 'no LDAP directory after the restart');
});

await test('Configured: the Users page shows the directory, its server, and the group mapping, and says when no role exists', async () => {
    await signIn(ADMIN_USER, ADMIN_PASSWORD);
    await go('/console/admin-users');
    const text = await box().innerText();
    check(text.includes('corp') && text.includes(GROUPS) && text.includes('"console-"') && text.includes('Test sign-in'), `box: ${text}`);
    check(text.includes('No role exists yet') || (await sql('SELECT count() FROM system.roles')) !== '0', 'no warning without roles');
    check(!(await sql('CREATE ROLE analysts')), 'role not created');
    check(!(await sql('GRANT SELECT ON e2e_ldap.* TO analysts')), 'grant failed');
    await screenshot('l02-configured');
});

await test('A directory user signs in to the console with the directory password and gets the role of the group', async () => {
    await signIn('dana', 'Dana-Ldap-Pw-1');
    check((await page.locator('#shell').innerText()).length > 0, 'no console for dana');
    check(await sql('SELECT count() FROM e2e_ldap.facts', 'dana', 'Dana-Ldap-Pw-1') === '42', 'dana cannot read with the role of her group');
    check(code(await sql('SELECT count() FROM e2e_ldap.facts', 'eli', 'Eli-Ldap-Pw-1')) === 497, 'eli, in no group, can read');
    check(code(await sql('SELECT 1', 'dana', 'wrong-password')) === 516, 'a wrong password is accepted');
    await signIn(ADMIN_USER, ADMIN_PASSWORD);
    await go('/console/admin-users');
    const row = await view().locator('tr', {hasText: 'dana'}).first().innerText();
    check(row.includes('LDAP'), `dana is not shown as a directory user: ${row}`);
});

await test('Test sign-in reports the roles and the directory; a wrong password is refused, and no password is recorded', async () => {
    await go('/console/admin-users');
    await box().locator('button', {hasText: 'Test sign-in'}).click();
    await dialog().getByLabel('User name', {exact: true}).fill('dana');
    await dialog().getByLabel('Password', {exact: true}).fill('Dana-Ldap-Pw-1');
    await dialog().locator('.dialog-actions button', {hasText: 'Sign in'}).click();
    await dialog().locator('.message').waitFor();
    const ok = await dialog().innerText();
    check(ok.includes('Signed in as') && ok.includes('analysts') && ok.includes('ldap'), `result: ${ok}`);
    await dialog().getByLabel('Password', {exact: true}).fill('not-the-password');
    await dialog().locator('.dialog-actions button', {hasText: 'Sign in'}).click();
    await until(async () => (await dialog().innerText()).includes('Refused'), 15000, 'the refusal');
    await sql('SYSTEM FLUSH LOGS');
    /// The audit log exists only once the console tables are set up; the server's query log always does.
    if (await sql("SELECT count() FROM system.tables WHERE database = 'console_admin' AND name = 'audit_log'") === '1') {
        const audited = await sql(`SELECT count() FROM console_admin.audit_log WHERE position(details, 'Dana-Ldap-Pw-1') > 0 OR position(error, 'not-the-password') > 0
            OR position(summary, 'Dana-Ldap-Pw-1') > 0`);
        check(audited === '0', `a password is in the audit log: ${audited}`);
    }
    const logged = await sql(`SELECT count() FROM system.query_log WHERE event_date >= yesterday() AND (position(query, 'Dana-Ldap-Pw-1') > 0 OR position(query, 'not-the-password') > 0)`);
    check(logged === '0', `a password is in the query log: ${logged}`);
    await screenshot('l03-test-sign-in');
});

await test('Directory changes reach ClickHouse after the cooldown: a removed group membership and a changed password', async () => {
    ldapModify(`dn: cn=console-analysts,${GROUPS}\nchangetype: modify\ndelete: member\nmember: uid=dana,${USERS}\n`);
    ldapModify(`dn: uid=eli,${USERS}\nchangetype: modify\nreplace: userPassword\nuserPassword: Eli-Ldap-Pw-2\n`);
    await sleep((COOLDOWN + 2) * 1000);
    check(code(await sql('SELECT count() FROM e2e_ldap.facts', 'dana', 'Dana-Ldap-Pw-1')) === 497, 'dana keeps the role after leaving the group');
    check(code(await sql('SELECT 1', 'eli', 'Eli-Ldap-Pw-1')) === 516, 'the old password of eli still works');
    check(await sql('SELECT 1', 'eli', 'Eli-Ldap-Pw-2') === '1', 'the new password of eli does not work');
    ldapModify(`dn: cn=console-analysts,${GROUPS}\nchangetype: modify\nadd: member\nmember: uid=dana,${USERS}\n`);
    await sleep((COOLDOWN + 2) * 1000);
    check(await sql('SELECT count() FROM e2e_ldap.facts', 'dana', 'Dana-Ldap-Pw-1') === '42', 'dana does not get the role back');
});

/// One cycle of the access policy worker, reading the attributes from the directory (asynchronous: a blocked event loop
/// would keep the HTTP client from seeing the server close its idle connections).
function policyWorker(env) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [POLICY_WORKER, '--once'], {env: {...process.env, CLICKHOUSE_URL: BASE, CLICKHOUSE_USER: ADMIN_USER,
            CLICKHOUSE_PASSWORD: ADMIN_PASSWORD, CONSOLE_HTML, LDAP_ATTRIBUTES_BIND_DN: 'cn=admin,dc=example,dc=org', LDAP_ATTRIBUTES_PASSWORD: LDAP_ADMIN_PASSWORD,
            LDAP_ATTRIBUTES_BASE_DN: USERS, LDAP_ATTRIBUTES_MAP: 'department=departmentNumber', ...env}});
        let output = '';
        child.stdout.on('data', d => { output += d; });
        child.stderr.on('data', d => { output += d; });
        child.on('close', exit => resolve({exit, output}));
    });
}

const ldaps = {LDAP_ATTRIBUTES_URL: `ldaps://127.0.0.1:${LDAP_PORT}`, LDAP_ATTRIBUTES_CA_FILE: LDAP_CA};
const departments = async () => Object.fromEntries((await sql(`SELECT user_name, value FROM console_admin.dap_user_attributes FINAL
    WHERE NOT deleted AND source = 'ldap' AND attribute = 'department' ORDER BY user_name FORMAT TSV`)).split('\n').filter(Boolean).map(line => line.split('\t')));

await test('Data Access Policies read user attributes from the directory: values, changes, and leavers follow it, over LDAPS and StartTLS', async () => {
    check(POLICY_WORKER && CONSOLE_HTML, 'give --policy-worker and --console-html (run_e2e.sh does)');
    await signIn(ADMIN_USER, ADMIN_PASSWORD);
    await page.evaluate(() => { history.pushState(null, '', '/console/admin-data-access?tab=attributes'); dispatchEvent(new PopStateEvent('popstate')); });
    await until(() => page.evaluate(() => !document.querySelector('#admin-view .spinner')), 30000, 'the page');
    const setup = view().locator('button', {hasText: 'Set up'});
    if (await setup.count()) {
        await setup.first().click();
        await dialog().locator('.dialog-actions button.primary').last().click();
        await dialog().locator('.dialog-actions button', {hasText: 'Close'}).waitFor({timeout: 60000});
        await page.evaluate(() => document.getElementById('admin-dialog').close());
    }
    const defined = await sql(`INSERT INTO console_admin.dap_attributes (attribute, category, dynamic, source, writer, owner, max_age_seconds, description)
        VALUES ('department', 'user', false, 'ldap', '${ADMIN_USER}', 'e2e', 86400, 'From the LDAP directory')`);
    check(!code(defined), `attribute not defined: ${defined}`);
    ldapModify(`dn: uid=dana,${USERS}\nchangetype: modify\nadd: departmentNumber\ndepartmentNumber: finance\n`);
    ldapModify(`dn: uid=eli,${USERS}\nchangetype: modify\nadd: departmentNumber\ndepartmentNumber: sales\n`);

    const first = await policyWorker(ldaps);
    check(/attribute feed imported/.test(first.output), `LDAPS import: ${first.output.slice(-600)}`);
    const imported = await departments();
    check(imported.dana === 'finance' && imported.eli === 'sales', `imported: ${JSON.stringify(imported)}`);
    await page.reload();
    await page.waitForSelector('#login-user, #shell:not([hidden])');
    await signIn(ADMIN_USER, ADMIN_PASSWORD);
    await page.evaluate(() => { history.pushState(null, '', '/console/admin-data-access?tab=attributes'); dispatchEvent(new PopStateEvent('popstate')); });
    await until(() => page.evaluate(() => !document.querySelector('#admin-view .spinner')), 30000, 'the page');
    const tab = await view().innerText();
    check(tab.includes('finance') && tab.includes('ldap'), 'the Attributes tab does not show the values from the directory');
    await screenshot('l04-attributes');

    /// A change and a leaver, read over StartTLS on the plain port.
    ldapModify(`dn: uid=eli,${USERS}\nchangetype: modify\nreplace: departmentNumber\ndepartmentNumber: marketing\n`);
    ldapModify(`dn: uid=dana,${USERS}\nchangetype: modify\ndelete: departmentNumber\n`);
    const second = await policyWorker({LDAP_ATTRIBUTES_URL: `ldap://127.0.0.1:${LDAP_STARTTLS_PORT}`, LDAP_ATTRIBUTES_STARTTLS: '1', LDAP_ATTRIBUTES_CA_FILE: LDAP_CA});
    check(/attribute feed imported/.test(second.output), `StartTLS import: ${second.output.slice(-600)}`);
    const changed = await departments();
    check(changed.eli === 'marketing' && changed.dana === undefined, `after the changes: ${JSON.stringify(changed)}`);
});

await test('The worker refuses plain LDAP, an untrusted certificate, and a search that finds nobody, and keeps the values', async () => {
    const plain = await policyWorker({LDAP_ATTRIBUTES_URL: `ldap://127.0.0.1:${LDAP_STARTTLS_PORT}`});
    check(/needs StartTLS/.test(plain.output), `plain LDAP: ${plain.output.slice(-400)}`);
    const untrusted = await policyWorker({LDAP_ATTRIBUTES_URL: `ldaps://127.0.0.1:${LDAP_PORT}`});
    check(/attribute feed failed/.test(untrusted.output) && /certificate|self.signed/i.test(untrusted.output), `untrusted certificate: ${untrusted.output.slice(-400)}`);
    const nobody = await policyWorker({...ldaps, LDAP_ATTRIBUTES_FILTER: '(uid=nobody-at-all)'});
    check(/refusing to remove them all/.test(nobody.output), `empty search: ${nobody.output.slice(-400)}`);
    check((await departments()).eli === 'marketing', 'a refused import changed the values');
});

await test('Users managed here keep working, and a local user of the same name comes first', async () => {
    check(!(await sql("CREATE USER e2e_local IDENTIFIED BY 'E2e-Local-Pw-1'")), 'local user not created');
    check(await sql('SELECT 1', 'e2e_local', 'E2e-Local-Pw-1') === '1', 'a local user cannot sign in');
    await signIn('e2e_local', 'E2e-Local-Pw-1');
    check(!(await sql("CREATE USER dana IDENTIFIED BY 'Local-Dana-Pw-1'")), 'local dana not created');
    check(code(await sql('SELECT 1', 'dana', 'Dana-Ldap-Pw-1')) === 516, 'the directory password works although a local user of that name exists');
    check(await sql('SELECT 1', 'dana', 'Local-Dana-Pw-1') === '1', 'the local dana cannot sign in');
    await sql('DROP USER dana');
    await sleep((COOLDOWN + 1) * 1000);
    check(await sql('SELECT 1', 'dana', 'Dana-Ldap-Pw-1') === '1', 'the directory user does not come back after the local one is removed');
});

await test('No script errors in the pages', async () => {
    check(!page_errors.length, page_errors.join('\n'));
});

/// Back to a server without the directory, for the next suites.
rmSync(LDAP_FILE, {force: true});
await sql('DROP USER IF EXISTS e2e_local, dana');
await sql('DROP ROLE IF EXISTS analysts');
await sql('DROP DATABASE IF EXISTS e2e_ldap');
execFileSync('bash', ['-c', RESTART], {stdio: 'inherit'});
await until(async () => (await sql('SELECT 1').catch(() => '')) === '1', 180000, 'the server to restart');
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
