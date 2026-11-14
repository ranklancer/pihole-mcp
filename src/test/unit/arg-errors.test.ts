import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { formatArgIssues } from '../../arg-errors.js';

describe('formatArgIssues', () => {
  const schema = z.object({
    action: z.enum(['list', 'add']),
    domain: z.string(),
    nested: z.object({ n: z.number() }).optional(),
  });

  test('joins issues as "path: message" on one line', () => {
    const r = schema.safeParse({ action: 'zap', nested: { n: 'x' } });
    assert.ok(!r.success);
    const msg = formatArgIssues(r.error);
    assert.match(msg, /^Invalid arguments: /);
    assert.match(msg, /action: /);
    assert.match(msg, /domain: /);
    assert.match(msg, /nested\.n: /);
    assert.ok(!msg.includes('\n'), 'must be a single line');
  });

  test('a root-level issue has no path prefix', () => {
    const r = z.string().safeParse(1);
    assert.ok(!r.success);
    assert.match(formatArgIssues(r.error), /^Invalid arguments: [^:]+$/);
  });
});

describe('stdio server: invalid tool arguments', () => {
  const entry = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.js');

  // Speak raw newline-delimited JSON-RPC to the built server over stdio.
  function rpc(messages: object[]): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry], {
        env: {
          PATH: process.env.PATH,
          MCP_TRANSPORT: 'stdio',
          PIHOLE_INSTANCES: 'fake',
          // Bad arguments are rejected before any network call; this URL is never contacted.
          FAKE_BASE_URL: 'http://127.0.0.1:9',
          FAKE_PASSWORD: 'unit-test-only',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const out: any[] = [];
      let buf = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('timed out')); }, 10_000);
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) out.push(JSON.parse(line));
        }
        if (out.length >= messages.filter((m: any) => m.id !== undefined).length) {
          clearTimeout(timer);
          child.kill();
          resolve(out);
        }
      });
      child.on('error', reject);
      for (const m of messages) child.stdin.write(JSON.stringify(m) + '\n');
    });
  }

  const init = [
    { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ];

  test('bad arguments return isError with a one-line message; unknown tool is a protocol error', async () => {
    const out = await rpc([
      ...init,
      { jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'pihole_adlist_management', arguments: { action: 'purge' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'no_such_tool', arguments: {} } },
    ]);
    const bad = out.find((m) => m.id === 2);
    assert.equal(bad.result?.isError, true, JSON.stringify(bad));
    const text: string = bad.result.content[0].text;
    assert.match(text, /^Invalid arguments: action: /);
    assert.ok(!text.includes('\n'));
    const unknown = out.find((m) => m.id === 3);
    assert.ok(unknown.error, 'unknown tool should be a JSON-RPC error');
    assert.equal(unknown.error.code, -32602);
  });
});
