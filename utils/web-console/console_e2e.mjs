/// Browser end-to-end checks of the unified web console (`/console`, `programs/server/console.html`).
///
/// This is a development tool, not part of the build: it needs Node.js and Playwright, installed
/// outside of the repository (see `README.md` next to this file). It drives a running server.
///
/// Usage: node console_e2e.mjs --url http://127.0.0.1:28123 \
///            --admin alice:alicepass --limited limited:limitedpass [--screenshots DIR]
///
/// `--admin` is a user with access to all system tables and introspection functions; `--limited`
/// is a user without `SELECT ON system.part_log` and without the `INTROSPECTION` privilege.

import {chromium} from 'playwright';
import {mkdirSync} from 'node:fs';

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

const BASE = arg('url', 'http://127.0.0.1:28123').replace(/\/+$/, '');
const [ADMIN_USER, ADMIN_PASSWORD] = arg('admin', 'alice:alicepass').split(':');
const [LIMITED_USER, LIMITED_PASSWORD] = arg('limited', 'limited:limitedpass').split(':');
const SCREENSHOTS = arg('screenshots', null);
if (SCREENSHOTS) mkdirSync(SCREENSHOTS, {recursive: true});
const ORIGIN = new URL(BASE).origin;

const results = [];
let current_test = null;

function check(condition, message) {
    if (!condition) throw new Error(message);
}

async function test(name, body) {
    current_test = name;
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

/// Polls `fn` in the page or frame until it returns a truthy value. `waitForFunction` cannot be used:
/// it evaluates strings, which the Content Security Policy of the console rightly forbids.
async function waitUntil(target, fn, arg, options = {}) {
    const deadline = Date.now() + (options.timeout || 30000);
    for (;;) {
        let value = null;
        try {
            value = await target.evaluate(fn, arg);
        } catch (e) {
            if (!/context was destroyed|navigat|detached/i.test(e.message)) throw e;
        }
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${fn.toString().slice(0, 300)}`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

async function screenshot(page, name) {
    if (SCREENSHOTS) await page.screenshot({path: `${SCREENSHOTS}/${name}.png`});
}

const browser = await chromium.launch();

/// A context that records every request, so that the tests can check where requests go and what
/// they carry. With `offline`, requests to any origin other than the server under test fail, as in
/// a network without Internet access.
async function newContext({offline = false, viewport = {width: 1400, height: 900}} = {}) {
    const context = await browser.newContext({viewport});
    const log = {requests: [], blocked: []};
    context.on('request', request => log.requests.push({url: request.url(), headers: request.headers(), post_data: request.postData()}));
    if (offline) {
        await context.route('**/*', route => {
            const url = route.request().url();
            if (url.startsWith(ORIGIN) || url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return route.continue();
            log.blocked.push(url);
            return route.abort('internetdisconnected');
        });
    }
    const page = await context.newPage();
    page.on('pageerror', e => log.requests.push({page_error: e.message}));
    return {context, page, log};
}

async function login(page, user, password, url = BASE) {
    await page.fill('#login-url', url);
    await page.fill('#login-user', user);
    await page.fill('#login-password', password);
    await page.click('#login-submit');
}

async function waitForHome(page) {
    await page.waitForURL(`${BASE}/console/home`);
    await page.waitForSelector('#home-view:not([hidden]) .overview');
}

function frameOf(page, path) {
    return page.frames().find(f => new URL(f.url(), BASE).pathname.startsWith(path));
}

async function waitForSQLConsole(page) {
    await page.waitForSelector('.frame-host[data-component="sql"] iframe');
    await waitUntil(page, () => {
        const iframe = document.querySelector('.frame-host[data-component="sql"] iframe');
        const doc = iframe && iframe.contentDocument;
        return doc && doc.querySelector('[data-testid="standalone-console-layout"], [data-testid="standalone-home-page"]')
            && !document.querySelector('.frame-host[data-component="sql"] .frame-overlay');
    }, null, {timeout: 60000});
}

// ---------------------------------------------------------------------------------------------

await test('Open console without a session: login appears', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await page.waitForSelector('#login-view:not([hidden])');
    check(page.url() === `${BASE}/console/login`, `URL is ${page.url()}`);
    check(await page.isHidden('#shell'), 'shell is visible');
    check(await page.inputValue('#login-url') === ORIGIN, 'URL field does not default to the server origin');
    await screenshot(page, '01-login');
    await context.close();
});

await test('Submit invalid credentials: login stays with an actionable error', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, 'wrong-password');
    await page.waitForSelector('#login-error:not([hidden])');
    const error = await page.textContent('#login-error');
    check(error.includes('username or password is incorrect'), `error: ${error}`);
    check(await page.isVisible('#login-view'), 'login hidden');
    check(!(await page.isDisabled('#login-submit')), 'submit stays disabled');
    check(page.url().startsWith(`${BASE}/console/login`), `URL is ${page.url()}`);
    await screenshot(page, '02-invalid-credentials');

    await login(page, ADMIN_USER, ADMIN_PASSWORD, 'http://127.0.0.1:1');
    await waitUntil(page, () => /Cannot connect|blocked/.test(document.querySelector('#login-error').textContent));
    const unreachable = await page.textContent('#login-error');
    check(unreachable.includes('127.0.0.1:1'), `unreachable error: ${unreachable}`);

    await login(page, ADMIN_USER, ADMIN_PASSWORD, 'http://user:pw@127.0.0.1:1');
    await waitUntil(page, () => document.querySelector('#login-error').textContent.includes('Do not include credentials'));
    await context.close();
});

await test('Login: duplicate submissions are prevented while connecting', async () => {
    const {context, page, log} = await newContext();
    await page.route(`${BASE}/?**`, async route => {
        await new Promise(resolve => setTimeout(resolve, 1500));
        await route.continue();
    });
    await page.route(`${BASE}/`, async route => {
        await new Promise(resolve => setTimeout(resolve, 1500));
        await route.continue();
    });
    await page.goto(`${BASE}/console`);
    await page.fill('#login-user', ADMIN_USER);
    await page.fill('#login-password', ADMIN_PASSWORD);
    await page.click('#login-submit');
    check(await page.isDisabled('#login-submit'), 'submit is not disabled while connecting');
    check((await page.textContent('#login-submit')).includes('Connecting'), 'no loading text');
    await page.press('#login-password', 'Enter');
    await waitForHome(page);
    const checks = log.requests.filter(r => r.post_data && r.post_data.startsWith('SELECT currentUser()'));
    check(checks.length === 1, `${checks.length} login requests`);
    await context.close();
});

await test('Submit valid credentials: Home shows the server-reported connection', async () => {
    const {context, page, log} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    const overview = await page.textContent('.overview');
    check(overview.includes(`Database user${ADMIN_USER}`), `overview: ${overview}`);
    check(overview.includes(`Server${ORIGIN}`), `overview: ${overview}`);
    check(/Connected, verified at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(overview), `overview: ${overview}`);
    check((await page.textContent('#connection-pill')).includes(`${ADMIN_USER}@`), 'header pill');
    /// The connection check sends credentials in headers, never in the URL.
    const with_password = log.requests.filter(r => r.url && r.url.includes(ADMIN_PASSWORD));
    check(with_password.length === 0, `password in URL: ${with_password.map(r => r.url).join(', ')}`);
    await waitUntil(page, () => !document.querySelector('.card .badge') || ![...document.querySelectorAll('.card .badge')].some(b => b.textContent === 'Checking…'));
    await screenshot(page, '03-home');
    await context.close();
});

await test('Home cards and sidebar list every component and resolve to the same destination', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    const expected = {
        Home: ['Home'],
        Workspace: ['SQL Console', 'Dashboard', 'ClickStack', 'Web Terminal'],
        Diagnostics: ['Binary visualizer', 'Merges visualizer', 'Schema visualizer', 'Jemalloc', 'Processors profile'],
        Resources: ['Source code', 'Documentation', 'Reference', 'Website', 'Cloud'],
    };
    const sidebar = await page.evaluate(() => [...document.querySelectorAll('#sidebar h2')].map(h => ({
        category: h.textContent,
        items: [...h.nextElementSibling.querySelectorAll('a')].map(a => ({id: a.dataset.component, title: a.querySelector('.label').textContent, href: a.href, target: a.target})),
    })));
    const cards = await page.evaluate(() => [...document.querySelectorAll('.category')].map(s => ({
        category: s.querySelector('h2').textContent,
        items: [...s.querySelectorAll('.card')].map(c => {
            const a = c.querySelector('.card-foot a');
            return {id: c.dataset.component, title: c.querySelector('h3').textContent, href: a.href, target: a.target, action: a.childNodes[0].textContent};
        }),
    })));
    for (const [category, titles] of Object.entries(expected)) {
        const nav = sidebar.find(s => s.category === category);
        check(nav && JSON.stringify(nav.items.map(i => i.title)) === JSON.stringify(titles), `sidebar ${category}: ${JSON.stringify(nav)}`);
        if (category === 'Home') continue;
        const section = cards.find(s => s.category === category);
        check(section && JSON.stringify(section.items.map(i => i.title)) === JSON.stringify(titles), `cards ${category}: ${JSON.stringify(section)}`);
        for (const card of section.items) {
            const link = nav.items.find(i => i.id === card.id);
            check(link.href === card.href && link.target === card.target, `${card.id}: card ${card.href} ${card.target} != sidebar ${link.href} ${link.target}`);
            check(['Open', 'Configure', 'Details'].includes(card.action), `${card.id}: action ${card.action}`);
        }
    }
    /// Click every internal card and its sidebar entry: both land on the same route.
    for (const section of cards) {
        for (const card of section.items.filter(i => !i.target)) {
            await page.click(`#sidebar a[data-component="home"]`);
            await page.click(`.card[data-component="${card.id}"] .card-foot a`);
            const from_card = page.url();
            await page.click(`#sidebar a[data-component="home"]`);
            await page.click(`#sidebar a[data-component="${card.id}"]`);
            check(page.url() === from_card && from_card === `${BASE}/console/${card.id}`, `${card.id}: ${from_card} vs ${page.url()}`);
            check(await page.getAttribute(`#sidebar a[data-component="${card.id}"]`, 'aria-current') === 'page', `${card.id} not highlighted`);
        }
    }
    await context.close();
});

await test('Protected deep link requires login, then opens the panel with the console connection', async () => {
    const {context, page, log} = await newContext();
    await page.goto(`${BASE}/console/merges`);
    await page.waitForSelector('#login-view:not([hidden])');
    check(page.url() === `${BASE}/console/login?next=merges`, `URL is ${page.url()}`);
    check((await page.textContent('#login-notice')).includes('Merges visualizer'), 'no deep link notice');
    check(await page.$('iframe') === null, 'a panel was loaded before login');
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.waitForURL(`${BASE}/console/merges`);
    await page.waitForSelector('.frame-host[data-component="merges"] iframe');
    await waitUntil(page, () => {
        const doc = document.querySelector('.frame-host[data-component="merges"] iframe').contentDocument;
        return doc && doc.readyState === 'complete' && doc.getElementById('user');
    });
    const merges = frameOf(page, '/merges');
    check(merges.url() === `${BASE}/merges`, `frame URL ${merges.url()}`);
    check(await merges.inputValue('#user') === ADMIN_USER, 'merges did not take the console user');
    check(await merges.evaluate(() => getComputedStyle(document.getElementById('connection-params')).display) === 'none', 'connection fields visible');

    /// A validated `next` only: an external or unknown destination is ignored.
    const other = await context.newPage();
    await other.goto(`${BASE}/console/login?next=https://example.com/`);
    await login(other, ADMIN_USER, ADMIN_PASSWORD);
    await other.waitForURL(`${BASE}/console/home`);
    await screenshot(page, '04-deep-link-merges');
    await context.close();
});

await test('Refresh of a deep link asks to log in again and returns to the panel', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await page.click('#sidebar a[data-component="schema"]');
    await page.waitForURL(`${BASE}/console/schema`);
    await page.reload();
    await page.waitForURL(`${BASE}/console/login?next=schema`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.waitForURL(`${BASE}/console/schema`);
    await page.waitForSelector('.frame-host[data-component="schema"] iframe');
    await context.close();
});

await test('SQL Console: automatic sign-in, unsaved query survives switching panels', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await page.click('#sidebar a[data-component="sql"]');
    await waitForSQLConsole(page);
    const sql = frameOf(page, '/ui');
    const user_in_console = await sql.evaluate(() => document.body.innerText);
    check(user_in_console.includes(ADMIN_USER), 'SQL Console does not show the signed-in user');
    check(await sql.evaluate(() => !document.querySelector('[data-testid="standalone-password-input"]')), 'connect form still shown');
    check(await page.isHidden('#panel-notice'), `unexpected notice: ${await page.textContent('#panel-notice')}`);

    /// Open a new query tab and type an unsaved query.
    const new_query = await sql.$('[data-testid="standalone-home-new-query"]');
    if (new_query) await new_query.click();
    await sql.waitForSelector('.monaco-editor textarea', {timeout: 30000});
    await sql.click('.monaco-editor .view-lines');
    const marker = `SELECT 'unsaved_marker_${Date.now()}'`;
    await page.keyboard.type(marker);
    await waitUntil(sql, m => document.querySelector('.monaco-editor .view-lines').innerText.includes(m.slice(8)), marker);
    await screenshot(page, '05-sql-console');

    const iframe_before = await page.$('.frame-host[data-component="sql"] iframe');
    await page.click('#sidebar a[data-component="dashboard"]');
    await page.waitForURL(`${BASE}/console/dashboard`);
    await page.waitForSelector('.frame-host[data-component="dashboard"] iframe');
    check(await page.isHidden('.frame-host[data-component="sql"]'), 'SQL Console still visible');
    await page.goBack();
    await page.waitForURL(`${BASE}/console/sql`);
    check(await page.isVisible('.frame-host[data-component="sql"]'), 'SQL Console not shown after Back');
    const iframe_after = await page.$('.frame-host[data-component="sql"] iframe');
    check(await iframe_before.evaluate((a, b) => a === b, iframe_after), 'SQL Console frame was recreated');
    const text = await frameOf(page, '/ui').evaluate(() => document.querySelector('.monaco-editor .view-lines').innerText);
    check(text.includes(marker.slice(8)), `unsaved query lost: ${text}`);
    await page.goForward();
    await page.waitForURL(`${BASE}/console/dashboard`);
    await context.close();
});

await test('SQL Console: a failed automatic sign-in is reported and leaves its form usable', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    /// Make the server refuse the requests of the SQL Console only, as if its credentials were wrong.
    await context.route(`${BASE}/**`, route => {
        const frame = route.request().frame();
        if (route.request().method() === 'POST' && frame && new URL(frame.url()).pathname.startsWith('/ui')) {
            return route.fulfill({status: 401, body: `${ADMIN_USER}: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)`});
        }
        return route.continue();
    });
    await page.click('#sidebar a[data-component="sql"]');
    await page.waitForSelector('#panel-notice:not([hidden])', {timeout: 60000});
    const notice = await page.textContent('#panel-notice');
    check(notice.includes('did not succeed') && notice.includes('Authentication failed'), `notice: ${notice}`);
    check(await page.$('.frame-host[data-component="sql"] .frame-overlay') === null, 'overlay hides the form');
    const sql = frameOf(page, '/ui');
    check(await sql.inputValue('[data-testid="standalone-password-input"]') === '', 'password left in the SQL Console form');
    await screenshot(page, '05b-sql-console-failed');
    await context.close();
});

await test('Theme: the toggle applies to the console and to panels opened after it', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    const before = await page.getAttribute('html', 'data-theme');
    const label = await page.getAttribute('#shell-theme', 'aria-label');
    await page.click('#shell-theme');
    const after = await page.getAttribute('html', 'data-theme');
    check(before !== after && label === `Switch to ${after} theme`, `${before} -> ${after}, label ${label}`);
    check(await page.evaluate(() => localStorage.getItem('theme')) === after, 'theme not remembered');
    await page.click('#sidebar a[data-component="schema"]');
    await page.waitForSelector('.frame-host[data-component="schema"] iframe');
    await waitUntil(page, () => !document.querySelector('.frame-host[data-component="schema"] .frame-overlay'));
    const panel_theme = await frameOf(page, '/schema').evaluate(() => document.documentElement.getAttribute('data-theme'));
    check(panel_theme === after, `schema theme ${panel_theme}`);
    await page.click('#sidebar a[data-component="home"]');
    await screenshot(page, `15-home-${after}`);
    await page.click('#shell-theme');
    await context.close();
});

await test('Restricted diagnostic panel: shown as restricted and the server still enforces permissions', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, LIMITED_USER, LIMITED_PASSWORD);
    await waitForHome(page);
    await waitUntil(page, () => document.querySelector('.card[data-component="merges"] .badge')?.textContent === 'Restricted');
    await waitUntil(page, () => document.querySelector('.card[data-component="binary"] .badge')?.textContent === 'Restricted');
    await waitUntil(page, () => !document.querySelector('.card[data-component="schema"] .badge.bad'));
    await screenshot(page, '06-restricted-home');
    await page.click('.card[data-component="merges"] .card-foot a');
    await page.waitForSelector('#panel-state:not([hidden])');
    const state = await page.textContent('#panel-state');
    check(state.includes('restricted') && state.includes('SELECT ON system.part_log'), `state: ${state}`);
    await page.click('text=Open anyway');
    await page.waitForSelector('.frame-host[data-component="merges"] iframe');
    const merges = frameOf(page, '/merges');
    await merges.waitForSelector('#play');
    /// `merges.html` does not display query errors, so check the answer of the server itself.
    const denied = page.waitForResponse(r => r.frame() === merges && r.request().method() === 'POST');
    await merges.click('#play');
    const response = await denied;
    const body = await response.text();
    check(response.status() >= 400 && /ACCESS_DENIED/.test(body) && body.includes(`${LIMITED_USER}:`), `server answer: ${response.status()} ${body.slice(0, 200)}`);
    await screenshot(page, '07-restricted-merges');
    await context.close();
});

await test('Missing optional integrations show configuration and unavailable states', async () => {
    const {context, page} = await newContext();
    await context.route(`${BASE}/console/config.json`, route => route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({clickstack_url: '', website_url: '', cloud_url: 'javascript:alert(1)'}),
    }));
    await context.route(`${BASE}/webterminal`, route => route.request().method() === 'HEAD'
        ? route.fulfill({status: 403, body: ''}) : route.continue());
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    const card = async id => page.evaluate(id => {
        const c = document.querySelector(`.card[data-component="${id}"]`);
        return {badge: c.querySelector('.badge')?.textContent, action: c.querySelector('.card-foot a').childNodes[0].textContent, href: c.querySelector('.card-foot a').getAttribute('href')};
    }, id);
    const clickstack = await card('clickstack');
    check(clickstack.badge === 'Not configured' && clickstack.action === 'Configure', JSON.stringify(clickstack));
    const website = await card('website');
    check(website.action === 'Configure' && website.href === '/console/website', JSON.stringify(website));
    const cloud = await card('cloud');
    check(cloud.action === 'Configure' && !cloud.href.startsWith('javascript'), JSON.stringify(cloud));
    await waitUntil(page, () => document.querySelector('.card[data-component="terminal"] .badge')?.textContent === 'Unavailable');
    check((await page.textContent('.card[data-component="terminal"]')).includes('enable_webterminal'), 'terminal reason');
    await page.click('.card[data-component="clickstack"] .card-foot a');
    const state = await page.textContent('#panel-state');
    check(state.includes('<clickstack_url>') && state.includes('web_console'), `state: ${state}`);
    await screenshot(page, '08-configure-clickstack');
    /// Login, Home, and the SQL Console keep working.
    await page.click('#sidebar a[data-component="sql"]');
    await waitForSQLConsole(page);
    await context.close();
});

await test('Switch user: previous panels and credentials are discarded', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await page.click('#sidebar a[data-component="sql"]');
    await waitForSQLConsole(page);
    await page.click('#sidebar a[data-component="dashboard"]');
    await page.waitForSelector('.frame-host[data-component="dashboard"] iframe');
    await page.evaluate(() => sessionStorage.setItem('connections', '[{"password":"clickstack-secret"}]'));
    await page.click('#switch-button');
    await page.waitForSelector('#login-view:not([hidden])');
    check(await page.$$eval('#frames .frame-host', hosts => hosts.length) === 0, 'frames remain after switching');
    check(await page.inputValue('#login-password') === '', 'password field not cleared');
    check(await page.evaluate(() => sessionStorage.getItem('connections')) === null, 'ClickStack connection not cleared');
    check(await page.evaluate(() => window.clickhouseConsole.getConnection(window)) === null, 'connection still available');
    check((await page.textContent('#login-notice')).includes('All panels were closed'), 'no notice');
    await login(page, LIMITED_USER, LIMITED_PASSWORD);
    await waitForHome(page);
    check((await page.textContent('.overview')).includes(`Database user${LIMITED_USER}`), 'wrong user on Home');
    await page.click('#sidebar a[data-component="sql"]');
    await waitForSQLConsole(page);
    const body = await frameOf(page, '/ui').evaluate(() => document.body.innerText);
    check(body.includes(LIMITED_USER), 'SQL Console not signed in as the new user');
    await context.close();
});

await test('Logout, then browser Back: authenticated state is not restored', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await page.click('#sidebar a[data-component="processors-profile"]');
    await page.waitForSelector('.frame-host[data-component="processors-profile"] iframe');
    await page.click('#logout-button');
    await page.waitForSelector('#login-view:not([hidden])');
    check((await page.textContent('#login-notice')).includes('signed out'), 'no sign-out notice');
    await page.goBack();
    await page.waitForSelector('#login-view:not([hidden])');
    check(await page.isHidden('#shell'), 'shell visible after Back');
    check(await page.$('iframe') === null, 'a panel is loaded after Back');
    check(await page.inputValue('#login-password') === '', 'password restored');
    check(await page.evaluate(() => window.clickhouseConsole.getConnection(window)) === null, 'connection available after Back');
    await page.goForward();
    await page.waitForSelector('#login-view:not([hidden])');
    check(await page.isHidden('#shell'), 'shell visible after Forward');
    check(await page.$('iframe') === null, 'a panel is loaded after Forward');
    await context.close();
});

await test('External resources open in a new tab without credentials or query context', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    const links = await page.$$eval('a[target="_blank"][href]', as => as.map(a => ({href: a.href, rel: a.rel, text: a.textContent})));
    check(links.length >= 8, `only ${links.length} external links`);
    for (const link of links) {
        check(link.rel.includes('noopener') && link.rel.includes('noreferrer'), `${link.href}: rel ${link.rel}`);
        const url = new URL(link.href);
        check(!url.search && !url.username && !url.password && !link.href.includes(ADMIN_USER) && !link.href.includes(ADMIN_PASSWORD), `${link.href} carries context`);
        if (url.origin !== ORIGIN) check(link.text.includes('opens in a new tab'), `${link.href}: no new-tab indicator`);
    }
    const popup_promise = context.waitForEvent('page');
    await context.route('https://clickhouse.com/**', route => route.fulfill({body: 'stub'}));
    await page.click('.card[data-component="website"] .card-foot a');
    const popup = await popup_promise;
    await popup.waitForLoadState();
    check(await popup.evaluate(() => window.opener === null && document.referrer === ''), 'opener or referrer leaked');
    await context.close();
});

await test('Without Internet access the core console works and makes no external requests', async () => {
    const {context, page, log} = await newContext({offline: true});
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await page.click('#sidebar a[data-component="sql"]');
    await waitForSQLConsole(page);
    for (const id of ['dashboard', 'schema', 'reference', 'merges', 'processors-profile']) {
        await page.click(`#sidebar a[data-component="${id}"]`);
        await page.waitForSelector(`.frame-host[data-component="${id}"] iframe`);
        await waitUntil(page, id => !document.querySelector(`.frame-host[data-component="${id}"] .frame-overlay`), id);
    }
    await page.click('#sidebar a[data-component="home"]');
    await screenshot(page, '09-offline-home');
    console.log(`      external requests attempted by core and local panels: ${log.blocked.length ? log.blocked.join(', ') : 'none'}`);
    check(log.blocked.length === 0, `blocked: ${log.blocked.join(', ')}`);
    /// The panels marked "Needs Internet" do try the public CDN.
    await page.click('#sidebar a[data-component="jemalloc"]');
    await page.waitForSelector('.frame-host[data-component="jemalloc"] iframe');
    await page.waitForTimeout(2000);
    console.log(`      requests blocked for Jemalloc (marked "Needs Internet"): ${log.blocked.join(', ')}`);
    check(log.blocked.some(u => u.includes('cdn.jsdelivr.net')), 'Jemalloc did not try the CDN; update its card');
    await context.close();
});

await test('Keyboard navigation and visible focus', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await page.waitForSelector('#login-view:not([hidden])');
    check(await page.evaluate(() => document.activeElement.id) === 'login-password', 'focus is not in the login form');
    await page.keyboard.type(ADMIN_PASSWORD);
    await page.focus('#login-user');
    await page.keyboard.press('Control+A');
    await page.keyboard.type(ADMIN_USER);
    await page.keyboard.press('Enter');
    await waitForHome(page);
    check(await page.evaluate(() => document.activeElement.tagName) === 'H1', 'focus not moved to the page heading');
    await page.keyboard.press('Shift+Tab');
    const order = [];
    await page.focus('#skip-link');
    check(await page.isVisible('#skip-link'), 'skip link not visible on focus');
    for (let i = 0; i < 12; ++i) {
        await page.keyboard.press('Tab');
        order.push(await page.evaluate(() => {
            const e = document.activeElement;
            const style = getComputedStyle(e);
            return {id: e.id || e.dataset.component || e.textContent.trim().slice(0, 20), outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px'};
        }));
    }
    check(order.every(o => o.outline), `no visible focus: ${JSON.stringify(order.filter(o => !o.outline))}`);
    const sidebar_link = order.find(o => o.id === 'merges');
    check(sidebar_link, `sidebar not reachable by Tab: ${JSON.stringify(order)}`);
    await page.focus('#sidebar a[data-component="merges"]');
    await page.keyboard.press('Enter');
    await page.waitForURL(`${BASE}/console/merges`);
    await page.focus('#collapse-button');
    await page.keyboard.press('Enter');
    check(await page.evaluate(() => document.getElementById('shell').classList.contains('collapsed')), 'sidebar not collapsed');
    check(await page.getAttribute('#collapse-button', 'aria-expanded') === 'false', 'aria-expanded');
    check(await page.isVisible('#sidebar a[data-component="merges"]'), 'collapsed sidebar hides links');
    check(await page.getAttribute('#sidebar a[data-component="merges"]', 'aria-current') === 'page', 'active link not highlighted');
    await screenshot(page, '10-collapsed');
    await page.keyboard.press('Enter');
    await context.close();
});

await test('Narrow viewport: navigation and essential actions remain usable', async () => {
    const {context, page} = await newContext({viewport: {width: 390, height: 800}});
    await page.goto(`${BASE}/console`);
    await screenshot(page, '11-narrow-login');
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    check(await page.isHidden('#sidebar a[data-component="sql"]'), 'sidebar visible on a narrow screen');
    check(await page.isVisible('#logout-button'), 'sign-out not visible');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `horizontal overflow ${overflow}px`);
    await screenshot(page, '12-narrow-home');
    await page.click('#menu-button');
    await page.waitForSelector('#sidebar a[data-component="schema"]', {state: 'visible'});
    check(await page.getAttribute('#menu-button', 'aria-expanded') === 'true', 'aria-expanded');
    await screenshot(page, '13-narrow-sidebar');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#sidebar a[data-component="schema"]', {state: 'hidden'});
    check(await page.evaluate(() => document.activeElement.id) === 'menu-button', 'focus not returned to the menu button');
    await page.click('#menu-button');
    await page.click('#sidebar a[data-component="schema"]');
    await page.waitForURL(`${BASE}/console/schema`);
    await page.waitForSelector('#sidebar a[data-component="schema"]', {state: 'hidden'});
    await context.close();
});

await test('Web Terminal: signed in with the console credentials', async () => {
    const {context, page, log} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await waitUntil(page, () => !document.querySelector('.card[data-component="terminal"] .badge'));
    await page.click('#sidebar a[data-component="terminal"]');
    await page.waitForSelector('.frame-host[data-component="terminal"] iframe');
    const terminal = () => frameOf(page, '/webterminal');
    await waitUntil(page, () => {
        const doc = document.querySelector('.frame-host[data-component="terminal"] iframe').contentDocument;
        return doc && doc.querySelector('.xterm-rows') && /:\)/.test(doc.querySelector('.xterm-rows').textContent);
    }, null, {timeout: 60000});
    await terminal().click('.xterm-screen');
    await page.keyboard.type('SELECT currentUser() AS who_am_i;\n');
    await waitUntil(page, user => document.querySelector('.frame-host[data-component="terminal"] iframe').contentDocument
        .querySelector('.xterm-rows').textContent.includes(`│ ${user}`) || document.querySelector('.frame-host[data-component="terminal"] iframe').contentDocument
        .querySelector('.xterm-rows').textContent.includes(user + ' '), ADMIN_USER, {timeout: 30000});
    check(!terminal().url().includes('user='), `credentials in the terminal URL: ${terminal().url()}`);
    await screenshot(page, '14-terminal');
    await context.close();
});

await test('Legacy pages and links keep working on their own', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/ui`);
    await page.waitForSelector('[data-testid="standalone-connect-button"]', {timeout: 60000});
    await page.goto(`${BASE}/merges?user=${ADMIN_USER}`);
    check(await page.inputValue('#user') === ADMIN_USER, '?user= no longer works on /merges');
    check(await page.isVisible('#url'), 'connection fields hidden outside of the console');
    await page.goto(`${BASE}/dashboard`);
    check(await page.isVisible('#url'), 'dashboard connection fields hidden outside of the console');
    await page.goto(`${BASE}/play`);
    await page.waitForSelector('#query');
    await page.goto(`${BASE}/`);
    check(await page.getAttribute('#links a:first-child', 'href') === '/console', 'no Console link on the landing page');
    const response = await page.goto(`${BASE}/consolex`);
    check(response.status() === 404, `/consolex: ${response.status()}`);
    await context.close();
});

await browser.close();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
