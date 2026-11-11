#!/usr/bin/env node
/// Tests of `server_bundle.mjs`, without a server: round trips with each key provider, and the failures that must be
/// refused (wrong key or passphrase, changed ciphertext or header, truncation, paths that leave the staging directory).
/// The vault provider is tested against a local stand-in of the Transit API (`/v1/transit/encrypt|decrypt/<key>`), not a
/// real Vault.
///
/// Usage: node server_bundle_test.mjs        (exits with an error when a check fails)

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {collectFiles, createKeyFile, fileKeyProvider, passphraseKeyProvider, readBundle, stagedPath, vaultKeyProvider, writeBundle} from './server_bundle.mjs';

const results = [];
async function test(name, body) {
    try {
        await body();
        results.push(`PASS  ${name}`);
    } catch (e) {
        results.push(`FAIL  ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`);
    }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
const config = path.join(dir, 'etc', 'clickhouse-server');
fs.mkdirSync(path.join(config, 'config.d'), {recursive: true});
fs.writeFileSync(path.join(config, 'config.xml'), '<clickhouse><tcp_port>9000</tcp_port></clickhouse>\n');
fs.writeFileSync(path.join(config, 'config.d', 'secrets.xml'), '<clickhouse><s3><key>AKIA-SECRET-VALUE</key></s3></clickhouse>\n', {mode: 0o600});
fs.writeFileSync(path.join(config, 'big.bin'), crypto.randomBytes(9 * 1024 * 1024));
fs.symlinkSync(path.join(config, 'config.xml'), path.join(config, 'config.d', 'link.xml'));
fs.symlinkSync(config, path.join(config, 'config.d', 'loop'));

async function roundTrip(provider, reader = provider) {
    const files = collectFiles([config]);
    const parts = [];
    const written = await writeBundle({files, roots: [config], provider, meta: {server: 'test'}, onPart: async part => { parts.push(part); }});
    const read = new Map();
    const result = await readBundle({header: written.header, parts, tag: written.tag, provider: reader, onFile: async (entry, data) => { read.set(entry.path, data); }});
    return {files, parts, written, read, result};
}

function checkContents({files, read, result, written}) {
    assert.equal(read.size, files.length);
    for (const file of files) assert.ok(read.get(file.path).equals(fs.readFileSync(file.absolute)), `content of ${file.path}`);
    assert.equal(result.end.files, files.length);
    assert.ok(!written.header.includes('secrets.xml') && !written.header.includes('AKIA'), 'the header names no file and no secret');
}

const key_file = path.join(dir, 'keys', 'bundle.key');

await test('A key file is created readable by its owner only, and never replaced', async () => {
    const fingerprint = createKeyFile(key_file);
    assert.match(fingerprint, /^sha256:[0-9a-f]{16}$/);
    assert.equal(fs.statSync(key_file).mode & 0o777, 0o600);
    assert.throws(() => createKeyFile(key_file), /EEXIST/);
});

await test('A key file readable by other users is refused', async () => {
    const loose = path.join(dir, 'loose.key');
    fs.writeFileSync(loose, crypto.randomBytes(32).toString('base64'), {mode: 0o644});
    fs.chmodSync(loose, 0o644);
    assert.throws(() => fileKeyProvider(loose), /readable by other users/);
});

await test('Key file: a round trip restores every file, symbolic links followed, directory loops skipped', async () => {
    const run = await roundTrip(fileKeyProvider(key_file));
    checkContents(run);
    assert.ok(run.files.some(f => f.path.endsWith('link.xml')));
    assert.ok(!run.files.some(f => f.path.includes(`${path.sep}loop${path.sep}`)));
    assert.ok(run.parts.length >= 2, 'a large file spans several parts');
});

await test('Key file: another key is refused before decryption', async () => {
    const other = path.join(dir, 'other.key');
    createKeyFile(other);
    await assert.rejects(roundTrip(fileKeyProvider(key_file), fileKeyProvider(other)), /encrypted with the master key/);
});

await test('Passphrase: a round trip works; a wrong passphrase and a short one are refused', async () => {
    checkContents(await roundTrip(passphraseKeyProvider('correct horse battery staple')));
    await assert.rejects(roundTrip(passphraseKeyProvider('correct horse battery staple'), passphraseKeyProvider('wrong horse battery staple')), /passphrase is wrong/);
    assert.throws(() => passphraseKeyProvider('short'), /at least 12/);
});

await test('A changed byte of the ciphertext, of the header, or a missing part fails authentication', async () => {
    const provider = fileKeyProvider(key_file);
    const {parts, written} = await roundTrip(provider);
    const changed = parts.map(p => Buffer.from(p));
    changed[0][100] ^= 1;
    await assert.rejects(readBundle({header: written.header, parts: changed, tag: written.tag, provider, onFile: async () => {}}), /authentication|checksum|incorrect header|invalid/i);
    const header = JSON.parse(written.header);
    header.created_at = '2000-01-01T00:00:00.000Z';
    await assert.rejects(readBundle({header: JSON.stringify(header), parts, tag: written.tag, provider, onFile: async () => {}}), /authentication/i);
    await assert.rejects(readBundle({header: written.header, parts: parts.slice(0, -1), tag: written.tag, provider, onFile: async () => {}}), /authentication|truncated|middle|unexpected end/i);
});

await test('Vault Transit: a round trip wraps the data key in Vault; another key name is refused', async () => {
    const keys = new Map();
    let calls = 0;
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const m = req.url.match(/^\/v1\/transit\/(encrypt|decrypt)\/([^/]+)$/);
            if (!m || req.headers['x-vault-token'] !== 'test-token') {
                res.writeHead(403, {'Content-Type': 'application/json'}).end(JSON.stringify({errors: ['permission denied']}));
                return;
            }
            calls++;
            const name = decodeURIComponent(m[2]);
            if (!keys.has(name)) keys.set(name, crypto.randomBytes(32));
            const data = JSON.parse(body);
            const key = keys.get(name);
            if (m[1] === 'encrypt') {
                const iv = crypto.randomBytes(12);
                const c = crypto.createCipheriv('aes-256-gcm', key, iv);
                const ct = Buffer.concat([c.update(Buffer.from(data.plaintext, 'base64')), c.final()]);
                res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({data: {ciphertext: `vault:v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`}}));
            } else {
                const raw = Buffer.from(data.ciphertext.slice('vault:v1:'.length), 'base64');
                const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
                d.setAuthTag(raw.subarray(12, 28));
                res.writeHead(200, {'Content-Type': 'application/json'}).end(JSON.stringify({data: {plaintext: Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('base64')}}));
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = `http://127.0.0.1:${server.address().port}`;
    try {
        const provider = vaultKeyProvider({addr, token: 'test-token', key: 'clickhouse-bundles'});
        const run = await roundTrip(provider);
        checkContents(run);
        assert.ok(JSON.parse(run.written.header).key.wrapped.startsWith('vault:v1:'));
        assert.equal(calls, 2);
        await assert.rejects(roundTrip(provider, vaultKeyProvider({addr, token: 'test-token', key: 'other'})), /encrypted with vault:transit\/clickhouse-bundles/);
        await assert.rejects(roundTrip(vaultKeyProvider({addr, token: 'bad-token', key: 'clickhouse-bundles'})), /HTTP 403 permission denied/);
    } finally {
        server.close();
    }
});

/// A real Vault, when one is given: VAULT_TEST_ADDR, VAULT_TEST_TOKEN (a policy with update on transit/encrypt and
/// transit/decrypt of VAULT_TEST_KEY), VAULT_TEST_TOKEN_ENCRYPT_ONLY, and VAULT_TEST_ROOT_TOKEN to rotate the key.
if (process.env.VAULT_TEST_ADDR) {
    await test('Real Vault: a round trip; an encrypt-only token cannot decrypt; bundles made before a key rotation still decrypt', async () => {
        const addr = process.env.VAULT_TEST_ADDR;
        const key = process.env.VAULT_TEST_KEY || 'clickhouse-bundles';
        const provider = vaultKeyProvider({addr, token: process.env.VAULT_TEST_TOKEN, key});
        const before = await roundTrip(provider);
        checkContents(before);
        assert.match(JSON.parse(before.written.header).key.wrapped, /^vault:v\d+:/);
        await assert.rejects(roundTrip(vaultKeyProvider({addr, token: process.env.VAULT_TEST_TOKEN_ENCRYPT_ONLY, key})), /decrypt .* failed: HTTP 403/);
        const rotate = await fetch(`${addr}/v1/transit/keys/${key}/rotate`, {method: 'POST', headers: {'X-Vault-Token': process.env.VAULT_TEST_ROOT_TOKEN}});
        assert.ok(rotate.ok, `rotation: HTTP ${rotate.status}`);
        const read = new Map();
        await readBundle({header: before.written.header, parts: before.parts, tag: before.written.tag, provider, onFile: async (entry, data) => { read.set(entry.path, data); }});
        assert.equal(read.size, before.files.length);
        const after = await roundTrip(provider);
        checkContents(after);
        assert.notEqual(JSON.parse(after.written.header).key.wrapped.split(':')[1], JSON.parse(before.written.header).key.wrapped.split(':')[1], 'the new bundle uses the new key version');
    });
}

await test('Staged paths stay inside the staging directory', async () => {
    assert.equal(stagedPath('/stage', '/etc/clickhouse-server/config.xml'), '/stage/etc/clickhouse-server/config.xml');
    assert.throws(() => stagedPath('/stage', '/etc/../../root/.ssh/id_rsa'), /Refusing/);
    assert.throws(() => stagedPath('/stage', '/'), /Refusing/);
});

await test('A file that cannot be read fails the collection', async () => {
    if (process.getuid && process.getuid() === 0) return;
    const locked = path.join(config, 'locked.xml');
    fs.writeFileSync(locked, 'x', {mode: 0o000});
    try {
        assert.throws(() => collectFiles([config]), /cannot read 1 files/);
    } finally {
        fs.rmSync(locked);
    }
});

fs.rmSync(dir, {recursive: true, force: true});
console.log(results.join('\n'));
const failed = results.filter(r => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
