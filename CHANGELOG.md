# Changelog

## Unreleased

### Security

- HTTP transport hardening ([#43](https://github.com/ranklancer/pihole-mcp/issues/43)):
  - **Behaviour change:** `HOST` now defaults to `127.0.0.1` (was `0.0.0.0`). Binding any
    non-loopback address requires `MCP_ALLOW_NON_LOOPBACK=true`; without it the server exits
    with an error. The Docker image and example compose file set it explicitly.
  - **Behaviour change:** the `Host` header is validated against `MCP_ALLOWED_HOSTS`
    (default `localhost,127.0.0.1,[::1]`) using the MCP SDK's `hostHeaderValidation`
    middleware; other hosts get `403`.
  - **Behaviour change:** a request whose `Origin` header is present and not listed in
    `MCP_ALLOWED_ORIGINS` gets `403`, as the MCP Streamable HTTP specification requires.
  - Optional bearer token on `/mcp` via `MCP_AUTH_TOKEN_FILE` or `MCP_AUTH_TOKEN`
    (minimum 32 characters, constant-time comparison, never logged). `/health` stays
    unauthenticated.
