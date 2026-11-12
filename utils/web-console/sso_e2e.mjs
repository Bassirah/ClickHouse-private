/// Browser acceptance checks of the Identity Providers pages of the web console (`/console/idp-ldap`, `/console/idp-sso`):
/// the settings of a Keycloak provider, its connection test, and a test sign-in with Authorization Code and PKCE.
///
/// A development tool, like `ldap_e2e.mjs` (see `README.md`). `run_e2e.sh` provides Keycloak: a realm with a public client
/// for the console (standard flow, PKCE S256, the redirect URI and web origin of the server under test), a group claim,
/// and an audience mapper. The suite changes only the providers it creates, named `e2e-*`, so it can also run against a
/// development server whose other providers it leaves alone.
///
/// Usage:
///   node sso_e2e.mjs --url http://localhost:38123 --admin default:<password> --keycloak-url http://localhost:39080 \
///       --realm clickhouse --client clickhouse-console --keycloak-user kara:<password> --role-group clickhouse-developer \
///       [--sign-in --keycloak-admin admin:<password> --outsider pia:<password> --token-lifespan 60]
///
/// With --sign-in, also the sign-in with Keycloak: the server must have web_console.sso_* set, the HTTP authentication
/// server `sso`, and the token authenticator running with its user sync (which creates the Keycloak user in ClickHouse).
/// The outsider is a Keycloak user in no `clickhouse-*` group, so without a ClickHouse user. The checks of the token
/// refresh wait for more than the lifespan of the access tokens of the realm (--token-lifespan, in seconds).
///
/// The console must be opened on the origin registered in the client (`--url`), and the Keycloak user must be in the
/// group `--role-group`, whose name is `clickhouse-<role>`.

import {chromium} from 'playwright';
import {mkdirSync} from 'node:fs';
import path from 'node:path';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE = arg('url', 'http://localhost:38123').replace(/\/+$/, '');
const [ADMIN_USER, ADMIN_PASSWORD] = arg('admin', 'default:e2e-admin-pass').split(':');
const KEYCLOAK = arg('keycloak-url', 'http://localhost:39080').replace(/\/+$/, '');
const REALM = arg('realm', 'clickhouse');
const CLIENT = arg('client', 'clickhouse-console');
const [KC_USER, KC_PASSWORD] = arg('keycloak-user', 'kara:karapass').split(':');
const ROLE_GROUP = arg('role-group', 'clickhouse-developer');
const SIGN_IN = process.argv.includes('--sign-in');
const [KC_ADMIN, KC_ADMIN_PASSWORD] = arg('keycloak-admin', 'admin:admin').split(':');
const [OUTSIDER, OUTSIDER_PASSWORD] = arg('outsider', 'pia:piapass').split(':');
const TOKEN_LIFESPAN = Number(arg('token-lifespan', '300'));
const DB = arg('admin-db', 'console_admin');
const SCREENSHOTS = arg('screenshots', null);
if (SCREENSHOTS) mkdirSync(SCREENSHOTS, {recursive: true});
const ROLE = ROLE_GROUP.replace(/^clickhouse-/, '');
const RUN = Date.now().toString(36);
const NAME = `e2e-kc-${RUN}`;

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
const providerBox = name => view().locator('.box', {has: page.locator('h2', {hasText: name})}).first();
const tableExists = async () => (await sql(`SELECT count() FROM system.tables WHERE database = '${DB}' AND name = 'idp_providers'`)) === '1';
/// With the materialized columns, which SELECT * leaves out.
const providerRows = async name => JSON.parse(`[${(await sql(`SELECT *, updated_at, updated_by FROM ${DB}.idp_providers FINAL WHERE name = '${name}' AND NOT deleted FORMAT JSONEachRow`))
    .split('\n').filter(Boolean).join(',')}]`);

async function fillProvider(values) {
    for (const [label, value] of Object.entries(values)) await dialog().getByLabel(label, {exact: true}).fill(value);
}

async function submitDialog(text) {
    await dialog().locator('.dialog-actions button', {hasText: text}).click();
}

/// Reviews and applies the plan that a form opened, and waits for its result.
async function applyPlan() {
    await dialog().locator('.dialog-actions button', {hasText: /^(Apply|Remove)$/}).click();
    await until(async () => !(await dialog().innerText()).includes('Applying'), 30000, 'the plan to finish');
    const text = await dialog().innerText();
    await dialog().locator('.dialog-actions button', {hasText: 'Close'}).click();
    await sleep(1000);
    return text;
}

/// Signs in on the Keycloak page that the test sign-in opens, as `user`.
async function keycloakSignIn(popup, user, password) {
    await popup.waitForSelector('#username', {timeout: 30000});
    await popup.fill('#username', user);
    await popup.fill('#password', password);
    await popup.click('#kc-login');
}

// ---------------------------------------------------------------------------------------------

check((await sql('SELECT 1')) === '1', `cannot query ${BASE} as ${ADMIN_USER}`);
check((await fetch(`${KEYCLOAK}/realms/${REALM}/.well-known/openid-configuration`)).ok, `no realm ${REALM} at ${KEYCLOAK}`);
check(!(await sql(`CREATE ROLE IF NOT EXISTS ${ROLE}`)), `role ${ROLE} not created`);
/// The Dashboard panel, which the refresh checks open as the Keycloak user, needs only this.
check(!(await sql(`GRANT SELECT ON system.dashboards TO ${ROLE}`)), `grant to ${ROLE} failed`);

/// On a server without the console tables, such as a new one, the tables of the administration pages (the audit log, which
/// the checks read) are created first, through the console's own setup.
if (await sql(`SELECT count() FROM system.tables WHERE database = '${DB}' AND name IN ('audit_log', 'component_policy', 'protected_accounts')`) !== '3') {
    await signIn(ADMIN_USER, ADMIN_PASSWORD);
    await go('/console/admin-access');
    await view().locator('button', {hasText: 'Set up'}).first().click();
    await dialog().locator('.dialog-actions button', {hasText: 'Review'}).click();
    await sleep(400);
    const outcome = await applyPlan();
    check(outcome.includes('Applied'), `the setup of the administration pages failed: ${outcome}`);
}

await test('The sidebar has Identity Providers with LDAP and SSO, and the Users page points there', async () => {
    await signIn(ADMIN_USER, ADMIN_PASSWORD);
    /// The headings of the sidebar are upper-cased by the style sheet.
    const sidebar = (await page.locator('#sidebar').innerText()).toLowerCase();
    check(sidebar.includes('identity providers') && sidebar.includes('ldap') && sidebar.includes('sso (keycloak)'), `sidebar: ${sidebar}`);
    await go('/console/admin-users');
    const note = await view().innerText();
    check(note.includes('Users can also come from identity providers') && !note.includes('Directory sign-in (LDAP)'), 'the Users page still has the directory box');
    await view().locator('a', {hasText: 'SSO (Keycloak)'}).first().click();
    await until(async () => (await page.evaluate(() => location.pathname)) === '/console/idp-sso', 10000, 'the SSO page');
});

await test('The LDAP page shows the directory sign-in and the attributes from the directory', async () => {
    await go('/console/idp-ldap');
    const text = await view().innerText();
    check(text.includes('Directory sign-in (LDAP)') && text.includes('Attributes from the directory'), `page: ${text.slice(0, 400)}`);
    await screenshot('s01-ldap');
});

await test('Set up creates the provider table, when it is missing', async () => {
    if (await tableExists()) return;
    await go('/console/idp-sso');
    await view().locator('button', {hasText: 'Set up'}).click();
    await applyPlan();
    check(await tableExists(), 'no table after the setup');
});

await test('Adding Keycloak refuses plain HTTP to another host, a URL with /realms, and scopes without openid', async () => {
    await go('/console/idp-sso');
    await view().locator('button', {hasText: 'Add Keycloak'}).click();
    await fillProvider({'Name': NAME, 'Keycloak URL': 'http://keycloak.example.com', 'Realm': REALM, 'Client ID': CLIENT});
    await submitDialog('Add');
    check((await dialog().innerText()).includes('must be reached over HTTPS'), 'plain HTTP to another host accepted');
    await fillProvider({'Keycloak URL': `${KEYCLOAK}/realms/${REALM}`});
    await submitDialog('Add');
    check((await dialog().innerText()).includes('without /realms'), 'a URL with /realms accepted');
    await fillProvider({'Keycloak URL': KEYCLOAK, 'Scopes': 'profile email'});
    await submitDialog('Add');
    check((await dialog().innerText()).includes('must include openid'), 'scopes without openid accepted');
    const text = await dialog().innerText();
    check(text.includes(`${BASE}/console/oidc-callback`), 'the dialog does not show the redirect URI to register');
});

await test('Keycloak is added, and recorded with its settings and an audit record', async () => {
    await fillProvider({'Scopes': 'openid profile email'});
    await screenshot('s02-add');
    await submitDialog('Add');
    const outcome = await applyPlan();
    check(!outcome.includes('Failed'), `the plan failed: ${outcome}`);
    const rows = await providerRows(NAME);
    check(rows.length === 1 && rows[0].base_url === KEYCLOAK && rows[0].realm === REALM && rows[0].client_id === CLIENT && rows[0].updated_by === ADMIN_USER,
        `row: ${JSON.stringify(rows)}`);
    const audited = await sql(`SELECT count() FROM ${DB}.audit_log WHERE action = 'add_identity_provider' AND target_name = '${NAME}' AND result = 'success'`);
    check(audited === '1', `audit records: ${audited}`);
    const box = await providerBox(NAME).innerText();
    check(box.includes(`${KEYCLOAK}/realms/${REALM}`) && box.includes('preferred_username'), `box: ${box}`);
});

await test('The connection test passes: discovery, issuer, PKCE, signing keys; the result is stored', async () => {
    await go('/console/idp-sso');
    await providerBox(NAME).locator('button', {hasText: 'Test connection'}).click();
    await until(async () => (await providerBox(NAME).innerText()).includes('The provider is reachable') || (await providerBox(NAME).innerText()).includes('found problems'),
        30000, 'the connection test');
    const text = await providerBox(NAME).innerText();
    check(text.includes('The provider is reachable') && text.includes('S256') && text.includes('signing key'), `test: ${text}`);
    await screenshot('s03-connection');
    const rows = await providerRows(NAME);
    check(rows[0].tested_at && JSON.parse(rows[0].test_result).ok === true, `stored result: ${rows[0].test_result}`);
});

await test('The connection test of a wrong realm fails, and says why', async () => {
    await go('/console/idp-sso');
    await providerBox(NAME).locator('button', {hasText: 'Edit'}).click();
    await fillProvider({'Realm': 'no-such-realm'});
    await submitDialog('Save');
    await applyPlan();
    check((await providerRows(NAME))[0].test_result === '', 'a change of the settings keeps the old test result');
    await providerBox(NAME).locator('button', {hasText: 'Test connection'}).click();
    await until(async () => (await providerBox(NAME).innerText()).includes('found problems'), 30000, 'the failed test');
    const text = await providerBox(NAME).innerText();
    check(text.includes('has no realm no-such-realm'), `test: ${text}`);
    await providerBox(NAME).locator('button', {hasText: 'Edit'}).click();
    await fillProvider({'Realm': REALM});
    await submitDialog('Save');
    await applyPlan();
});

await test('A test sign-in with Keycloak checks the tokens and shows the user, the groups, and the roles', async () => {
    await go('/console/idp-sso');
    await providerBox(NAME).locator('button', {hasText: 'Test sign-in'}).click();
    const [popup] = await Promise.all([page.waitForEvent('popup'), dialog().locator('.dialog-actions button', {hasText: 'Sign in with Keycloak'}).click()]);
    await keycloakSignIn(popup, KC_USER, KC_PASSWORD);
    await until(async () => (await dialog().innerText()).includes('Signed in as') || (await dialog().locator('.message.error').count()) > 0, 60000, 'the sign-in result');
    const text = await dialog().innerText();
    check(text.includes('Signed in as') && text.includes(KC_USER) && text.includes(ROLE_GROUP) && text.includes(ROLE) && text.includes('Checked and dropped'),
        `result: ${text}`);
    check(!text.includes('Not usable by the server'), `the access token is not usable: ${text}`);
    await screenshot('s04-sign-in');
    await until(async () => popup.isClosed(), 10000, 'the sign-in window to close');
});

await test('A refused sign-in is reported: an unknown client, and a window closed before the end', async () => {
    await go('/console/idp-sso');
    await providerBox(NAME).locator('button', {hasText: 'Edit'}).click();
    await fillProvider({'Client ID': 'no-such-client'});
    await submitDialog('Save');
    await applyPlan();
    await providerBox(NAME).locator('button', {hasText: 'Test sign-in'}).click();
    const [popup] = await Promise.all([page.waitForEvent('popup'), dialog().locator('.dialog-actions button', {hasText: 'Sign in with Keycloak'}).click()]);
    /// Keycloak shows its own error page and does not redirect to an unregistered client. The window opens empty and is
    /// then sent to Keycloak.
    await popup.waitForURL(/\/realms\//, {timeout: 30000});
    await until(async () => (await popup.locator('body').innerText().catch(() => '')).includes('Client not found'), 30000, 'the error page of Keycloak');
    await popup.close();
    await until(async () => (await dialog().innerText()).includes('closed before the sign-in finished'), 15000, 'the refusal');
    await go('/console/idp-sso');
    await providerBox(NAME).locator('button', {hasText: 'Edit'}).click();
    await fillProvider({'Client ID': CLIENT});
    await submitDialog('Save');
    await applyPlan();
});

await test('No token reaches the server: not in the audit log, the provider table, or the query log', async () => {
    await sql('SYSTEM FLUSH LOGS');
    /// A JWT starts with the encoded {"alg": header: eyJ.
    const leaks = await sql(`SELECT
        (SELECT count() FROM ${DB}.audit_log WHERE position(details, 'eyJ') > 0 OR position(error, 'eyJ') > 0),
        (SELECT count() FROM ${DB}.idp_providers WHERE position(test_result, 'eyJ') > 0),
        (SELECT count() FROM system.query_log WHERE event_time > now() - INTERVAL 1 HOUR AND position(query, '.eyJ') > 0 AND position(query, 'position(') = 0)`);
    check(leaks === '0\t0\t0', `tokens found (audit, providers, query log): ${leaks}`);
    const audited = await sql(`SELECT count() FROM ${DB}.audit_log WHERE action = 'test_identity_provider_sign_in' AND target_name = '${NAME}' AND result = 'success'`);
    check(Number(audited) >= 1, 'the test sign-in is not in the audit log');
});

await test('Remove deletes the settings of the provider only', async () => {
    await go('/console/idp-sso');
    await providerBox(NAME).locator('button', {hasText: 'Remove'}).click();
    check((await dialog().innerText()).includes('The realm and the client in Keycloak are not changed'), 'no warning about Keycloak');
    await applyPlan();
    check(!(await providerRows(NAME)).length, 'the provider is still there');
    check(!(await view().innerText()).includes(NAME), 'the page still shows the provider');
});

await test('The callback page without an answer explains itself and does not start the console', async () => {
    const other = await page.context().newPage();
    await other.goto(`${BASE}/console/oidc-callback`);
    const text = await other.locator('body').innerText();
    check(text.includes('receives the answer of an identity provider') && !(await other.locator('#login-user').isVisible()), `callback: ${text}`);
    await other.close();
});

/// --- Sign-in with Keycloak ---

/// A call of Keycloak's admin API, as the administrator of the master realm.
async function keycloakAdmin(method, path, body) {
    const token = await (await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {method: 'POST',
        body: new URLSearchParams({grant_type: 'password', client_id: 'admin-cli', username: KC_ADMIN, password: KC_ADMIN_PASSWORD})})).json();
    const response = await fetch(`${KEYCLOAK}/admin/realms/${REALM}${path}`, {method, headers: {Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined});
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
}

async function setKeycloakUserEnabled(user, enabled) {
    const [found] = await keycloakAdmin('GET', `/users?username=${encodeURIComponent(user)}&exact=true`);
    await keycloakAdmin('PUT', `/users/${found.id}`, {enabled});
}

/// On the sign-in page: Sign in with Keycloak, as `user` in the window that opens. Returns the window.
async function ssoSignIn(user, password) {
    if (page) await page.context().close();
    page = await (await browser.newContext({viewport: {width: 1400, height: 1000}})).newPage();
    page.on('pageerror', e => page_errors.push(`sso ${user}: ${e.message}`));
    await page.goto(`${BASE}/console/login`);
    await page.locator('#login-sso-button').waitFor({timeout: 15000});
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#login-sso-button')]);
    await keycloakSignIn(popup, user, password);
    return popup;
}

const consoleState = () => page.evaluate(() => session ? {user: session.user, password: session.password, sso: !!session.sso} : null);

if (SIGN_IN) {
    await test('The sync of the authenticator has created the Keycloak user, identified with the authentication server', async () => {
        const row = await until(async () => {
            /// SET DEFAULT ROLE ALL leaves default_roles_list empty: the grants are in system.role_grants.
            const text = await sql(`SELECT name, has(auth_type, 'http'), (SELECT count() FROM system.role_grants WHERE user_name = '${KC_USER}' AND granted_role_name = '${ROLE}')
                FROM system.users WHERE name = '${KC_USER}' FORMAT TSV`);
            return text === `${KC_USER}\t1\t1` ? text : null;
        }, 60000, `the user ${KC_USER} with the role ${ROLE}`);
        check(row, 'no user');
        check((await sql(`SELECT count() FROM system.users WHERE name = '${OUTSIDER}'`)) === '0', `${OUTSIDER}, in no group, was created`);
    });

    await test('The sign-in page offers Keycloak, and a user signs in with it and gets the role of the group', async () => {
        const popup = await ssoSignIn(KC_USER, KC_PASSWORD);
        await page.waitForSelector('#shell:not([hidden])', {timeout: 60000});
        await until(async () => popup.isClosed(), 10000, 'the sign-in window to close');
        await sleep(2000);
        const state = await consoleState();
        check(state && state.user === KC_USER && state.sso && state.password.startsWith('eyJ'), `session: ${JSON.stringify(state && {...state, password: state.password.slice(0, 3)})}`);
        const pill = await page.locator('#connection-pill').innerText();
        check(pill.includes(KC_USER), `connection: ${pill}`);
        const roles = await sql('SELECT arraySort(currentRoles()) FORMAT TSV', KC_USER, state.password);
        check(roles.includes(ROLE), `roles with the token: ${roles}`);
        await screenshot('s05-signed-in');
    });

    await test('The access token is refreshed before it expires, and the console and a native panel keep working with the new one', async () => {
        await go('/console/dashboard');
        /// The panel's frame, not the console itself, whose address is /console/dashboard.
        const frame = () => page.frames().find(f => f !== page.mainFrame() && new URL(f.url()).pathname === '/dashboard');
        await until(async () => frame() && await frame().evaluate(() => typeof password === 'string' && password.length > 0).catch(() => false), 30000, 'the dashboard');
        const before = (await consoleState()).password;
        check(await frame().evaluate(() => password) === before, 'the dashboard did not get the token');
        /// After the first token has expired (with the authenticator's 30 seconds of skew).
        await sleep((TOKEN_LIFESPAN + 35) * 1000);
        const after = await consoleState();
        check(after && after.password !== before, 'the token was not refreshed');
        check(await frame().evaluate(() => password) === after.password, 'the dashboard did not get the new token');
        check((await sql('SELECT 1', KC_USER, before)).startsWith('Code: 516'), 'the expired token is still accepted');
        check((await sql('SELECT 1', KC_USER, after.password)) === '1', 'the new token is refused');
        await go('/console/admin-users');
        check(!(await view().innerText()).includes('AUTHENTICATION_FAILED'), 'a page of the console fails after the refresh');
    });

    await test('A user without a ClickHouse user is told why the sign-in did not succeed', async () => {
        await ssoSignIn(OUTSIDER, OUTSIDER_PASSWORD);
        await until(async () => !(await page.locator('#login-error').isHidden()), 60000, 'the error');
        const text = await page.locator('#login-error').innerText();
        check(text.includes(`signed you in as ${OUTSIDER}`) && text.includes('must exist on the server'), `error: ${text}`);
        check(await page.locator('#shell').isHidden(), 'the console opened');
    });

    await test('Signing out ends the Keycloak session: the next sign-in asks for the password again', async () => {
        await ssoSignIn(KC_USER, KC_PASSWORD);
        await page.waitForSelector('#shell:not([hidden])', {timeout: 60000});
        await sleep(1500);
        await page.click('#logout-button');
        await page.waitForURL(url => url.pathname === '/console/login', {timeout: 30000});
        await page.locator('#login-sso-button').waitFor();
        check(!(await consoleState()), 'still signed in');
        const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#login-sso-button')]);
        await popup.waitForSelector('#username', {timeout: 30000});
        await popup.close();
    });

    await test('A user disabled in Keycloak loses access: the sync drops the user, and the console signs out at the next refresh', async () => {
        await ssoSignIn(KC_USER, KC_PASSWORD);
        await page.waitForSelector('#shell:not([hidden])', {timeout: 60000});
        await sleep(1500);
        await setKeycloakUserEnabled(KC_USER, false);
        try {
            await until(async () => (await sql(`SELECT count() FROM system.users WHERE name = '${KC_USER}'`)) === '0', 60000, `the sync to drop ${KC_USER}`);
            await until(async () => !(await page.locator('#login-view').isHidden()), (TOKEN_LIFESPAN + 30) * 1000, 'the console to sign out');
            const notice = await page.locator('#login-notice').innerText();
            check(notice.includes('session has ended'), `notice: ${notice}`);
            const audited = await sql(`SELECT count() FROM ${DB}.audit_log WHERE action = 'sso_drop_user' AND target_name = '${KC_USER}' AND result = 'success'`);
            check(Number(audited) >= 1, 'the drop is not in the audit log');
        } finally {
            await setKeycloakUserEnabled(KC_USER, true);
        }
        await until(async () => (await sql(`SELECT count() FROM system.users WHERE name = '${KC_USER}'`)) === '1', 60000, `the sync to create ${KC_USER} again`);
    });
}

await test('No script errors in the pages', async () => {
    check(!page_errors.length, page_errors.join('\n'));
});

await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
