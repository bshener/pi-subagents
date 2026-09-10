# Plan: Split `index.ts` into Logical TS Modules

## Goal

Break the ~806-line `index.ts` into focused modules by responsibility. The
extension entry point (`default function (pi)`) stays as the thin wiring file;
all helpers, types, and command implementations move into `src/`.

**Constraint: plan only. Do not execute any changes.**

---

## Current Module Layout (what lives in `index.ts` today)

| Group | Symbols |
|-------|---------|
| Constants | `HERDR_BIN`, `DEFAULT_TIMEOUT_MS`, `AGENT_FILENAME`, `CLOSE_RETRY_MS`, `WORKER_OUTPUT_LINES`, `TRANSIENT_START_ERRORS`, `MAX_START_ATTEMPTS`, `START_BACKOFF_MS` |
| Parsing helpers | `parseHerdrErrorCode`, `parseHerdrResult` |
| Types | `PiSubagentsParams`, `LoadedAgent`, `SpFile` |
| Low-level runner | `sleep`, `runHerdr`, `writeTempSystemPrompt`, `cleanupSpFiles` |
| Agent FS ops | `parseAgentManifest`, `resolveAgentsDir`, `findProjectAgentsDir`, `discoverAgentsIn`, `loadAgent` |
| Terminal I/O | `readAgentOutput`, `isPaneClosed` |
| Task lifecycle | `execute`, `runTask` |
| List tool | `formatAgentLine`, `agentsBySourceText`, `listAgentsBySource` |
| Entry | `export default function (pi)` + tool/command registration |

---

## Target Module Split

```
index.ts                     -> src/index.ts        (entry: registerTool/registerCommand wiring)
index.ts                     -> src/constants.ts    (module-level constants)
index.ts                     -> src/types.ts        (interfaces + shared param types)
index.ts                     -> src/herdr.ts        (subprocess wrapper layer)
index.ts                     -> src/agents.ts       (agent manifest + discovery)
index.ts                     -> src/task.ts         (execute + runTask)
index.ts                     -> src/list.ts         (list tool)
```

### `src/constants.ts`

Move all top-level `const` declarations:
`HERDR_BIN`, `DEFAULT_TIMEOUT_MS`, `AGENT_FILENAME`, `CLOSE_RETRY_MS`,
`WORKER_OUTPUT_LINES`, `TRANSIENT_START_ERRORS`, `MAX_START_ATTEMPTS`,
`START_BACKOFF_MS`.

### `src/types.ts`

Move the interfaces: `PiSubagentsParams`, `LoadedAgent`, `SpFile`.
Optionally also define the shared return-shape types here
(`ExecuteResult`, `RunTaskResult`, `PaneInfo`) so `task.ts` and `herdr.ts`
share them without circular imports.

### `src/herdr.ts`

The subprocess + temp-file layer (no knowledge of pi tools):
`sleep`, `runHerdr`, `parseHerdrErrorCode`, `parseHerdrResult`,
`writeTempSystemPrompt`, `cleanupSpFiles`, `readAgentOutput`, `isPaneClosed`.
Imports: `constants`, `types`.

### `src/agents.ts`

Agent filesystem logic:
`parseAgentManifest`, `resolveAgentsDir`, `findProjectAgentsDir`,
`discoverAgentsIn`, `loadAgent`.
Imports: `constants` (`AGENT_FILENAME`), `herdr` (only if `discoverAgentsIn`
needs it — it does not; keep this module herdr-free).

### `src/task.ts`

The execution path: `execute` and `runTask`.
Imports: `constants`, `types`, `herdr`, `agents`.
This is the largest module; keep `execute` (validation + model precedence +
temp-prompt wiring) and `runTask` (pane split → agent start w/ retry → prompt
→ terminal-state wait → read output → close pane) together since they are
tightly coupled.

### `src/list.ts`

The listing path: `formatAgentLine`, `agentsBySourceText`,
`listAgentsBySource`.
Imports: `constants`, `agents` (`discoverAgentsIn`), `types`.

### `src/index.ts` (entry)

Keep only the `export default function (pi)` extension registration:

- `registerTool("pi-subagents", ...)` → `execute` from `task.ts`
- `registerTool("pi-subagents-list", ...)` → `listAgentsBySource` from `list.ts`
- `registerMessageRenderer` + `registerCommand` → `agentsBySourceText` from `list.ts`

All the `Type.Object(...)` parameter schemas and the `renderCall`/`renderResult`
helpers stay inline here (they are per-tool registration concerns). Optionally
lift the two render helpers into a small `src/render.ts` if they grow.

---

## Import Graph (acyclic)

```
constants  ← everything
types      ← everything
herdr      ← constants, types
agents     ← constants
list       ← constants, agents, types
task       ← constants, types, herdr, agents
index      ← task, list, render (entry only)
```

No circular dependencies: `task` and `list` are leaf command modules; nothing
imports them except the entry point.

---

## Changes Needed Beyond Moving Code

1. **`package.json`** — update `main`, `pi.extensions`, and `dev` script from
   `./index.ts` to `./src/index.ts` (or keep `index.ts` at root re-exporting
   from `src/index.ts`).
2. **`tsconfig.json`** — change `include` from `["index.ts"]` to
   `["src"]` (or `["src/**/*.ts"]`).
3. **Re-exports** — decide whether to keep a root `index.ts` shim
   (`export { default } from "./src/index"`) so the extension path is unchanged,
   or move the entry to `src/index.ts` and update `package.json`. Recommend the
   shim to minimize surface change.

---

## Verification Plan (after implementation — not part of this plan)

- `npm run typecheck` (`tsc --noEmit`) passes.
- `node -e "import('./src/index.ts')"` (or via `pi -e`) still loads the
  extension and both tools register.
- Functional smoke test of `/pi-subagents` and `/pi-subagents-list` unchanged.

---

## Risk Notes

- `execute` and `runTask` share a lot of inline logic and comments; splitting
  them into two files is optional — they could stay together as `src/execute.ts`.
  The plan keeps them in one `task.ts` because they are one logical flow.
- The long explanatory comments (transient-start retry, backchannel/no-bloat
  design) travel with their functions; keep them attached to preserve intent.
