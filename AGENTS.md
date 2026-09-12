# AGENTS.md — pi-subagents

AI collaborators working in this repo. Read this before editing. Short, Turkish
mix is fine, but keep code comments and commit messages in English.

## What this is

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that opens a
new visible pane in [Herdr](https://herdr.dev) and launches an isolated **subagent**
inside it. Each subagent runs its own model + system prompt (from an `AGENT.md`),
works until the task completes, then closes automatically. A concise summary flows
back to the caller's pane; the full transcript never does.

Entry point: `src/index.ts` (`"pi": { "extensions": ["./src/index.ts"] }`).

## Architecture (data flow)

```
pi calls tool "pi-subagents" (agent, task, ...)
  └─ execute(agent, task)        src/task.ts
       ├─ validate agent (guard)
       ├─ read <agent>/AGENT.md  → parse frontmatter (model, systemPrompt)
       ├─ write temp system-prompt file(s) from the markdown BODY
       └─ runTask():
            1. herdr pane split            (open pane)
            2. herdr agent start --kind pi (start pi in pane, retry transient)
            3. herdr agent prompt --wait   (submit task, block on terminal state)
            4. read bounded worker output tail  (so summary isn't lost)
            5. optionally close pane
```

`pi-subagents-list` is separate: `list.ts` scans two agent dirs and returns a
two-group string (Project vs Global); `index.ts` registers it as a tool, a
message renderer, and a `/pi-subagents-list` command.

## Key files

- `src/index.ts` — tool/command/renderer registration. Do not rename tools.
- `src/task.ts` — `execute()` + `runTask()`. The whole Herdr orchestration lives here.
- `src/list.ts` — agent discovery across the two dirs + text rendering.
- `src/herdr.ts` — `runHerdr()` wrapper, result/error parsing, temp files, sleep.
- `src/agents.ts` — `parseAgentManifest()` (YAML frontmatter + markdown body).
- `src/constants.ts` — `HERDR_BIN`, timeouts, `AGENT_FILENAME`, retry/backoff.
- `src/render.ts` — `renderCall` / `renderResult` (how tool calls/results display).
- `src/doctor.ts` — `/pi-subagents-doctor` reports whether the extension is loaded.

## `thinkingLevel` (tool arg + agent frontmatter)

- Tool arg `thinkingLevel` agent frontmatter `thinkingLevel`'ı ezer.
- Frontmatter `thinkingLevel` pi'nin kendi default'unu ezer; ikisi de yoksa pi
  eşzamanlı oturumun seviyesini korur (`--thinking`'a hiçbir şey gönderilmez).
- Değerler: `off | minimal | low | medium | high | xhigh | max` (pi'ye
  `herdr agent start ... -- --thinking <level>` olarak iletilir).

## Agent files (`AGENT.md`)

```
---
name: <id>
description: <one line, shown in tool schema>
model: <model id, or omit for "default">
thinkingLevel: off          # optional, per-agent default: off|minimal|low|medium|high|xhigh|max
direction: right            # optional, per-agent default split
closePaneOnDone: true       # optional
---
# markdown body = the agent's system prompt
```

Agent dirs scanned (run from a project dir to see both):

- Project: `<repo>/.pi/agents/<id>/AGENT.md`
- Global: `~/.pi/agent/agents/<id>/AGENT.md` (i.e. `os.homedir()/.pi/agent/agents`)
- Also honors `PI_SUBAGENTS_DIR` env override.

## Conventions / gotchas

- **ESM + `.ts` imports.** Modules import each other with `.ts` extensions and use
  `import type` for type-only exports (e.g. `SpFile`). Run code through pi's loader
  or `tsc`, NOT raw `node --experimental-strip-types` — raw node chokes on
  type-only value imports.
- **Never let a Node builtin error escape `execute`.** `path.join(agent, ...)` with
  an undefined `agent` throws `TypeError: The "path" argument must be of type
  string. Received undefined` — misleading and uncaught. Always validate `agent`
  up front and wrap filesystem/path work in try/catch.
- **The worker summary must not bloat the parent.** Read only a bounded tail
  (`WORKER_OUTPUT_LINES`), never the full transcript.
- **`agent start` is screen-detection based** and can fail transiently right after
  `pane split`. Retry only `agent_pane_busy`/`timeout` with backoff; do not treat
  other failures as retryable.
- Keep existing output formats, custom message types
  (`customType: "pi-subagents-list"`), and the two-group listing.
- Tool names (`pi-subagents`, `pi-subagents-list`) and command names are part of
  the public surface — don't rename without updating registration + docs.

## Build / verify

```bash
npm run typecheck     # tsc --noEmit — must pass before finishing
```

Install (so the tools appear in pi):

```bash
pi install /abs/path/to/pi-subagents   # bundles + makes tools available everywhere
/reload                                 # then reload pi
```

Or copy the whole repo (incl. `node_modules`) into the global extensions dir.

After any source change, the running extension must reload from source — if a tool
still errors after editing, reload/reinstall and restart pi so the new code loads.

## Debugging a broken tool

1. `/pi-subagents-doctor` — reports LOADED / NOT LOADED and which surfaces exist.
2. Check the session jsonl under `~/.pi/agent/sessions/` for the actual tool-call
   `arguments` vs the returned error. If arguments are present in the call but the
   tool reports them as undefined, the loaded code is stale — reload/reinstall.
3. Confirm the agent dir + `AGENT.md` exist; a missing agent file yields
   `Could not find agent file at <path>`.
