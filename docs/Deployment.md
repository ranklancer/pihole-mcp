# Deployment

The recommended path is to pull the prebuilt multi-arch image from GHCR — no
local build. Images are published on every release by
[`.github/workflows/docker.yml`](../.github/workflows/docker.yml).

```bash
docker pull ghcr.io/ranklancer/pihole-mcp:0.3.0   # or :latest
```

## Docker Compose

The build/deploy files live in the repo root:

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build (build context is the **repo root**). |
| `docker-compose.example.yml` | Example stack: builds the image, publishes the MCP port, passwords via Docker secrets, hardened (`cap_drop: ALL`, `no-new-privileges`). |
| `.env.example` | Template for instance names + base URLs (non-secret). |

### Steps

```bash
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env
# Edit .env with your instance names and base URLs.

mkdir -p secrets
printf '%s' 'your-pihole-password' > secrets/pihole_password
chmod 600 secrets/pihole_password

docker compose up -d
```

To pull the prebuilt GHCR image instead of building locally, replace the
`build:` block in `docker-compose.yml` with
`image: ghcr.io/ranklancer/pihole-mcp:latest` and run `docker compose pull`
before `up`.

Passwords are provided as Docker secrets (files under `secrets/`), which the
server reads from `/run/secrets/<instance>_password`. See the README for the
instance-naming rules.

## Building from source

```bash
docker build -f Dockerfile -t pihole-mcp:local .
```

## Verify a deploy

```bash
curl http://<host>:<port>/health
# {"ok":true,"service":"pihole-mcp","version":"0.3.0"}

docker ps --filter name=pihole-mcp --format '{{.ID}}  {{.Image}}  {{.Status}}'
# The container ID must change after a real redeploy — a restart alone keeps
# the old ID.
```

The example compose publishes the MCP port on the host (edit the `ports:`
mapping to suit your network). Then connect your MCP client directly (no
`mcp-remote` proxy needed):

```json
{ "mcpServers": { "pihole": { "url": "http://<host>:<port>/mcp" } } }
```

## Networking

`pihole-mcp` runs on a Docker **bridge** network and publishes its port to the
host. Whether it can reach a given Pi-hole depends on where that Pi-hole sits
relative to this container:

- **Pi-hole on a different host** (its own LAN IP) — reachable normally, no
  special setup.
- **Pi-hole on the _same host_, attached to a macvlan / `br0` network** — a
  bridge container **cannot** reach a macvlan container on the same host (Linux
  macvlan isolation). Calls fail with `connect EHOSTUNREACH <ip>:80`. Fix it at
  the host level, not by changing the base URL:
  - **Unraid:** Settings -> Docker -> **"Host access to custom networks" =
    Enabled**. This creates a macvlan shim so the host — and bridge containers
    routed through it — can reach macvlan containers. If Unraid warns about
    macvlan stability, switch **"Docker custom network type"** to **ipvlan**.
  - **Plain Docker:** add a macvlan shim interface on the host with a route to
    the macvlan subnet.

> **Do not "dual-home"** `pihole-mcp` by also attaching it to the macvlan
> network. Joining macvlan moves the container's default gateway off the bridge,
> so replies to the published host port take an asymmetric path and the endpoint
> stops responding (health check still passes internally, but the port refuses
> or times out from outside). Keep `pihole-mcp` **bridge-only** and use the host
> shim above.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `connect EHOSTUNREACH <ip>:80` | Network path to the Pi-hole is blocked — commonly same-host bridge<->macvlan isolation. Not a password problem. | See [Networking](#networking). |
| `auth failed: password incorrect` | The Pi-hole rejected the exact string sent. Passwords are read from the secret file (or a `<NAME>_PASSWORD` env var, which **overrides** the file) **once at startup** and `.trim()`-ed. | Verify the value first: `curl -sk -X POST http://<ip>/api/auth -H 'content-type: application/json' -d '{"password":"..."}'` -> expect `"valid":true`. Then put that exact string in the secret file and **recreate** the container so it re-reads. |
| Password looks right in the file but is still rejected | Single-file bind-mounted secrets go **stale** when replaced by an editor (the running container is pinned to the old inode), and the server caches the password at startup. | Recreate — don't just edit/restart: `docker rm -f pihole-mcp && docker compose up -d`. Confirm what the container actually reads with `docker exec pihole-mcp cat /run/secrets/<name>_password`. |

> Base URLs must be the Pi-hole **root** (e.g. `http://198.51.100.10`). The
> server appends `/api/auth` and the other v6 API paths itself — do **not** point
> a base URL at `/admin` or `/admin/login`.
