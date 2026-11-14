#!/usr/bin/env node
import type { Server as HttpServer } from 'node:http';
import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toolDefs } from './tools.js';
import { formatArgIssues } from './arg-errors.js';
import { createHttpApp, isLoopbackHost, loadHttpSecurityConfig } from './http-security.js';

const VERSION = '0.3.0';

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
