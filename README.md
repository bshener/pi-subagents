# pi-subagents

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that opens a
new visible pane in [Herdr](https://herdr.dev) and launches an isolated pi
**subagent** inside it. Each subagent runs its own model, gets its own system
prompt (from an agent file), and works until the task completes — then the pane
closes automatically.

Useful for offloading quick, well-defined tasks (refactors, lookups, formatting,
report drafting, etc.) to a dedicated worker without leaving your main session.

## Features

- Per-agent **model** + **system prompt** declared in a simple `AGENT.md` file.
- Lifecycle managed through Herdr's `agent start` / `prompt` / `read` API.
- Automatic pane open/close, focus control, split direction, and timeouts.
- Transient-start retry with backoff (a cold local model gets time to boot).

## Requirements

- [pi](https://github.com/earendil-works/pi-coding-agent) (the coding agent)
- [Herdr](https://herdr.dev) on your `PATH` (`HERDR_BIN` overrides the binary name)
- Node.js >= 18
- A configured model for the subagent(s) you run

## Installation

The extension reads its dependencies from `package.json`. Runtime imports are
`typebox` and `@earendil-works/pi-tui`; both are listed under `dependencies` so
`pi install` (which does a production install) keeps them. `@earendil-works/pi-coding-agent`
is a type-only import and stays in `devDependencies`.

### Option 1 — Install as a pi package (recommended)

```bash
pi install /absolute/path/to/pi-subagents
```

This bundles the package, reads the `"pi": { "extensions": ["./src/index.ts"] }`
entry, and makes the tools available in every project. Then reload pi:

```bash
/reload
```

### Option 2 — Global extension directory

Copy the whole repo (including `node_modules`) into the global extensions dir so
its dependencies resolve:

```bash
cp -r /absolute/path/to/pi-subagents ~/.pi/agent/extensions/pi-subagents
```

The entry point is `~/.pi/agent/extensions/pi-subagents/src/index.ts`. Reload pi
with `/reload`.

> Note: copy the directory rather than symlinking it if you want the bundled
> `node_modules` to travel with it. A symlink works too, because Node resolves
> dependencies from the real file location — but a copy is the most predictable.

### Option 3 — Dev / quick test (no install)

Run pi with the extension loaded from the repo (uses the repo's own
`node_modules`):

```bash
npm install
npm run dev        # == pi -e ./src/index.ts
```

This starts a new pi session with the extension active. Good for development and
testing; it does not persist across your normal sessions.

## Usage

Once installed, two tools become available to the model:

```
/pi-subagents --agent <id> "do the task"
/pi-subagents-list
```

On top of those, one **`/subagent:<agent-id>` slash command** is registered for
each discovered agent (project-local and global). They appear in the `/` menu
under the `subagent:` prefix, so you can fire an agent straight from the command
line without a tool call:

```
/subagent:ling-tiny-worker "Reformat these three files"
/subagent:tiel-coder-worker "Write a plan for X"
```

The command launches the agent in its own Herdr pane (same path as the
`/pi-subagents` tool) and reports launch + completion status as notifications.
Agents are discovered at load time from `process.cwd()`, so add a new agent to
`.pi/agents` (or the global dir) and reload pi to see its command.

> The examples below use slash-command syntax; pi also accepts the tool call form.

### `pi-subagents` parameters

| Parameter         | Required | Description                                                                      |
| ----------------- | -------- | -------------------------------------------------------------------------------- |
| `task`            | yes      | The task the subagent will perform.                                              |
| `agent`           | no       | Agent id (directory name under the agents dir). Loads its model + system prompt. |
| `model`           | no       | The model to use. Overrides the agent file and the current model.                |
| `cwd`             | no       | Working directory for the pane. Defaults to the current cwd.                     |
| `direction`       | no       | Pane split: right/left/up/down. Default: right.                                  |
| `focus`           | no       | Should the new pane take focus? Default: false.                                  |
| `closePaneOnDone` | no       | Close the pane when the task completes? Default: true.                           |
| `timeoutMs`       | no       | Maximum wait time in ms. Default: 360000 (6 min).                                |

Model precedence: `--model` flag > agent file > current model. If neither an
explicit `--model` nor an agent that declares a model is provided, the tool
refuses to silently inherit the current model.

### Examples

```bash
/pi-subagents "Update the README"
/pi-subagents --model "openai/gpt-5" --no-close "Test it and write the report"
/pi-subagents --agent ling-tiny-worker "Reformat these three files"
/pi-subagents-list
```

`/pi-subagents-list` groups agents by source directory (project-local
`<project>/.pi/agents` and global `~/.pi/agent/agents`) so you can see where each
agent is defined. Run it from the project directory to see both. If
`PI_SUBAGENTS_DIR` is set, that directory is shown instead.

`/pi-subagents` and `/pi-subagents-list` also accept the tool-call form
(`pi-subagents` / `pi-subagents-list` from the `/` menu), whereas the
`/subagent:<id>` commands are slash commands only.

## Agent files

Agents live in an **agents directory**. Each agent is a subdirectory named after
its id, containing a single `AGENT.md` file:

```text
<agents-dir>/
└── ling-tiny-worker/
    └── AGENT.md
```

`AGENT.md` has YAML frontmatter (metadata) followed by a markdown body (the
system prompt):

```markdown
---
name: ling-tiny-worker
description: Fast basic-task worker using the lightweight model.
model: llama-cpp2/Ling-Tiny
direction: right
closePaneOnDone: true
---

You are the ling-tiny-worker subagent. You run on the lightweight model, so you
are fast but not deep. Use yourself for simple, quick tasks ...
```

### Frontmatter fields

| Field             | Type    | Description                                        |
| ----------------- | ------- | -------------------------------------------------- |
| `name`            | string  | Agent display name. Defaults to the directory id.  |
| `description`     | string  | Shown in `/pi-subagents-list`.                     |
| `model`           | string  | Model used for this agent (`provider/id`).         |
| `direction`       | string  | Pane split direction (`right`/`left`/`down`/`up`). |
| `closePaneOnDone` | boolean | Close the pane on completion (`true`/`false`).     |

Everything after the `---` closing line is the agent's **system prompt** and is
passed to the subagent via `--append-system-prompt` (written to a temp file to
avoid shell-escaping issues with multiline content).

### USAGE.md (spawner contract, optional)

An agent directory may also contain a `USAGE.md` file next to `AGENT.md`:

```text
<agents-dir>/
└── my-worker/
    ├── AGENT.md   # runner instructions (the worker's system prompt)
    └── USAGE.md   # spawner instructions (for the parent agent)
```

`USAGE.md` is written **for the parent agent**, not the runner: recommended
`timeoutMs`, what the task must contain, known gotchas. The runner never reads
it. `pi-subagents-list` appends a `[+usage]` marker to agents that have one, so
the parent knows to read `<source-dir>/<agent-id>/USAGE.md` before spawning.

### Where the agents directory is resolved

Resolution order:

1. `PI_SUBAGENTS_DIR` environment variable (override).
2. `<project>/.pi/agents` (project-local) — used if it exists.
3. `~/.pi/agent/agents` (global).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run dev         # pi -e ./src/index.ts
```

## Security

Extensions run with your full system permissions and can execute arbitrary code.
Only install extensions from sources you trust.

## License

MIT
