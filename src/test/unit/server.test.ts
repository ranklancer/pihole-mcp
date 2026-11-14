import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Black-box tests of the built server over its real stdio transport.
 *
 * src/index.ts starts a transport as a side effect of being imported, so it
 * cannot be loaded into an in-memory transport pair without a source change;
 * spawning dist/index.js (built by `npm test`) exercises the same code path a
 * real MCP client uses. No Pi-hole is contacted: the configured base URL
 * points at a closed port.
 *
 * These deliberately assert on observable behaviour (tool names, the shape of
 * the advertised input schemas, validation outcomes), not on how the
 * zod -> JSON Schema converter is implemented.
 */

// The tools present when these tests were written; later tools are allowed.
const BASELINE_TOOLS = [
  'pihole_query_log', 'pihole_allow_domain', 'pihole_deny_domain', 'pihole_list_allowlist',
  'pihole_list_denylist', 'pihole_stats_summary', 'pihole_reload_lists', 'pihole_group_management',
  'pihole_client_management', 'pihole_check_regex_types', 'pihole_set_blocking',
  'pihole_domain_management', 'pihole_local_dns', 'pihole_local_cname',
];

const entry = fileURLToPath(new URL('../../index.js', import.meta.url));
let client: Client;

before(async () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, {
    MCP_TRANSPORT: 'stdio',
    PIHOLE_INSTANCES: 'pihole',
    PIHOLE_BASE_URL: 'http://127.0.0.1:1',
    PIHOLE_PASSWORD: 'unused',
  });
  client = new Client({ name: 'unit-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env, stderr: 'ignore' }));
});

after(async () => { await client?.close(); });

describe('tools/list', () => {
  test('advertises every baseline tool with a description and an object schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    for (const n of BASELINE_TOOLS) assert.ok(names.includes(n), `missing ${n}`);
    assert.equal(new Set(names).size, names.length, 'tool names are unique');
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 0, `${t.name} has a description`);
      assert.equal(t.inputSchema.type, 'object', `${t.name} schema is an object`);
    }
  });

  test('instance-aware tools expose an optional instance selector', async () => {
    const { tools } = await client.listTools();
    for (const n of ['pihole_stats_summary', 'pihole_local_dns']) {
      const t = tools.find(x => x.name === n)!;
      const props = t.inputSchema.properties as Record<string, unknown>;
      assert.ok('instance' in props, `${n} has instance`);
      assert.ok(!(t.inputSchema.required ?? []).includes('instance'), `${n}: instance is optional`);
    }
  });

  test('action enums and required fields are advertised', async () => {
    const { tools } = await client.listTools();
    const dns = tools.find(t => t.name === 'pihole_local_dns')!;
    const action = (dns.inputSchema.properties as any).action;
    assert.deepEqual([...action.enum].sort(), ['add', 'delete', 'list']);
    assert.ok((dns.inputSchema.required ?? []).includes('action'));

    const block = tools.find(t => t.name === 'pihole_set_blocking')!;
    assert.ok((block.inputSchema.required ?? []).includes('blocking'));

    const clients = tools.find(t => t.name === 'pihole_client_management')!;
    const groups = (clients.inputSchema.properties as any).groups;
    assert.equal(groups.type, 'array');
  });
});

describe('argument validation', () => {
  async function outcome(name: string, args: Record<string, unknown>): Promise<{ failed: boolean; text: string }> {
    try {
      const res: any = await client.callTool({ name, arguments: args });
      return { failed: res.isError === true, text: JSON.stringify(res.content) };
    } catch (err: any) {
      return { failed: true, text: String(err?.message ?? err) };
    }
  }

  test('rejects an unknown tool', async () => {
    assert.equal((await outcome('pihole_does_not_exist', {})).failed, true);
  });

  test('rejects arguments that violate the schema', async () => {
    assert.equal((await outcome('pihole_set_blocking', { blocking: 'yes' })).failed, true, 'wrong type');
    assert.equal((await outcome('pihole_set_blocking', {})).failed, true, 'missing required');
    assert.equal((await outcome('pihole_set_blocking', { blocking: true, timer: -5 })).failed, true, 'non-positive timer');
    assert.equal((await outcome('pihole_local_dns', { action: 'explode' })).failed, true, 'bad enum value');
    assert.equal((await outcome('pihole_allow_domain', { domain: '' })).failed, true, 'empty domain');
  });

  test('reports missing add/delete parameters instead of calling Pi-hole', async () => {
    const r = await outcome('pihole_local_dns', { action: 'add', domain: 'a.lan' });
    assert.equal(r.failed, true);
    assert.match(r.text, /ip and domain/);
    const c = await outcome('pihole_local_cname', { action: 'delete', domain: 'a.lan' });
    assert.equal(c.failed, true);
    assert.match(c.text, /domain and target/);
  });

  test('an unreachable Pi-hole surfaces as a failed call, not a crash', async () => {
    const r = await outcome('pihole_stats_summary', {});
    assert.equal(r.failed, true);
    // The server must still answer afterwards.
    assert.ok((await client.listTools()).tools.length >= BASELINE_TOOLS.length);
  });
});

// ── HTTP transport ───────────────────────────────────────────────────
// Spawns the built server with MCP_TRANSPORT unset (HTTP) on a random loopback
// port. The token is a throwaway generated per run and kept in a 0600 file,
// never on the command line.

function baseEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.MCP_TRANSPORT;
  for (const k of Object.keys(env)) if (k.startsWith('MCP_') || k === 'HOST' || k === 'PORT') delete env[k];
  return Object.assign(env, {
    PIHOLE_INSTANCES: 'pihole',
    PIHOLE_BASE_URL: 'http://127.0.0.1:1',
    PIHOLE_PASSWORD: 'unused',
  }, extra);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

describe('HTTP transport', () => {
  let child: ChildProcess;
  let dir: string;
  let url: string;
  const token = `t-${'a1b2c3d4'.repeat(8)}`;
  const initialize = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'unit-test', version: '0.0.0' } },
  };

  function post(headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(initialize),
      signal: AbortSignal.timeout(10_000),
    });
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pihole-mcp-test-'));
    const tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [entry], {
      env: baseEnv({ HOST: '127.0.0.1', PORT: String(port), MCP_AUTH_TOKEN_FILE: tokenFile }),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Wait for the server's own "listening" line rather than sleeping.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('HTTP server did not start')), 15_000);
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited early (${code})`)); });
      child.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('listening')) { clearTimeout(timer); resolve(); }
      });
    });
  });

  after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise(r => child.once('exit', r));
      child.kill('SIGTERM');
      await exited;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('401 without a token, and the challenge names Bearer', async () => {
    const res = await post();
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') ?? '', /^Bearer/);
    await res.arrayBuffer();
  });

  test('401 with a wrong token', async () => {
    const res = await post({ authorization: `Bearer ${'z'.repeat(token.length)}` });
    assert.equal(res.status, 401);
    await res.arrayBuffer();
  });

  test('200 with the token, and the response is a valid initialize result', async () => {
    const res = await post({ authorization: `Bearer ${token}` });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"serverInfo"/);
    assert.match(text, /pihole-mcp/);
  });

  test('403 for a foreign Origin even with a valid token', async () => {
    const res = await post({ authorization: `Bearer ${token}`, origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    await res.arrayBuffer();
  });

  test('/health needs no token', async () => {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
  });

  test('HOST=0.0.0.0 without MCP_ALLOW_NON_LOOPBACK exits non-zero', async () => {
    const refused = spawn(process.execPath, [entry], {
      env: baseEnv({ HOST: '0.0.0.0', PORT: String(await freePort()) }),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    refused.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => refused.kill('SIGKILL'), 15_000);
    const code = await new Promise<number | null>(resolve => refused.once('exit', resolve));
    clearTimeout(timer);
    assert.ok(code !== null && code !== 0, `expected non-zero exit, got ${code}`);
    assert.match(stderr, /MCP_ALLOW_NON_LOOPBACK/);
  });
});
