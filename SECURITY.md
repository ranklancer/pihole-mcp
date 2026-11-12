# Security Policy

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Instead, report them privately using GitHub's
[private security advisory](https://github.com/ranklancer/pihole-mcp/security/advisories/new)
feature. You should receive an acknowledgement within a reasonable time, and we
will keep you informed as the issue is investigated and resolved.

When reporting, please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept if possible)
- Any known mitigations

## Supported Versions

This project is developed on a rolling basis; fixes are applied to the latest
release. Please make sure you are running the most recent version before
reporting.

## Deployment hardening

The HTTP transport binds `127.0.0.1` by default, validates the `Host` and
`Origin` headers, and supports a bearer token (`MCP_AUTH_TOKEN_FILE`). Set a
token whenever the port is reachable from anything other than the local
machine. See [HTTP transport security](README.md#http-transport-security).
