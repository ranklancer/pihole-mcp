#!/usr/bin/env node
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toolDefs } from './tools.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * Minimal Zod-to-JSON-Schema converter for MCP tool registration.
 *
 * Recurses through the schema shapes this server uses — objects, strings,
 * numbers, booleans, enums, arrays and nested objects — so array/object
 * inputs are described faithfully instead of being flattened to `string`.
 * Optional/default/nullable wrappers are unwrapped for typing; optional and
 * default fields are marked non-required.
 */
function jsonSchemaForType(type: z.ZodType<any>): Record<string, any> {
  let v: any = type;
  while (
    v instanceof z.ZodOptional ||
    v instanceof z.ZodDefault ||
    v instanceof z.ZodNullable
  ) {
    v = v._def.innerType;
  }

  if (v instanceof z.ZodString)  return { type: 'string' };
  if (v instanceof z.ZodNumber)  return { type: 'number' };
  if (v instanceof z.ZodBoolean) return { type: 'boolean' };
  if (v instanceof z.ZodEnum)    return { type: 'string', enum: v._def.values };
  if (v instanceof z.ZodArray)   return { type: 'array', items: jsonSchemaForType(v._def.type) };
  if (v instanceof z.ZodObject)  return jsonSchemaForObject(v as z.ZodObject<any>);
  return { type: 'string' };
}

function jsonSchemaForObject(schema: z.ZodObject<any>): Record<string, any> {
  const shape = schema.shape;
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, val] of Object.entries(shape)) {
    let optional = false;
    let inner: any = val;
    while (
      inner instanceof z.ZodOptional ||
      inner instanceof z.ZodDefault ||
      inner instanceof z.ZodNullable
    ) {
      if (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) optional = true;
      inner = inner._def.innerType;
    }

    const prop = jsonSchemaForType(inner);
    const description = (val as any)?._def?.description ?? (inner as any)?._def?.description;
    if (description) prop.description = description;

    properties[key] = prop;
    if (!optional) required.push(key);
  }

  return { type: 'object', properties, required };
}

function zodToJsonSchema(schema: z.ZodType<any>): Record<string, any> {
  if (!(schema instanceof z.ZodObject)) return { type: 'object' };
  return jsonSchemaForObject(schema as z.ZodObject<any>);
}

/**
 * One-line, model-readable summary of a failed argument parse, e.g.
 * `Invalid arguments: action: Invalid enum value...; domain: Required`.
 * Uses only `issues[].path` and `.message`, which are the same in zod 3 and 4.
 */
function formatArgIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const parts = error.issues.map(i => {
    const where = i.path.map(String).join('.');
    return where ? `${where}: ${i.message}` : i.message;
  });
  return `Invalid arguments: ${parts.join('; ')}`;
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
    // MCP spec (Tools > Error Handling): unknown tools are protocol errors
    // (-32602); input validation failures are tool execution errors so the
    // model can read them and retry.
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`);

    const parsed = tool.schema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      return { isError: true, content: [{ type: 'text', text: formatArgIssues(parsed.error) }] };
    }
    const args = parsed.data;
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
    res.end(JSON.stringify({ ok: true, service: 'pihole-mcp', version: '0.3.0' }));
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

// stdout carries the JSON-RPC stream in stdio mode, so nothing else may log to it.
if (process.env.MCP_TRANSPORT === 'stdio') {
  await createServer().connect(new StdioServerTransport());
} else {
  httpServer.listen(PORT, HOST, () => {
    console.log(`pihole-mcp listening on http://${HOST}:${PORT}`);
  });
}

function shutdown() { httpServer.close(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
