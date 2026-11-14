# Contributing

Thanks for your interest in contributing!

## Development

```bash
npm ci          # install exact, locked dependencies
npm run build   # compile TypeScript
npm run lint    # eslint
npm test        # build, then run the unit tests (needs no Pi-hole)
```

## Pull Requests

- Create a topic branch from `main` (e.g. `feat/...`, `fix/...`, `chore/...`).
- Keep changes focused; one logical change per PR.
- Ensure the project builds and `npm test` passes before opening a PR.
- All changes land via pull request and require review — direct pushes to
  `main` are disabled.
- Use clear, conventional commit messages (e.g. `feat:`, `fix:`, `chore:`,
  `docs:`, `ci:`).

## Supported Node versions

`engines.node` is `>=22`. The CI matrix must only list versions at or above that floor; do not raise `engines` past a version CI does not test. `npm test` relies on `node --test` expanding a glob, which needs Node 21 or later; the floor of 22 satisfies this. The Docker image uses `node:22-alpine`, which must stay at or above the floor.

## Releasing

1. Bump `version` in `package.json` and `server.json` (both the top-level and the `packages[]` entry) and the `version` strings in `src/index.ts`, and land the bump through a normal pull request.
2. Publish a GitHub Release tagged `vX.Y.Z`. The `docker.yml` workflow runs on `release: published` and pushes `ghcr.io/ranklancer/pihole-mcp` tagged `X.Y.Z`, `X.Y` and `latest`.
3. Publish to npm from a clean checkout of the tag: `npm ci && npm publish --access public` (`prepublishOnly` runs the build). There is currently no workflow in this repository that publishes to npm, so this step is manual.

## Reporting Issues

Use the issue templates. For security-sensitive reports, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
