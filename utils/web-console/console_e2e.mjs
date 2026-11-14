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

async function login(page, user, password) {
    await page.fill('#login-user', user);
    await page.fill('#login-password', password);
    await page.click('#login-submit');
}

async function waitForHome(page) {
    await page.waitForURL(`${BASE}/console/home`);
    await page.waitForSelector('#home-view:not([hidden]) .overview');
}

/// Clicks a control of the console header or sidebar. While a component is open, they are hidden (focus
/// mode), so first press the arrow that shows them, as a user would.
async function clickConsole(page, selector) {
    /// A message of the console (such as the ClickStack notice on its first opening) is acknowledged first.
    if (await page.evaluate(() => document.getElementById('admin-dialog').open)) await page.click('#admin-dialog .dialog-actions button.primary');
    if (await page.evaluate(() => document.getElementById('shell').classList.contains('focus'))) await page.click('#console-toggle');
    await page.click(selector);
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
        Workspace: ['SQL Console', 'Play UI', 'Dashboard', 'ClickStack', 'Web Terminal'],
        Diagnostics: ['Binary visualizer', 'Merges visualizer', 'Schema visualizer', 'Jemalloc', 'Processors profile', 'Running queries'],
        Resources: ['Console Guide', 'Source code', 'Documentation', 'Reference', 'Website', 'Cloud'],
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
            await clickConsole(page, `#sidebar a[data-component="home"]`);
            await page.click(`.card[data-component="${card.id}"] .card-foot a`);
            const from_card = page.url();
            await clickConsole(page, `#sidebar a[data-component="home"]`);
            await clickConsole(page, `#sidebar a[data-component="${card.id}"]`);
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
    await clickConsole(page, '#sidebar a[data-component="schema"]');
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
    await clickConsole(page, '#sidebar a[data-component="sql"]');
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
    await clickConsole(page, '#sidebar a[data-component="dashboard"]');
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
    await clickConsole(page, '#sidebar a[data-component="sql"]');
    await page.waitForSelector('#panel-notice:not([hidden])', {timeout: 60000});
    const notice = await page.textContent('#panel-notice');
    check(notice.includes('did not succeed') && notice.includes('Authentication failed'), `notice: ${notice}`);
    check(await page.$('.frame-host[data-component="sql"] .frame-overlay') === null, 'overlay hides the form');
    const sql = frameOf(page, '/ui');
    check(await sql.inputValue('[data-testid="standalone-password-input"]') === '', 'password left in the SQL Console form');
    await screenshot(page, '05b-sql-console-failed');
    await context.close();
});

await test('SQL Console: an unreachable cluster is reported as a limitation, and the panel still opens', async () => {
    const {context, page} = await newContext();
    /// Answer the console's check as a server whose cluster `default` has a shard that does not answer.
    await context.route(url => url.origin === ORIGIN && url.pathname === '/', route => {
        const request = route.request();
        if (request.method() === 'POST' && request.frame() === page.mainFrame() && (request.postData() || '').includes('clusterAllReplicas')) {
            return route.fulfill({status: 500, headers: {'X-ClickHouse-Exception-Code': '519'},
                body: 'Code: 519. DB::NetException: All attempts to get table structure failed. (NO_REMOTE_SHARD_AVAILABLE)'});
        }
        return route.continue();
    });
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await waitUntil(page, () => [...document.querySelectorAll('#home-view .badge')].some(b => b.textContent === 'Limited'));
    const card = await page.evaluate(() => [...document.querySelectorAll('#home-view .badge')].find(b => b.textContent === 'Limited')
        .closest('li, .card').textContent);
    check(card.includes('SQL Console') && card.includes('through the cluster default'), `card: ${card}`);

    await clickConsole(page, '#sidebar a[data-component="sql"]');
    await waitForSQLConsole(page);
    await page.waitForSelector('#panel-notice:not([hidden])');
    const notice = await page.textContent('#panel-notice');
    check(notice.includes('through the cluster default') && notice.includes('NO_REMOTE_SHARD_AVAILABLE') && notice.includes('Queries still run'),
        `notice: ${notice}`);
    await screenshot(page, '05c-sql-console-cluster-warning');
    await context.close();
});

await test('Running queries: lists a running query and stops it with KILL QUERY', async () => {
    /// A query of about a minute, started outside of the browser.
    const query_id = `e2e-running-${Date.now()}`;
    const running = fetch(`${BASE}/?query_id=${query_id}&max_block_size=1`, {method: 'POST',
        headers: {'X-ClickHouse-User': ADMIN_USER, 'X-ClickHouse-Key': ADMIN_PASSWORD},
        body: 'SELECT sleepEachRow(1) FROM numbers(60) FORMAT Null'}).then(async response => ({status: response.status, text: await response.text()}));

    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await clickConsole(page, '#sidebar a[data-component="running-queries"]');
    await page.waitForURL(`${BASE}/console/running-queries`);
    await waitUntil(page, id => [...document.querySelectorAll('#admin-view details')].some(d => d.dataset.queryId === id), query_id);
    const row = page.locator('#admin-view tr', {has: page.locator(`details[data-query-id="${query_id}"]`)});
    check((await row.textContent()).includes('sleepEachRow'), 'the query text is not shown');
    await screenshot(page, '06-running-queries');

    await row.getByRole('button', {name: 'Stop'}).click();
    await page.waitForSelector('#admin-dialog[open]');
    const review = await page.textContent('#admin-dialog');
    check(review.includes(`KILL QUERY WHERE query_id = '${query_id}' ASYNC`), `review: ${review}`);
    await page.click('#admin-dialog button.danger');
    const result = await running;
    check(result.text.includes('QUERY_WAS_CANCELLED'), `the query was not cancelled: ${result.status} ${result.text.slice(0, 300)}`);
    await page.click('#admin-dialog .dialog-actions button');
    await waitUntil(page, id => ![...document.querySelectorAll('#admin-view details')].some(d => d.dataset.queryId === id), query_id);
    await context.close();
});

/// The text of every result of the Play UI (their shadow roots included).
async function playResultText(play) {
    return play.evaluate(() => [...document.querySelectorAll('query-result')].map(r => (r.shadowRoot || r).textContent).join('\n'));
}

/// Types a query into the editor of the Play UI and runs it.
async function runInPlay(play, query) {
    await play.fill('#query', query);
    await play.focus('#query');
    await play.press('#query', 'Control+Enter');
}

/// The stored tabs of the Play UI, read in the console page (same origin): the queries and whether they keep a result.
async function playStoredTabs(page) {
    return page.evaluate(async () => {
        if (!(await indexedDB.databases()).some(d => d.name === 'clickhouse-play')) return null;
        return new Promise((resolve, reject) => {
            const open = indexedDB.open('clickhouse-play');
            open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result;
                const all = db.transaction('tabs').objectStore('tabs').getAll();
                all.onsuccess = () => {
                    db.close();
                    resolve(all.result.map(t => ({query: t.query, has_result: !!t.result || (t.cells || []).some(c => c && c.result)})));
                };
                all.onerror = () => { db.close(); reject(all.error); };
            };
        });
    });
}

await test('Play UI: runs with the connection of the console, sends credentials in headers only, and stops queries on the server', async () => {
    const {context, page, log} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await clickConsole(page, '#sidebar a[data-component="play"]');
    await page.waitForURL(`${BASE}/console/play`);
    await page.waitForSelector('.frame-host[data-component="play"] iframe');
    await waitUntil(page, () => {
        const doc = document.querySelector('.frame-host[data-component="play"] iframe').contentDocument;
        return doc && doc.getElementById('query');
    });
    const play = frameOf(page, '/play');
    check(await play.evaluate(() => getComputedStyle(document.getElementById('connection-menu')).display === 'none'), 'the connection menu is shown');
    check(await play.inputValue('#user') === ADMIN_USER, 'not the user of the console');

    await runInPlay(play, `SELECT 'play_marker_' || toString(1 + 1) AS m`);
    await waitUntil(play, () => [...document.querySelectorAll('query-result')].some(r => (r.shadowRoot || r).textContent.includes('play_marker_2')));

    /// A chart: uPlot comes from the server.
    await runInPlay(play, 'SELECT number AS x, number * number AS y FROM numbers(10) FORMAT JSONCompactColumns');
    await waitUntil(play, () => [...document.querySelectorAll('query-result')].some(r => r.shadowRoot && r.shadowRoot.querySelector('.uplot')));
    check(log.requests.some(r => r.url === `${BASE}/js/uplot.js`), 'uPlot not loaded from the server');
    await screenshot(page, '07-play-ui');

    /// A download: through fetch, with the format chosen.
    await runInPlay(play, `SELECT 'download_marker' AS m`);
    await waitUntil(play, () => [...document.querySelectorAll('query-result')].some(r => (r.shadowRoot || r).textContent.includes('download_marker')));
    await play.click('#download-div');
    await play.selectOption('#download-format', 'CSV');
    const [download] = await Promise.all([page.waitForEvent('download'), play.click('#download-button')]);
    check(download.suggestedFilename() === 'result.csv', `file name ${download.suggestedFilename()}`);
    const {readFileSync} = await import('node:fs');
    const content = readFileSync(await download.path(), 'utf8');
    check(content.includes('download_marker'), `downloaded: ${content.slice(0, 200)}`);

    /// Stop: the query ends on the server.
    await runInPlay(play, 'SELECT sleepEachRow(1) FROM numbers(60) SETTINGS max_block_size = 1 FORMAT Null');
    const running = await waitUntil(play, () => document.getElementById('run').textContent.trim() === 'Stop');
    check(running, 'Run did not turn into Stop');
    /// Stop once the server runs it, so that the request is not merely aborted before it was sent.
    const started_deadline = Date.now() + 15000;
    for (;;) {
        const count = await (await fetch(`${BASE}/`, {method: 'POST', headers: {'X-ClickHouse-User': ADMIN_USER, 'X-ClickHouse-Key': ADMIN_PASSWORD},
            body: "SELECT count() FROM system.processes WHERE query LIKE '%sleepEachRow(1) FROM numbers(60)%' AND query NOT LIKE '%system.processes%'"})).text();
        if (count.trim() !== '0') break;
        if (Date.now() > started_deadline) throw new Error('the query did not start');
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    await play.click('#run');
    const kill = await (async () => {
        const deadline = Date.now() + 15000;
        for (;;) {
            const found = log.requests.find(r => (r.post_data || '').startsWith('KILL QUERY WHERE query_id = '));
            if (found) return found;
            if (Date.now() > deadline) throw new Error('Stop sent no KILL QUERY');
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    })();
    const query_id = kill.post_data.match(/query_id = '([^']+)'/)[1];
    const processes = async () => (await fetch(`${BASE}/?param_id=${query_id}`, {method: 'POST',
        headers: {'X-ClickHouse-User': ADMIN_USER, 'X-ClickHouse-Key': ADMIN_PASSWORD},
        body: 'SELECT count() FROM system.processes WHERE query_id = {id:String}'})).text();
    const deadline = Date.now() + 15000;
    while ((await processes()).trim() !== '0') {
        if (Date.now() > deadline) throw new Error(`the query ${query_id} is still running`);
        await new Promise(resolve => setTimeout(resolve, 200));
    }

    /// No request of the Play UI carries the credentials in its URL; they are in the headers.
    const from_play = log.requests.filter(r => r.url && r.url.startsWith(`${BASE}/?`) && r.headers && r.headers['x-clickhouse-user'] === ADMIN_USER);
    check(from_play.length > 0, 'no request of the Play UI with the credentials in headers');
    const leaked = log.requests.filter(r => r.url && /[?&](password|user)=/.test(r.url));
    check(!leaked.length, `credentials in URLs: ${leaked.map(r => r.url).join(', ')}`);

    /// Signing out removes the results of the Play UI and keeps its queries. The stopped query left no result: run one
    /// that does, and wait until the Play UI stored it.
    await runInPlay(play, `SELECT 'stored_marker' AS m`);
    await waitUntil(play, () => [...document.querySelectorAll('query-result')].some(r => (r.shadowRoot || r).textContent.includes('stored_marker')));
    await waitUntil(page, async () => {
        const tabs = await new Promise(resolve => {
            const open = indexedDB.open('clickhouse-play');
            open.onsuccess = () => {
                const db = open.result;
                const all = db.transaction('tabs').objectStore('tabs').getAll();
                all.onsuccess = () => { db.close(); resolve(all.result); };
            };
        });
        return tabs.some(t => t.result || (t.cells || []).some(c => c && c.result));
    });
    await clickConsole(page, '#logout-button');
    await page.waitForSelector('#login-view:not([hidden])');
    check((await page.evaluate(() => sql_console_cleanup)).length === 0, 'cleanup problems');
    const tabs = await playStoredTabs(page);
    check(tabs && tabs.length && tabs.every(t => !t.has_result), `results left: ${JSON.stringify(tabs)}`);
    check(tabs.some(t => (t.query || '').includes('stored_marker')), `queries lost: ${JSON.stringify(tabs)}`);
    await context.close();
});

/// What the SQL Console stored in the browser, read in the console page (same origin): the number of result rows
/// in IndexedDB (-1 without the database, which is not opened then, so as not to create it), and its storage keys.
async function sqlConsoleStorage(page) {
    return page.evaluate(async () => {
        let rows = -1;
        if ((await indexedDB.databases()).some(d => d.name === 'rowData')) {
            rows = await new Promise((resolve, reject) => {
                const open = indexedDB.open('rowData');
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                    const db = open.result;
                    const count = db.transaction('rows').objectStore('rows').count();
                    count.onsuccess = () => { db.close(); resolve(count.result); };
                    count.onerror = () => { db.close(); reject(count.error); };
                };
            });
        }
        return {rows, local: Object.keys(localStorage), session: Object.keys(sessionStorage)};
    });
}

/// The keys of the saved work of the SQL Console in local storage (`SQL_CONSOLE_WORK_KEY_PREFIXES` of the console).
const SQL_CONSOLE_WORK_KEY = /^(tabs:encrypted:|queryHistory:|standalone-saved-queries:|selectedTabId:|selected-databases|schemaExplorer:)|^[0-9a-f-]{36}:selectedDatabase$/;

/// Waits until `predicate` holds for `sqlConsoleStorage`, and returns that state.
async function waitForSQLConsoleStorage(page, predicate, what) {
    const deadline = Date.now() + 30000;
    for (;;) {
        const stored = await sqlConsoleStorage(page);
        if (predicate(stored)) return stored;
        if (Date.now() > deadline) throw new Error(`${what}: ${JSON.stringify(stored)}`);
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

/// Signs in, runs a query in the SQL Console, and waits until it stored the result rows and the tabs.
async function runQueryInSQLConsole(page) {
    await clickConsole(page, '#sidebar a[data-component="sql"]');
    await waitForSQLConsole(page);
    const sql = frameOf(page, '/ui');
    const new_query = await sql.$('[data-testid="standalone-home-new-query"]');
    if (new_query) await new_query.click();
    await sql.waitForSelector('.monaco-editor textarea', {timeout: 30000});
    await sql.click('.monaco-editor .view-lines');
    await page.keyboard.type(`SELECT 'stored_marker' AS m`);
    await page.keyboard.press('Control+Enter');
    return waitForSQLConsoleStorage(page,
        s => s.rows > 0 && s.local.some(k => k.startsWith('tabs:encrypted:')) && s.session.some(k => k.startsWith('tabs:encrypted:')),
        'the SQL Console did not store its result');
}

/// Serves `/console/config.json` with `sql_console_clear_on_sign_out` set to `value`.
async function setClearOnSignOut(context, value) {
    await context.route(`${BASE}/console/config.json`, async route => {
        const response = await route.fetch();
        route.fulfill({response, json: {...await response.json(), sql_console_clear_on_sign_out: value}});
    });
}

await test('SQL Console: signing out deletes its stored results and keeps the saved work', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);

    /// Before the SQL Console ever ran, signing out creates no database: an empty one would skip the SQL Console's own
    /// upgrade, which creates its stores.
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await clickConsole(page, '#logout-button');
    await page.waitForSelector('#login-view:not([hidden])');
    const problems = await page.evaluate(() => sql_console_cleanup);
    check(problems.length === 0, `cleanup problems: ${problems}`);
    check((await sqlConsoleStorage(page)).rows === -1, 'signing out created the results database of the SQL Console');

    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await runQueryInSQLConsole(page);

    await clickConsole(page, '#logout-button');
    await page.waitForSelector('#login-view:not([hidden])');
    let stored = await waitForSQLConsoleStorage(page, s => s.rows === 0, 'result rows left');
    check(!stored.session.some(k => k === 'liveQueries' || k.startsWith('tabs:encrypted:')), `session storage left: ${stored.session}`);
    check(stored.local.some(k => k.startsWith('tabs:encrypted:')), `tabs deleted: ${stored.local}`);

    /// The emptied database still works for the SQL Console.
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    stored = await runQueryInSQLConsole(page);
    check(stored.rows > 0, 'the SQL Console stores no result after the cleanup');

    /// Switching connection deletes them too.
    await clickConsole(page, '#switch-button');
    await page.waitForSelector('#login-view:not([hidden])');
    await waitForSQLConsoleStorage(page, s => s.rows === 0, 'result rows left after Switch connection');
    const notice = await page.textContent('#login-notice');
    check(!notice.includes('Browser data:'), `notice: ${notice}`);
    await context.close();
});

await test('SQL Console: with sql_console_clear_on_sign_out = all, signing out also deletes the saved work', async () => {
    const {context, page} = await newContext();
    await setClearOnSignOut(context, 'all');
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await runQueryInSQLConsole(page);
    await page.evaluate(() => localStorage.setItem('unrelated-key', 'kept'));

    await clickConsole(page, '#logout-button');
    await page.waitForSelector('#login-view:not([hidden])');
    const stored = await waitForSQLConsoleStorage(page, s => s.rows === 0 && !s.local.some(k => SQL_CONSOLE_WORK_KEY.test(k)),
        'saved work or result rows left');
    check(stored.local.includes('unrelated-key'), `an unrelated key was deleted: ${stored.local}`);
    check(stored.local.includes('cui-theme'), `the theme of the SQL Console was deleted: ${stored.local}`);
    await context.close();
});

await test('SQL Console: an unknown sql_console_clear_on_sign_out is reported, and the saved work is kept', async () => {
    const {context, page} = await newContext();
    await setClearOnSignOut(context, 'everything');
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await runQueryInSQLConsole(page);

    await clickConsole(page, '#logout-button');
    await page.waitForSelector('#login-view:not([hidden])');
    await waitUntil(page, () => document.getElementById('login-notice').textContent.includes('Browser data:'));
    const notice = await page.textContent('#login-notice');
    check(notice.includes(`sql_console_clear_on_sign_out is 'everything'`), `notice: ${notice}`);
    const stored = await sqlConsoleStorage(page);
    check(stored.rows === 0, `result rows left: ${stored.rows}`);
    check(stored.local.some(k => k.startsWith('tabs:encrypted:')), `tabs deleted: ${stored.local}`);
    await context.close();
});

await test('Theme: the toggle applies to the console and to panels opened after it', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    const before = await page.getAttribute('html', 'data-theme');
    const label = await page.getAttribute('#shell-theme', 'aria-label');
    await clickConsole(page, '#shell-theme');
    const after = await page.getAttribute('html', 'data-theme');
    check(before !== after && label === `Switch to ${after} theme`, `${before} -> ${after}, label ${label}`);
    check(await page.evaluate(() => localStorage.getItem('theme')) === after, 'theme not remembered');
    await clickConsole(page, '#sidebar a[data-component="schema"]');
    await page.waitForSelector('.frame-host[data-component="schema"] iframe');
    await waitUntil(page, () => !document.querySelector('.frame-host[data-component="schema"] .frame-overlay'));
    const panel_theme = await frameOf(page, '/schema').evaluate(() => document.documentElement.getAttribute('data-theme'));
    check(panel_theme === after, `schema theme ${panel_theme}`);
    await clickConsole(page, '#sidebar a[data-component="home"]');
    await screenshot(page, `15-home-${after}`);
    await clickConsole(page, '#shell-theme');
    await context.close();
});

await test('Restricted diagnostic panel: hidden from the user, and the server still enforces permissions', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, LIMITED_USER, LIMITED_PASSWORD);
    await waitForHome(page);
    /// Components whose probe query the server denies are neither cards nor sidebar entries.
    await waitUntil(page, () => !document.querySelector('.card[data-component="merges"]') && !document.querySelector('.card[data-component="binary"]'));
    check(!(await page.$('#sidebar a[data-component="merges"]')) && !(await page.$('#sidebar a[data-component="binary"]')), 'restricted components in the sidebar');
    await waitUntil(page, () => !!document.querySelector('.card[data-component="schema"]') && !document.querySelector('.card[data-component="schema"] .badge.bad'));
    check(!!(await page.$('#sidebar a[data-component="schema"]')), 'an allowed component is missing from the sidebar');
    check(!(await page.textContent('#home-view')).includes('Restricted'), 'a Restricted badge is shown');
    await screenshot(page, '06-restricted-home');
    /// Its address still explains the restriction.
    await page.goto(`${BASE}/console/merges`);
    await login(page, LIMITED_USER, LIMITED_PASSWORD);
    await page.waitForURL(`${BASE}/console/merges`);
    /// The privileges are checked first ("Checking ..."), then the restriction is explained.
    await waitUntil(page, () => document.getElementById('panel-state').textContent.includes('restricted'));
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
    await clickConsole(page, '#sidebar a[data-component="sql"]');
    await waitForSQLConsole(page);
    await context.close();
});

await test('Switch user: previous panels and credentials are discarded', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await clickConsole(page, '#sidebar a[data-component="sql"]');
    await waitForSQLConsole(page);
    await clickConsole(page, '#sidebar a[data-component="dashboard"]');
    await page.waitForSelector('.frame-host[data-component="dashboard"] iframe');
    await page.evaluate(() => sessionStorage.setItem('connections', '[{"password":"clickstack-secret"}]'));
    await clickConsole(page, '#switch-button');
    await page.waitForSelector('#login-view:not([hidden])');
    check(await page.$$eval('#frames .frame-host', hosts => hosts.length) === 0, 'frames remain after switching');
    check(await page.inputValue('#login-password') === '', 'password field not cleared');
    check(await page.evaluate(() => sessionStorage.getItem('connections')) === null, 'ClickStack connection not cleared');
    check(await page.evaluate(() => window.clickhouseConsole.getConnection(window)) === null, 'connection still available');
    check((await page.textContent('#login-notice')).includes('All panels were closed'), 'no notice');
    await login(page, LIMITED_USER, LIMITED_PASSWORD);
    await waitForHome(page);
    check((await page.textContent('.overview')).includes(`Database user${LIMITED_USER}`), 'wrong user on Home');
    await clickConsole(page, '#sidebar a[data-component="sql"]');
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
    await clickConsole(page, '#sidebar a[data-component="processors-profile"]');
    await page.waitForSelector('.frame-host[data-component="processors-profile"] iframe');
    await clickConsole(page, '#logout-button');
    await page.waitForSelector('#login-view:not([hidden])');
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
    await clickConsole(page, '#sidebar a[data-component="sql"]');
    await waitForSQLConsole(page);
    for (const id of ['dashboard', 'schema', 'reference', 'merges', 'processors-profile']) {
        await clickConsole(page, `#sidebar a[data-component="${id}"]`);
        await page.waitForSelector(`.frame-host[data-component="${id}"] iframe`);
        await waitUntil(page, id => !document.querySelector(`.frame-host[data-component="${id}"] .frame-overlay`), id);
    }
    await clickConsole(page, '#sidebar a[data-component="home"]');
    await screenshot(page, '09-offline-home');
    console.log(`      external requests attempted by core and local panels: ${log.blocked.length ? log.blocked.join(', ') : 'none'}`);
    check(log.blocked.length === 0, `blocked: ${log.blocked.join(', ')}`);
    /// The panels marked "Needs Internet" do try the public CDN.
    await clickConsole(page, '#sidebar a[data-component="jemalloc"]');
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
    /// The panel gets the whole window; the arrow in the panel bar brings the console navigation back.
    await waitUntil(page, () => document.getElementById('shell').classList.contains('focus'));
    await page.focus('#console-toggle');
    await page.keyboard.press('Enter');
    check(!(await page.evaluate(() => document.getElementById('shell').classList.contains('focus'))), 'console navigation not shown with the keyboard');
    check(await page.evaluate(() => document.activeElement.id) === 'console-toggle', 'focus left the arrow');
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

await test('Focus mode: an open component hides the console navigation until the arrow is pressed', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    const mode = () => page.evaluate(() => ({
        focus: document.getElementById('shell').classList.contains('focus'),
        header: getComputedStyle(document.getElementById('topbar')).display !== 'none',
        sidebar: getComputedStyle(document.getElementById('sidebar')).display !== 'none',
        arrow: !document.getElementById('console-toggle').hidden,
        frame_width: document.querySelector('.frame-host:not([hidden]) iframe')?.getBoundingClientRect().width,
    }));
    let state = await mode();
    check(!state.focus && state.header && state.sidebar && !state.arrow, `Home: ${JSON.stringify(state)}`);

    await page.click('#sidebar a[data-component="schema"]');
    await page.waitForSelector('.frame-host[data-component="schema"] iframe');
    state = await mode();
    check(state.focus && !state.header && !state.sidebar && state.arrow, `open component: ${JSON.stringify(state)}`);
    check(state.frame_width === 1400, `the component does not have the whole width: ${state.frame_width}`);
    check((await page.textContent('#console-toggle')).includes('Console'), 'the arrow is not labelled');
    await screenshot(page, '11-focus');

    await page.click('#console-toggle');
    state = await mode();
    check(!state.focus && state.header && state.sidebar && state.arrow, `after the arrow: ${JSON.stringify(state)}`);
    check(state.frame_width < 1400, 'the component did not make room for the sidebar');
    check(await page.getAttribute('#console-toggle', 'aria-expanded') === 'true', 'aria-expanded');
    check(await page.getAttribute('#sidebar a[data-component="schema"]', 'aria-current') === 'page', 'the panel is not current');

    /// Selecting another component hides the console navigation again.
    await page.click('#sidebar a[data-component="dashboard"]');
    await page.waitForSelector('.frame-host[data-component="dashboard"] iframe');
    check((await mode()).focus, 'not in focus mode after selecting another component');
    /// The arrow toggles both ways.
    await page.click('#console-toggle');
    check(!(await mode()).focus, 'the arrow did not show the console navigation');
    await page.click('#console-toggle');
    check((await mode()).focus, 'the arrow did not hide the console navigation');

    /// Pages of the console itself keep the console navigation.
    await page.click('#console-toggle');
    await page.click('#sidebar a[data-component="home"]');
    state = await mode();
    check(!state.focus && state.sidebar && !state.arrow, `back on Home: ${JSON.stringify(state)}`);
    await page.goBack();
    await page.waitForURL(`${BASE}/console/dashboard`);
    check((await mode()).focus, 'Back to a component does not hide the console navigation');
    await context.close();
});

await test('ClickStack: its banner message is a popup on the first opening after sign-in', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await waitUntil(page, () => !['Checking…'].includes(document.querySelector('.card[data-component="clickstack"] .badge')?.textContent));
    if (await page.evaluate(() => document.querySelector('.card[data-component="clickstack"] .badge')?.textContent === 'Unavailable')) {
        console.log('      skipped: this server build has no ClickStack bundle');
        await context.close();
        return;
    }
    await page.click('.card[data-component="clickstack"] .card-foot a');
    await page.waitForSelector('#admin-dialog[open]');
    const text = await page.textContent('#admin-dialog');
    check(text.includes('not recommended for production use') && text.includes('ClickStack Docs'), `popup: ${text}`);
    check(await page.getAttribute('#admin-dialog a', 'href') === 'https://clickhouse.com/docs/use-cases/observability/clickstack/getting-started', 'docs link');
    check(await page.evaluate(() => document.activeElement.textContent) === 'OK', 'focus not on OK');
    await screenshot(page, '12-clickstack-notice');
    await page.click('#admin-dialog .dialog-actions button.primary');
    check(await page.evaluate(() => localStorage.getItem('clickstack-banner-state')) === '"closed"', 'ClickStack banner not closed');
    /// ClickStack itself no longer shows the banner.
    await page.waitForSelector('.frame-host[data-component="clickstack"] .frame-overlay', {state: 'detached', timeout: 60000});
    await waitUntil(frameOf(page, '/clickstack'), () => document.body && document.body.innerText.length > 0, null, {timeout: 60000});
    check(!(await frameOf(page, '/clickstack').evaluate(() => document.body.innerText.includes('not recommended for production use'))), 'the banner is still in ClickStack');
    /// Once per sign-in.
    await clickConsole(page, '#sidebar a[data-component="home"]');
    await page.click('.card[data-component="clickstack"] .card-foot a');
    await page.waitForTimeout(500);
    check(!(await page.evaluate(() => document.getElementById('admin-dialog').open)), 'shown again in the same sign-in');
    /// After signing in again it is shown again, unless the user asked not to.
    await clickConsole(page, '#logout-button');
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await page.click('.card[data-component="clickstack"] .card-foot a');
    await page.waitForSelector('#admin-dialog[open]');
    await page.check('#admin-dialog input[type="checkbox"]');
    await page.click('#admin-dialog .dialog-actions button.primary');
    await clickConsole(page, '#logout-button');
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await page.click('.card[data-component="clickstack"] .card-foot a');
    await page.waitForTimeout(500);
    check(!(await page.evaluate(() => document.getElementById('admin-dialog').open)), 'shown although dismissed');
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
    await clickConsole(page, '#sidebar a[data-component="schema"]');
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
    await clickConsole(page, '#sidebar a[data-component="terminal"]');
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

await test('Console Guide: deep links survive the sign-in, search, links between pages, tabs, and the Guide button', async () => {
    const {context, page} = await newContext();
    /// A deep link to a page of the guide: after the sign-in, the console opens that page.
    await page.goto(`${BASE}/console/guide/how-to/configure-ldap`);
    await page.waitForSelector('#login-view:not([hidden])');
    check(new URL(page.url()).searchParams.get('next') === 'guide/how-to/configure-ldap', `login next: ${page.url()}`);
    check((await page.textContent('#login-notice')).includes('Console Guide'), 'no deep link notice');
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await page.waitForSelector('#admin-view .guide-content #active-directory');
    check(new URL(page.url()).pathname === '/console/guide/how-to/configure-ldap', `after sign-in: ${page.url()}`);
    check(await page.getAttribute('.guide-nav a[aria-current="page"]', 'href') === '/console/guide/how-to/configure-ldap', 'current page not marked');
    check((await page.title()).includes('Console Guide'), `title: ${await page.title()}`);

    /// The article fills the width of the window: "On this page" is a column on the right of a wide window.
    const widths = await page.evaluate(() => {
        const view = document.querySelector('#admin-view').getBoundingClientRect();
        const toc = document.querySelector('.guide-toc').getBoundingClientRect();
        return {gap: Math.round(view.right - toc.right), article: Math.round(document.querySelector('.guide-article').getBoundingClientRect().width)};
    });
    check(widths.gap < 40, `empty space on the right of the guide: ${widths.gap}px`);
    check(widths.article > 600, `the article is narrow: ${widths.article}px`);
    check(await page.isHidden('details.guide-contents'), '"On this page" is shown twice');

    /// An anchor of the page scrolls to its heading and is kept in the address.
    await page.click('.guide-toc a[href="#active-directory"]');
    await waitUntil(page, () => location.hash === '#active-directory');
    const top = await page.evaluate(() => document.querySelector('#active-directory').getBoundingClientRect().top);
    check(top >= 0 && top < 250, `the heading of the anchor is not at the top: ${top}`);

    /// A narrower window has "On this page" at the top of the article instead.
    await page.setViewportSize({width: 1100, height: 900});
    check(await page.isHidden('.guide-toc') && await page.isVisible('details.guide-contents'), '"On this page" of a narrower window');
    await page.setViewportSize({width: 1400, height: 900});

    /// Search: the results replace the navigation, and the query is kept on the page of a result.
    await page.fill('.guide-nav input[type="search"]', 'keycloak realm');
    await page.waitForSelector('.guide-results li a');
    const results = await page.$$eval('.guide-results li a', links => links.map(a => a.getAttribute('href')));
    check(results.includes('/console/guide/tutorials/single-sign-on'), `search results: ${results.join(', ')}`);
    check(await page.isHidden('.guide-groups'), 'the navigation is shown with search results');
    await page.click('.guide-results li a[href="/console/guide/tutorials/single-sign-on"]');
    await waitUntil(page, () => location.pathname === '/console/guide/tutorials/single-sign-on' && document.querySelector('#guide-title'));
    check(await page.inputValue('.guide-nav input[type="search"]') === 'keycloak realm', 'the search is not kept');
    await page.fill('.guide-nav input[type="search"]', '');
    check(await page.isVisible('.guide-groups'), 'the navigation does not come back when the search is cleared');

    /// Links between pages, the previous page, and the diagram of the overview.
    await page.click('.guide-nav a[href="/console/guide/overview"]');
    await waitUntil(page, () => location.pathname === '/console/guide/overview' && document.querySelector('.guide-diagram'));
    await page.click('.guide-content a[href="/console/guide/quick-start"]');
    await waitUntil(page, () => location.pathname === '/console/guide/quick-start' && document.querySelector('#guide-title'));
    await page.click('.guide-pager a.previous');
    await waitUntil(page, () => location.pathname === '/console/guide/overview' && document.querySelector('.guide-diagram'));

    /// Tabs, and external links.
    await page.click('.guide-nav a[href="/console/guide/how-to/create-service-accounts"]');
    await page.waitForSelector('.guide-tabs [role="tab"]');
    const tabs = await page.$$('.guide-tabs [role="tab"]');
    await tabs[1].click();
    check(await tabs[1].getAttribute('aria-selected') === 'true', 'the second tab is not selected');
    check(await page.evaluate(() => document.querySelector('.guide-tabs').querySelectorAll('[role="tabpanel"]:not([hidden])').length) === 1,
        'not exactly one tab panel shown');
    const external = await page.$$eval('#admin-view a[target="_blank"]', links => links.map(a => a.rel));
    check(external.every(rel => rel.includes('noopener') && rel.includes('noreferrer')), 'an external link without noopener noreferrer');

    /// The Guide button of an administration page opens its guide.
    await page.click('#sidebar a[data-component="admin-users"]');
    await page.waitForSelector('#admin-view .guide-help');
    await page.click('#admin-view .guide-help');
    await page.waitForSelector('.guide-content #the-users-page');
    check(new URL(page.url()).pathname === '/console/guide/guides/users-and-roles', `Guide button: ${page.url()}`);

    /// A missing page.
    await page.click('.guide-nav a[href="/console/guide/overview"]');
    await page.evaluate(() => { history.pushState(null, '', '/console/guide/no-such-page'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.waitForSelector('.guide-article .box h2');
    check(await page.textContent('.guide-article .box h2') === 'Page not found', 'missing page');
    await screenshot(page, '15-guide');
    await context.close();
});

await test('Console Guide home: a card for every page by section, cards open their page, search replaces the sections', async () => {
    const {context, page} = await newContext();
    await page.goto(`${BASE}/console`);
    await login(page, ADMIN_USER, ADMIN_PASSWORD);
    await waitForHome(page);
    await page.click('#sidebar a[data-component="guide"]');
    await page.waitForSelector('#admin-view .guide-landing .guide-card');
    const guide = await page.evaluate(async () => (await fetch('/console/guide.json')).json());
    const grouped = guide.groups.filter(g => g.title);
    const sections = await page.$$eval('.guide-section', list => list.map(s => ({
        title: s.querySelector('h2').textContent,
        cards: [...s.querySelectorAll('.guide-card h3 a')].map(a => a.getAttribute('href')),
    })));
    for (const group of grouped) {
        const section = sections.find(s => s.title === group.title);
        check(section && JSON.stringify(section.cards) === JSON.stringify(group.pages.map(key => `/console/guide/${key}`)),
            `cards of ${group.title}: ${JSON.stringify(section)}`);
    }
    check(sections.some(s => s.title === 'More resources'), 'no More resources');
    const primary = await page.getAttribute('.guide-get-started a.button.primary', 'href');
    check(primary === '/console/guide/quick-start', `primary action: ${primary}`);
    /// Each card is one link: the title, stretched over the card.
    check(await page.evaluate(() => [...document.querySelectorAll('.guide-section .guide-card')].every(card => card.querySelectorAll('a').length === 1)),
        'a card with more than one link');

    /// A click anywhere on a card opens its page, inside the console.
    const card = await page.$('.guide-card:has(a[href="/console/guide/how-to/offboard-a-user"])');
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12);
    await waitUntil(page, () => location.pathname === '/console/guide/how-to/offboard-a-user' && document.querySelector('.guide-article'));
    await page.click('.guide-home-link');
    await page.waitForSelector('.guide-landing');

    /// The keyboard reaches a card and opens it.
    await page.focus('.guide-card a[href="/console/guide/reference/privileges"]');
    await page.keyboard.press('Enter');
    await waitUntil(page, () => location.pathname === '/console/guide/reference/privileges');
    await page.click('.admin-head .crumbs a');
    await page.waitForSelector('.guide-landing');

    await page.fill('#guide-landing-search', 'offboard');
    await page.waitForSelector('.guide-landing-results li a');
    check(await page.isHidden('.guide-sections'), 'the sections are shown with search results');
    check(await page.$('.guide-landing-results a[href="/console/guide/how-to/offboard-a-user"]'), 'no search result for offboard');
    await page.fill('#guide-landing-search', '');
    check(await page.isVisible('.guide-sections'), 'the sections do not come back when the search is cleared');
    await screenshot(page, '16-guide-home');
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
    /// Not the page, and a client error: 404, or 401 when the default user has a password, because the server asks
    /// for credentials before it reports a path that no handler serves.
    const response = await page.goto(`${BASE}/consolex`);
    check([401, 404].includes(response.status()), `/consolex: ${response.status()}`);
    check(!(await response.text()).includes('<title>ClickHouse Console</title>'), '/consolex serves the console');
    await context.close();
});

await browser.close();

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
