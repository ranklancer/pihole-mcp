import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
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
