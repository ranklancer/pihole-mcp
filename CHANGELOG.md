# Changelog

## Unreleased

### Security

- HTTP transport hardening ([#43](https://github.com/ranklancer/pihole-mcp/issues/43)):
  - **Behaviour change:** `HOST` now defaults to `127.0.0.1` (was `0.0.0.0`). Binding any
    non-loopback address requires `MCP_ALLOW_NON_LOOPBACK=true`; without it the server exits
    with an error. The Docker image and example compose file set it explicitly.
  - **Behaviour change:** a non-loopback bind also requires a bearer token unless
    `MCP_ALLOW_UNAUTHENTICATED=true`. Docker users must create `secrets/mcp_auth_token`
    and set `MCP_AUTH_TOKEN_FILE` (the example compose file does), or opt out explicitly.
  - **Behaviour change:** the `Host` header is validated using the MCP SDK's
    `hostHeaderValidation` middleware. `localhost`, `127.0.0.1` and `[::1]` are always
    accepted; add others with `MCP_ALLOWED_HOSTS`. Other hosts get `403`.
  - **Behaviour change:** a request whose `Origin` header is present and not listed in
    `MCP_ALLOWED_ORIGINS` gets `403`, as the MCP Streamable HTTP specification requires.
  - Bearer token on `/mcp` via `MCP_AUTH_TOKEN_FILE` or `MCP_AUTH_TOKEN` (minimum 32
    characters, constant-time comparison, never logged). `/health` stays unauthenticated.
  - Compressed request bodies are refused (`415`).
