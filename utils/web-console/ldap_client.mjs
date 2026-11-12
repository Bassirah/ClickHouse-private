/// A small LDAP v3 client for the access policy worker (`access_policy_worker.mjs`): a simple bind and searches with
/// paged results (RFC 4511, RFC 4515 filters, RFC 2696 paging), over LDAPS or StartTLS only. A connection without TLS
/// is refused: the bind sends the password of the service account.
///
/// Node.js 18 or later, no packages.

import net from 'node:net';
import tls from 'node:tls';

// ---------------------------------------------------------------------------------------------
// BER encoding of the parts of LDAP that the client uses.

function length(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    while (n > 0) {
        bytes.unshift(n & 0xff);
        n = Math.floor(n / 256);
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const seq = (tag, ...parts) => tlv(tag, Buffer.concat(parts));
const str = (value, tag = 0x04) => tlv(tag, Buffer.from(String(value), 'utf8'));
const bool = value => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));

function int(value, tag = 0x02) {
    const bytes = [];
    let n = value;
    do {
        bytes.unshift(n & 0xff);
        n = Math.floor(n / 256);
    } while (n > 0);
    if (bytes[0] & 0x80) bytes.unshift(0);
    return tlv(tag, Buffer.from(bytes));
}

/// Reads one element at `at`: {tag, content, end}, or null when the buffer does not hold it whole yet.
function read(buffer, at = 0) {
    if (buffer.length < at + 2) return null;
    const tag = buffer[at];
    let n = buffer[at + 1];
    let start = at + 2;
    if (n & 0x80) {
        const bytes = n & 0x7f;
        if (buffer.length < start + bytes) return null;
        n = 0;
        for (let i = 0; i < bytes; i++) n = n * 256 + buffer[start + i];
        start += bytes;
    }
    if (buffer.length < start + n) return null;
    return {tag, content: buffer.subarray(start, start + n), end: start + n};
}

function children(content) {
    const out = [];
    let at = 0;
    while (at < content.length) {
        const element = read(content, at);
        if (!element) throw new Error('A truncated LDAP element.');
        out.push(element);
        at = element.end;
    }
    return out;
}

const integer = content => content.reduce((n, byte) => n * 256 + byte, content.length && content[0] & 0x80 ? -1 : 0);

// ---------------------------------------------------------------------------------------------
// Search filters (RFC 4515): (&...), (|...), (!...), equality, presence, substrings, >=, <=, ~=.

function unescape(value) {
    return Buffer.from(value.replace(/\\([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('latin1');
}

export function parseFilter(text) {
    let at = 0;
    const fail = message => {
        throw new Error(`Invalid LDAP filter ${text}: ${message} at position ${at}.`);
    };
    const filter = () => {
        if (text[at] !== '(') fail('expected (');
        at++;
        let result;
        const op = text[at];
        if (op === '&' || op === '|') {
            at++;
            const parts = [];
            while (text[at] === '(') parts.push(filter());
            if (!parts.length) fail('an empty list');
            result = seq(op === '&' ? 0xa0 : 0xa1, ...parts);
        } else if (op === '!') {
            at++;
            result = seq(0xa2, filter());
        } else {
            const end = text.indexOf(')', at);
            if (end < 0) fail('expected )');
            const item = text.slice(at, end);
            const m = item.match(/^([A-Za-z0-9;.-]+)(=|>=|<=|~=)(.*)$/s);
            if (!m) fail(`an invalid item ${item}`);
            const [, attribute, operator, value] = m;
            if (operator === '=' && value === '*') {
                result = str(attribute, 0x87);
            } else if (operator === '=' && value.includes('*')) {
                const pieces = value.split('*');
                const subs = [];
                pieces.forEach((piece, i) => {
                    if (!piece) return;
                    const tag = i === 0 ? 0x80 : i === pieces.length - 1 ? 0x82 : 0x81;
                    subs.push(tlv(tag, Buffer.from(unescape(piece), 'latin1')));
                });
                result = seq(0xa4, str(attribute), seq(0x30, ...subs));
            } else {
                const tag = {'=': 0xa3, '>=': 0xa5, '<=': 0xa6, '~=': 0xa8}[operator];
                result = seq(tag, str(attribute), tlv(0x04, Buffer.from(unescape(value), 'latin1')));
            }
            at = end;
        }
        if (text[at] !== ')') fail('expected )');
        at++;
        return result;
    };
    const result = filter();
    if (at !== text.length) fail('trailing characters');
    return result;
}

// ---------------------------------------------------------------------------------------------
// The client.

const RESULT_NAMES = {0: 'success', 1: 'operationsError', 2: 'protocolError', 4: 'sizeLimitExceeded', 7: 'authMethodNotSupported', 8: 'strongerAuthRequired',
    32: 'noSuchObject', 34: 'invalidDNSyntax', 49: 'invalidCredentials', 50: 'insufficientAccessRights', 51: 'busy', 52: 'unavailable', 53: 'unwillingToPerform'};
const PAGED_RESULTS = '1.2.840.113556.1.4.319';
const START_TLS = '1.3.6.1.4.1.1466.20037';

export class LdapClient {
    /// `url`: ldaps://host[:636] or ldap://host[:389] with `starttls`. `ca`: PEM of the certificate authority (the
    /// system authorities are used without it). The certificate of the server is always checked.
    constructor({url, ca = null, starttls = false, timeout_ms = 30000}) {
        const u = new URL(url);
        if (!['ldaps:', 'ldap:'].includes(u.protocol)) throw new Error(`Not an LDAP URL: ${url}`);
        if (u.protocol === 'ldap:' && !starttls) throw new Error('An ldap:// URL needs StartTLS: the bind would send the password in clear. Use ldaps://, or StartTLS.');
        this.host = u.hostname;
        this.port = Number(u.port || (u.protocol === 'ldaps:' ? 636 : 389));
        this.ldaps = u.protocol === 'ldaps:';
        this.starttls = !this.ldaps;
        this.ca = ca;
        this.timeout_ms = timeout_ms;
        this.next_id = 1;
        this.pending = new Map();
        this.buffer = Buffer.alloc(0);
    }

    tlsOptions(socket) {
        return {host: this.host, servername: net.isIP(this.host) ? undefined : this.host, ca: this.ca || undefined, rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(socket ? {socket} : {})};
    }

    async connect() {
        const socket = await new Promise((resolve, reject) => {
            const s = this.ldaps ? tls.connect({port: this.port, ...this.tlsOptions()}, () => resolve(s)) : net.connect({host: this.host, port: this.port}, () => resolve(s));
            s.once('error', reject);
            s.setTimeout(this.timeout_ms, () => s.destroy(new Error(`The LDAP server ${this.host}:${this.port} did not answer within ${this.timeout_ms / 1000} s.`)));
        });
        this.attach(socket);
        if (this.starttls) {
            const response = await this.request(seq(0x77, str(START_TLS, 0x80)));
            this.checkResult(response, 'StartTLS');
            this.socket.removeAllListeners('data');
            this.socket = await new Promise((resolve, reject) => {
                const secure = tls.connect(this.tlsOptions(this.socket), () => resolve(secure));
                secure.once('error', reject);
            });
            this.attach(this.socket, true);
        }
    }

    attach(socket, upgraded = false) {
        this.socket = socket;
        if (!upgraded) this.buffer = Buffer.alloc(0);
        socket.on('data', chunk => this.receive(chunk));
        socket.on('error', e => this.failAll(e));
        socket.on('close', () => this.failAll(new Error('The LDAP server closed the connection.')));
    }

    failAll(error) {
        for (const {reject} of this.pending.values()) reject(error);
        this.pending.clear();
    }

    receive(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const message = read(this.buffer);
            if (!message) return;
            this.buffer = this.buffer.subarray(message.end);
            const [id, op, controls] = children(message.content);
            const waiting = this.pending.get(integer(id.content));
            if (waiting) waiting.on({tag: op.tag, content: op.content, controls});
        }
    }

    /// Sends one request; resolves with its final response, after `onEntry` saw each search entry.
    request(op, controls = null, onEntry = null) {
        const id = this.next_id++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {reject, on: response => {
                if (response.tag === 0x64) {
                    if (onEntry) onEntry(response);
                    return;
                }
                if (response.tag === 0x73) return; /// A referral to another server: not followed.
                this.pending.delete(id);
                resolve(response);
            }});
            this.socket.write(seq(0x30, int(id), op, ...(controls ? [controls] : [])));
        });
    }

    checkResult(response, what) {
        const [code, , message] = children(response.content);
        const value = integer(code.content);
        if (value !== 0) throw new Error(`LDAP ${what} failed: ${RESULT_NAMES[value] || `result ${value}`}${message && message.content.length ? `: ${message.content.toString('utf8')}` : ''}.`);
    }

    async bind(dn, password) {
        if (!password) throw new Error('An LDAP bind without a password is an anonymous bind: give the password of the service account.');
        this.checkResult(await this.request(seq(0x60, int(3), str(dn), str(password, 0x80))), 'bind');
    }

    /// Entries under `base` (subtree) that match `filter`, with `attributes`: [{dn, attributes: {name: [values]}}].
    /// Pages of `page_size`, so that servers with a size limit per search (Active Directory: 1000) return everything.
    async search(base, filter, attributes, page_size = 500) {
        const encoded = parseFilter(filter);
        const entries = [];
        let cookie = Buffer.alloc(0);
        do {
            const paging = seq(0xa0, seq(0x30, str(PAGED_RESULTS), bool(false), tlv(0x04, seq(0x30, int(page_size), tlv(0x04, cookie)))));
            const request = seq(0x63, str(base), int(2, 0x0a), int(0, 0x0a), int(0), int(this.timeout_ms / 1000), bool(false), encoded,
                seq(0x30, ...attributes.map(a => str(a))));
            const done = await this.request(request, paging, response => {
                const [dn, list] = children(response.content);
                const values = {};
                for (const attribute of children(list.content)) {
                    const [name, set] = children(attribute.content);
                    values[name.content.toString('utf8').toLowerCase()] = children(set.content).map(v => v.content.toString('utf8'));
                }
                entries.push({dn: dn.content.toString('utf8'), attributes: values});
            });
            this.checkResult(done, 'search');
            cookie = Buffer.alloc(0);
            if (done.controls) {
                for (const control of children(done.controls.content)) {
                    const [oid, ...rest] = children(control.content);
                    if (oid.content.toString() !== PAGED_RESULTS) continue;
                    const value = rest.find(r => r.tag === 0x04);
                    const [, next] = children(read(value.content).content);
                    cookie = Buffer.from(next.content);
                }
            }
        } while (cookie.length);
        return entries;
    }

    close() {
        if (!this.socket) return;
        try {
            this.socket.end(seq(0x30, int(this.next_id++), tlv(0x42, Buffer.alloc(0))));
        } catch (e) {
            /// Closing: an unbind that cannot be sent changes nothing.
        }
        this.socket.destroy();
    }
}
