# pihole-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Pi-hole v6](https://img.shields.io/badge/Pi--hole-v6-red.svg)](https://pi-hole.net)
[![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-purple.svg)](https://modelcontextprotocol.io)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that gives AI assistants like **Claude** full control over your [Pi-hole v6](https://pi-hole.net) DNS ad-blocker - query logs, allow/deny lists, group management, gravity reload, and stats. Designed from day one for **multi-instance deployments**: manage one or many Pi-hole instances from a single MCP endpoint.

## Why?

Pi-hole's admin API is powerful but cumbersome to script against. This MCP server turns every Pi-hole API action into a tool that any MCP-compatible AI assistant can call directly. Instead of clicking through the admin UI or writing curl commands, just ask your AI to check what's being blocked, allowlist a domain, or compare stats across instances.

Perfect for **homelabbers** running multiple Pi-holes (primary + secondary, or per-VLAN), **network admins** managing DNS filtering at scale, and anyone who wants AI-assisted DNS management.

## Features

- **Multi-instance support** - configure 1 to N Pi-hole instances via environment variables
- **Full Pi-hole v6 API coverage** - query logs, allow/deny lists (full CRUD), group management, blocking control, local DNS (A + CNAME) records, gravity reload, stats
- **Smart regex detection** - automatically routes domains to exact or regex lists based on metacharacter analysis
- **Regex landmine detector** - finds deny-exact entries that look like they should be regex (miscategorized rules)
- **Docker-ready** - multi-stage Dockerfile with non-root user, health checks, and security hardening
- **Streamable HTTP transport** - works with any MCP client that supports HTTP-based MCP
- **Docker secrets support** - passwords via env vars or `/run/secrets/` files

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/ranklancer/pihole-mcp.git
cd pihole-mcp
cp .env.example .env
# Edit .env with your Pi-hole URL(s) and password(s)

mkdir -p secrets
echo "your-pihole-password" > secrets/pihole_password
chmod 600 secrets/pihole_password

cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

### Node.js

```bash
npm install
npm run build
export PIHOLE_INSTANCES=pihole
export PIHOLE_BASE_URL=http://pihole.example.com
export PIHOLE_PASSWORD=your-password
npm start
```

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
| `pihole_query_log` | Fetch query log with filters (limit, time range, client, domain, status) |
| `pihole_allow_domain` | Add to allowlist (auto-detects exact vs regex) |
| `pihole_deny_domain` | Add to denylist (auto-detects exact vs regex) |
| `pihole_list_allowlist` | List all allowlist entries (exact + regex merged) |
| `pihole_list_denylist` | List all denylist entries (exact + regex merged) |
| `pihole_stats_summary` | Get Pi-hole statistics summary |
| `pihole_reload_lists` | Trigger gravity reload |
| `pihole_group_management` | CRUD operations on Pi-hole groups |
| `pihole_check_regex_types` | Detect miscategorized regex in deny-exact list |
| `pihole_set_blocking` | Enable/disable blocking, with optional auto-revert timer |
| `pihole_domain_management` | Update or delete an allow/deny domain (completes CRUD) |
| `pihole_local_dns` | List/add/delete local DNS A records |
| `pihole_local_cname` | List/add/delete local CNAME records |

Every tool accepts an optional `instance` parameter to target a specific Pi-hole. Defaults to the first configured instance.

## Connecting to Your MCP Client

The server listens on `http://HOST:PORT/mcp` (default: `http://localhost:3000/mcp`).

### Claude Desktop / Claude Code

Add to your MCP settings:

```json
{
  "mcpServers": {
    "pihole": {
      "url": "http://localhost:3031/mcp"
    }
  }
}
```

### Supergateway (stdio wrapper)

If your MCP client only supports stdio transport, use [supergateway](https://github.com/supercorp-ai/supergateway):

```bash
npx -y supergateway --streamableHttp http://localhost:3031/mcp
```

## Health Check

```bash
curl http://localhost:3031/health
# {"ok":true,"service":"pihole-mcp","version":"0.3.0"}
```

## Development

```bash
npm install
npm run dev     # Watch mode — recompiles on save
npm start       # Run the server
```

## Requirements

- Node.js >= 20
- Pi-hole v6 with API access enabled
- Network connectivity to your Pi-hole instance(s)

## Related Projects

- [Pi-hole](https://pi-hole.net) — Network-wide ad blocking
- [Model Context Protocol](https://modelcontextprotocol.io) — Open standard for AI tool integration
- [MCP Server Registry](https://github.com/modelcontextprotocol/servers) — Directory of MCP servers

## License

MIT
