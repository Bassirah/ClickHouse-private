/// Server bundles of the backup worker (`backup_worker.mjs`): the state of a ClickHouse server that `BACKUP` cannot reach,
/// such as its configuration files, the secrets in them, TLS keys, scripts, and a snapshot of Keeper, encrypted as one
/// stream.
///
/// Format (version 1). A bundle is a clear header, the ciphertext, and an authentication tag:
/// - The header is JSON. It names the cipher and the key provider, and holds the data key wrapped by that provider. It
///   holds no file names, sizes, or checksums: those can tell an attacker something about the secrets.
/// - The ciphertext is AES-256-GCM, with the header as additional authenticated data, of a gzip stream of records. Each
///   file is a 4-byte big-endian length, a JSON entry `{type: 'file', path, mode, size, mtime, kind}`, its bytes, and the
///   SHA-256 of its bytes (32 bytes). A last entry `{type: 'end', roots, files, bytes}` closes the stream.
/// - The tag authenticates the header and the ciphertext. Nothing read from a bundle is trusted before it is checked.
///
/// Envelope encryption: every bundle has a new random 256-bit data key, wrapped by the key provider:
/// - `file`: a 256-bit master key in a file readable by its owner only (`createKeyFile`). Keep a copy of the key out of
///   band, for example in a password manager: without it, the bundles cannot be decrypted.
/// - `vault`: the Transit secrets engine of HashiCorp Vault encrypts and decrypts the data key; the master key never
///   leaves Vault.
/// - `passphrase`: a key derived from a passphrase with scrypt. Nothing is stored, so only bundles made by a person on the
///   host can use it, not scheduled ones.
///
/// Node.js 18 or later, no packages.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import {once} from 'node:events';

export const FORMAT = 'clickhouse-console-server-bundle';
export const VERSION = 1;
const CIPHER = 'aes-256-gcm';
/// The size of the ciphertext parts the caller stores.
export const PART_SIZE = 4 * 1024 * 1024;
const SCRYPT = {N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024};
export const MIN_PASSPHRASE = 12;

// ---------------------------------------------------------------------------------------------
// Key providers: wrap and unwrap the data key of a bundle.

function sealWith(key, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(CIPHER, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function openWith(key, sealed, what) {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = crypto.createDecipheriv(CIPHER, key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    try {
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    } catch (e) {
        throw new Error(`The data key cannot be unwrapped: ${what}.`);
    }
}

/// The fingerprint of a master key: identifies it in bundles and in the console without revealing it.
export function keyFingerprint(key) {
    return `sha256:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

/// Creates a new master key file, readable by its owner only. Refuses to replace an existing file: a replaced key
/// makes every bundle encrypted with it unreadable.
export function createKeyFile(file) {
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(path.resolve(file)), {recursive: true, mode: 0o700});
    fs.writeFileSync(file, key.toString('base64') + '\n', {flag: 'wx', mode: 0o600});
    return keyFingerprint(key);
}

export function readKeyFile(file) {
    const stat = fs.statSync(file);
    if (stat.mode & 0o077) throw new Error(`The key file ${file} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}): make it 600.`);
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`The key file ${file} does not hold a 256-bit key in base64.`);
    return key;
}

export function fileKeyProvider(file) {
    const key = readKeyFile(file);
    const key_id = keyFingerprint(key);
    return {
        type: 'file', key_id,
        async wrap(data_key) { return {wrapped: sealWith(key, data_key), params: {}}; },
        async unwrap(wrapped, params, header_key_id) {
            if (header_key_id !== key_id) throw new Error(`The bundle was encrypted with the master key ${header_key_id}; this worker has ${key_id}.`);
            return openWith(key, wrapped, 'the key file does not match');
        },
    };
}

export function passphraseKeyProvider(passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) throw new Error(`The passphrase must have at least ${MIN_PASSPHRASE} characters.`);
    const derive = (salt, p) => crypto.scryptSync(passphrase.normalize('NFC'), salt, 32, {N: p.N, r: p.r, p: p.p, maxmem: SCRYPT.maxmem});
    return {
        type: 'passphrase', key_id: 'passphrase',
        async wrap(data_key) {
            const salt = crypto.randomBytes(16);
            const params = {kdf: 'scrypt', salt: salt.toString('base64'), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p};
            return {wrapped: sealWith(derive(salt, params), data_key), params};
        },
        async unwrap(wrapped, params) {
            if (params.kdf !== 'scrypt') throw new Error(`Unknown key derivation ${params.kdf}.`);
            return openWith(derive(Buffer.from(params.salt, 'base64'), params), wrapped, 'the passphrase is wrong');
        },
    };
}

/// The Transit secrets engine of HashiCorp Vault: `POST /v1/<mount>/encrypt/<key>` and `/decrypt/<key>`.
export function vaultKeyProvider({addr, token, mount = 'transit', key, namespace = ''}) {
    if (!addr || !token || !key) throw new Error('The vault key provider needs VAULT_ADDR, a token (VAULT_TOKEN or VAULT_TOKEN_FILE), and VAULT_TRANSIT_KEY.');
    const call = async (operation, body) => {
        const response = await fetch(`${addr.replace(/\/+$/, '')}/v1/${mount}/${operation}/${encodeURIComponent(key)}`, {
            method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
            headers: {'X-Vault-Token': token, 'Content-Type': 'application/json', ...(namespace ? {'X-Vault-Namespace': namespace} : {})},
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`Vault ${operation} with the key ${mount}/${key} failed: HTTP ${response.status} ${(result.errors || []).join('; ')}`);
        return result.data;
    };
    return {
        type: 'vault', key_id: `vault:${mount}/${key}`,
        async wrap(data_key) { return {wrapped: (await call('encrypt', {plaintext: data_key.toString('base64')})).ciphertext, params: {}}; },
        async unwrap(wrapped, params, header_key_id) {
            if (header_key_id !== `vault:${mount}/${key}`) throw new Error(`The bundle was encrypted with ${header_key_id}; this worker uses vault:${mount}/${key}.`);
            return Buffer.from((await call('decrypt', {ciphertext: wrapped})).plaintext, 'base64');
        },
    };
}

// ---------------------------------------------------------------------------------------------
// What a bundle contains.

/// The files under `roots` (files or directories), recursively. Symbolic links to files are followed; links to
/// directories are not, so that a loop cannot make the walk endless. A file that cannot be read fails the collection:
/// a bundle that silently misses a file is worse than none.
export function collectFiles(roots) {
    const files = [];
    const unreadable = [];
    const visit = (absolute, top) => {
        const lstat = fs.lstatSync(absolute);
        if (lstat.isSymbolicLink()) {
            const stat = fs.statSync(absolute, {throwIfNoEntry: false});
            if (stat && stat.isFile()) add(absolute, stat);
            return;
        }
        if (lstat.isDirectory()) {
            for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), false);
            return;
        }
        if (lstat.isFile()) add(absolute, lstat);
        else if (top) throw new Error(`${absolute} is not a file or a directory.`);
    };
    const add = (absolute, stat) => {
        try {
            fs.accessSync(absolute, fs.constants.R_OK);
        } catch (e) {
            unreadable.push(absolute);
            return;
        }
        files.push({path: absolute, absolute, mode: stat.mode & 0o7777, size: stat.size, mtime: stat.mtime.toISOString(), kind: 'file'});
    };
    for (const root of roots) {
        if (!fs.existsSync(root)) throw new Error(`${root} does not exist.`);
        visit(path.resolve(root), true);
    }
    if (unreadable.length) throw new Error(`This worker cannot read ${unreadable.length} files: ${unreadable.slice(0, 5).join(', ')}${unreadable.length > 5 ? ', …' : ''}.`);
    return files;
}

/// A four-letter command of Keeper (`csnp`, `lgif`): the reply as text.
function keeperCommand(host, port, command) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({host, port});
        const chunks = [];
        socket.setTimeout(10000, () => socket.destroy(new Error(`Keeper ${host}:${port} did not answer ${command}.`)));
        socket.on('connect', () => socket.write(command));
        socket.on('data', chunk => chunks.push(chunk));
        socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        socket.on('error', reject);
    });
}

/// Asks Keeper for a new snapshot (`csnp`), waits until `lgif` reports it, and returns its file in `snapshot_dir`.
/// Keeper writes the snapshot in the background; it is complete when `last_snapshot_idx` reaches its index.
export async function keeperSnapshot({host, port, snapshot_dir, timeout_ms = 300000}) {
    const reply = (await keeperCommand(host, port, 'csnp')).trim();
    const index = Number(reply);
    if (!Number.isInteger(index) || index <= 0) throw new Error(`Keeper refused to create a snapshot: ${reply || 'no reply'} (is csnp in four_letter_word_white_list?).`);
    const deadline = Date.now() + timeout_ms;
    for (;;) {
        const info = await keeperCommand(host, port, 'lgif');
        const last = Number((info.match(/last_snapshot_idx\s+(\d+)/) || [])[1]);
        if (last >= index) break;
        if (Date.now() > deadline) throw new Error(`Keeper did not finish the snapshot ${index} within ${timeout_ms / 1000} s.`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    /// `snapshot_<index>_<random>.bin[.zstd]`, or `snapshot_<index>_recovered_<generation>_<random>.bin` (KeeperSnapshotManager).
    const name = fs.readdirSync(snapshot_dir).filter(n => (n.match(/^snapshot_(\d+)[_.]/) || [])[1] === String(index) && /\.bin(\.zstd)?$/.test(n)).sort()[0];
    if (!name) throw new Error(`Keeper reports the snapshot ${index}, but ${snapshot_dir} has no snapshot_${index}_*.bin file: is it Keeper's snapshot directory?`);
    const absolute = path.join(snapshot_dir, name);
    const stat = fs.statSync(absolute);
    return {path: absolute, absolute, mode: stat.mode & 0o7777, size: stat.size, mtime: stat.mtime.toISOString(), kind: 'keeper-snapshot', index};
}

// ---------------------------------------------------------------------------------------------
// Writing and reading.

async function write(stream, data) {
    if (!stream.write(data)) await once(stream, 'drain');
}

function record(entry) {
    const json = Buffer.from(JSON.stringify(entry));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(json.length);
    return Buffer.concat([length, json]);
}

/// Encrypts `files` into a bundle. Returns the header, and calls `onPart` with each ciphertext part of at most
/// PART_SIZE bytes, in order; `onPart` is awaited, so the caller can store parts as they come. Returns the tag last.
export async function writeBundle({files, roots, provider, meta = {}, onPart}) {
    const data_key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const {wrapped, params} = await provider.wrap(data_key);
    const header = {format: FORMAT, version: VERSION, created_at: new Date().toISOString(), ...meta, cipher: CIPHER, compression: 'gzip',
        iv: iv.toString('base64'), key: {provider: provider.type, key_id: provider.key_id, wrapped, params}};
    const header_text = JSON.stringify(header);
    const cipher = crypto.createCipheriv(CIPHER, data_key, iv);
    cipher.setAAD(Buffer.from(header_text));
    const gzip = zlib.createGzip({level: 6});
    gzip.pipe(cipher);
    let bytes = 0;
    const producer = (async () => {
        for (const file of files) {
            await write(gzip, record({type: 'file', path: file.path, mode: file.mode, size: file.size, mtime: file.mtime, kind: file.kind}));
            const hash = crypto.createHash('sha256');
            let read = 0;
            for await (const chunk of fs.createReadStream(file.absolute)) {
                read += chunk.length;
                if (read > file.size) break;
                hash.update(chunk);
                await write(gzip, chunk);
            }
            if (read !== file.size) throw new Error(`${file.absolute} changed while it was read (${file.size} bytes listed, ${read} read).`);
            await write(gzip, hash.digest());
            bytes += file.size;
        }
        await write(gzip, record({type: 'end', roots, files: files.length, bytes}));
        gzip.end();
    })();
    producer.catch(e => cipher.destroy(e));
    let pending = [];
    let pending_size = 0;
    let parts = 0;
    let ciphertext_size = 0;
    const flush = async () => {
        if (!pending_size) return;
        const part = Buffer.concat(pending);
        pending = [];
        pending_size = 0;
        parts++;
        ciphertext_size += part.length;
        await onPart(part);
    };
    for await (const chunk of cipher) {
        pending.push(chunk);
        pending_size += chunk.length;
        if (pending_size >= PART_SIZE) await flush();
    }
    await producer;
    await flush();
    return {header: header_text, tag: cipher.getAuthTag(), files: files.length, bytes, parts, ciphertext_size};
}

/// Decrypts a bundle and calls `onFile(entry, data)` for each file, after its checksum matched, and `onEnd(end)`. Data
/// that fails authentication makes the whole read fail with an error; the caller treats everything it received as
/// unverified until this function returns.
export async function readBundle({header: header_text, parts, tag, provider, onFile, onEnd}) {
    const header = JSON.parse(header_text);
    if (header.format !== FORMAT || header.version !== VERSION) throw new Error(`Not a server bundle of version ${VERSION}: ${header.format} ${header.version}.`);
    if (header.key.provider !== provider.type) throw new Error(`The bundle was encrypted with the ${header.key.provider} key provider; this worker uses ${provider.type}.`);
    const data_key = await provider.unwrap(header.key.wrapped, header.key.params, header.key.key_id);
    const decipher = crypto.createDecipheriv(CIPHER, data_key, Buffer.from(header.iv, 'base64'));
    decipher.setAAD(Buffer.from(header_text));
    decipher.setAuthTag(tag);
    const gunzip = zlib.createGunzip();
    decipher.pipe(gunzip);
    const feeder = (async () => {
        for await (const part of parts) await write(decipher, part);
        decipher.end();
    })();
    feeder.catch(e => gunzip.destroy(e));
    decipher.on('error', e => gunzip.destroy(new Error(`The bundle failed authentication: it was changed, or the key is wrong (${e.message}).`)));

    let buffer = Buffer.alloc(0);
    let entry = null;
    let remaining = 0;
    let file_chunks = [];
    let hash = null;
    let end = null;
    for await (const chunk of gunzip) {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        for (;;) {
            if (!entry) {
                if (buffer.length < 4) break;
                const length = buffer.readUInt32BE(0);
                if (buffer.length < 4 + length) break;
                const parsed = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
                buffer = buffer.subarray(4 + length);
                if (parsed.type === 'end') {
                    end = parsed;
                    continue;
                }
                entry = parsed;
                remaining = entry.size;
                file_chunks = [];
                hash = crypto.createHash('sha256');
                continue;
            }
            if (remaining > 0) {
                if (!buffer.length) break;
                const take = buffer.subarray(0, Math.min(remaining, buffer.length));
                hash.update(take);
                file_chunks.push(take);
                remaining -= take.length;
                buffer = buffer.subarray(take.length);
                continue;
            }
            if (buffer.length < 32) break;
            const expected = buffer.subarray(0, 32);
            buffer = buffer.subarray(32);
            const digest = hash.digest();
            if (!digest.equals(expected)) throw new Error(`The checksum of ${entry.path} does not match.`);
            await onFile({...entry, sha256: digest.toString('hex')}, Buffer.concat(file_chunks));
            entry = null;
        }
    }
    await feeder;
    if (entry || buffer.length) throw new Error('The bundle ends in the middle of a file.');
    if (!end) throw new Error('The bundle has no end record: it is truncated.');
    if (onEnd) await onEnd(end);
    return {header, end};
}

/// The relative path under a staging directory for a path of the bundle, refusing paths that would leave it.
export function stagedPath(staging_dir, bundle_path) {
    const relative = bundle_path.replace(/^\/+/, '');
    const target = path.resolve(staging_dir, relative);
    if (!relative || !target.startsWith(path.resolve(staging_dir) + path.sep)) throw new Error(`Refusing the path ${bundle_path} in a bundle.`);
    return target;
}
