# The transport bug (why the upstream server never worked)

This document records the fatal HTTP-transport bug that made the server unusable
with `mcp-remote` and any client that initializes more than once, and the fix
that shipped in v0.3.0 (PR #7).

## Root cause

`src/index.ts` created a single `StreamableHTTPServerTransport` in **stateful**
mode at module load and connected it once at startup:

```ts
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => crypto.randomUUID(),
});
await server.connect(transport);
```

A stateful `StreamableHTTPServerTransport` accepts exactly one `initialize` for
its lifetime. Every later one is rejected with:

```
-32600  Invalid Request: Server already initialized
```

`mcp-remote` is a proxy: it initializes its own upstream client connection
(claiming the only session), then forwards the downstream client's
`initialize` — which always fails. `mcp-remote` treats this as fatal and exits,
so no tools ever register. The failure is deterministic; restarting the
container cannot help, because the first client to connect consumes the session.

## Fix

Each `/mcp` request now gets a fresh `Server` + `StreamableHTTPServerTransport`
pair in **stateless** mode (`sessionIdGenerator: undefined`), torn down on
`res.on('close')`. The tool handlers were moved into a `createServer()` factory;
no tool behavior changed. Repeated `initialize` calls now succeed, so
`mcp-remote` and direct HTTP MCP clients connect and register all tools.

## Verification

Two consecutive `initialize` calls both succeed (the second previously returned
`-32600`), and `tools/list` returns the full tool set:

```
init#1 -> {"result":{...,"serverInfo":{"name":"pihole-mcp","version":"0.3.0"}},"id":1}
init#2 -> {"result":{...,"serverInfo":{"name":"pihole-mcp","version":"0.3.0"}},"id":1}
```

This fix was contributed by @rhamblen and merged as
[#7](https://github.com/ranklancer/pihole-mcp/pull/7).
