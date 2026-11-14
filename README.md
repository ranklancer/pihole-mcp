# pihole-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![Pi-hole v6](https://img.shields.io/badge/Pi--hole-v6-red.svg)](https://pi-hole.net)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-purple.svg)](https://modelcontextprotocol.io)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that gives AI assistants like **Claude** full control over your [Pi-hole v6](https://pi-hole.net) DNS ad-blocker - query logs, allow/deny lists, group management, gravity reload, and stats. Designed from day one for **multi-instance deployments**: manage one or many Pi-hole instances from a single MCP endpoint.

## Why?

Pi-hole's admin API is powerful but cumbersome to script against. This MCP server turns every Pi-hole API action into a tool that any MCP-compatible AI assistant can call directly. Instead of clicking through the admin UI or writing curl commands, just ask your AI to check what's being blocked, allowlist a domain, or compare stats across instances.

Perfect for **homelabbers** running multiple Pi-holes (primary + secondary, or per-VLAN), **network admins** managing DNS filtering at scale, and anyone who wants AI-assisted DNS management.

## Features

- **Multi-instance support** - configure 1 to N Pi-hole instances via environment variables
- **Full Pi-hole v6 API coverage** - query logs, allow/deny lists (full CRUD), group and client management, blocking control, local DNS (A + CNAME) records, gravity reload, stats
- **Smart regex detection** - automatically routes domains to exact or regex lists based on metacharacter analysis
- **Regex landmine detector** - finds deny-exact entries that look like they should be regex (miscategorized rules)
- **Docker-ready** - multi-stage Dockerfile with non-root user, health checks, and security hardening
- **Streamable HTTP or stdio transport** - run as a long-lived HTTP service, or let the MCP client spawn it on demand
- **Docker secrets support** - passwords via env vars or `/run/secrets/` files

## Quick Start

### npx (stdio, no clone, no Docker)

> **Requires `@ranklancer/pihole-mcp` 0.3.0 or later.** The only version on npm at the time of writing is 0.2.0, which predates stdio support (`MCP_TRANSPORT=stdio`) and starts an HTTP server instead, so the configs below do not work with it. Until 0.3.0 is published, use one of the other options below. Check with `npm view @ranklancer/pihole-mcp version`.

The MCP client starts the server as a child process through `npx` and talks to it over stdin/stdout. Nothing is cloned, no port is opened and nothing keeps running in the background. Requires Node.js 22 or newer.

Add this to your MCP client config (for Claude Desktop: `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "pihole": {
      "command": "npx",
      "args": ["-y", "@ranklancer/pihole-mcp"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "PIHOLE_INSTANCES": "pihole",
        "PIHOLE_BASE_URL": "http://pihole.example.com",
        "PIHOLE_PASSWORD": "your-pihole-api-password"
      }
    }
  }
}
```

Or with Claude Code:

```bash
claude mcp add --scope user pihole \
  -e MCP_TRANSPORT=stdio \
  -e PIHOLE_INSTANCES=pihole \
  -e PIHOLE_BASE_URL=http://pihole.example.com \
  -e PIHOLE_PASSWORD=your-pihole-api-password \
  -- npx -y @ranklancer/pihole-mcp
```

The password sits in plain text in the client config; keep that file private (`chmod 600`). For several instances, see [Configuration](#configuration). To pin a release, use `@ranklancer/pihole-mcp@0.3.0` in `args`. For a long-lived HTTP endpoint, use Docker below.

### Docker (HTTP endpoint)

```bash
git clone https://github.com/ranklancer/pihole-mcp.git
cd pihole-mcp
cp .env.example .env
# Edit .env with your Pi-hole URL(s) and password(s)

mkdir -p secrets
printf '%s' "your-pihole-password" > secrets/pihole_password
openssl rand -hex 32 > secrets/mcp_auth_token   # bearer token for /mcp
# The container runs as uid 1001 and must be able to read both files:
chmod 640 secrets/pihole_password secrets/mcp_auth_token
sudo chgrp 1001 secrets/pihole_password secrets/mcp_auth_token

cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

The container binds all interfaces but the example compose file publishes the port on `127.0.0.1:3031` only, and `/mcp` requires the bearer token. Your MCP client must send it; see [Connecting to Your MCP Client](#connecting-to-your-mcp-client). If you are upgrading an existing Docker install, read [Upgrading from 0.3.0](#upgrading-from-030-behaviour-change).

### Node.js (HTTP endpoint)

```bash
npm ci
npm run build
export PIHOLE_INSTANCES=pihole
export PIHOLE_BASE_URL=http://pihole.example.com
export PIHOLE_PASSWORD=your-password
npm start
```

This listens on `http://127.0.0.1:3000/mcp` (loopback only, no token needed). To listen on another address, see [HTTP transport security](#http-transport-security).

### Local on demand (stdio, no Docker)

The MCP client starts the server as a child process when needed and talks to it over stdin/stdout. No port is opened and nothing keeps running in the background.

```bash
npm ci
npm run build
cp .env.example .env
chmod 600 .env
# Edit .env with your Pi-hole URL(s) and password(s)
```

Register it with Claude Code (user scope):

```bash
claude mcp add --scope user pihole -- bash -c \
  'set -a; . ~/path/to/pihole-mcp/.env; set +a; MCP_TRANSPORT=stdio exec node ~/path/to/pihole-mcp/dist/index.js'
```

Or add it manually to your MCP client config:

```json
{
  "mcpServers": {
    "pihole": {
      "type": "stdio",
      "command": "bash",
      "args": ["-c", "set -a; . ~/path/to/pihole-mcp/.env; set +a; MCP_TRANSPORT=stdio exec node ~/path/to/pihole-mcp/dist/index.js"]
    }
  }
}
```

`HOST`, `PORT` and the `MCP_*` HTTP security settings (token, allowed hosts and origins) from `.env` are ignored in stdio mode: there is no network listener to protect.

## Configuration

All configuration is via environment variables. See [`.env.example`](.env.example) for the full reference.

### Single Instance

```env
PIHOLE_INSTANCES=pihole
PIHOLE_BASE_URL=http://192.0.2.100
PIHOLE_PASSWORD=your-password
```

### Multiple Instances

```env
PIHOLE_INSTANCES=primary,secondary
PRIMARY_BASE_URL=http://192.0.2.100
PRIMARY_PASSWORD=password1
SECONDARY_BASE_URL=https://198.51.100.101
SECONDARY_PASSWORD=password2
SECONDARY_INSECURE_TLS=true
```

For each instance name in `PIHOLE_INSTANCES`, provide:

| Variable | Required | Description |
|---|---|---|
| `<NAME>_BASE_URL` | Yes | Pi-hole base URL (e.g. `http://pihole.local`) |
| `<NAME>_PASSWORD` | Yes | Pi-hole API password (or use Docker secrets) |
| `<NAME>_INSECURE_TLS` | No | Set `true` for self-signed certs (default: `false`) |

Docker secrets are supported as a fallback: `/run/secrets/<name>_password` (lowercase).

## Available MCP Tools

| Tool | Description |
|---|---|
| `pihole_query_log` | Fetch query log with filters (limit, time range, client IP or name, domain, status) |
| `pihole_allow_domain` | Add to allowlist (auto-detects exact vs regex) |
| `pihole_deny_domain` | Add to denylist (auto-detects exact vs regex) |
| `pihole_list_allowlist` | List all allowlist entries (exact + regex merged) |
| `pihole_list_denylist` | List all denylist entries (exact + regex merged) |
| `pihole_stats_summary` | Get Pi-hole statistics summary |
| `pihole_reload_lists` | Trigger gravity reload |
| `pihole_group_management` | CRUD operations on Pi-hole groups |
| `pihole_client_management` | CRUD operations on Pi-hole clients and their group assignments |
| `pihole_check_regex_types` | Detect miscategorized regex in deny-exact list |
| `pihole_set_blocking` | Enable/disable blocking, with optional auto-revert timer |
| `pihole_domain_management` | Update or delete an allow/deny domain (completes CRUD) |
| `pihole_local_dns` | List/add/delete local DNS A records |
| `pihole_local_cname` | List/add/delete local CNAME records |

Every tool accepts an optional `instance` parameter to target a specific Pi-hole. Defaults to the first configured instance.

## Connecting to Your MCP Client

This section applies to the HTTP transport (Docker or `npm start`). For stdio, see [npx](#npx-stdio-no-clone-no-docker) or [Local on demand](#local-on-demand-stdio-no-docker).

The server listens on `http://HOST:PORT/mcp`. Run directly with `npm start` that is `http://127.0.0.1:3000/mcp`; the example Docker compose file publishes it as `http://127.0.0.1:3031/mcp`. The examples below use the Docker port; adjust it for your setup. See [HTTP transport security](#http-transport-security) before exposing it beyond loopback.

### Claude Desktop / Claude Code

The Docker setup requires a bearer token, so send it in the `Authorization` header. Claude Code expands environment variables in `.mcp.json`, so the token stays out of the file (export `PIHOLE_MCP_TOKEN` with the contents of `secrets/mcp_auth_token`):

```json
{
  "mcpServers": {
    "pihole": {
      "type": "http",
      "url": "http://localhost:3031/mcp",
      "headers": { "Authorization": "Bearer ${PIHOLE_MCP_TOKEN}" }
    }
  }
}
```

A loopback-only server started with `npm start` and no token needs no header:

```json
{
  "mcpServers": {
    "pihole": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## HTTP transport security

These tools can disable blocking and delete domains and DNS records, so the HTTP endpoint is locked down by default, following the [MCP Streamable HTTP security requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#security-warning):

| Variable | Default | Effect |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. |
| `MCP_ALLOW_NON_LOOPBACK` | unset | Must be `true` to bind any non-loopback address (e.g. `0.0.0.0`); otherwise the server refuses to start. The Docker image sets it, because a container must bind all interfaces for a published port to reach it. |
| `MCP_ALLOW_UNAUTHENTICATED` | unset | A non-loopback bind also needs a token (below); without one the server refuses to start unless this is `true`. The Docker image does **not** set it. |
| `MCP_ALLOWED_HOSTS` | none | Extra hostnames accepted in the `Host` header (port-agnostic; DNS-rebinding protection via the MCP SDK's `hostHeaderValidation`). `localhost`, `127.0.0.1` and `[::1]` are always accepted. Other hosts get `403`. Add the name or IP your clients use, including a Docker service name such as `pihole-mcp` if other containers call it. |
| `MCP_ALLOWED_ORIGINS` | none | Exact browser origins (e.g. `http://localhost:6274`) allowed to call the server. A request whose `Origin` header is present and not listed gets `403`. Requests without `Origin` (non-browser MCP clients) are unaffected. |
| `MCP_AUTH_TOKEN_FILE` | unset | Path to a file holding a bearer token (e.g. a Docker secret at `/run/secrets/mcp_auth_token`). When set, `/mcp` requires `Authorization: Bearer <token>` and answers `401` otherwise. Minimum 32 characters, no whitespace: `openssl rand -hex 32`. If the file is missing or empty the server refuses to start. |
| `MCP_AUTH_TOKEN` | unset | Same, read from the environment. Set only one of the two. Prefer the file form. |

The token is compared in constant time and is never logged. There is no CLI flag for it by design.

`/health` needs no token (so container health checks need no secret) and returns only static service metadata; the `Host` and `Origin` checks still apply to it.

Behind a reverse proxy that forwards `Host: 127.0.0.1`/`localhost`, the Host check cannot tell proxied traffic apart, so set a token there.

On a loopback bind the token is optional. On any other bind it is required unless you set `MCP_ALLOW_UNAUTHENTICATED=true`, in which case the server logs a warning at startup.

### Upgrading from 0.3.0 (behaviour change)

- The default `HOST` changed from `0.0.0.0` to `127.0.0.1`. A non-Docker install that relied on the old default, or sets `HOST=0.0.0.0` in `.env`, must now also set `MCP_ALLOW_NON_LOOPBACK=true`, or the server exits with an error saying so.
- **Docker users must act.** A non-loopback bind (which the image uses) now needs a bearer token: create `secrets/mcp_auth_token` and set `MCP_AUTH_TOKEN_FILE` (the example compose file does both), then send the token from your MCP client. Or set `MCP_ALLOW_UNAUTHENTICATED=true` to keep the old open behaviour. Without either, the container exits at startup with a message naming both options.
- `Host` headers are now validated. If clients reach the server by a LAN IP, hostname or Docker service name (rather than `localhost`/`127.0.0.1`), add it to `MCP_ALLOWED_HOSTS` or requests get `403 Invalid Host`.
- Requests from a browser origin not in `MCP_ALLOWED_ORIGINS` now get `403`.

## Health Check

```bash
curl http://localhost:3031/health
# {"ok":true,"service":"pihole-mcp","version":"0.3.0"}
```

`/health` is unauthenticated; see [HTTP transport security](#http-transport-security).

## Development

```bash
npm ci
npm run dev     # Watch mode — recompiles on save
npm start       # Run the server
npm test        # Build and run the unit tests (no Pi-hole needed)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the pull request and release process.

## Requirements

- Node.js >= 22 (Node 20 reached end of life on 2026-04-30). `npm test` also needs Node 21 or later, because `node --test` only expands glob patterns from then on; the 22 floor covers it.
- Pi-hole v6 with API access enabled
- Network connectivity to your Pi-hole instance(s)

## Related Projects

- [Pi-hole](https://pi-hole.net) — Network-wide ad blocking
- [Model Context Protocol](https://modelcontextprotocol.io) — Open standard for AI tool integration
- [MCP Server Registry](https://github.com/modelcontextprotocol/servers) — Directory of MCP servers

## License

MIT
