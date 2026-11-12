#!/usr/bin/env node
/// Token authenticator of the web console: single sign-on with an OpenID Connect provider (Keycloak) for ClickHouse.
///
/// This build of ClickHouse does not verify tokens itself. It can ask an HTTP service to check a sign-in
/// (`http_authentication_servers`), for the users `IDENTIFIED WITH http SERVER '<name>'`: it sends the user name and the
/// password as HTTP Basic credentials, and accepts the sign-in when the answer is 200. The console signs a user in with
/// the provider (Authorization Code with PKCE) and sends the access token as the password. This service checks it:
/// - the signature, with the provider's keys (cached; fetched again for an unknown key ID, at most every 30 seconds);
///   only RS256, PS256, and ES256: a token signed with `none` or a shared secret is refused;
/// - the issuer, the type (an access token, not an ID token), the client it was issued to (`azp`), the audience;
/// - the expiry and the time it becomes valid, with 30 seconds for clock skew;
/// - that the user name claim is the user name of the sign-in.
/// Anything it cannot check is refused: the provider's keys unavailable, an unknown key, a malformed token (fail closed).
/// A token is accepted until it expires: the console refreshes it while the user is signed in, and a user disabled in
/// the provider can no longer refresh, so access ends at the latest when the last token expires (5 minutes by default
/// in Keycloak).
///
/// Optionally, it also keeps the users in line with the provider (SSO_SYNC_*): every interval, it reads the members of the
/// groups whose name starts with SSO_ROLE_PREFIX, with a service account of the provider, and
/// - creates a ClickHouse user `IDENTIFIED WITH http SERVER '<SSO_SERVER_NAME>'` for each enabled member;
/// - grants the roles of their groups (a group `<prefix><role>` gives the role `<role>`, if it exists) and SSO_DEFAULT_ROLES,
///   and revokes the roles they no longer get;
/// - drops the users who left every such group, or were disabled or deleted.
/// It changes only users identified with this authentication server: never a user with a password or another method.
/// A read that finds no group with the prefix while such users exist is refused, not applied, so that a wrong setting or a
/// failure of the provider cannot remove every user at once.
///
/// It needs Node.js 18 or later and no packages. Configuration (environment variables):
///   SSO_ISSUER             issuer of the provider, e.g. https://keycloak.example.com/realms/clickhouse (HTTPS; HTTP only on localhost)
///   SSO_CLIENT_ID          client of the console: the tokens must be issued to it (azp)
///   SSO_AUDIENCE           audience the access token must name (default SSO_CLIENT_ID; empty: not checked)
///   SSO_USERNAME_CLAIM     claim that is the ClickHouse user name (default preferred_username)
///   SSO_TOKEN_TYPE         value of the claim typ of access tokens (default Bearer, as in Keycloak; empty: not checked)
///   SSO_LISTEN             address to listen on (default 127.0.0.1:29700). Only the ClickHouse server should reach it.
/// User sync (optional; all of the first three to turn it on):
///   SSO_SYNC_CLIENT_ID     confidential client of the provider with a service account that can read users and groups
///                          (Keycloak: the roles view-users and query-groups of realm-management)
///   SSO_SYNC_SECRET_FILE   file with its client secret (or SSO_SYNC_SECRET)
///   CLICKHOUSE_URL         HTTP interface of the server (default http://127.0.0.1:8123)
///   CLICKHOUSE_USER        service account: CREATE USER, ALTER USER, DROP USER, and ROLE ADMIN (or the roles WITH ADMIN OPTION)
///   CLICKHOUSE_PASSWORD    its password
///   SSO_SERVER_NAME        name of this service in http_authentication_servers (default sso)
///   SSO_ROLE_PREFIX        prefix of the groups that give roles (default clickhouse-)
///   SSO_DEFAULT_ROLES      roles every synced user gets, comma-separated (default none)
///   SSO_SYNC_INTERVAL_SECONDS  time between syncs (default 60)
///   ADMIN_DATABASE         database of the console tables, for the audit records (default console_admin; empty: none)
/// Arguments: --sync-once runs one sync and exits; --check-config prints the configuration and the provider's keys.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';

const ISSUER = (process.env.SSO_ISSUER || '').replace(/\/+$/, '');
const CLIENT_ID = process.env.SSO_CLIENT_ID || '';
const AUDIENCE = process.env.SSO_AUDIENCE === undefined ? CLIENT_ID : process.env.SSO_AUDIENCE;
const USERNAME_CLAIM = process.env.SSO_USERNAME_CLAIM || 'preferred_username';
const TOKEN_TYPE = process.env.SSO_TOKEN_TYPE === undefined ? 'Bearer' : process.env.SSO_TOKEN_TYPE;
const LISTEN = process.env.SSO_LISTEN || '127.0.0.1:29700';
const SYNC_CLIENT_ID = process.env.SSO_SYNC_CLIENT_ID || '';
const SYNC_SECRET = process.env.SSO_SYNC_SECRET_FILE ? fs.readFileSync(process.env.SSO_SYNC_SECRET_FILE, 'utf8').trim() : (process.env.SSO_SYNC_SECRET || '');
const CH_URL = (process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const CH_USER = process.env.CLICKHOUSE_USER || '';
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD || '';
const SERVER_NAME = process.env.SSO_SERVER_NAME || 'sso';
const ROLE_PREFIX = process.env.SSO_ROLE_PREFIX === undefined ? 'clickhouse-' : process.env.SSO_ROLE_PREFIX;
const DEFAULT_ROLES = (process.env.SSO_DEFAULT_ROLES || '').split(',').map(r => r.trim()).filter(Boolean);
const SYNC_INTERVAL = Number(process.env.SSO_SYNC_INTERVAL_SECONDS || 60) * 1000;
const ADMIN_DATABASE = process.env.ADMIN_DATABASE === undefined ? 'console_admin' : process.env.ADMIN_DATABASE;
const SKEW = 30;
const ALGORITHMS = {
    RS256: key => ({key}),
    PS256: key => ({key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32}),
    ES256: key => ({key, dsaEncoding: 'ieee-p1363'}),
};
const ID = `${os.hostname()}-${process.pid}`;

function log(message, fields = {}) {
    console.log(JSON.stringify({time: new Date().toISOString(), authenticator: ID, message, ...fields}));
}

function fail(message) {
    console.error(`sso_authenticator: ${message}`);
    process.exit(2);
}

/// Tokens and keys are fetched over HTTPS; plain HTTP only from this machine, for development.
function checkUrl(text, what) {
    let url;
    try {
        url = new URL(text);
    } catch (e) {
        fail(`${what} is not a URL: ${text}`);
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) fail(`${what} must use HTTPS (plain HTTP only on localhost): ${text}`);
    return url;
}

if (!ISSUER || !CLIENT_ID) fail('set SSO_ISSUER and SSO_CLIENT_ID');
checkUrl(ISSUER, 'SSO_ISSUER');
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(SERVER_NAME)) fail(`invalid SSO_SERVER_NAME: ${SERVER_NAME}`);
if (ADMIN_DATABASE && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ADMIN_DATABASE)) fail(`invalid ADMIN_DATABASE: ${ADMIN_DATABASE}`);
for (const role of DEFAULT_ROLES) if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(role)) fail(`invalid role in SSO_DEFAULT_ROLES: ${role}`);
const SYNC = !!(SYNC_CLIENT_ID || SYNC_SECRET);
if (SYNC && !(SYNC_CLIENT_ID && SYNC_SECRET && CH_USER)) fail('the user sync needs SSO_SYNC_CLIENT_ID, SSO_SYNC_SECRET_FILE (or SSO_SYNC_SECRET), and CLICKHOUSE_USER');

async function fetchJSON(url, options = {}) {
    const response = await fetch(url, {...options, signal: AbortSignal.timeout(options.timeout || 5000)});
    const text = await response.text();
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

// ---------------------------------------------------------------------------------------------
// The provider's keys

let discovery = null;
let keys = new Map();
let keys_fetched_at = 0;

async function loadDiscovery() {
    const document = await fetchJSON(`${ISSUER}/.well-known/openid-configuration`);
    if (document.issuer !== ISSUER) throw new Error(`the provider reports the issuer ${document.issuer}, not ${ISSUER}`);
    checkUrl(document.jwks_uri, 'jwks_uri');
    checkUrl(document.token_endpoint, 'token_endpoint');
    discovery = document;
}

async function loadKeys() {
    if (!discovery) await loadDiscovery();
    const jwks = await fetchJSON(discovery.jwks_uri);
    const loaded = new Map();
    for (const jwk of jwks.keys || []) {
        if ((jwk.use || 'sig') !== 'sig' || !jwk.kid) continue;
        try {
            loaded.set(jwk.kid, {alg: jwk.alg, key: crypto.createPublicKey({key: jwk, format: 'jwk'})});
        } catch (e) {
            log('skipped a key the authenticator cannot read', {kid: jwk.kid, error: e.message});
        }
    }
    keys = loaded;
    keys_fetched_at = Date.now();
    return loaded.size;
}

/// The key of a token. An unknown key ID fetches the keys again, at most every 30 seconds: the provider rotated them.
async function keyFor(kid) {
    if (!keys.has(kid) && Date.now() - keys_fetched_at > SKEW * 1000) await loadKeys();
    return keys.get(kid);
}

// ---------------------------------------------------------------------------------------------
// Checking a sign-in

function decodePart(part) {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/// Returns null when the token is accepted for `user`, or the reason it is refused (logged, never the token).
async function checkToken(user, token) {
    const parts = token.split('.');
    if (parts.length !== 3) return 'not a signed JWT';
    let header, claims;
    try {
        header = decodePart(parts[0]);
        claims = decodePart(parts[1]);
    } catch (e) {
        return 'malformed token';
    }
    if (!ALGORITHMS[header.alg]) return `algorithm ${header.alg} is not accepted`;
    const key = await keyFor(header.kid);
    if (!key) return `unknown key ${header.kid}`;
    if (key.alg && key.alg !== header.alg) return `key ${header.kid} is for ${key.alg}, not ${header.alg}`;
    const valid = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), ALGORITHMS[header.alg](key.key), Buffer.from(parts[2], 'base64url'));
    if (!valid) return 'invalid signature';
    const now = Date.now() / 1000;
    if (claims.iss !== ISSUER) return `issuer ${claims.iss}`;
    if (TOKEN_TYPE && claims.typ !== TOKEN_TYPE) return `token type ${claims.typ}, not an access token`;
    if (claims.azp !== CLIENT_ID) return `issued to ${claims.azp}, not ${CLIENT_ID}`;
    if (AUDIENCE && ![].concat(claims.aud || []).includes(AUDIENCE)) return `audience does not include ${AUDIENCE}`;
    if (typeof claims.exp !== 'number' || claims.exp + SKEW < now) return 'expired';
    if (typeof claims.nbf === 'number' && claims.nbf - SKEW > now) return 'not valid yet';
    if (typeof claims.iat === 'number' && claims.iat - SKEW > now) return 'issued in the future';
    if (claims[USERNAME_CLAIM] !== user) return `the claim ${USERNAME_CLAIM} is not the user name`;
    return null;
}

function basicCredentials(header) {
    const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header || '');
    if (!match) return null;
    const text = Buffer.from(match[1], 'base64').toString('utf8');
    const colon = text.indexOf(':');
    return colon < 0 ? null : {user: text.slice(0, colon), password: text.slice(colon + 1)};
}

const server = http.createServer(async (request, response) => {
    const answer = (status, body) => {
        response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
        response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && request.url === '/health') {
        answer(keys.size ? 200 : 503, {keys: keys.size, issuer: ISSUER});
        return;
    }
    if (request.method !== 'GET') {
        answer(405, {});
        return;
    }
    const credentials = basicCredentials(request.headers.authorization);
    if (!credentials) {
        answer(401, {});
        return;
    }
    let reason;
    try {
        reason = await checkToken(credentials.user, credentials.password);
    } catch (e) {
        /// The keys could not be fetched: refuse, and say so in the log.
        log('cannot check the token', {user: credentials.user, error: e.message});
        answer(503, {});
        return;
    }
    if (reason) {
        log('refused', {user: credentials.user, reason});
        answer(401, {});
        return;
    }
    answer(200, {});
});

// ---------------------------------------------------------------------------------------------
// User sync

async function clickhouse(query, params = {}) {
    const url = new URL(`${CH_URL}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, typeof v === 'string' ? v : JSON.stringify(v));
    const response = await fetch(url, {method: 'POST', body: query, signal: AbortSignal.timeout(30000),
        headers: {'X-ClickHouse-User': CH_USER, 'X-ClickHouse-Key': CH_PASSWORD, 'X-ClickHouse-Format': 'JSONEachRow'}});
    const text = await response.text();
    if (!response.ok) throw new Error(`${query.split('\n')[0].slice(0, 120)}: ${text.trim().split('\n')[0]}`);
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

const quoteIdentifier = name => `\`${String(name).replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
const quoteString = value => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function providerAdmin(path) {
    if (!discovery) await loadDiscovery();
    const token = await fetchJSON(discovery.token_endpoint, {method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'client_credentials', client_id: SYNC_CLIENT_ID, client_secret: SYNC_SECRET})});
    /// Keycloak's admin API is under /admin/realms/<realm>, next to the issuer /realms/<realm>.
    const admin_base = ISSUER.replace(/\/realms\/([^/]+)$/, '/admin/realms/$1');
    const get = url => fetchJSON(`${admin_base}${url}`, {headers: {Authorization: `Bearer ${token.access_token}`}, timeout: 15000});
    return get(path).then(first => ({first, get}));
}

/// The members of the prefixed groups (and of their subgroups), with the roles each would get, and how many such groups
/// exist. Paged, so that a large group is read completely.
async function desiredUsers() {
    const {first: groups, get} = await providerAdmin(`/groups?search=${encodeURIComponent(ROLE_PREFIX)}&briefRepresentation=true&max=1000`);
    const flatten = list => list.flatMap(g => [g, ...flatten(g.subGroups || [])]);
    const users = new Map();
    const prefixed = flatten(groups).filter(g => g.name.startsWith(ROLE_PREFIX));
    for (const group of prefixed) {
        const role = group.name.slice(ROLE_PREFIX.length);
        for (let offset = 0; ; offset += 500) {
            const members = await get(`/groups/${group.id}/members?first=${offset}&max=500&briefRepresentation=true`);
            for (const member of members) {
                if (!member.enabled) continue;
                const name = member[USERNAME_CLAIM === 'preferred_username' ? 'username' : USERNAME_CLAIM] || member.username;
                if (!users.has(name)) users.set(name, new Set(DEFAULT_ROLES));
                users.get(name).add(role);
            }
            if (members.length < 500) break;
        }
    }
    return {users, groups: prefixed.length};
}

/// The users identified with this authentication server, and their granted roles. system.users does not report the
/// server of an http user (auth_params is empty), so it is read from SHOW CREATE USER.
async function managedUsers() {
    const rows = await clickhouse(`SELECT u.name AS name, groupArrayIf(g.granted_role_name, g.granted_role_name != '') AS roles
        FROM system.users AS u LEFT JOIN system.role_grants AS g ON g.user_name = u.name
        WHERE has(u.auth_type, 'http') GROUP BY u.name`);
    const marker = `IDENTIFIED WITH http SERVER ${quoteString(SERVER_NAME)}`;
    const managed = new Map();
    for (const row of rows) {
        const [statement] = await clickhouse(`SHOW CREATE USER ${quoteIdentifier(row.name)}`);
        if (Object.values(statement)[0].includes(marker)) managed.set(row.name, new Set(row.roles));
    }
    return managed;
}

async function audit(action, target, summary, result, error = '') {
    if (!ADMIN_DATABASE) return;
    const row = {correlation_id: crypto.randomUUID(), scope: 'local', target_type: 'user', target_name: target, action, summary, result, error, details: JSON.stringify({by: 'sso_authenticator', server: SERVER_NAME})};
    try {
        await clickhouse(`INSERT INTO ${quoteIdentifier(ADMIN_DATABASE)}.audit_log (correlation_id, scope, target_type, target_name, action, summary, result, error, details) FORMAT JSONEachRow\n${JSON.stringify(row)}`);
    } catch (e) {
        log('the audit record could not be written', {action, target, error: e.message});
    }
}

async function syncOnce() {
    const [{users: desired, groups}, managed, role_rows, all_users] = await Promise.all([desiredUsers(), managedUsers(), clickhouse('SELECT name FROM system.roles'),
        clickhouse('SELECT name FROM system.users')]);
    const roles = new Set(role_rows.map(r => r.name));
    /// No group at all is a wrong prefix, a wrong realm, or a service account that cannot see the groups, not users who
    /// left: removing everyone on that would be an outage. Groups whose members all left are a real answer.
    if (!groups && managed.size) {
        throw new Error(`the provider shows no group ${ROLE_PREFIX}*, while ${managed.size} users are identified with ${SERVER_NAME}: refusing to remove them all`);
    }
    const changes = [];
    const run = async (sql, action, user, summary) => {
        try {
            await clickhouse(sql);
            changes.push(summary);
            await audit(action, user, summary, 'success');
        } catch (e) {
            log('sync statement failed', {user, error: e.message});
            await audit(action, user, summary, 'failure', e.message);
        }
    };
    const existing = new Set(all_users.map(r => r.name));
    for (const [user, wanted_all] of desired) {
        const wanted = new Set([...wanted_all].filter(r => roles.has(r)));
        const missing_roles = [...wanted_all].filter(r => !roles.has(r));
        if (missing_roles.length) log('roles that do not exist are skipped', {user, roles: missing_roles});
        if (!managed.has(user)) {
            if (existing.has(user)) {
                /// A user of that name with a password or another method: not ours to change.
                log('a user of that name exists with another authentication: skipped', {user});
                continue;
            }
            await run(`CREATE USER ${quoteIdentifier(user)} IDENTIFIED WITH http SERVER ${quoteString(SERVER_NAME)} SCHEME 'BASIC'`,
                'sso_create_user', user, `Create the SSO user ${user}`);
            managed.set(user, new Set());
        }
        const current = managed.get(user);
        const grant = [...wanted].filter(r => !current.has(r));
        const revoke = [...current].filter(r => !wanted.has(r));
        if (grant.length) await run(`GRANT ${grant.map(quoteIdentifier).join(', ')} TO ${quoteIdentifier(user)}`, 'sso_grant_roles', user, `Grant ${grant.join(', ')} to ${user}`);
        if (revoke.length) await run(`REVOKE ${revoke.map(quoteIdentifier).join(', ')} FROM ${quoteIdentifier(user)}`, 'sso_revoke_roles', user, `Revoke ${revoke.join(', ')} from ${user}`);
        if (grant.length || revoke.length) await run(`SET DEFAULT ROLE ALL TO ${quoteIdentifier(user)}`, 'sso_default_roles', user, `Enable every role of ${user} by default`);
    }
    for (const user of managed.keys()) {
        if (!desired.has(user)) await run(`DROP USER ${quoteIdentifier(user)}`, 'sso_drop_user', user, `Drop the SSO user ${user}: no longer in a ${ROLE_PREFIX}* group, or disabled`);
    }
    log('users synced', {members: desired.size, changes: changes.length});
    return changes;
}

// ---------------------------------------------------------------------------------------------

if (process.argv.includes('--check-config')) {
    const count = await loadKeys();
    console.log(JSON.stringify({issuer: ISSUER, client_id: CLIENT_ID, audience: AUDIENCE, username_claim: USERNAME_CLAIM, token_type: TOKEN_TYPE,
        keys: count, sync: SYNC ? {client_id: SYNC_CLIENT_ID, server: SERVER_NAME, role_prefix: ROLE_PREFIX, default_roles: DEFAULT_ROLES} : null}, null, 2));
    process.exit(0);
}
if (process.argv.includes('--sync-once')) {
    if (!SYNC) fail('the user sync is not configured');
    const changes = await syncOnce();
    for (const change of changes) console.log(change);
    process.exit(0);
}

const [host, port] = [LISTEN.slice(0, LISTEN.lastIndexOf(':')), Number(LISTEN.slice(LISTEN.lastIndexOf(':') + 1))];
try {
    log('keys loaded', {issuer: ISSUER, keys: await loadKeys()});
} catch (e) {
    /// Refuse sign-ins until the keys can be fetched: each request tries again (keyFor).
    log('cannot load the keys of the provider yet', {error: e.message});
}
server.listen(port, host, () => log('listening', {address: LISTEN, client_id: CLIENT_ID, sync: SYNC}));
if (SYNC) {
    const cycle = async () => {
        try {
            await syncOnce();
        } catch (e) {
            log('sync failed', {error: e.message});
        }
        setTimeout(cycle, SYNC_INTERVAL);
    };
    cycle();
}
