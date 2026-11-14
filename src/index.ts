#!/usr/bin/env node
import type { Server as HttpServer } from 'node:http';
import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toolDefs } from './tools.js';
import { createHttpApp, isLoopbackHost, loadHttpSecurityConfig } from './http-security.js';

const VERSION = '0.3.0';

/**
 * Convert a tool's Zod schema to the JSON Schema advertised via tools/list.
 *
 * Uses Zod 4's built-in `z.toJSONSchema` (the documented replacement for
 * hand-rolled converters / zod-to-json-schema). `io: 'input'` describes what
 * callers send, so fields with `.default()` are not marked required;
 * `draft-07` is the dialect MCP clients handle most widely. The `$schema`
 * key is dropped since MCP tool inputSchema is implicitly a JSON Schema object.
 */
function zodToJsonSchema(schema: z.ZodType<any>): Record<string, any> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    target: 'draft-07',
    io: 'input',
  }) as Record<string, any>;
  return json.type === 'object' ? json : { type: 'object' };
}

// ── MCP server setup ────────────────────────────────────────────────

/**
 * Build a fresh MCP Server with the tool handlers registered.
 *
 * A new Server + transport pair is created per request (see below). A single
 * long-lived StreamableHTTPServerTransport in stateful mode accepts exactly
 * one `initialize` for its lifetime and rejects every later one with
 * `-32600 Invalid Request: Server already initialized`, which breaks proxies
 * such as mcp-remote that initialize an upstream connection and then forward
 * the downstream client's initialize.
 */
function createServer(): Server {
  const server = new Server(
    { name: 'pihole-mcp', version: '0.3.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefs.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = toolDefs.find(t => t.name === req.params.name);
    if (!tool) throw new Error(`Unknown tool: ${req.params.name}`);

    const args = tool.schema.parse(req.params.arguments ?? {});
    try {
      const result = await tool.handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] };
    }
  });

  return server;
}

// ── HTTP transport ──────────────────────────────────────────────────

// Host/Origin validation, the loopback-bind default and optional bearer auth
// live in http-security.ts (issue #43); this handler only runs once a request
// has passed them.
async function handleMcp(req: Request, res: Response): Promise<void> {
  // Stateless: one Server + transport per request, torn down on close.
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('mcp request failed:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      }));
    }
  }
}

let httpServer: HttpServer | undefined;

// stdout carries the JSON-RPC stream in stdio mode, so nothing else may log to it.
if (process.env.MCP_TRANSPORT === 'stdio') {
  await createServer().connect(new StdioServerTransport());
} else {
  let cfg;
  try {
    cfg = loadHttpSecurityConfig();
  } catch (err) {
    console.error(`pihole-mcp: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const { host, port } = cfg;
  // Log from the 'listening' event: Express 5's listen() callback also fires on
  // a bind error, which would print a false "listening" line first.
  httpServer = createHttpApp(cfg, handleMcp, VERSION).listen(port, host);
  httpServer.on('listening', () => {
    const shown = host.includes(':') ? `[${host}]` : host;
    console.log(`pihole-mcp listening on http://${shown}:${port}`);
    console.log(
      `pihole-mcp: auth ${cfg.authToken ? 'enabled (bearer token)' : 'disabled'}; ` +
      `allowed hosts: ${cfg.allowedHosts.join(', ')}; ` +
      `allowed origins: ${cfg.allowedOrigins.length ? cfg.allowedOrigins.join(', ') : '(none)'}`,
    );
    if (!isLoopbackHost(host) && !cfg.authToken) {
      console.warn(
        `pihole-mcp: WARNING: bound to non-loopback ${host} with authentication disabled ` +
        '(MCP_ALLOW_UNAUTHENTICATED=true). Anyone who can reach this port can change your Pi-hole configuration.',
      );
    }
  });
  httpServer.on('error', (err) => {
    console.error(`pihole-mcp: cannot listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
  });
}

function shutdown() { httpServer?.close(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
