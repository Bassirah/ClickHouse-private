#!/usr/bin/env node
/// Cluster agent of the web console (`/console`, Administration → Clusters).
///
/// The console records plans, desired configuration revisions, and operations in the console tables; a browser
/// cannot create containers or reach other servers. This agent, a long-running process on the infrastructure
/// host, does that:
/// - executes queued lifecycle operations with checkpoints, one at a time per cluster, after checking on the
///   server that the requester holds the capability (`EXECUTE AS <requester> CHECK GRANT`);
/// - provisions and changes clusters through a provider (implemented: `docker-compose`, a local lab);
/// - observes every registered cluster (nodes, replication, Keeper, configuration drift) and records what it
///   saw, so the console shows the last observation even when a cluster is unreachable.
///
/// It needs Node.js 18 or later and no packages; the `docker-compose` provider needs the `docker` CLI with
/// Compose v2. Configuration (environment variables):
///   CLICKHOUSE_URL, CLICKHOUSE_USER, CLICKHOUSE_PASSWORD   the server with the console tables (service account)
///   ADMIN_DATABASE               database of the console tables (default console_admin)
///   AGENT_ID                     name in heartbeats and claims (default: host name and process ID)
///   INTERVAL_SECONDS             time between cycles (default 10)
///   OBSERVE_SECONDS              time between observations of a cluster (default 30)
///   CLUSTER_AGENT_STATE_DIR      directory of the generated deployments (required for docker-compose)
///   CLUSTER_AGENT_ENVIRONMENTS   environments this agent may change, comma-separated (default lab,development)
///   CLUSTER_AGENT_PORT_RANGE     host ports for lab endpoints, bound to 127.0.0.1 (default 31000-31999)
///   CLUSTER_AGENT_IMAGES         image repositories allowed for lab containers (default clickhouse/clickhouse-server,
///                                contentsquareplatform/chproxy)
///   CLUSTER_AGENT_HOST_ALIAS     name of the host as seen from lab containers (default host.docker.internal)
///   <REF>_USER, <REF>_PASSWORD   credentials of a registered cluster whose credential reference is <REF>
///   <REF>_ACCESS_KEY_ID, <REF>_SECRET_ACCESS_KEY   credentials of an S3 backup destination
/// Arguments: --once runs one cycle and exits.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';

const URL_BASE = (process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123').replace(/\/+$/, '');
const USER = process.env.CLICKHOUSE_USER || 'default';
const PASSWORD = process.env.CLICKHOUSE_PASSWORD || '';
const DB = process.env.ADMIN_DATABASE || 'console_admin';
const AGENT_ID = process.env.AGENT_ID || `${os.hostname()}-${process.pid}`;
const INTERVAL = Number(process.env.INTERVAL_SECONDS || 10) * 1000;
const OBSERVE_INTERVAL = Number(process.env.OBSERVE_SECONDS || 30) * 1000;
const STATE_DIR = process.env.CLUSTER_AGENT_STATE_DIR || '';
const ENVIRONMENTS = (process.env.CLUSTER_AGENT_ENVIRONMENTS || 'lab,development').split(',').map(s => s.trim()).filter(Boolean);
const [PORT_MIN, PORT_MAX] = (process.env.CLUSTER_AGENT_PORT_RANGE || '31000-31999').split('-').map(Number);
const IMAGES = (process.env.CLUSTER_AGENT_IMAGES || 'clickhouse/clickhouse-server,contentsquareplatform/chproxy').split(',').map(s => s.trim()).filter(Boolean);
const HOST_ALIAS = process.env.CLUSTER_AGENT_HOST_ALIAS || 'host.docker.internal';
const ONCE = process.argv.includes('--once');
const LABEL_CLUSTER = 'io.clickhouse.console.cluster';
const LABEL_MANAGED = 'io.clickhouse.console.managed-by';
const MANAGED_BY = 'console-cluster-agent';

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(DB)) throw new Error(`Invalid ADMIN_DATABASE: ${DB}`);

function log(message, fields = {}) {
    console.log(JSON.stringify({time: new Date().toISOString(), agent: AGENT_ID, message, ...fields}));
}

// ---------------------------------------------------------------------------------------------
// ClickHouse

class QueryError extends Error {
    constructor(text, code) {
        super(text);
        this.code = code;
    }
}

/// Runs a query on a server. Returns the parsed JSON rows, or the text with `raw`.
async function httpQuery(base, user, password, sql, {params = {}, raw = false, settings = {}, timeout = 60000} = {}) {
    const url = new URL(`${base}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(`param_${k}`, v);
    for (const [k, v] of Object.entries(settings)) url.searchParams.set(k, v);
    let response;
    try {
        response = await fetch(url, {method: 'POST', body: raw ? sql : `${sql}\nFORMAT JSON`,
            headers: {'X-ClickHouse-User': user, 'X-ClickHouse-Key': password}, signal: AbortSignal.timeout(timeout)});
    } catch (e) {
        throw new QueryError(`${base} is unreachable: ${e.cause ? e.cause.code || e.cause.message : e.message}`, -1);
    }
    const text = await response.text();
    if (!response.ok) {
        const code = Number(response.headers.get('X-ClickHouse-Exception-Code') || (text.match(/Code: (\d+)/) || [])[1] || 0);
        throw new QueryError(maskSecrets(text.trim().split('\n')[0].slice(0, 600)), code);
    }
    return raw ? text : (text ? JSON.parse(text).data : []);
}

const query = (sql, options) => httpQuery(URL_BASE, USER, PASSWORD, sql, options);

const q = name => '`' + String(name).replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
const s = value => "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
const arrayParam = values => '[' + values.map(s).join(',') + ']';

function maskSecrets(text) {
    return String(text || '').replace(/\b(BY|HASH|SALT|PASSWORD|secret_access_key|access_key_id)(\s*=?\s*)'(?:[^'\\]|\\.)*'/gi, "$1$2'[HIDDEN]'")
        .replace(/S3\(([^,)]*),\s*'[^']*',\s*'[^']*'/gi, "S3($1, '[HIDDEN]', '[HIDDEN]'");
}

function parseJSON(text, fallback) {
    try {
        return text ? JSON.parse(text) : fallback;
    } catch (e) {
        return fallback;
    }
}

async function recordEvent(op_id, cluster_id, kind, fields = {}) {
    const row = {op_id, cluster_id, kind, state: fields.state || '', step: fields.step || '', message: maskSecrets(fields.message || ''), data: JSON.stringify(fields.data || {})};
    await query(`INSERT INTO ${q(DB)}.cluster_events (op_id, cluster_id, kind, state, step, message, data) FORMAT JSONEachRow\n${JSON.stringify(row)}`, {raw: true});
}

async function recordRevision(cluster_id, revision, spec, source, note) {
    const row = {cluster_id, revision, spec: JSON.stringify(spec), source, note};
    await query(`INSERT INTO ${q(DB)}.cluster_revisions (cluster_id, revision, spec, source, note) FORMAT JSONEachRow\n${JSON.stringify(row)}`, {raw: true});
}

async function recordResource(cluster_id, resource) {
    const row = {cluster_id, resource_id: resource.resource_id, kind: resource.kind, name: resource.name, owner_op: resource.owner_op || '',
        disposition: resource.disposition, retention_until: resource.retention_until || null, evidence: resource.evidence || ''};
    await query(`INSERT INTO ${q(DB)}.cluster_resources (cluster_id, resource_id, kind, name, owner_op, disposition, retention_until, evidence) FORMAT JSONEachRow\n${JSON.stringify(row)}`, {raw: true});
}

async function audit(action, cluster, summary, result, error, correlation_id, details = {}) {
    const row = {correlation_id, scope: 'local', target_type: 'cluster', target_name: cluster ? cluster.name : '', action, summary, result,
        error: maskSecrets(error || ''), details: JSON.stringify({agent: AGENT_ID, cluster_id: cluster ? cluster.cluster_id : '', ...details})};
    await query(`INSERT INTO ${q(DB)}.audit_log (correlation_id, scope, target_type, target_name, action, summary, result, error, details) FORMAT JSONEachRow\n${JSON.stringify(row)}`, {raw: true});
}

// ---------------------------------------------------------------------------------------------
// State

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'rejected'];

/// Capability (a column of `cluster_capabilities`, granted as `INSERT(<column>)`) required by each operation.
const CAPABILITY = {
    register: 'register', provision: 'create_cluster', adopt: 'adopt', release: 'adopt', configure: 'configure', reconcile: 'configure',
    resize: 'scale', add_replica: 'scale', add_shard: 'scale', remove_shard: 'scale', remove_replica: 'decommission',
    restart_node: 'maintain', backup: 'maintain', upgrade: 'upgrade', keeper_change: 'keeper', retire: 'retire', destroy: 'destroy',
};

/// Operations that change a deployment, and therefore need the Manage mode, a provider that implements them,
/// and an environment this agent may change.
const MUTATING = new Set(['provision', 'configure', 'reconcile', 'resize', 'add_replica', 'add_shard', 'remove_shard', 'remove_replica',
    'restart_node', 'backup', 'upgrade', 'keeper_change', 'retire', 'destroy']);

async function loadState() {
    const [clusters, revisions, operations] = await Promise.all([
        query(`SELECT cluster_id, name, environment, owner, description, toString(provider) AS provider, connection, deleted
            FROM ${q(DB)}.clusters FINAL WHERE NOT deleted`),
        query(`SELECT cluster_id, revision, spec, toString(source) AS source FROM ${q(DB)}.cluster_revisions ORDER BY cluster_id, revision DESC LIMIT 1 BY cluster_id`),
        query(`SELECT op_id, cluster_id, kind, revision, parameters, requested_by, toUnixTimestamp64Milli(requested_at) AS requested_ms
            FROM ${q(DB)}.cluster_operations ORDER BY requested_at`),
    ]);
    const events = await query(`SELECT op_id, cluster_id, kind, state, step, message, data, recorded_by, toUnixTimestamp64Milli(at) AS at_ms
        FROM ${q(DB)}.cluster_events WHERE kind != 'heartbeat' ORDER BY at`);
    const by_cluster = new Map(clusters.map(c => [c.cluster_id, {...c, connection: parseJSON(c.connection, {}), spec: null, revision: 0,
        lifecycle: 'planned', mode: 'observe', ops: [], drift_key: ''}]));
    for (const r of revisions) {
        const c = by_cluster.get(r.cluster_id);
        if (c) {
            c.spec = parseJSON(r.spec, null);
            c.revision = Number(r.revision);
        }
    }
    const ops = new Map(operations.map(o => [o.op_id, {...o, revision: Number(o.revision), parameters: parseJSON(o.parameters, {}), requested_ms: Number(o.requested_ms),
        state: 'queued', state_ms: 0, claims: [], steps: new Map(), step_results: new Map(), attempts: new Map(), cancel_requested: false, retry_ms: 0,
        last_ms: Number(o.requested_ms)}]));
    for (const e of events) {
        const c = by_cluster.get(e.cluster_id);
        if (c && e.kind === 'lifecycle') c.lifecycle = e.state;
        if (c && e.kind === 'mode') c.mode = e.state;
        if (c && e.kind === 'drift') c.drift_key = e.message;
        const op = ops.get(e.op_id);
        if (!op) continue;
        op.last_ms = Number(e.at_ms);
        if (e.kind === 'state') {
            op.state = e.state;
            op.state_ms = Number(e.at_ms);
        } else if (e.kind === 'claim') {
            const claim = parseJSON(e.data, {});
            op.claims.push({agent: claim.agent, generation: Number(claim.generation || 0), at: Number(e.at_ms)});
        } else if (e.kind === 'step') {
            op.steps.set(e.step, e.state);
            if (e.state === 'done') op.step_results.set(e.step, parseJSON(e.data, {}));
            if (e.state === 'running') op.attempts.set(e.step, (op.attempts.get(e.step) || 0) + 1);
        } else if (e.kind === 'request' && e.state === 'cancel') {
            op.cancel_requested = true;
        } else if (e.kind === 'request' && e.state === 'retry') {
            /// An operator retries a blocked operation: the attempts of its steps count again from zero.
            op.retry_ms = Number(e.at_ms);
            op.attempts.clear();
        }
    }
    for (const op of ops.values()) {
        const c = by_cluster.get(op.cluster_id);
        if (c) c.ops.push(op);
    }
    return {clusters: [...by_cluster.values()], by_cluster, ops: [...ops.values()]};
}

// ---------------------------------------------------------------------------------------------
// Shell commands: only `docker` with argument arrays, never a shell and never text from the browser as a command.

function run(command, args, {timeout = 300000, cwd} = {}) {
    return new Promise((resolve, reject) => {
        execFile(command, args, {timeout, cwd, maxBuffer: 32 * 1024 * 1024}, (error, stdout, stderr) => {
            if (error) {
                const e = new Error(`${command} ${args.slice(0, 4).join(' ')}: ${(stderr || error.message).trim().split('\n').slice(-3).join(' ')}`);
                e.timed_out = error.killed && error.signal === 'SIGTERM';
                reject(e);
            } else {
                resolve(stdout);
            }
        });
    });
}

// ---------------------------------------------------------------------------------------------
// Provider: docker-compose (a local lab on one Docker host)

const docker = {
    name: 'docker-compose',
    /// What this provider implements; the console shows the same list.
    operations: ['provision', 'configure', 'reconcile', 'resize', 'add_replica', 'add_shard', 'remove_shard', 'remove_replica', 'restart_node',
        'backup', 'upgrade', 'retire', 'destroy', 'release'],

    project: cluster => `chc-${cluster.cluster_id.replace(/-/g, '').slice(0, 10)}`,
    dir: cluster => {
        if (!STATE_DIR) throw new Error('CLUSTER_AGENT_STATE_DIR is not set: the docker-compose provider needs a directory for the deployments.');
        return path.join(STATE_DIR, docker.project(cluster));
    },
    compose: (cluster, args, options = {}) => run('docker', ['compose', '-p', docker.project(cluster), '-f', path.join(docker.dir(cluster), 'compose.yaml'), ...args], options),

    /// Secrets are generated once on this host, readable by its owner only, and passed to the containers as
    /// environment variables: the generated configuration refers to them with `from_env`.
    secrets(cluster, {create = true} = {}) {
        const file = path.join(docker.dir(cluster), 'secrets.env');
        if (!fs.existsSync(file)) {
            /// Only provisioning creates them: observing a deployment that was never generated must not create anything.
            if (!create) throw new QueryError(`The deployment of ${cluster.name} has not been generated on this agent host.`, -1);
            fs.mkdirSync(docker.dir(cluster), {recursive: true, mode: 0o700});
            fs.writeFileSync(file, '', {mode: 0o600});
        }
        const read = () => Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
            .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
        const secrets = read();
        /// CH_PROXY_PASSWORD is the password of the clients of chproxy; deployments made before it get it when rendered.
        const missing = ['CH_ADMIN_PASSWORD', 'CH_CLUSTER_SECRET', 'CH_INTERSERVER_PASSWORD', 'CH_PROXY_PASSWORD'].filter(k => !secrets[k]);
        if (missing.length && create) {
            fs.appendFileSync(file, missing.map(k => `${k}=${crypto.randomBytes(18).toString('base64url')}\n`).join(''));
            return read();
        }
        return secrets;
    },

    nodes: spec => spec.shards.flatMap(shard => shard.replicas.filter(r => r.state !== 'removed').map(r => ({...r, shard: shard.index}))),

    endpoint: node => `http://127.0.0.1:${node.http_port}`,

    async connect(cluster, node) {
        const secrets = docker.secrets(cluster, {create: false});
        return (sql, options) => httpQuery(docker.endpoint(node), cluster.spec.security.admin_user, secrets.CH_ADMIN_PASSWORD, sql, options);
    },

    /// Host ports bound to 127.0.0.1 for every node that does not have one yet. Taken from the range, skipping
    /// ports in use on this host and ports of other lab deployments.
    async assignPorts(clusters, cluster, spec) {
        const used = new Set();
        for (const other of clusters) {
            /// Only deployments of this provider have host ports; registered ones have a discovered description.
            if (other.provider !== 'docker-compose' || !other.spec || !other.spec.shards || other.cluster_id === cluster.cluster_id) continue;
            for (const n of [...docker.nodes(other.spec), ...other.spec.keeper.members]) for (const p of [n.http_port, n.native_port, n.client_port]) if (p) used.add(p);
            if (docker.chproxy(other.spec) && other.spec.routing.port) used.add(other.spec.routing.port);
        }
        if (docker.chproxy(spec) && spec.routing.port) used.add(spec.routing.port);
        for (const n of [...docker.nodes(spec), ...spec.keeper.members]) for (const p of [n.http_port, n.native_port, n.client_port]) if (p) used.add(p);
        const free = async port => !used.has(port) && await new Promise(resolve => {
            const server = net.createServer().once('error', () => resolve(false)).once('listening', () => server.close(() => resolve(true)));
            server.listen(port, '127.0.0.1');
        });
        let next = PORT_MIN;
        const take = async () => {
            while (next <= PORT_MAX) {
                const port = next++;
                if (await free(port)) {
                    used.add(port);
                    return port;
                }
            }
            throw new Error(`No free port left in ${PORT_MIN}-${PORT_MAX} (CLUSTER_AGENT_PORT_RANGE).`);
        };
        let changed = false;
        for (const shard of spec.shards) {
            for (const r of shard.replicas) {
                if (!r.http_port) { r.http_port = await take(); changed = true; }
                if (!r.native_port) { r.native_port = await take(); changed = true; }
            }
        }
        for (const k of spec.keeper.members) if (!k.client_port) { k.client_port = await take(); changed = true; }
        if (docker.chproxy(spec) && !spec.routing.port) { spec.routing.port = await take(); changed = true; }
        return changed;
    },

    /// Writes the compose file and the configuration of every node. Deterministic: the same specification
    /// gives the same files, so writing them again is harmless. Returns the hashes of the managed files.
    /// `exclude`: nodes left out of the routing of chproxy (while they are restarted or removed).
    render(cluster, spec, {exclude = []} = {}) {
        const dir = docker.dir(cluster);
        fs.mkdirSync(dir, {recursive: true, mode: 0o700});
        docker.secrets(cluster);
        const nodes = docker.nodes(spec);
        const keeper = spec.keeper.members;
        const labels = `{${LABEL_CLUSTER}: "${cluster.cluster_id}", ${LABEL_MANAGED}: "${MANAGED_BY}"}`;
        const remote = `<remote_servers replace="true"><${spec.cluster_name}><secret from_env="CH_CLUSTER_SECRET"/>${spec.shards.map(shard => {
            const replicas = shard.replicas.filter(r => r.state !== 'removed');
            return replicas.length ? `<shard><internal_replication>true</internal_replication>${replicas.map(r => `<replica><host>${r.name}</host><port>9000</port></replica>`).join('')}</shard>` : '';
        }).join('')}</${spec.cluster_name}></remote_servers>`;
        const zookeeper = `<zookeeper>${keeper.map(k => `<node><host>${k.name}</host><port>9181</port></node>`).join('')}</zookeeper>`;
        const files = {};
        const write = (relative, text) => {
            const file = path.join(dir, relative);
            fs.mkdirSync(path.dirname(file), {recursive: true});
            fs.writeFileSync(file, text);
            files[relative] = crypto.createHash('sha256').update(text).digest('hex');
        };
        for (const k of keeper) {
            write(`${k.name}/keeper.xml`, `<clickhouse>
    <listen_host>0.0.0.0</listen_host>
    <logger><level>information</level><console>1</console></logger>
    <keeper_server>
        <tcp_port>9181</tcp_port>
        <server_id>${k.server_id}</server_id>
        <log_storage_path>/var/lib/clickhouse-keeper/log</log_storage_path>
        <snapshot_storage_path>/var/lib/clickhouse-keeper/snapshots</snapshot_storage_path>
        <four_letter_word_white_list>conf,cons,envi,ruok,srvr,stat,wchs,dirs,mntr,isro,apiv,lgif</four_letter_word_white_list>
        <raft_configuration>
${keeper.map(m => `            <server><id>${m.server_id}</id><hostname>${m.name}</hostname><port>9234</port></server>`).join('\n')}
        </raft_configuration>
    </keeper_server>
</clickhouse>
`);
        }
        const server_settings = Object.entries((spec.settings || {}).server || {}).map(([k, v]) => `    <${k}>${v}</${k}>`).join('\n');
        const profile_settings = Object.entries((spec.settings || {}).profile || {}).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
        for (const n of nodes) {
            write(`${n.name}/console-cluster.xml`, `<clickhouse>
    <listen_host>0.0.0.0</listen_host>
    <macros><cluster>${spec.cluster_name}</cluster><shard>${String(n.shard).padStart(2, '0')}</shard><replica>${n.name}</replica></macros>
    ${remote}
    ${zookeeper}
    <interserver_http_host>${n.name}</interserver_http_host>
    <interserver_http_credentials><user>interserver</user><password from_env="CH_INTERSERVER_PASSWORD"/></interserver_http_credentials>
    <distributed_ddl><path>/clickhouse/task_queue/ddl</path></distributed_ddl>
</clickhouse>
`);
            write(`${n.name}/console-settings.xml`, `<clickhouse>\n${server_settings}\n</clickhouse>\n`);
            write(`${n.name}/console-users.xml`, `<clickhouse>
    <profiles><default>${profile_settings}</default></profiles>
    <users>
        <default remove="remove"/>
        <${spec.security.admin_user}>
            <password from_env="CH_ADMIN_PASSWORD"/>
            <networks><ip>::/0</ip></networks>
            <profile>default</profile><quota>default</quota>
            <access_management>1</access_management>
            <named_collection_control>1</named_collection_control>
        </${spec.security.admin_user}>
    </users>
</clickhouse>
`);
        }
        const resources = spec.resources || {};
        const limits = `${resources.cpus ? `\n    cpus: ${Number(resources.cpus)}` : ''}${resources.memory_mb ? `\n    mem_limit: ${Number(resources.memory_mb)}m` : ''}`;
        const services = [
            ...keeper.map(k => `  ${k.name}:
    image: ${spec.keeper.image || spec.image}
    hostname: ${k.name}
    entrypoint: ["clickhouse", "keeper", "--config-file=/etc/clickhouse-keeper/keeper.xml"]
    volumes: ["./${k.name}/keeper.xml:/etc/clickhouse-keeper/keeper.xml:ro", "${k.name}-data:/var/lib/clickhouse-keeper"]
    ports: ["127.0.0.1:${k.client_port}:9181"]
    labels: ${labels}
    restart: unless-stopped`),
            ...nodes.map(n => `  ${n.name}:
    image: ${n.image || spec.image}
    hostname: ${n.name}
    env_file: secrets.env
    volumes: ["./${n.name}/console-cluster.xml:/etc/clickhouse-server/config.d/console-cluster.xml:ro",
      "./${n.name}/console-settings.xml:/etc/clickhouse-server/config.d/console-settings.xml:ro",
      "./${n.name}/console-users.xml:/etc/clickhouse-server/users.d/console-users.xml:ro", "${n.name}-data:/var/lib/clickhouse"]
    ports: ["127.0.0.1:${n.http_port}:8123", "127.0.0.1:${n.native_port}:9000"]
    ulimits: {nofile: {soft: 262144, hard: 262144}}
    extra_hosts: ["${HOST_ALIAS}:host-gateway"]
    labels: ${labels}
    restart: unless-stopped${limits}`),
        ];
        if (docker.chproxy(spec)) {
            const r = spec.routing;
            const routed = nodes.filter(n => !exclude.includes(n.name));
            /// Passwords come from the environment (chproxy expands ${VAR}): the file holds no secret.
            write('chproxy/config.yml', `# Generated by the cluster agent of the ClickHouse web console. Do not edit.
server:
  http:
    listen_addr: ":9090"
    allowed_networks: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
users:
  - name: "${r.user}"
    password: "\${CH_PROXY_PASSWORD}"
    to_cluster: "${spec.cluster_name}"
    to_user: "${spec.security.admin_user}"
    max_concurrent_queries: ${Number(r.max_concurrent_queries)}
    max_execution_time: ${Number(r.max_execution_time_s)}s
clusters:
  - name: "${spec.cluster_name}"
    nodes: [${routed.map(n => `"${n.name}:8123"`).join(', ')}]
    heartbeat:
      interval: 5s
      timeout: 3s
    users:
      - name: "${spec.security.admin_user}"
        password: "\${CH_ADMIN_PASSWORD}"
`);
            services.push(`  chproxy:
    image: ${r.image}
    hostname: chproxy
    command: ["-config", "/etc/chproxy/config.yml"]
    env_file: secrets.env
    volumes: ["./chproxy/config.yml:/etc/chproxy/config.yml:ro"]
    ports: ["127.0.0.1:${r.port}:9090"]
    labels: ${labels}
    restart: unless-stopped`);
        }
        const volumes = [...keeper.map(k => k.name), ...nodes.map(n => n.name)].map(name => `  ${name}-data: {labels: ${labels}}`);
        write('compose.yaml', `# Generated by the cluster agent of the ClickHouse web console for cluster ${cluster.cluster_id}. Do not edit:\n# the agent writes it again from the desired configuration and reports changes made here as drift.\nname: ${docker.project(cluster)}\nservices:\n${services.join('\n')}\nvolumes:\n${volumes.join('\n')}\nnetworks:\n  default:\n    labels: ${labels}\n`);
        fs.writeFileSync(path.join(dir, '.console-hashes.json'), JSON.stringify(files, null, 1));
        return files;
    },

    /// The server settings that the last successful configuration applied, to tell what a new revision changes.
    appliedSettings(cluster) {
        const file = path.join(docker.dir(cluster), '.console-applied-settings.json');
        return fs.existsSync(file) ? parseJSON(fs.readFileSync(file, 'utf8'), {}) : {};
    },
    saveAppliedSettings(cluster, settings) {
        fs.writeFileSync(path.join(docker.dir(cluster), '.console-applied-settings.json'), JSON.stringify(settings));
    },

    /// Managed files changed on disk since the agent wrote them.
    changedFiles(cluster) {
        const dir = docker.dir(cluster);
        const hashes = parseJSON(fs.existsSync(path.join(dir, '.console-hashes.json')) ? fs.readFileSync(path.join(dir, '.console-hashes.json'), 'utf8') : '', {});
        return Object.entries(hashes).filter(([relative, hash]) => {
            const file = path.join(dir, relative);
            return !fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash;
        }).map(([relative]) => relative);
    },

    /// Containers of the deployment as Docker reports them: `{service: {state, status, image, id}}`.
    async containers(cluster) {
        const out = await run('docker', ['ps', '-a', '--filter', `label=${LABEL_CLUSTER}=${cluster.cluster_id}`, '--format', '{{json .}}'], {timeout: 30000});
        const result = {};
        for (const line of out.trim().split('\n').filter(Boolean)) {
            const c = JSON.parse(line);
            const labels = Object.fromEntries((c.Labels || '').split(',').map(kv => kv.split('=')));
            result[labels['com.docker.compose.service']] = {state: c.State, status: c.Status, image: c.Image, id: c.ID, name: c.Names};
        }
        return result;
    },

    /// Docker objects with the labels of this cluster: the only objects this provider may stop or delete.
    async owned(cluster) {
        const filter = ['--filter', `label=${LABEL_CLUSTER}=${cluster.cluster_id}`, '--filter', `label=${LABEL_MANAGED}=${MANAGED_BY}`];
        const [containers, volumes, networks] = await Promise.all([
            run('docker', ['ps', '-a', ...filter, '--format', '{{.Names}}'], {timeout: 30000}),
            run('docker', ['volume', 'ls', ...filter, '--format', '{{.Name}}'], {timeout: 30000}),
            run('docker', ['network', 'ls', ...filter, '--format', '{{.Name}}'], {timeout: 30000}),
        ]);
        const list = text => text.trim().split('\n').filter(Boolean);
        return [...list(containers).map(name => ({kind: 'container', name})), ...list(volumes).map(name => ({kind: 'volume', name})),
            ...list(networks).map(name => ({kind: 'network', name}))];
    },

    /// Stops or removes the container of a node by name, after checking that Docker labels it as this cluster's. Works
    /// also when the node is no longer in the compose file. A container that does not exist counts as done.
    async container(cluster, name, action) {
        const container = `${docker.project(cluster)}-${name}-1`;
        const owned = await docker.owned(cluster);
        if (!owned.some(r => r.kind === 'container' && r.name === container)) return {container, note: 'no such container of this cluster'};
        await run('docker', action === 'remove' ? ['rm', '-f', container] : ['stop', container], {timeout: 300000});
        return {container, [action === 'remove' ? 'removed' : 'stopped']: true};
    },

    chproxy: spec => !!(spec && spec.routing && spec.routing.kind === 'chproxy'),

    /// Writes the routing of chproxy without the excluded nodes and makes it reload its configuration (SIGHUP).
    async route(cluster, exclude = []) {
        if (!docker.chproxy(cluster.spec)) return null;
        docker.render(cluster, cluster.spec, {exclude});
        await docker.compose(cluster, ['kill', '-s', 'SIGHUP', 'chproxy'], {timeout: 60000});
        const routed = docker.nodes(cluster.spec).map(n => n.name).filter(n => !exclude.includes(n));
        /// The reload is effective when chproxy reports exactly the routed nodes.
        await waitFor('chproxy to route to the expected nodes', async () => {
            const health = await docker.routingHealth(cluster);
            const seen = Object.keys(health.nodes).sort();
            return JSON.stringify(seen) === JSON.stringify([...routed].sort());
        }, 60000);
        return {routed, excluded: exclude};
    },

    /// The backend nodes of chproxy and whether its heartbeat finds them healthy, from its /metrics.
    async routingHealth(cluster) {
        const response = await fetch(`http://127.0.0.1:${cluster.spec.routing.port}/metrics`, {signal: AbortSignal.timeout(5000)})
            .catch(e => { throw new QueryError(`chproxy is unreachable: ${e.cause ? e.cause.code || e.cause.message : e.message}`, -1); });
        const text = await response.text();
        const nodes = {};
        for (const m of text.matchAll(/^host_health\{[^}]*cluster_node="([^":]+):\d+"[^}]*\} (\d+)/gm)) nodes[m[1]] = Number(m[2]);
        return {nodes};
    },

    /// A query through chproxy, as a client of the proxy.
    async proxyQuery(cluster, sql) {
        const secrets = docker.secrets(cluster, {create: false});
        return httpQuery(`http://127.0.0.1:${cluster.spec.routing.port}`, cluster.spec.routing.user, secrets.CH_PROXY_PASSWORD, sql, {timeout: 10000});
    },

    async recordOwned(cluster, op, disposition = 'present') {
        const owned = await docker.owned(cluster);
        for (const r of owned) {
            await recordResource(cluster.cluster_id, {resource_id: `${r.kind}:${r.name}`, kind: r.kind, name: r.name, owner_op: op ? op.op_id : '', disposition,
                evidence: `docker reports it with label ${LABEL_CLUSTER}=${cluster.cluster_id}`});
        }
        await recordResource(cluster.cluster_id, {resource_id: `directory:${docker.project(cluster)}`, kind: 'directory', name: docker.dir(cluster),
            owner_op: op ? op.op_id : '', disposition: fs.existsSync(docker.dir(cluster)) ? 'present' : 'deleted',
            evidence: 'generated configuration and the secrets file of the deployment, on the agent host'});
        return owned;
    },
};

const PROVIDERS = {'docker-compose': docker};

// ---------------------------------------------------------------------------------------------
// Observation

/// One round trip per node: availability, versions, replication, capacity, and background work.
const NODE_HEALTH_SQL = `SELECT version() AS version, uptime() AS uptime, hostName() AS host,
    (SELECT count() FROM system.replicas WHERE is_readonly) AS readonly_replicas,
    (SELECT count() FROM system.replicas) AS replicated_tables,
    (SELECT max(absolute_delay) FROM system.replicas) AS max_replication_delay,
    (SELECT sum(queue_size) FROM system.replicas) AS replication_queue,
    (SELECT count() FROM system.merges) AS merges,
    (SELECT count() FROM system.mutations WHERE NOT is_done) AS unfinished_mutations,
    (SELECT sum(data_files) FROM system.distribution_queue) AS distribution_files,
    (SELECT sum(free_space) FROM system.disks) AS disk_free,
    (SELECT sum(total_space) FROM system.disks) AS disk_total,
    (SELECT value FROM system.metrics WHERE metric = 'MemoryTracking') AS memory_used,
    (SELECT value FROM system.asynchronous_metrics WHERE metric = 'OSMemoryTotal') AS memory_total,
    (SELECT value FROM system.asynchronous_metrics WHERE metric = 'LoadAverage1') AS load_1m,
    (SELECT count() FROM system.processes) AS running_queries,
    (SELECT value FROM system.events WHERE event = 'Query') AS queries_total,
    (SELECT value FROM system.events WHERE event = 'FailedQuery') AS failed_queries_total,
    (SELECT count() FROM system.zookeeper_connection WHERE NOT is_expired) AS keeper_sessions,
    (SELECT max(modification_time) FROM system.parts WHERE active) AS last_part_time`;

/// Keeper's `mntr` four-letter command over TCP. Returns the fields, or throws when the member does not answer.
function keeperMntr(host, port, timeout = 3000) {
    return new Promise((resolve, reject) => {
        const socket = net.connect({host, port});
        let data = '';
        const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no answer from ${host}:${port} within ${timeout / 1000} s`)); }, timeout);
        socket.on('connect', () => socket.write('mntr'));
        socket.on('data', chunk => { data += chunk; });
        socket.on('error', e => { clearTimeout(timer); reject(new Error(`${host}:${port}: ${e.code || e.message}`)); });
        socket.on('close', () => {
            clearTimeout(timer);
            if (!data) reject(new Error(`${host}:${port} closed the connection without an answer`));
            else resolve(Object.fromEntries(data.trim().split('\n').map(line => line.split('\t'))));
        });
    });
}

/// Connection functions for each node of a cluster: from the provider for managed deployments, from the
/// registered endpoints and the credential reference for others.
async function nodeConnections(cluster) {
    if (cluster.provider === 'docker-compose' && cluster.spec && cluster.spec.shards) {
        return Promise.all(docker.nodes(cluster.spec).map(async n => ({node_id: n.node_id, name: n.name, shard: n.shard, endpoint: docker.endpoint(n),
            query: await docker.connect(cluster, n)})));
    }
    const ref = cluster.connection.credential_ref;
    const user = process.env[`${ref}_USER`];
    const password = process.env[`${ref}_PASSWORD`];
    if (!ref || user === undefined) throw new Error(`The credential reference ${ref || '(none)'} is not set on the agent host (${ref}_USER, ${ref}_PASSWORD).`);
    return (cluster.connection.endpoints || []).map((endpoint, i) => ({node_id: `endpoint-${i + 1}`, name: endpoint, shard: null, endpoint,
        query: (sql, options) => httpQuery(endpoint, user, password || '', sql, options)}));
}

async function observe(state, cluster) {
    const nodes = await nodeConnections(cluster);
    const containers = cluster.provider === 'docker-compose' ? await docker.containers(cluster).catch(e => ({error: e.message})) : null;
    const rows = [];
    for (const n of nodes) {
        let status;
        let data;
        try {
            const [health] = await n.query(NODE_HEALTH_SQL, {timeout: 5000});
            status = 'ok';
            data = {endpoint: n.endpoint, ...health};
        } catch (e) {
            const container = containers && !containers.error ? containers[n.name] : null;
            /// Only the provider can confirm a failure: a container that is not running. Without that evidence an
            /// unanswered node is unreachable, which may be a network problem rather than a failed server. A node that
            /// answers with an error is reachable, but its health is unknown.
            if (e.code !== -1) status = 'unknown';
            else if (containers && !containers.error && (!container || container.state !== 'running')) status = 'failed';
            else status = 'unreachable';
            data = {endpoint: n.endpoint, error: e.message, container: container ? `${container.state}: ${container.status}` : (containers && !containers.error ? 'no container' : 'not managed')};
        }
        rows.push({cluster_id: cluster.cluster_id, node_id: n.node_id, role: 'clickhouse', status, data: JSON.stringify({name: n.name, shard: n.shard, ...data})});
    }
    if (cluster.provider === 'docker-compose' && cluster.spec) {
        for (const k of cluster.spec.keeper.members) {
            try {
                const m = await keeperMntr('127.0.0.1', k.client_port);
                rows.push({cluster_id: cluster.cluster_id, node_id: k.node_id, role: 'keeper', status: 'ok', data: JSON.stringify({name: k.name, server_state: m.zk_server_state,
                    version: m.zk_version, followers: Number(m.zk_followers || 0), synced_followers: Number(m.zk_synced_followers || 0),
                    znodes: Number(m.zk_znode_count || 0), outstanding_requests: Number(m.zk_outstanding_requests || 0), latency_avg: Number(m.zk_avg_latency || 0)})});
            } catch (e) {
                const container = containers && !containers.error ? containers[k.name] : null;
                rows.push({cluster_id: cluster.cluster_id, node_id: k.node_id, role: 'keeper', status: container && container.state !== 'running' ? 'failed' : 'unreachable',
                    data: JSON.stringify({name: k.name, error: e.message, container: container ? `${container.state}: ${container.status}` : 'no container'})});
            }
        }
    }
    if (cluster.provider === 'docker-compose' && docker.chproxy(cluster.spec) && cluster.spec.routing.port) {
        try {
            const health = await docker.routingHealth(cluster);
            rows.push({cluster_id: cluster.cluster_id, node_id: 'chproxy', role: 'proxy', status: 'ok', data: JSON.stringify({name: 'chproxy',
                endpoint: `http://127.0.0.1:${cluster.spec.routing.port}`, nodes: health.nodes,
                healthy: Object.values(health.nodes).filter(v => v === 1).length, routed: Object.keys(health.nodes).length})});
        } catch (e) {
            const container = containers && !containers.error ? containers.chproxy : null;
            rows.push({cluster_id: cluster.cluster_id, node_id: 'chproxy', role: 'proxy', status: containers && !containers.error && (!container || container.state !== 'running') ? 'failed' : 'unreachable',
                data: JSON.stringify({name: 'chproxy', error: e.message, container: container ? `${container.state}: ${container.status}` : 'no container'})});
        }
    }
    await query(`INSERT INTO ${q(DB)}.cluster_observations (cluster_id, node_id, role, status, data) FORMAT JSONEachRow\n${rows.map(r => JSON.stringify(r)).join('\n')}`, {raw: true});

    /// The health of the deployment from all its members, never from one node.
    const ch = rows.filter(r => r.role === 'clickhouse');
    const keepers = rows.filter(r => r.role === 'keeper');
    const readonly = ch.some(r => Number(parseJSON(r.data, {}).readonly_replicas || 0) > 0);
    let health;
    if (ch.length && ch.every(r => r.status !== 'ok')) health = 'unreachable';
    else if (ch.every(r => r.status === 'ok') && keepers.every(r => r.status === 'ok') && rows.filter(r => r.role === 'proxy').every(r => r.status === 'ok') && !readonly) health = 'ready';
    else health = 'degraded';
    /// Maintenance ends by observation once no operation of the cluster is in progress (for example after a failed one).
    const busy = state.ops.some(o => o.cluster_id === cluster.cluster_id && !TERMINAL.includes(o.state));
    const observable = ['ready', 'degraded', 'unreachable'].includes(cluster.lifecycle) || (cluster.lifecycle === 'maintenance' && !busy);
    if (observable && health !== cluster.lifecycle) {
        await recordEvent('', cluster.cluster_id, 'lifecycle', {state: health, message: `observed: ${ch.filter(r => r.status === 'ok').length}/${ch.length} ClickHouse nodes, `
            + `${keepers.filter(r => r.status === 'ok').length}/${keepers.length} Keeper members answer${rows.some(r => r.role === 'proxy' && r.status !== 'ok') ? '; chproxy does not answer' : ''}${readonly ? '; read-only replicas' : ''}`});
        cluster.lifecycle = health;
    }
    if (cluster.provider === 'docker-compose' && cluster.mode === 'manage') await detectDrift(cluster, nodes);
}

/// Differences between the desired configuration and what the nodes report, and managed files edited by hand.
async function detectDrift(cluster, nodes) {
    const items = [];
    const desired = (cluster.spec.settings || {}).server || {};
    const names = Object.keys(desired);
    for (const n of nodes) {
        try {
            if (names.length) {
                const rows = await n.query(`SELECT name, value FROM system.server_settings WHERE name IN {names:Array(String)}`, {params: {names: arrayParam(names)}, timeout: 5000});
                for (const r of rows) if (String(desired[r.name]) !== r.value) items.push({node: n.name, setting: r.name, desired: String(desired[r.name]), observed: r.value});
            }
            for (const [name, value] of Object.entries((cluster.spec.settings || {}).profile || {})) {
                const [r] = await n.query(`SELECT toString(getSetting({name:String})) AS value`, {params: {name}, timeout: 5000});
                if (r.value !== String(value)) items.push({node: n.name, setting: name, desired: String(value), observed: r.value, scope: 'profile'});
            }
            const [v] = await n.query('SELECT version() AS version', {timeout: 5000});
            const node = docker.nodes(cluster.spec).find(x => x.name === n.name);
            const want = ((node && node.image) || cluster.spec.image).split(':').pop();
            if (want && /^\d+\.\d+/.test(want) && !v.version.startsWith(want)) items.push({node: n.name, setting: 'version', desired: want, observed: v.version});
        } catch (e) {
            /// An unreachable node is reported by the observation, not as drift.
        }
    }
    const files = docker.changedFiles(cluster);
    const key = crypto.createHash('sha256').update(JSON.stringify({items, files})).digest('hex').slice(0, 16);
    if (key !== cluster.drift_key) {
        await recordEvent('', cluster.cluster_id, 'drift', {state: items.length || files.length ? 'drift' : 'in_sync', message: key, data: {items, files, revision: cluster.revision}});
        cluster.drift_key = key;
    }
}

// ---------------------------------------------------------------------------------------------
// Operations

class Rejected extends Error {}
class Blocked extends Error {}
class Uncertain extends Error {}

async function waitFor(what, fn, timeout = 180000, interval = 2000) {
    const deadline = Date.now() + timeout;
    let last = null;
    for (;;) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (e) {
            last = e;
        }
        if (Date.now() > deadline) throw new Error(`Timed out after ${timeout / 1000} s waiting for ${what}${last ? `: ${last.message}` : ''}`);
        await new Promise(resolve => setTimeout(resolve, interval));
    }
}

async function waitNodeReady(cluster, node, timeout = 180000) {
    const query_node = await docker.connect(cluster, node);
    return waitFor(`${node.name} to answer`, async () => (await query_node('SELECT 1 AS ok', {timeout: 3000}))[0].ok === 1, timeout);
}

async function keeperQuorum(cluster) {
    const members = cluster.spec.keeper.members;
    const states = [];
    for (const k of members) {
        try {
            states.push({name: k.name, ...(await keeperMntr('127.0.0.1', k.client_port))});
        } catch (e) {
            states.push({name: k.name, error: e.message});
        }
    }
    const leader = states.find(x => x.zk_server_state === 'leader' || x.zk_server_state === 'standalone');
    const answering = states.filter(x => !x.error).length;
    return {ok: !!leader && answering > members.length / 2, leader: leader ? leader.name : null, answering, total: members.length, states};
}

/// Replication of every replicated table of a node is caught up: an empty queue and no delay.
async function replicationCaughtUp(query_node) {
    const [r] = await query_node(`SELECT count() AS tables, sum(queue_size) AS queue, max(absolute_delay) AS delay, countIf(is_readonly) AS readonly,
        countIf(NOT is_session_expired AND total_replicas > active_replicas) AS inactive_peers FROM system.replicas`);
    return {...r, ok: Number(r.queue) === 0 && Number(r.delay) === 0 && Number(r.readonly) === 0};
}

/// The schema of a peer replica (databases and tables outside the system databases) created on a new node.
/// Tables are created from `SHOW CREATE`, so `ReplicatedMergeTree` tables with `{shard}`/`{replica}` macros join
/// replication and fetch their data; other tables are created empty, which the plan reports.
async function copySchema(source_query, target_query) {
    const notes = [];
    const databases = await source_query(`SELECT name, engine FROM system.databases WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema', 'default') ORDER BY name`);
    for (const d of databases) {
        const [create] = await source_query(`SHOW CREATE DATABASE ${q(d.name)}`);
        await target_query(Object.values(create)[0].replace(/^CREATE DATABASE/, 'CREATE DATABASE IF NOT EXISTS'), {raw: true});
    }
    const tables = await source_query(`SELECT database, name, engine, create_table_query FROM system.tables
        WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') AND NOT is_temporary
        ORDER BY dependencies_table = [] DESC, engine LIKE '%View' ASC, name`);
    const engines = new Map(databases.map(d => [d.name, d.engine]));
    for (const t of tables) {
        if (engines.get(t.database) === 'Replicated') continue; /// created by the Replicated database engine itself
        if (/^Replicated/.test(t.engine) && !/\{replica\}/.test(t.create_table_query)) {
            notes.push(`${t.database}.${t.name}: its replica name is not the {replica} macro, so it was not created; create it by hand with a new replica name.`);
            continue;
        }
        if (/MergeTree$/.test(t.engine) && !/^Replicated/.test(t.engine)) notes.push(`${t.database}.${t.name} (${t.engine}) is not replicated: it was created empty.`);
        await target_query(t.create_table_query.replace(/^CREATE (TABLE|MATERIALIZED VIEW|VIEW|DICTIONARY)/, 'CREATE $1 IF NOT EXISTS'), {raw: true});
    }
    return {databases: databases.length, tables: tables.length, notes};
}

/// Row counts of the replicated tables on two replicas of a shard.
async function compareCounts(a, b) {
    const tables = await a(`SELECT database, table FROM system.replicas ORDER BY database, table`);
    const differences = [];
    for (const t of tables) {
        const [x] = await a(`SELECT count() AS n FROM ${q(t.database)}.${q(t.table)}`);
        const [y] = await b(`SELECT count() AS n FROM ${q(t.database)}.${q(t.table)}`);
        if (x.n !== y.n) differences.push(`${t.database}.${t.table}: ${x.n} vs ${y.n}`);
    }
    return {tables: tables.length, differences};
}

/// Bounded write, replication, and distributed read test in a database that the test creates and drops.
async function replicationTest(cluster, label) {
    const spec = cluster.spec;
    const db = `_console_validation_${label.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
    const nodes = docker.nodes(spec);
    const first = await docker.connect(cluster, nodes[0]);
    const settings = {distributed_ddl_task_timeout: '120'};
    await first(`CREATE DATABASE IF NOT EXISTS ${q(db)} ON CLUSTER ${q(spec.cluster_name)}`, {raw: true, settings});
    try {
        await first(`CREATE TABLE IF NOT EXISTS ${q(db)}.t ON CLUSTER ${q(spec.cluster_name)} (shard UInt32, x UInt64)
            ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${db}/t', '{replica}') ORDER BY x`, {raw: true, settings});
        const result = [];
        for (const shard of spec.shards) {
            const replicas = shard.replicas.filter(r => r.state !== 'removed');
            if (!replicas.length) continue;
            const writer = await docker.connect(cluster, {...replicas[0], shard: shard.index});
            await writer(`INSERT INTO ${q(db)}.t SELECT ${shard.index}, number FROM numbers(1000)`, {raw: true});
            for (const r of replicas) {
                const reader = await docker.connect(cluster, {...r, shard: shard.index});
                await reader(`SYSTEM SYNC REPLICA ${q(db)}.t`, {raw: true, timeout: 120000});
                const [c] = await reader(`SELECT count() AS n FROM ${q(db)}.t WHERE shard = ${shard.index}`);
                result.push({node: r.name, shard: shard.index, rows: Number(c.n)});
                if (Number(c.n) !== 1000) throw new Error(`${r.name} has ${c.n} rows of the test, not 1000: replication of shard ${shard.index} is not working.`);
            }
        }
        const shards = spec.shards.filter(sh => sh.replicas.some(r => r.state !== 'removed')).length;
        const [d] = await first(`SELECT count() AS n FROM cluster(${s(spec.cluster_name)}, ${q(db)}, t)`);
        if (Number(d.n) !== shards * 1000) throw new Error(`A distributed read over the cluster returned ${d.n} rows, not ${shards * 1000}: the cluster definition does not reach every shard.`);
        return {replicas: result, distributed_rows: Number(d.n)};
    } finally {
        await first(`DROP DATABASE IF EXISTS ${q(db)} ON CLUSTER ${q(spec.cluster_name)} SYNC`, {raw: true, settings});
    }
}

/// Every node lists the cluster as the desired configuration defines it.
async function verifyTopology(cluster) {
    const spec = cluster.spec;
    const expected = spec.shards.flatMap((shard, i) => shard.replicas.filter(r => r.state !== 'removed').map(r => r.name)).sort();
    for (const n of docker.nodes(spec)) {
        const query_node = await docker.connect(cluster, n);
        const rows = await query_node(`SELECT host_name FROM system.clusters WHERE cluster = {c:String} ORDER BY host_name`, {params: {c: spec.cluster_name}});
        const seen = rows.map(r => r.host_name).sort();
        if (JSON.stringify(seen) !== JSON.stringify(expected)) throw new Error(`${n.name} lists the hosts ${seen.join(', ') || 'none'} for cluster ${spec.cluster_name}, expected ${expected.join(', ')}.`);
        const [z] = await query_node(`SELECT count() AS n FROM system.zookeeper_connection WHERE NOT is_expired`);
        if (Number(z.n) === 0) throw new Error(`${n.name} has no Keeper session.`);
    }
    return {hosts: expected};
}

/// chproxy answers as the proxy user, refuses a wrong password, finds every node healthy, and sends queries to them.
async function verifyRouting(cluster) {
    const nodes = docker.nodes(cluster.spec).map(n => n.name).sort();
    const health = await waitFor('chproxy to find every node healthy', async () => {
        const h = await docker.routingHealth(cluster);
        return nodes.every(n => h.nodes[n] === 1) ? h : null;
    }, 90000);
    const seen = new Set();
    for (let i = 0; i < nodes.length * 4; i++) seen.add((await docker.proxyQuery(cluster, 'SELECT hostName() AS host'))[0].host);
    const unknown = [...seen].filter(host => !nodes.includes(host));
    if (unknown.length) throw new Error(`chproxy sent queries to hosts that are not nodes of the cluster: ${unknown.join(', ')}.`);
    const refused = await httpQuery(`http://127.0.0.1:${cluster.spec.routing.port}`, cluster.spec.routing.user, 'not-the-password', 'SELECT 1', {timeout: 10000})
        .then(() => false, e => e.code !== -1);
    if (!refused) throw new Error('chproxy accepted a wrong password.');
    return {endpoint: `http://127.0.0.1:${cluster.spec.routing.port}`, healthy: Object.keys(health.nodes).length, answered_by: [...seen].sort()};
}

async function lifecycle(cluster, value, message) {
    await recordEvent('', cluster.cluster_id, 'lifecycle', {state: value, message});
    cluster.lifecycle = value;
}

/// A rolling action over nodes: before each node, the other replicas of its shard must be caught up; after it,
/// the node must answer and catch up before the next one starts.
async function rolling(ctx, nodes, action, label) {
    const {cluster} = ctx;
    const done = [];
    for (const n of nodes) {
        const step = `${label}:${n.name}`;
        if (ctx.op.steps.get(step) === 'done') continue;
        await ctx.step(step, `${label} ${n.name}`, async () => {
            const peers = docker.nodes(cluster.spec).filter(x => x.shard === n.shard && x.name !== n.name);
            for (const p of peers) {
                const peer = await docker.connect(cluster, p);
                const state = await replicationCaughtUp(peer).catch(e => ({ok: false, error: e.message}));
                if (!state.ok) throw new Blocked(`${p.name}, another replica of shard ${n.shard}, is not caught up (${state.error || `queue ${state.queue}, delay ${state.delay} s`}): continuing would leave the shard without a healthy replica.`);
            }
            /// With chproxy, clients are routed away from the node before it stops, and back once it has caught up.
            await docker.route(cluster, [n.name]);
            const result = await action(n);
            await waitNodeReady(cluster, n);
            const node_query = await docker.connect(cluster, n);
            await waitFor(`${n.name} to catch up with replication`, async () => (await replicationCaughtUp(node_query)).ok, 300000);
            await docker.route(cluster, []);
            done.push(n.name);
            return {node: n.name, ...(result || {}), single_replica: peers.length === 0};
        });
    }
    return done;
}

function newRevision(ctx, spec, note) {
    const revision = ctx.cluster.revision + 1;
    return recordRevision(ctx.cluster.cluster_id, revision, spec, 'agent', note).then(() => {
        ctx.cluster.revision = revision;
        ctx.cluster.spec = spec;
    });
}

const HANDLERS = {
    /// Discovery of an existing deployment: reads only, records what it saw with provenance and confidence.
    async register(ctx) {
        const {cluster} = ctx;
        await ctx.step('discover', 'Discover nodes, topology, versions, storage, and Keeper', async () => {
            const nodes = await nodeConnections(cluster);
            const discovered = {schema: 1, provider: cluster.provider, nodes: [], clusters: {}, conflicts: [], provenance: {}};
            for (const n of nodes) {
                try {
                    const [info] = await n.query(`SELECT version() AS version, hostName() AS host, uptime() AS uptime,
                        (SELECT groupArray((macro, substitution)) FROM system.macros) AS macros,
                        (SELECT groupArray((name, path, free_space, total_space)) FROM system.disks) AS disks,
                        (SELECT groupArray((name, host, port)) FROM system.zookeeper_connection) AS keeper,
                        (SELECT count() FROM system.users) AS users,
                        (SELECT count() FROM system.replicas) AS replicated_tables`, {timeout: 10000});
                    const clusters = await n.query(`SELECT cluster, shard_num, replica_num, host_name, port, is_local FROM system.clusters ORDER BY cluster, shard_num, replica_num`, {timeout: 10000});
                    discovered.nodes.push({endpoint: n.endpoint, reachable: true, ...info});
                    for (const c of clusters) {
                        const list = discovered.clusters[c.cluster] || (discovered.clusters[c.cluster] = {seen_from: [], members: {}});
                        if (!list.seen_from.includes(n.endpoint)) list.seen_from.push(n.endpoint);
                        const key = `${c.shard_num}/${c.replica_num}`;
                        const member = `${c.host_name}:${c.port}`;
                        if (list.members[key] && list.members[key] !== member) discovered.conflicts.push(`${c.cluster} shard ${c.shard_num} replica ${c.replica_num}: ${list.members[key]} on one node, ${member} on ${n.endpoint}`);
                        list.members[key] = member;
                    }
                } catch (e) {
                    discovered.nodes.push({endpoint: n.endpoint, reachable: false, error: e.message});
                }
            }
            const versions = [...new Set(discovered.nodes.filter(n => n.reachable).map(n => n.version))];
            if (versions.length > 1) discovered.conflicts.push(`Different versions: ${versions.join(', ')}`);
            discovered.provenance = {
                nodes: 'observed: queried at the registered endpoints',
                clusters: 'reported by system.clusters of the reachable nodes: a configuration entry, not proof of membership or of infrastructure ownership',
                keeper: 'reported by system.zookeeper_connection of each node',
                confidence: discovered.nodes.every(n => n.reachable) ? 'complete for the registered endpoints' : 'partial: some endpoints did not answer',
            };
            await recordRevision(cluster.cluster_id, cluster.revision + 1, discovered, 'observed', `discovery by operation ${ctx.op.op_id}`);
            cluster.revision += 1;
            const reachable = discovered.nodes.filter(n => n.reachable).length;
            await lifecycle(cluster, reachable === 0 ? 'unreachable' : (reachable < discovered.nodes.length ? 'degraded' : 'ready'), `registered in Observe mode: ${reachable}/${discovered.nodes.length} endpoints answered`);
            return {reachable, endpoints: discovered.nodes.length, conflicts: discovered.conflicts};
        });
    },

    async provision(ctx) {
        const {cluster, state} = ctx;
        const provider = docker;
        const previous = state.ops.find(o => o.cluster_id === cluster.cluster_id && o.kind === 'provision' && o.op_id !== ctx.op.op_id && o.state === 'succeeded');
        if (previous) throw new Rejected(`The cluster was already provisioned by operation ${previous.op_id}: a second provisioning is not run.`);
        await ctx.step('preflight', 'Check the provider: Docker, the image, ports, and resources', async () => {
            const version = (await run('docker', ['version', '--format', '{{.Server.Version}} {{.Server.Arch}}'], {timeout: 30000})).trim();
            const images = [cluster.spec.image, cluster.spec.keeper.image || cluster.spec.image, ...(docker.chproxy(cluster.spec) ? [cluster.spec.routing.image] : [])];
            for (const image of new Set(images)) {
                if (!IMAGES.some(prefix => image.startsWith(`${prefix}:`))) throw new Rejected(`The image ${image} is not allowed on this agent (CLUSTER_AGENT_IMAGES: ${IMAGES.join(', ')}).`);
                await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], {timeout: 30000}).catch(() => {
                    throw new Blocked(`The image ${image} is not on the Docker host. Pull it (docker pull ${image}), then retry the operation.`);
                });
            }
            const info = JSON.parse(await run('docker', ['info', '--format', '{{json .}}'], {timeout: 30000}));
            const nodes = docker.nodes(cluster.spec).length;
            const memory = (cluster.spec.resources.memory_mb || 0) * nodes * 1024 * 1024;
            if (memory && memory > info.MemTotal * 0.8) throw new Rejected(`The plan reserves ${Math.round(memory / 2 ** 30)} GiB for ClickHouse nodes; the Docker host has ${Math.round(info.MemTotal / 2 ** 30)} GiB.`);
            const owned = await provider.owned(cluster);
            const changed = await provider.assignPorts(state.clusters, cluster, cluster.spec);
            if (changed) await newRevision(ctx, cluster.spec, 'host ports assigned by the agent');
            return {docker: version, cpus: info.NCPU, memory_gib: Math.round(info.MemTotal / 2 ** 30), existing_resources: owned.length, revision: cluster.revision};
        });
        await ctx.step('render', 'Generate the deployment and the node configuration', async () => ({files: Object.keys(provider.render(cluster, cluster.spec)).length, directory: provider.dir(cluster)}));
        await lifecycle(cluster, 'provisioning', `operation ${ctx.op.op_id}`);
        await ctx.step('create', 'Create the network, volumes, and containers', async () => {
            try {
                await provider.compose(cluster, ['up', '-d', '--remove-orphans=false'], {timeout: 600000});
            } finally {
                await provider.recordOwned(cluster, ctx.op);
            }
            return {resources: (await provider.owned(cluster)).length};
        }, {recovery: 'The resources created so far are listed under Retirement → Resources. Retry the operation (it reuses them), or clean them up with Destroy.'});
        await lifecycle(cluster, 'validating', `operation ${ctx.op.op_id}`);
        await ctx.step('ready', 'Wait for every node and the Keeper quorum', async () => {
            for (const n of docker.nodes(cluster.spec)) await waitNodeReady(cluster, n);
            const quorum = await waitFor('the Keeper quorum', async () => {
                const k = await keeperQuorum(cluster);
                return k.ok ? k : null;
            });
            return {leader: quorum.leader, keeper_members: quorum.total};
        });
        await ctx.step('topology', 'Check authentication, Keeper sessions, and the cluster definition on every node', async () => verifyTopology(cluster));
        await ctx.step('replication', 'Write, replicate, and read test data in an isolated database', async () => replicationTest(cluster, ctx.op.op_id));
        if (docker.chproxy(cluster.spec)) await ctx.step('routing', 'Check client routing through chproxy', async () => verifyRouting(cluster));
        await lifecycle(cluster, 'ready', `validated by operation ${ctx.op.op_id}`);
    },

    async configure(ctx) {
        const {cluster} = ctx;
        const nodes = docker.nodes(cluster.spec);
        await ctx.step('render', 'Write the configuration of the new revision', async () => ({files: Object.keys(docker.render(cluster, cluster.spec)).length, revision: cluster.revision}));
        const restart = await ctx.step('reload', 'Reload the configuration on every node', async () => {
            const desired = (cluster.spec.settings || {}).server || {};
            const applied = docker.appliedSettings(cluster);
            /// What the server can change without a restart, as it reports it (`changeable_without_restart`). The value
            /// column already shows the configured value, so the decision compares with the values applied last time.
            const changed = Object.keys({...desired, ...applied}).filter(name => String(desired[name]) !== String(applied[name]));
            const needs = [];
            for (const n of nodes) {
                const node_query = await docker.connect(cluster, n);
                await node_query('SYSTEM RELOAD CONFIG', {raw: true});
                if (!changed.length) continue;
                const rows = await node_query(`SELECT name, changeable_without_restart AS mode FROM system.server_settings WHERE name IN {names:Array(String)}`,
                    {params: {names: arrayParam(changed)}});
                for (const r of rows) {
                    const before = Number(applied[r.name]);
                    const after = Number(desired[r.name]);
                    const restart = r.mode === 'No' || desired[r.name] === undefined
                        || (r.mode === 'IncreaseOnly' && !(after >= before)) || (r.mode === 'DecreaseOnly' && !(after <= before));
                    if (restart) needs.push({node: n.name, setting: r.name, mode: r.mode});
                }
            }
            return {changed, needs_restart: [...new Set(needs.map(x => x.node))], reasons: needs};
        });
        if (restart.needs_restart.length) {
            await rolling(ctx, nodes.filter(n => restart.needs_restart.includes(n.name)), async n => {
                await docker.compose(cluster, ['restart', n.name], {timeout: 300000});
            }, 'restart');
        }
        await ctx.step('verify', 'Check the settings on every node', async () => {
            const desired = (cluster.spec.settings || {}).server || {};
            const mismatch = [];
            for (const n of nodes) {
                const node_query = await docker.connect(cluster, n);
                for (const [name, value] of Object.entries(desired)) {
                    const [r] = await node_query(`SELECT value FROM system.server_settings WHERE name = {n:String}`, {params: {n: name}});
                    if (!r || r.value !== String(value)) mismatch.push(`${n.name}: ${name} = ${r ? r.value : 'unknown'}, desired ${value}`);
                }
                for (const [name, value] of Object.entries((cluster.spec.settings || {}).profile || {})) {
                    const [r] = await node_query(`SELECT toString(getSetting({n:String})) AS value`, {params: {n: name}});
                    if (r.value !== String(value)) mismatch.push(`${n.name}: profile ${name} = ${r.value}, desired ${value}`);
                }
            }
            if (mismatch.length) throw new Error(`The nodes do not report the desired values: ${mismatch.join('; ')}`);
            docker.saveAppliedSettings(cluster, desired);
            return {revision: cluster.revision};
        });
    },

    async reconcile(ctx) {
        return HANDLERS.configure(ctx);
    },

    async restart_node(ctx) {
        const {cluster, op} = ctx;
        const nodes = docker.nodes(cluster.spec).filter(n => (op.parameters.nodes || []).includes(n.name));
        if (!nodes.length) throw new Rejected('No node of this cluster was chosen.');
        await lifecycle(cluster, 'maintenance', `operation ${op.op_id}`);
        await rolling(ctx, nodes, async n => { await docker.compose(cluster, ['restart', n.name], {timeout: 300000}); }, 'restart');
        await lifecycle(cluster, 'ready', `maintenance ${op.op_id} completed`);
    },

    async resize(ctx) {
        const {cluster, op} = ctx;
        await ctx.step('render', 'Write the deployment with the new resources', async () => {
            docker.render(cluster, cluster.spec);
            return {resources: cluster.spec.resources};
        });
        await lifecycle(cluster, 'maintenance', `operation ${op.op_id}`);
        await rolling(ctx, docker.nodes(cluster.spec), async n => {
            await docker.compose(cluster, ['up', '-d', '--no-deps', n.name], {timeout: 300000});
            const [c] = JSON.parse(await run('docker', ['inspect', `${docker.project(cluster)}-${n.name}-1`, '--format', '{{json .HostConfig}}'], {timeout: 30000})
                .then(text => `[${text}]`));
            return {nano_cpus: c.NanoCpus, memory: c.Memory};
        }, 'recreate');
        await lifecycle(cluster, 'ready', `resize ${op.op_id} completed`);
    },

    async add_replica(ctx) {
        const {cluster, op} = ctx;
        /// Looked up again after the ports step, which adds the host ports to the specification.
        const fresh = () => docker.nodes(cluster.spec).filter(n => (op.parameters.nodes || []).includes(n.name));
        let new_nodes = fresh();
        if (!new_nodes.length) throw new Rejected('The revision of this operation has no new replica.');
        await ctx.step('ports', 'Assign host ports to the new replicas', async () => {
            if (await docker.assignPorts(ctx.state.clusters, cluster, cluster.spec)) await newRevision(ctx, cluster.spec, 'host ports assigned by the agent');
            return {revision: cluster.revision};
        });
        new_nodes = fresh();
        await ctx.step('render', 'Write the configuration with the new replicas', async () => ({files: Object.keys(docker.render(cluster, cluster.spec)).length}));
        await ctx.step('create', 'Create the new containers and volumes', async () => {
            try {
                await docker.compose(cluster, ['up', '-d', '--no-recreate', ...new_nodes.map(n => n.name)], {timeout: 300000});
            } finally {
                await docker.recordOwned(cluster, op);
            }
            for (const n of new_nodes) await waitNodeReady(cluster, n);
            return {nodes: new_nodes.map(n => n.name)};
        });
        const schema = await ctx.step('schema', 'Create the databases and tables of a peer replica on the new replicas', async () => {
            const result = [];
            for (const n of new_nodes) {
                const peer = docker.nodes(cluster.spec).find(p => p.shard === n.shard && !new_nodes.some(x => x.name === p.name));
                if (!peer) throw new Rejected(`Shard ${n.shard} has no existing replica to copy from.`);
                const copied = await copySchema(await docker.connect(cluster, peer), await docker.connect(cluster, n));
                result.push({node: n.name, peer: peer.name, ...copied});
            }
            return {nodes: result, notes: result.flatMap(r => r.notes)};
        });
        await ctx.step('sync', 'Wait until the new replicas have caught up, and compare row counts', async () => {
            const result = [];
            for (const n of new_nodes) {
                const node_query = await docker.connect(cluster, n);
                const tables = await node_query('SELECT database, table FROM system.replicas');
                for (const t of tables) await node_query(`SYSTEM SYNC REPLICA ${q(t.database)}.${q(t.table)}`, {raw: true, timeout: 600000});
                const peer = docker.nodes(cluster.spec).find(p => p.shard === n.shard && !new_nodes.some(x => x.name === p.name));
                const counts = await compareCounts(await docker.connect(cluster, peer), node_query);
                if (counts.differences.length) throw new Error(`${n.name} differs from ${peer.name}: ${counts.differences.join('; ')}`);
                result.push({node: n.name, replicated_tables: counts.tables});
            }
            return {nodes: result, schema_notes: schema.notes};
        });
        await ctx.step('topology', 'Check the cluster definition on every node', async () => verifyTopology(cluster));
        if (docker.chproxy(cluster.spec)) await ctx.step('routing', 'Route clients to the new replicas through chproxy', async () => ({...(await docker.route(cluster, [])), ...(await verifyRouting(cluster))}));
        await lifecycle(cluster, 'ready', `replicas ${new_nodes.map(n => n.name).join(', ')} added by ${op.op_id}`);
    },

    async add_shard(ctx) {
        const {cluster, op} = ctx;
        /// Looked up again after the ports step, which adds the host ports to the specification.
        const fresh = () => docker.nodes(cluster.spec).filter(n => (op.parameters.nodes || []).includes(n.name));
        let new_nodes = fresh();
        if (!new_nodes.length) throw new Rejected('The revision of this operation has no new shard.');
        await ctx.step('ports', 'Assign host ports to the new nodes', async () => {
            if (await docker.assignPorts(ctx.state.clusters, cluster, cluster.spec)) await newRevision(ctx, cluster.spec, 'host ports assigned by the agent');
            return {revision: cluster.revision};
        });
        new_nodes = fresh();
        await ctx.step('render', 'Write the configuration with the new shard', async () => ({files: Object.keys(docker.render(cluster, cluster.spec)).length}));
        await ctx.step('create', 'Create the containers and volumes of the new shard', async () => {
            try {
                await docker.compose(cluster, ['up', '-d', '--no-recreate', ...new_nodes.map(n => n.name)], {timeout: 300000});
            } finally {
                await docker.recordOwned(cluster, op);
            }
            for (const n of new_nodes) await waitNodeReady(cluster, n);
            return {nodes: new_nodes.map(n => n.name)};
        });
        await ctx.step('schema', 'Create the schema of shard 1 on the new shard (empty: existing data is not moved)', async () => {
            const source = docker.nodes(cluster.spec).find(n => n.shard === cluster.spec.shards[0].index);
            const result = [];
            for (const n of new_nodes) result.push({node: n.name, ...(await copySchema(await docker.connect(cluster, source), await docker.connect(cluster, n)))});
            return {nodes: result, data_placement: 'Existing rows stay on their shards. Distributed tables send new rows to the new shard according to their sharding key from now on.'};
        });
        await ctx.step('topology', 'Check the cluster definition on every node', async () => verifyTopology(cluster));
        await ctx.step('replication', 'Write, replicate, and read test data on every shard', async () => replicationTest(cluster, op.op_id));
        if (docker.chproxy(cluster.spec)) await ctx.step('routing', 'Route clients to the new shard through chproxy', async () => ({...(await docker.route(cluster, [])), ...(await verifyRouting(cluster))}));
        await lifecycle(cluster, 'ready', `shard added by ${op.op_id}`);
    },

    async remove_replica(ctx) {
        const {cluster, op} = ctx;
        const name = op.parameters.node;
        const node = docker.nodes(cluster.spec).find(n => n.name === name)
            || cluster.spec.shards.flatMap(sh => sh.replicas.map(r => ({...r, shard: sh.index}))).find(n => n.name === name);
        if (!node) throw new Rejected(`${name} is not a node of this cluster.`);
        const peers = cluster.spec.shards.find(sh => sh.index === node.shard).replicas.filter(r => r.name !== name && r.state !== 'removed');
        await ctx.step('roles', 'Identify the roles and dependencies of the node', async () => {
            if (!peers.length) throw new Rejected(`${name} is the last replica of shard ${node.shard}: removing it would remove the shard's data. Use Remove shard after migrating the data.`);
            if (cluster.spec.keeper.members.some(k => k.name === name)) throw new Rejected(`${name} is a Keeper member: change the Keeper membership first.`);
            return {shard: node.shard, remaining_replicas: peers.map(p => p.name), keeper_member: false};
        });
        await ctx.step('coverage', 'Check that the remaining replicas are synchronized and the Keeper quorum is healthy', async () => {
            const quorum = await keeperQuorum(cluster);
            if (!quorum.ok) throw new Blocked(`The Keeper quorum is not healthy (${quorum.answering}/${quorum.total} members answer): no node is removed while coordination is uncertain.`);
            const result = [];
            for (const p of peers) {
                const peer = await docker.connect(cluster, {...p, shard: node.shard});
                const caught = await replicationCaughtUp(peer).catch(e => ({ok: false, error: e.message}));
                if (!caught.ok) throw new Blocked(`${p.name} is not caught up (${caught.error || `queue ${caught.queue}, delay ${caught.delay} s, read-only ${caught.readonly}`}): it must hold all data before ${name} is removed.`);
                result.push({node: p.name, ...caught});
            }
            /// When the node still answers, its replicated tables must match a remaining replica. A node that no longer
            /// answers (for example stopped by an earlier attempt) cannot be compared: the caught-up peers are the evidence.
            let counts = {note: `${name} does not answer: its rows were not compared; the remaining replicas are caught up`};
            try {
                counts = await compareCounts(await docker.connect(cluster, node), await docker.connect(cluster, {...peers[0], shard: node.shard}));
            } catch (e) {
                if (e.code !== -1) throw e;
            }
            if (counts.differences && counts.differences.length) throw new Blocked(`${name} and ${peers[0].name} differ: ${counts.differences.join('; ')}. Wait for replication, or investigate before removing.`);
            return {peers: result, counts};
        });
        await ctx.step('workload', 'Check running queries and queued distributed inserts on the node', async () => {
            let w;
            try {
                [w] = await (await docker.connect(cluster, node))(`SELECT (SELECT count() FROM system.processes WHERE query NOT LIKE '%system.processes%') AS queries, (SELECT sum(data_files) FROM system.distribution_queue) AS distribution_files`);
            } catch (e) {
                if (e.code !== -1) throw e;
                return {note: `${name} does not answer: it runs no queries, and inserts queued on it cannot be checked`};
            }
            if (Number(w.distribution_files) > 0) throw new Blocked(`${name} has ${w.distribution_files} queued distributed inserts that would be lost: flush them (SYSTEM FLUSH DISTRIBUTED) first.`);
            return {running_queries: Number(w.queries)};
        });
        await ctx.step('routing', 'Route clients away from the node', async () => (docker.chproxy(cluster.spec)
            ? {...(await docker.route(cluster, [name])), note: 'chproxy no longer sends queries to the node. Clients that connect to the node directly must be moved by their owners.'}
            : {note: 'No chproxy: clients that connect to this node directly must be moved by their owners.'}));
        ctx.irreversible();
        await ctx.step('stop', 'Stop the node', async () => docker.container(cluster, name, 'stop'));
        await ctx.step('configure', 'Remove the node from the cluster definition of the other nodes', async () => {
            const spec = JSON.parse(JSON.stringify(cluster.spec));
            spec.shards.find(sh => sh.index === node.shard).replicas.find(r => r.name === name).state = 'removed';
            await newRevision(ctx, spec, `${name} removed by ${op.op_id}`);
            docker.render(cluster, spec);
            for (const p of docker.nodes(spec)) await (await docker.connect(cluster, p))('SYSTEM RELOAD CONFIG', {raw: true});
            if (docker.chproxy(spec)) await docker.route(cluster, []);
            return {revision: cluster.revision};
        });
        await ctx.step('metadata', 'Remove the replica metadata of the stopped node from Keeper', async () => {
            /// Justified because the agent stopped this node itself and removed it from the configuration; DROP REPLICA
            /// only removes an inactive replica.
            const peer = await docker.connect(cluster, {...peers[0], shard: node.shard});
            /// The stopped replica stays active in Keeper until its session expires (session_timeout_ms, 30 s by default).
            await waitFor(`the Keeper session of ${name} to expire`, async () => {
                try {
                    await peer(`SYSTEM DROP REPLICA ${s(name)}`, {raw: true});
                    return true;
                } catch (e) {
                    if (e.code === 305 && /active/.test(e.message)) return false;
                    throw e;
                }
            }, 120000, 5000);
            return {dropped_replica: name};
        });
        await ctx.step('validate', 'Check the remaining cluster', async () => verifyTopology(cluster));
        await ctx.step('dispose', 'Remove the container; keep or delete its volume as planned', async () => {
            await docker.container(cluster, name, 'remove');
            const volume = `${docker.project(cluster)}_${name}-data`;
            await recordResource(cluster.cluster_id, {resource_id: `container:${docker.project(cluster)}-${name}-1`, kind: 'container', name: `${docker.project(cluster)}-${name}-1`,
                owner_op: op.op_id, disposition: 'deleted', evidence: `removed by ${op.op_id}`});
            if (op.parameters.delete_volume) {
                await run('docker', ['volume', 'rm', volume], {timeout: 120000});
                await recordResource(cluster.cluster_id, {resource_id: `volume:${volume}`, kind: 'volume', name: volume, owner_op: op.op_id, disposition: 'deleted', evidence: `deleted by ${op.op_id} as approved`});
            } else {
                await recordResource(cluster.cluster_id, {resource_id: `volume:${volume}`, kind: 'volume', name: volume, owner_op: op.op_id, disposition: 'retained',
                    retention_until: op.parameters.retention_until || null, evidence: `kept by ${op.op_id}: the data of the removed replica`});
            }
            return {volume, deleted: !!op.parameters.delete_volume};
        });
        await lifecycle(cluster, 'ready', `${name} decommissioned by ${op.op_id}`);
    },

    async remove_shard(ctx) {
        const {cluster, op} = ctx;
        const index = Number(op.parameters.shard);
        const shard = cluster.spec.shards.find(sh => sh.index === index);
        if (!shard) throw new Rejected(`Shard ${index} does not exist.`);
        const replicas = shard.replicas.filter(r => r.state !== 'removed');
        await ctx.step('empty', 'Check that the shard holds no data', async () => {
            const node_query = await docker.connect(cluster, {...replicas[0], shard: index});
            const tables = await node_query(`SELECT database, name, total_rows FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') AND total_rows > 0`);
            if (tables.length) throw new Rejected(`Shard ${index} holds data in ${tables.map(t => `${t.database}.${t.name} (${t.total_rows} rows)`).join(', ')}. `
                + 'Removing a shard with data needs a migration of these rows to the other shards first; the console does not move data.');
            return {tables_with_data: 0};
        });
        ctx.irreversible();
        await ctx.step('remove', 'Stop the nodes and remove the shard from the cluster definition', async () => {
            await docker.route(cluster, replicas.map(r => r.name));
            for (const r of replicas) await docker.container(cluster, r.name, 'stop');
            const spec = JSON.parse(JSON.stringify(cluster.spec));
            for (const r of spec.shards.find(sh => sh.index === index).replicas) r.state = 'removed';
            await newRevision(ctx, spec, `shard ${index} removed by ${op.op_id}`);
            docker.render(cluster, spec);
            for (const p of docker.nodes(spec)) await (await docker.connect(cluster, p))('SYSTEM RELOAD CONFIG', {raw: true});
            if (docker.chproxy(spec)) await docker.route(cluster, []);
            for (const r of replicas) await docker.container(cluster, r.name, 'remove');
            for (const r of replicas) {
                await recordResource(cluster.cluster_id, {resource_id: `volume:${docker.project(cluster)}_${r.name}-data`, kind: 'volume', name: `${docker.project(cluster)}_${r.name}-data`,
                    owner_op: op.op_id, disposition: 'retained', evidence: `kept by ${op.op_id}`});
            }
            return {removed: replicas.map(r => r.name)};
        });
        await ctx.step('validate', 'Check the remaining cluster', async () => verifyTopology(cluster));
        await lifecycle(cluster, 'ready', `shard ${index} removed by ${op.op_id}`);
    },

    async backup(ctx) {
        const {cluster, op} = ctx;
        const [destination] = await query(`SELECT id, name, toString(type) AS type, named_collection, endpoint, bucket, prefix, credential_ref, enabled
            FROM ${q(DB)}.backup_destinations FINAL WHERE id = {id:String} AND NOT deleted`, {params: {id: op.parameters.destination_id || ''}});
        if (!destination) throw new Rejected('The backup destination does not exist.');
        if (destination.type !== 's3') throw new Rejected(`${destination.name} is a disk of the console's server; lab nodes cannot write to it. Choose an S3 destination.`);
        const key = process.env[`${destination.credential_ref}_ACCESS_KEY_ID`];
        const secret = process.env[`${destination.credential_ref}_SECRET_ACCESS_KEY`];
        if (!destination.credential_ref || !key || !secret) throw new Blocked(`The credentials of ${destination.name} are not set on the agent host (${destination.credential_ref || '<REF>'}_ACCESS_KEY_ID, _SECRET_ACCESS_KEY).`);
        /// Containers reach an endpoint published on the Docker host through the host alias.
        const endpoint = destination.endpoint.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost)(?=[:/]|$)/, `$1${HOST_ALIAS}`);
        const url = `${endpoint}/${destination.bucket}/${destination.prefix}/clusters/${cluster.cluster_id}/${op.op_id}`;
        /// One backup per shard, taken from a replica that is caught up, without ON CLUSTER: each one can be opened and
        /// checked on its own, and a node that is down elsewhere does not block it.
        const shards = cluster.spec.shards.filter(sh => sh.replicas.some(r => r.state !== 'removed'));
        const sources = await ctx.step('preconditions', 'Choose a caught-up replica of every shard', async () => {
            const chosen = [];
            for (const shard of shards) {
                let found = null;
                for (const r of shard.replicas.filter(x => x.state !== 'removed')) {
                    const state = await replicationCaughtUp(await docker.connect(cluster, {...r, shard: shard.index})).catch(() => null);
                    if (state && state.ok) { found = r.name; break; }
                }
                if (!found) throw new Blocked(`No replica of shard ${shard.index} answers and is caught up: the backup would miss its latest data.`);
                chosen.push({shard: shard.index, node: found});
            }
            return {sources: chosen, destination: destination.name};
        });
        const nodeOf = name => docker.nodes(cluster.spec).find(n => n.name === name);
        const urlOf = shard => `${url}/shard${shard}`;
        await ctx.step('backup', 'Back up all databases of every shard', async () => {
            const result = [];
            for (const src of sources.sources) {
                const node_query = await docker.connect(cluster, nodeOf(src.node));
                const [r] = await node_query(`BACKUP ALL EXCEPT DATABASES system, information_schema, INFORMATION_SCHEMA
                    TO S3(${s(urlOf(src.shard))}, ${s(key)}, ${s(secret)}) SETTINGS id = ${s(`${op.op_id}-${src.shard}`)}`, {timeout: 1800000});
                if (r.status !== 'BACKUP_CREATED') throw new Error(`The backup of shard ${src.shard} ended with status ${r.status}.`);
                result.push({shard: src.shard, node: src.node});
            }
            return {shards: result, location: `${destination.name}/clusters/${cluster.cluster_id}/${op.op_id}`, destination_id: destination.id};
        });
        await ctx.step('verify', 'Open the backup of every shard and compare its tables and rows', async () => {
            const compared = [];
            for (const src of sources.sources) {
                const node_query = await docker.connect(cluster, nodeOf(src.node));
                const databases = await node_query(`SELECT DISTINCT database AS name FROM system.tables WHERE database NOT IN ('system', 'information_schema', 'INFORMATION_SCHEMA') AND NOT is_temporary`);
                for (const d of databases) {
                    const probe = `_console_probe_${crypto.randomBytes(4).toString('hex')}`;
                    await node_query(`CREATE DATABASE ${q(probe)} ENGINE = Backup(${s(d.name)}, S3(${s(urlOf(src.shard))}, ${s(key)}, ${s(secret)}))`, {raw: true, settings: {backup_restore_s3_retry_attempts: '2'}});
                    try {
                        const tables = await node_query(`SELECT name, total_rows FROM system.tables WHERE database = {d:String} AND engine LIKE '%MergeTree%'`, {params: {d: d.name}});
                        for (const t of tables) {
                            const [b] = await node_query(`SELECT count() AS n FROM ${q(probe)}.${q(t.name)}`).catch(e => [{n: null, error: e.message}]);
                            if (b.n === null) throw new Error(`Shard ${src.shard}: ${d.name}.${t.name} is not readable in the backup (${b.error}).`);
                            compared.push({shard: src.shard, table: `${d.name}.${t.name}`, rows_in_backup: Number(b.n), rows_now: Number(t.total_rows)});
                        }
                    } finally {
                        await node_query(`DROP DATABASE IF EXISTS ${q(probe)}`, {raw: true});
                    }
                }
            }
            return {verified: true, tables: compared};
        });
    },

    async upgrade(ctx) {
        const {cluster, op} = ctx;
        const target = op.parameters.image;
        if (!target || !IMAGES.some(prefix => target.startsWith(`${prefix}:`))) throw new Rejected(`The image ${target} is not allowed on this agent.`);
        const version = image => (image.split(':').pop().match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?/) || []).slice(1).map(Number);
        const compare = (a, b) => { for (let i = 0; i < 4; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0); return 0; };
        await ctx.step('path', 'Check the upgrade path, the image, and the recovery readiness', async () => {
            const current = docker.nodes(cluster.spec).map(n => n.image || cluster.spec.image);
            const from = current.map(version).sort(compare)[0];
            const to = version(target);
            if (!to.length) throw new Rejected(`The tag of ${target} is not a ClickHouse version.`);
            if (compare(to, from) < 0) throw new Rejected(`${target} is older than the running version ${from.join('.')}: a downgrade with persisted data is not supported. Restore a backup into a new cluster of the older version instead.`);
            /// ClickHouse versions are year.month: more than 12 months apart is more than a year of releases.
            if ((to[0] * 12 + to[1]) - (from[0] * 12 + from[1]) > 12) throw new Rejected(`From ${from.join('.')} to ${to.join('.')} skips more than a year of releases: upgrade through intermediate versions and check each changelog.`);
            await run('docker', ['image', 'inspect', target, '--format', '{{.Id}}'], {timeout: 30000}).catch(() => {
                throw new Blocked(`The image ${target} is not on the Docker host. Pull it (docker pull ${target}), then retry.`);
            });
            const backups = ctx.state.ops.filter(o => o.cluster_id === cluster.cluster_id && o.kind === 'backup' && o.state === 'succeeded' && Date.now() - o.last_ms < 24 * 3600 * 1000);
            if (!backups.length && !op.parameters.waive_backup) throw new Rejected('No verified backup of this cluster from the last 24 hours: back up first, or waive the requirement with a reason.');
            return {from: from.join('.'), to: to.join('.'), backup: backups.length ? backups[backups.length - 1].op_id : `waived: ${op.parameters.waive_backup}`,
                rollback: 'Not by changing the image back: a newer version may change persisted data. Recovery is a restore of the backup into a new cluster.'};
        });
        await lifecycle(cluster, 'maintenance', `upgrade ${op.op_id}`);
        /// Order: the replicas of each shard from the last one, so that the first replica of every shard serves on the old
        /// version while the others are upgraded; a failure stops the rollout with the remaining nodes on the old version.
        const order = docker.nodes(cluster.spec).sort((a, b) => a.shard - b.shard || b.name.localeCompare(a.name));
        const spec = JSON.parse(JSON.stringify(cluster.spec));
        await rolling(ctx, order, async n => {
            spec.shards.find(sh => sh.index === n.shard).replicas.find(r => r.name === n.name).image = target;
            await newRevision(ctx, JSON.parse(JSON.stringify(spec)), `${n.name} → ${target} by ${op.op_id}`);
            docker.render(cluster, spec);
            await docker.compose(cluster, ['up', '-d', '--no-deps', n.name], {timeout: 600000});
            await waitNodeReady(cluster, n, 300000);
            const [v] = await (await docker.connect(cluster, n))('SELECT version() AS version');
            if (!target.endsWith(`:${v.version}`) && !v.version.startsWith(target.split(':').pop())) throw new Error(`${n.name} reports version ${v.version} after the upgrade, not ${target}.`);
            const [e] = await (await docker.connect(cluster, n))(`SELECT count() AS n FROM system.errors WHERE last_error_time > now() - INTERVAL 2 MINUTE AND name IN ('CANNOT_LOAD_CONFIG', 'UNKNOWN_TABLE', 'CORRUPTED_DATA', 'CHECKSUM_DOESNT_MATCH')`);
            if (Number(e.n) > 0) throw new Error(`${n.name} reports load or data errors after the upgrade (system.errors): the rollout stops here.`);
            return {version: v.version};
        }, 'upgrade');
        await ctx.step('checks', 'Run the post-upgrade checks', async () => ({...(await verifyTopology(cluster)), ...(await replicationTest(cluster, op.op_id))}));
        await lifecycle(cluster, 'ready', `upgraded to ${target} by ${op.op_id}`);
    },

    async keeper_change() {
        throw new Rejected('Keeper membership changes are not implemented: the docker-compose provider creates the ensemble at provisioning, and a reconfiguration of a running ensemble needs a verified procedure for the deployed version.');
    },

    async adopt(ctx) {
        const {cluster} = ctx;
        const provider = PROVIDERS[cluster.provider];
        if (!provider) throw new Rejected(`The ${cluster.provider} provider has no management integration: this cluster can be observed, but the console cannot change its infrastructure or configuration.`);
        await recordEvent('', cluster.cluster_id, 'mode', {state: 'manage', message: `adopted by ${ctx.op.op_id}`});
    },

    async release(ctx) {
        await recordEvent('', ctx.cluster.cluster_id, 'mode', {state: 'observe', message: `management released by ${ctx.op.op_id}`});
    },

    async retire(ctx) {
        const {cluster, op, state} = ctx;
        const p = op.parameters;
        await ctx.step('dependencies', 'Check that every dependency has a disposition', async () => {
            const open = (p.dependencies || []).filter(d => !d.disposition);
            if (open.length) throw new Rejected(`Dependencies without a disposition: ${open.map(d => d.item).join(', ')}.`);
            const others = state.ops.filter(o => o.cluster_id === cluster.cluster_id && o.op_id !== op.op_id && !TERMINAL.includes(o.state));
            if (others.length) throw new Blocked(`Operations still in progress: ${others.map(o => `${o.kind} ${o.op_id.slice(0, 8)}`).join(', ')}. Resolve them first.`);
            return {dependencies: (p.dependencies || []).length};
        });
        await ctx.step('protection', 'Check the final backup and its verification', async () => {
            if (p.final_backup_op) {
                const backup = state.ops.find(o => o.op_id === p.final_backup_op && o.cluster_id === cluster.cluster_id);
                if (!backup || backup.kind !== 'backup' || backup.state !== 'succeeded' || backup.steps.get('verify') !== 'done') {
                    throw new Rejected(`The final backup ${p.final_backup_op} did not succeed with a verification: the protection gate is not passed.`);
                }
                return {final_backup: p.final_backup_op, verified: true, retention_until: p.retention_until || null};
            }
            if (!p.no_backup_reason) throw new Rejected('A verified final backup, or a recorded reason why none is needed, is required.');
            const tables = [];
            for (const n of docker.nodes(cluster.spec)) {
                const rows = await (await docker.connect(cluster, n))(`SELECT database, name, total_rows FROM system.tables WHERE database NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') AND total_rows > 0`).catch(() => [{database: '?', name: `${n.name} unreachable`, total_rows: '?'}]);
                tables.push(...rows.map(r => `${n.name}: ${r.database}.${r.name}`));
            }
            if (tables.length) throw new Rejected(`The cluster holds data (${tables.slice(0, 5).join(', ')}): a final backup is required.`);
            return {final_backup: null, reason: p.no_backup_reason};
        });
        ctx.irreversible();
        await lifecycle(cluster, 'retiring', `operation ${op.op_id}`);
        await ctx.step('stop', 'Stop the managed containers', async () => {
            await docker.compose(cluster, ['stop'], {timeout: 600000});
            const owned = await docker.owned(cluster);
            for (const r of owned) {
                await recordResource(cluster.cluster_id, {resource_id: `${r.kind}:${r.name}`, kind: r.kind, name: r.name, owner_op: op.op_id,
                    disposition: r.kind === 'container' ? 'stopped' : 'retained', retention_until: p.retention_until || null, evidence: `retirement ${op.op_id}`});
            }
            return {stopped: owned.filter(r => r.kind === 'container').length, retained: owned.filter(r => r.kind !== 'container').length};
        });
        await recordEvent('', cluster.cluster_id, 'mode', {state: 'retired', message: `retired by ${op.op_id}`});
        await lifecycle(cluster, 'retired', `retired by ${op.op_id}; backups and records are kept`);
    },

    /// Deletes only the resources listed in the operation, after checking that Docker labels them as this cluster's.
    async destroy(ctx) {
        const {cluster, op} = ctx;
        const approved = op.parameters.resources || [];
        if (!['retired', 'failed'].includes(cluster.lifecycle) && cluster.mode !== 'retired') throw new Rejected('Only a retired cluster, or one whose provisioning failed, can have its resources deleted.');
        if (!Array.isArray(approved) || approved.some(id => typeof id !== 'string' || !/^(container|volume|network|directory):[A-Za-z0-9_.-]+$/.test(id))) {
            throw new Rejected('The approved resources must be a list of identifiers such as volume:<name>.');
        }
        if (!approved.length) throw new Rejected('No resource was approved for deletion.');
        const owned = await docker.owned(cluster);
        await ctx.step('delete', 'Delete the approved resources', async () => {
            const deleted = [];
            const order = {container: 0, network: 1, volume: 2, directory: 3};
            for (const id of [...approved].sort((a, b) => order[a.split(':')[0]] - order[b.split(':')[0]])) {
                const [kind, ...rest] = id.split(':');
                const name = rest.join(':');
                if (kind === 'directory') {
                    if (name !== docker.project(cluster)) throw new Rejected(`The directory ${name} is not this cluster's deployment.`);
                    fs.rmSync(docker.dir(cluster), {recursive: true, force: true});
                } else {
                    if (!owned.some(r => r.kind === kind && r.name === name)) {
                        await recordResource(cluster.cluster_id, {resource_id: id, kind, name, owner_op: op.op_id, disposition: 'deleted', evidence: 'not found with the labels of this cluster: nothing deleted'});
                        continue;
                    }
                    await run('docker', [kind === 'container' ? 'rm' : kind, ...(kind === 'container' ? ['-f'] : ['rm']), name], {timeout: 120000});
                }
                await recordResource(cluster.cluster_id, {resource_id: id, kind, name, owner_op: op.op_id, disposition: 'deleted', evidence: `deleted by ${op.op_id}`});
                deleted.push(id);
            }
            return {deleted};
        });
    },
};

/// Runs an operation step by step. Completed steps are recorded, so a restarted agent continues after the last
/// completed step; steps are written so that running one again is harmless.
async function execute(state, op) {
    const cluster = state.by_cluster.get(op.cluster_id);
    const ctx = {state, op, cluster, boundary: false,
        irreversible() { this.boundary = true; },
        async step(name, title, fn, {recovery} = {}) {
            if (op.steps.get(name) === 'done') return op.step_results.get(name) || {};
            if (op.cancel_requested && !this.boundary) throw new Cancelled();
            if ((op.attempts.get(name) || 0) >= 3) throw new Blocked(`The step "${title}" failed 3 times. ${recovery || 'Investigate, then retry or cancel the operation.'}`);
            await recordEvent(op.op_id, op.cluster_id, 'step', {step: name, state: 'running', message: title});
            op.attempts.set(name, (op.attempts.get(name) || 0) + 1);
            try {
                const result = await fn();
                await recordEvent(op.op_id, op.cluster_id, 'step', {step: name, state: 'done', message: title, data: result || {}});
                op.steps.set(name, 'done');
                op.step_results.set(name, result || {});
                return result || {};
            } catch (e) {
                await recordEvent(op.op_id, op.cluster_id, 'step', {step: name, state: 'failed', message: `${title}: ${e.message}`, data: {recovery: recovery || ''}});
                if (e.timed_out) throw new Uncertain(`${title}: the provider did not answer in time; the outcome is unknown and is checked again on the next cycle.`);
                throw e;
            }
        }};
    await HANDLERS[op.kind](ctx);
}

class Cancelled extends Error {}

async function authorize(op, cluster) {
    const capability = CAPABILITY[op.kind];
    if (!capability) throw new Rejected(`Unknown operation ${op.kind}.`);
    let allowed;
    try {
        allowed = (await query(`EXECUTE AS ${q(op.requested_by)} CHECK GRANT INSERT(${capability}) ON ${q(DB)}.cluster_capabilities`, {raw: true})).trim() === '1';
    } catch (e) {
        throw new Rejected(`The capability of ${op.requested_by} could not be checked (${e.message}). The agent's account needs IMPERSONATE on the requesting users.`);
    }
    if (!allowed) throw new Rejected(`${op.requested_by} does not have the capability ${capability} (INSERT(${capability}) ON ${DB}.cluster_capabilities).`);
    if (MUTATING.has(op.kind)) {
        if (!ENVIRONMENTS.includes(cluster.environment)) throw new Rejected(`This agent changes only the environments ${ENVIRONMENTS.join(', ')}; the cluster is in ${cluster.environment}.`);
        const provider = PROVIDERS[cluster.provider];
        if (!provider || !provider.operations.includes(op.kind)) throw new Rejected(`The ${cluster.provider} provider does not implement ${op.kind}.`);
        if (op.kind !== 'provision' && op.kind !== 'destroy' && cluster.mode !== 'manage') throw new Rejected(`The cluster is in ${cluster.mode} mode: only a managed cluster can be changed.`);
    }
    return capability;
}

async function processOperations(state) {
    const active = state.ops.filter(o => !TERMINAL.includes(o.state));
    for (const op of active) {
        const cluster = state.by_cluster.get(op.cluster_id);
        if (!cluster) continue;
        /// Claims: within the newest generation the earliest claim wins, so agents that claim at the same time agree.
        /// A claim without progress for 10 minutes (an agent that stopped) is taken over with a new generation.
        const winnerOf = claims => {
            const generation = Math.max(...claims.map(c => c.generation));
            return claims.filter(c => c.generation === generation).sort((a, b) => a.at - b.at || String(a.agent).localeCompare(String(b.agent)))[0];
        };
        const stale = op.claims.length && winnerOf(op.claims).agent !== AGENT_ID && Date.now() - op.last_ms > 600000;
        if (!op.claims.length || stale) {
            const generation = op.claims.length ? Math.max(...op.claims.map(c => c.generation)) + 1 : 0;
            await recordEvent(op.op_id, op.cluster_id, 'claim', {data: {agent: AGENT_ID, generation, takeover: !!stale}});
            const claims = (await query(`SELECT JSONExtractString(data, 'agent') AS agent, JSONExtractUInt(data, 'generation') AS generation, toUnixTimestamp64Milli(at) AS at
                FROM ${q(DB)}.cluster_events WHERE op_id = {id:String} AND kind = 'claim'`, {params: {id: op.op_id}})).map(c => ({...c, generation: Number(c.generation), at: Number(c.at)}));
            if (winnerOf(claims).agent !== AGENT_ID) continue;
        } else if (winnerOf(op.claims).agent !== AGENT_ID) {
            continue;
        }
        /// One operation at a time per cluster: an earlier unfinished operation goes first.
        const earlier = active.find(o => o.cluster_id === op.cluster_id && o.requested_ms < op.requested_ms && o !== op);
        if (earlier) {
            if (op.state !== 'waiting') await recordEvent(op.op_id, op.cluster_id, 'state', {state: 'waiting', message: `waits for ${earlier.kind} ${earlier.op_id.slice(0, 8)} on the same cluster`});
            op.state = 'waiting';
            continue;
        }
        if (op.cancel_requested && ['queued', 'waiting', 'blocked', 'unknown'].includes(op.state)) {
            await recordEvent(op.op_id, op.cluster_id, 'state', {state: 'cancelled', message: op.state === 'queued' || op.state === 'waiting'
                ? 'cancelled before it started' : `cancelled while ${op.state}: the steps marked done took effect and were not undone`});
            await audit(`cluster_${op.kind}`, cluster, `${op.kind} on ${cluster.name} cancelled`, 'failure', 'cancelled by an operator', op.op_id);
            continue;
        }
        /// A blocked operation waits for an operator: it runs again only after a retry request.
        if (op.state === 'blocked' && !(op.retry_ms > op.state_ms)) continue;
        let capability;
        try {
            capability = await authorize(op, cluster);
        } catch (e) {
            await recordEvent(op.op_id, op.cluster_id, 'state', {state: 'rejected', message: e.message});
            await audit(`cluster_${op.kind}_rejected`, cluster, `${op.kind} on ${cluster.name} rejected`, 'failure', e.message, op.op_id);
            log('rejected', {op: op.op_id, reason: e.message});
            continue;
        }
        if (op.state !== 'running') await recordEvent(op.op_id, op.cluster_id, 'state', {state: 'running', message: `started by ${AGENT_ID}`, data: {capability}});
        op.state = 'running';
        log('running', {op: op.op_id, kind: op.kind, cluster: cluster.name});
        try {
            await execute(state, op);
            await recordEvent(op.op_id, op.cluster_id, 'state', {state: 'succeeded', message: `${op.kind} completed`});
            await audit(`cluster_${op.kind}`, cluster, `${op.kind} on ${cluster.name} succeeded`, 'success', '', op.op_id);
            log('succeeded', {op: op.op_id});
        } catch (e) {
            let next = 'failed';
            if (e instanceof Rejected) next = 'rejected';
            else if (e instanceof Cancelled) next = 'cancelled';
            else if (e instanceof Blocked) next = 'blocked';
            else if (e instanceof Uncertain) next = 'unknown';
            let message = e.message;
            if (op.kind === 'upgrade' && next === 'failed') {
                const upgraded = [...op.steps.entries()].filter(([k, v]) => k.startsWith('upgrade:') && v === 'done').map(([k]) => k.slice(8));
                message += ` The rollout stopped. Upgraded: ${upgraded.join(', ') || 'none'}; the other nodes keep the previous version. Find the cause before continuing. `
                    + 'Changing the image back does not downgrade data the new version may have written: to return, restore the pre-upgrade backup into a new cluster.';
            }
            await recordEvent(op.op_id, op.cluster_id, 'state', {state: next, message});
            if (op.kind === 'provision' && next === 'failed') await lifecycle(cluster, 'failed', `provisioning ${op.op_id} failed`);
            else if (['add_replica', 'add_shard', 'remove_replica', 'remove_shard', 'upgrade', 'resize', 'restart_node', 'configure', 'reconcile'].includes(op.kind)
                && ['failed', 'blocked', 'unknown'].includes(next) && ['maintenance', 'ready', 'validating'].includes(cluster.lifecycle)) {
                await lifecycle(cluster, 'degraded', `${op.kind} ${op.op_id} ${next}`);
            }
            if (TERMINAL.includes(next) || next === 'blocked') {
                await audit(`cluster_${op.kind}`, cluster, `${op.kind} on ${cluster.name} ${next}`, 'failure', message, op.op_id);
            }
            log(next, {op: op.op_id, error: message});
        }
    }
}

const last_observed = new Map();

async function cycle() {
    const state = await loadState();
    await recordEvent(`agent:${AGENT_ID}`, '', 'heartbeat', {state: 'alive', data: {providers: Object.keys(PROVIDERS), environments: ENVIRONMENTS, state_dir: !!STATE_DIR}});
    await processOperations(state);
    for (const cluster of state.clusters) {
        if (cluster.mode === 'retired' || !cluster.spec || ['planned', 'provisioning', 'retiring', 'retired', 'destroyed'].includes(cluster.lifecycle)) continue;
        if (Date.now() - (last_observed.get(cluster.cluster_id) || 0) < OBSERVE_INTERVAL && !ONCE) continue;
        last_observed.set(cluster.cluster_id, Date.now());
        try {
            await observe(state, cluster);
        } catch (e) {
            log('observation failed', {cluster: cluster.name, error: e.message});
            await recordEvent('', cluster.cluster_id, 'observation', {state: 'error', message: e.message});
        }
    }
}

async function main() {
    log('started', {server: URL_BASE, database: DB, environments: ENVIRONMENTS, state_dir: STATE_DIR || null});
    for (;;) {
        try {
            await cycle();
        } catch (e) {
            log('cycle failed', {error: e.message});
            if (ONCE) process.exit(1);
        }
        if (ONCE) break;
        await new Promise(resolve => setTimeout(resolve, INTERVAL));
    }
}

export {keeperMntr, docker};

if (import.meta.url === `file://${process.argv[1]}`) await main();
