# agent-driver

`agent-driver` is the standalone runtime driver for sandbox-hosted agent sessions. The core product is the Driver Kernel: runtime-neutral commands, events, host ports, provider backends, and the provider registry.

CMA is a compatibility surface layered on top of the Driver Kernel through projections. Provider backends must emit Driver runtime events and consume Driver commands; they must not emit CMA events directly.

## Package Entries

- Command `agent-driver`: Bun process runner, built to `dist/driver.mjs`.
- Package root `agent-driver`: Driver Kernel, provider registry, host ports, commands, events, diagnostics, and CMA projection exports.
- `agent-driver/boot`: process boot payload, protocol version, boot environment names, and host snapshot contracts.
- `agent-driver/runtime`: runtime-neutral runtime, transport, and native resume contracts.
- `agent-driver/paths`: sandbox path constants and path normalization helpers shared by host integrations.
- `agent-driver/events`: canonical driver event envelope contracts.
- `agent-driver/orpc`: sandbox-local driver RPC wire input/output contracts.
- `agent-driver/cma-http`: CMA-compatible HTTP surface.
- `agent-driver/cma-sdk`: thin CMA client.
- `agent-driver/testing`: public golden fixture manifest.

Every public entry has a matching declaration file under `dist/types`.

## Commands

```sh
bun install
bun run lint
bun run tc
bun run test
bun run build
bun run docker:build
```

`bun run docker:build` produces a local `agent-driver:local` image and installs `dist/driver.mjs` on the image `PATH` as `agent-driver`.

## Boundaries

- The Driver Kernel owns command dispatch, runtime event emission, provider lifecycle, permission flow, diagnostics, and host port contracts.
- Host applications own credential, file, skill, MCP, policy, logging, persistence, and transport implementations.
- Provider backends depend on Driver contracts and host ports only.
- The library root is safe to import and must not start the process runner.
- The package must not depend on Mosoo workspace packages at runtime.

## Checks

- `bun run lint`
- `bun run tc`
- `bun run test`
- `bun run build`
- `bun run docker:build`
- no `@mosoo/*` runtime dependencies in `package.json`
- public entries include typed exports
- golden fixtures are packaged under `tests/fixtures`
- live provider smoke tests are gated by environment credentials
