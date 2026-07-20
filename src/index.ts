#!/usr/bin/env node
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toolDefs } from './tools.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

/** Minimal Zod-to-JSON-Schema converter for MCP tool registration. */
function zodToJsonSchema(schema: z.ZodType<any>): Record<string, any> {
  if (!(schema instanceof z.ZodObject)) return { type: 'object' };
  const shape = (schema as z.ZodObject<any>).shape;
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, val] of Object.entries(shape)) {
    let v = val as z.ZodType<any>;
    let optional = false;

    if (v instanceof z.ZodOptional) { v = (v as any)._def.innerType; optional = true; }
    if (v instanceof z.ZodDefault)  { v = (v as any)._def.innerType; optional = true; }

    let prop: Record<string, any> = { type: 'string' };
    if      (v instanceof z.ZodString)  prop = { type: 'string' };
    else if (v instanceof z.ZodNumber)  prop = { type: 'number' };
    else if (v instanceof z.ZodBoolean) prop = { type: 'boolean' };
    else if (v instanceof z.ZodEnum)    prop = { type: 'string', enum: (v as any)._def.values };

    if ((val as any)?._def?.description) prop.description = (val as any)._def.description;

    properties[key] = prop;
    if (!optional) required.push(key);
  }
  return { type: 'object', properties, required };
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
    { name: 'pihole-mcp', version: '0.2.0' },
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

const httpServer = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'pihole-mcp', version: '0.2.0' }));
    return;
  }
  if (req.url?.startsWith('/mcp')) {
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
      await transport.handleRequest(req, res);
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
    return;
  }
  res.writeHead(404).end('not found');
});

httpServer.listen(PORT, HOST, () => {
  console.log(`pihole-mcp listening on http://${HOST}:${PORT}`);
});

function shutdown() { httpServer.close(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
