import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express, { type Express, type Request, type RequestHandler, type Response } from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';

/**
 * HTTP transport hardening (issue #43).
 *
 * Implements the Streamable HTTP "Security Warning" of the MCP specification
 * (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning):
 *
 *  1. Origin validation: a request whose `Origin` header is present and not
 *     allowlisted gets 403 Forbidden.
 *  2. Bind to localhost by default; binding any other address needs an
 *     explicit opt-in (MCP_ALLOW_NON_LOOPBACK=true).
 *  3. Bearer-token authentication on /mcp: optional on loopback; required on a
 *     non-loopback bind unless the operator sets MCP_ALLOW_UNAUTHENTICATED=true.
 *
 * Host-header validation (DNS-rebinding protection) uses the SDK's own
 * `hostHeaderValidation` middleware, which the SDK recommends in place of the
 * deprecated `allowedHosts` / `enableDnsRebindingProtection` transport options.
 * The SDK ships no non-deprecated Origin middleware, so that check lives here.
 *
 * This module has no import-time side effects so it can be unit-tested
 * without a Pi-hole configuration.
 */

export interface HttpSecurityConfig {
  host: string;
  port: number;
  /** Hostnames (port-agnostic) accepted in the Host header. IPv6 in brackets. Always includes loopback names. */
  allowedHosts: string[];
  /** Exact origins (scheme://host[:port]) accepted in the Origin header. */
  allowedOrigins: string[];
  /** Bearer token required on /mcp, or undefined when auth is off. Never log. */
  authToken?: string;
}

/** Minimum token length; `openssl rand -hex 32` produces 64 characters. */
export const MIN_TOKEN_LENGTH = 32;

// Loopback names are always accepted: a DNS-rebinding page always presents
// the attacker's own hostname, never these, and the container health check
// connects via 127.0.0.1.
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Normalise an allowed-origin entry to the serialised form browsers send
 * (lowercase scheme and host, no path, no trailing slash, default port
 * dropped). Rejects entries that are not plain origins.
 */
function normaliseOrigin(entry: string): string {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new Error(`MCP_ALLOWED_ORIGINS: "${entry}" is not a valid origin (expected scheme://host[:port])`);
  }
  if (url.origin === 'null' || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error(`MCP_ALLOWED_ORIGINS: "${entry}" is not a plain origin (expected scheme://host[:port])`);
  }
  return url.origin;
}

function loadToken(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.MCP_AUTH_TOKEN;
  const file = env.MCP_AUTH_TOKEN_FILE;
  if (fromEnv !== undefined && fromEnv !== '' && file !== undefined && file !== '') {
    throw new Error('Set only one of MCP_AUTH_TOKEN and MCP_AUTH_TOKEN_FILE');
  }
  let token: string | undefined;
  if (file !== undefined && file !== '') {
    try {
      token = readFileSync(file, 'utf8').trim();
    } catch (err) {
      // Fail closed: a configured but unreadable token file must not start an
      // unauthenticated server. Only the error code is reported.
      const code = (err as NodeJS.ErrnoException)?.code ?? 'error';
      throw new Error(`MCP_AUTH_TOKEN_FILE could not be read (${code})`, { cause: err });
    }
    if (token === '') throw new Error('MCP_AUTH_TOKEN_FILE is empty');
  } else if (fromEnv !== undefined && fromEnv !== '') {
    token = fromEnv.trim();
  }
  if (token !== undefined && /\s/.test(token)) {
    throw new Error('MCP auth token must not contain whitespace');
  }
  if (token !== undefined && token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `MCP auth token is too short (minimum ${MIN_TOKEN_LENGTH} characters; generate one with \`openssl rand -hex 32\`)`,
    );
  }
  return token;
}

/** Read and validate HTTP transport settings. Throws on unsafe or invalid config. */
export function loadHttpSecurityConfig(env: NodeJS.ProcessEnv = process.env): HttpSecurityConfig {
  const host = (env.HOST ?? '127.0.0.1').trim();
  const rawPort = (env.PORT ?? '3000').trim();
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65535) {
    throw new Error('PORT must be an integer 0-65535');
  }

  if (!isLoopbackHost(host) && env.MCP_ALLOW_NON_LOOPBACK !== 'true') {
    throw new Error(
      `Refusing to bind HOST=${host}: it is not a loopback address. ` +
      'Set MCP_ALLOW_NON_LOOPBACK=true to opt in (required inside a container), ' +
      'and set MCP_AUTH_TOKEN or MCP_AUTH_TOKEN_FILE.',
    );
  }

  const extraHosts = (parseList(env.MCP_ALLOWED_HOSTS) ?? []).map(h => h.toLowerCase());
  if (extraHosts.some(h => h.includes('*'))) {
    throw new Error('MCP_ALLOWED_HOSTS does not support wildcards; list each hostname');
  }
  const allowedHosts = [...new Set([...LOOPBACK_HOSTNAMES, ...extraHosts])];
  const allowedOrigins = (parseList(env.MCP_ALLOWED_ORIGINS) ?? []).map(normaliseOrigin);
  const authToken = loadToken(env);

  if (!isLoopbackHost(host) && authToken === undefined && env.MCP_ALLOW_UNAUTHENTICATED !== 'true') {
    throw new Error(
      `Refusing to serve unauthenticated on non-loopback HOST=${host}. ` +
      'Set MCP_AUTH_TOKEN_FILE (or MCP_AUTH_TOKEN), or set MCP_ALLOW_UNAUTHENTICATED=true to accept the risk.',
    );
  }

  return { host, port, allowedHosts, allowedOrigins, authToken };
}

function jsonRpcError(res: Response, status: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/**
 * Reject a request whose Origin header is present and not allowlisted
 * (MCP spec: "If the Origin header is present and invalid, servers MUST
 * respond with HTTP 403 Forbidden"). Requests with no Origin header — the
 * norm for non-browser MCP clients — pass through.
 */
export function originValidation(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined) return next();
    if (!allowed.has(origin)) return jsonRpcError(res, 403, 'Forbidden: Origin not allowed');
    next();
  };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Require `Authorization: Bearer <token>`. The comparison hashes both sides
 * to fixed-length digests and uses crypto.timingSafeEqual, so neither the
 * token's content nor its length leaks through timing. The header value is
 * never logged or echoed.
 */
export function bearerAuth(token: string): RequestHandler {
  const expected = digest(token);
  return (req, res, next) => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer[ ]+(\S+)[ ]*$/i.exec(header) : null;
    const presented = match ? digest(match[1]) : undefined;
    // Always run one comparison so the missing-header path costs the same.
    const ok = timingSafeEqual(presented ?? digest(''), expected) && presented !== undefined;
    if (!ok) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="pihole-mcp"');
      return jsonRpcError(res, 401, 'Unauthorized');
    }
    next();
  };
}

export type McpRequestHandler = (req: Request, res: Response) => Promise<void>;

/**
 * Build the Express app. Middleware order is deliberate:
 * Host check -> Origin check -> /health (unauthenticated) -> auth -> body parse -> MCP.
 * Rejections happen before the request body is read.
 */
export function createHttpApp(cfg: HttpSecurityConfig, handleMcp: McpRequestHandler, version: string): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostHeaderValidation(cfg.allowedHosts));
  app.use(originValidation(cfg.allowedOrigins));

  // Liveness probe: no auth, so container health checks need no secret. It
  // returns only static service metadata. Host and Origin checks still apply.
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'pihole-mcp', version });
  });

  const mcpChain: RequestHandler[] = [];
  if (cfg.authToken !== undefined) mcpChain.push(bearerAuth(cfg.authToken));
  // inflate: false — compressed bodies are refused (415), as the SDK transport
  // itself never decompressed them; this also keeps body-parser's inflate path
  // (GHSA-27r3-jxmh-p828) off the request path.
  mcpChain.push(express.json({ inflate: false }));
  app.all('/mcp', ...mcpChain, (req, res) => handleMcp(req, res));

  app.use((_req, res) => { res.status(404).type('text/plain').send('not found'); });

  // Replace Express's default error page (which includes a stack trace
  // outside NODE_ENV=production) with a JSON-RPC error.
  app.use(((err, _req, res, _next) => {
    if (res.headersSent) return;
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 400) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }
    jsonRpcError(res, status, status === 500 ? 'Internal server error' : 'Request rejected');
  }) as express.ErrorRequestHandler);
  return app;
}
