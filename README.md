# pihole-mcp

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes Pi-hole v6 admin API functionality as MCP tools. Designed for multi-instance deployments — manage one or many Pi-hole instances from a single MCP endpoint.

## Features

- **Multi-instance support** — configure 1 to N Pi-hole instances via environment variables
- **Full Pi-hole v6 API coverage** — query logs, allow/deny lists, group management, gravity reload, stats
- **Smart regex detection** — automatically routes domains to exact or regex lists based on metacharacter analysis
- **Regex landmine detector** — finds deny-exact entries that look like they should be regex (miscategorized rules)
- **Docker-ready** — multi-stage Dockerfile with non-root user, health checks, and security hardening
- **Streamable HTTP transport** — works with any MCP client that supports HTTP-based MCP

## Quick Start

### Docker (recommended)

```bash
# Clone and configure
git clone https://github.com/ranklancer/pihole-mcp-public.git
cd pihole-mcp-public
cp .env.example .env
# Edit .env with your Pi-hole URL(s) and password(s)

# Create secrets directory
mkdir -p secrets
echo "your-pihole-password" > secrets/pihole_password
chmod 600 secrets/pihole_password

# Build and run
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

### Node.js

```bash
npm install
npm run build
# Set environment variables (see .env.example)
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
PIHOLE_BASE_URL=http://192.168.1.100
PIHOLE_PASSWORD=your-password
```

### Multiple Instances

```env
PIHOLE_INSTANCES=primary,secondary
PRIMARY_BASE_URL=http://192.168.1.100
PRIMARY_PASSWORD=password1
SECONDARY_BASE_URL=https://192.168.1.101
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

Every tool accepts an optional `instance` parameter to target a specific Pi-hole. Defaults to the first configured instance.

## MCP Client Configuration

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
# {"ok":true,"service":"pihole-mcp","version":"0.2.0"}
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

## License

MIT
