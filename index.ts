import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERDR_BIN = process.env.HERDR_BIN ?? "herdr";
const DEFAULT_TIMEOUT_MS = 360_000; // 3 minutes
const AGENT_FILENAME = "AGENT.md";
// How long to wait before retrying a close that raced with the agent exiting.
const CLOSE_RETRY_MS = 400;

// `agent start` readiness is screen-detection based: Herdr only succeeds once
// pi has fully launched and rendered inside the freshly split pane. Right after
// `pane split` the pane's shell is still coming up, so the first attempt often
// fails with a transient error. These codes mean "pi isn't ready yet" (as
// opposed to a real misconfiguration), so we retry them with backoff instead of
// abandoning the already-allocated pane — which would leave a ghost/host pane.
// The per-attempt readiness timeout is left to Herdr's default (30s) on purpose:
// a cold llama.cpp model can take a while, and shortening it would regress the
// cold-start case that the original default handled fine.
const TRANSIENT_START_ERRORS = new Set(["agent_pane_busy", "timeout"]);
const MAX_START_ATTEMPTS = 3; // bounds worst case to ~3×30s if pi never starts
const START_BACKOFF_MS = 1_500;

/** Extracts the `error.code` string from a herdr JSON error payload, if any. */
function parseHerdrErrorCode(stdout: string): string | undefined {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  if (!line) return undefined;
  try {
    return JSON.parse(line)?.error?.code;
  } catch {
    return undefined;
  }
}

interface PiSubagentsParams {
  /** Name of an agent directory under the agents dir (matches the folder name). */
  agent?: string;
  /** The task the subagent will perform (the user prompt). */
  task: string;
  /** The model to use. Order of precedence: this flag > agent file > current model. */
  model?: string;
  /** Working directory for the pane. If omitted, the current cwd is used. */
  cwd?: string;
  /** Pane split direction: right | left | down | up. */
  direction?: string;
  /** Should the new pane take focus? false = does not steal focus. */
  focus?: boolean;
  /** Close the pane (and pi agent) when the task completes? */
  closePaneOnDone?: boolean;
  /** Maximum wait time in ms. */
  timeoutMs?: number;
}

interface LoadedAgent {
  id: string;
  name: string;
  description: string;
  model?: string;
  systemPrompt?: string;
  direction?: string;
  closePaneOnDone?: boolean;
}

/** Parses the single-line JSON output and returns the result.<field> value. */
function parseHerdrResult<T>(stdout: string, field: string): T | undefined {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  if (!line) return undefined;
  try {
    const obj = JSON.parse(line);
    return obj?.result?.[field] as T | undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function runHerdr(args: Array<string>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const proc = spawn(HERDR_BIN, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", () => resolve({ code: 127, stdout: "", stderr: err }));
    proc.on("close", (code) =>
      resolve({ code: code ?? 0, stdout: out, stderr: err }),
    );
  });
}

async function writeTempSystemPrompt(content: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagents-"),
  );
  const file = path.join(dir, "system-prompt.md");
  await fs.promises.writeFile(file, content, "utf8");
  return file;
}

/** Deletes every owned (extension-created) temp file in the list. */
async function cleanupSpFiles(spFiles: SpFile[]): Promise<void> {
  for (const f of spFiles) {
    if (f.owned && f.path) await fs.promises.unlink(f.path).catch(() => {});
  }
}

/** Returns true once the pane no longer exists in herdr (i.e. it was closed). */
async function isPaneClosed(paneId: string): Promise<boolean> {
  const { stdout } = await runHerdr(["pane", "list"]);
  const panes = parseHerdrResult<{ pane_id: string }[]>(stdout, "panes");
  return !panes?.some((p) => p.pane_id === paneId);
}

/** Minimal YAML-frontmatter + markdown-body parser (no external dependency). */
function parseAgentManifest(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

/** Resolves the agents directory (env override > project-local .pi/agents > ~/.pi/agent/agents). */
function resolveAgentsDir(cwd: string): string {
  if (process.env.PI_SUBAGENTS_DIR) return process.env.PI_SUBAGENTS_DIR;
  const projectLocal = path.join(cwd, ".pi", "agents");
  const globalDir = path.join(os.homedir(), ".pi", "agent", "agents");
  return fs.existsSync(projectLocal) ? projectLocal : globalDir;
}

/** Lists agent definitions discovered in a single agents directory. */
async function discoverAgents(
  dir: string,
): Promise<
  Array<{ id: string; name: string; description: string; model?: string }>
> {
  return discoverAgentsIn(dir);
}

/** Shared implementation used by both discoverAgents and the list tool. */
async function discoverAgentsIn(
  dir: string,
): Promise<
  Array<{ id: string; name: string; description: string; model?: string }>
> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const agents: Array<{
    id: string;
    name: string;
    description: string;
    model?: string;
  }> = [];
  for (const entry of entries.sort()) {
    const agentFile = path.join(dir, entry, AGENT_FILENAME);
    let content: string;
    try {
      content = await fs.promises.readFile(agentFile, "utf8");
    } catch {
      continue; // Not an agent directory (no AGENT.md).
    }
    const { meta } = parseAgentManifest(content);
    agents.push({
      id: entry,
      name: meta.name ?? entry,
      description: meta.description ?? "",
      model: meta.model,
    });
  }
  return agents;
}

/** Loads a single agent by id (directory name under the agents dir). */
async function loadAgent(id: string, dir: string): Promise<LoadedAgent | null> {
  const file = path.join(dir, id, AGENT_FILENAME);
  let content: string;
  try {
    content = await fs.promises.readFile(file, "utf8");
  } catch {
    return null;
  }
  const { meta, body } = parseAgentManifest(content);
  let closePaneOnDone: boolean | undefined;
  if (meta.closePaneOnDone !== undefined) {
    closePaneOnDone = meta.closePaneOnDone !== "false";
  }
  return {
    id,
    name: meta.name ?? id,
    description: meta.description ?? "",
    model: meta.model,
    systemPrompt: body.trim() || undefined,
    direction: meta.direction,
    closePaneOnDone,
  };
}

interface SpFile {
  path: string;
  /** true = this extension created the file and should delete it after. */
  owned: boolean;
}

async function execute(
  _id: string,
  params: PiSubagentsParams,
  _signal: AbortSignal | undefined,
  _onUpdate: (data: unknown) => void,
  ctx: { cwd: string; model?: { provider?: string; id?: string } },
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: {
    paneId?: string;
    model?: string;
    agent?: string;
    done?: boolean;
    closed?: boolean;
  };
}> {
  if (!params.task?.trim()) {
    return {
      content: [
        { type: "text", text: "pi-subagents: 'task' cannot be empty." },
      ],
      details: {},
    };
  }

  const cwd = params.cwd ?? ctx.cwd;
  const dir = resolveAgentsDir(cwd);

  // Resolve the agent (if requested) and merge its config.
  const agent = params.agent ? await loadAgent(params.agent, dir) : null;
  if (params.agent && !agent) {
    return {
      content: [
        {
          type: "text",
          text: `pi-subagents: unknown agent "${params.agent}". Run /pi-subagents-list-agents to see available agents.`,
        },
      ],
      details: {},
    };
  }

  // Model precedence: --model flag > agent file (md) > the current model.
  const currentModel = ctx.model?.id
    ? ctx.model.provider
      ? `${ctx.model.provider}/${ctx.model.id}`
      : ctx.model.id
    : undefined;

  // Guard: if neither an explicit --model nor an agent that declares a model
  // was provided, refuse to silently fall back to the current model. That
  // fallback usually means the caller forgot to pass --agent or --model, so
  // the subagent would silently inherit the wrong model (e.g. inherit the
  // orchestrator's own model instead of the agent's declared one).
  if (!params.model && !agent?.model) {
    return {
      content: [
        {
          type: "text",
          text: `pi-subagents: no model specified. Pass --agent <id> (which declares a model) or --model <provider/id>. Refusing to silently inherit the current model ("${currentModel ?? "<none>"}")`,
        },
      ],
      details: {},
    };
  }

  // At least one of --model / agent.model is guaranteed by the guard above.
  const model = params.model ?? agent?.model ?? currentModel;
  if (!model) {
    return {
      content: [
        {
          type: "text",
          text: `pi-subagents: no model. Set one via --model or in the agent file (${dir}/${params.agent ?? "<id>"}/AGENT.md).`,
        },
      ],
      details: {},
    };
  }
  const direction = params.direction ?? agent?.direction ?? "right";
  const focus = params.focus ?? false;
  const closePaneOnDone =
    params.closePaneOnDone ?? agent?.closePaneOnDone ?? true;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Build the system prompt files to pass to pi (--append-system-prompt).
  // The agent's system prompt is the markdown BODY of its md file (everything
  // after the YAML frontmatter), so we write that body to a temp file rather
  // than passing the whole md — passing the whole file would inject the
  // frontmatter metadata (name/description/model/...) into the prompt.
  const spFiles: SpFile[] = [];
  if (agent?.systemPrompt) {
    const agentSp = await writeTempSystemPrompt(agent.systemPrompt);
    spFiles.push({ path: agentSp, owned: true });
  }

  try {
    const res = await runTask(
      {
        cwd,
        model,
        direction,
        focus,
        closePaneOnDone,
        timeoutMs,
      },
      spFiles,
      params.task,
    );
    // Always remove the temp system-prompt files we created, whatever happened.
    await cleanupSpFiles(spFiles);
    return res;
  } catch (err) {
    await cleanupSpFiles(spFiles);
    return {
      content: [
        {
          type: "text",
          text: `pi-subagents: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
      details: {},
    };
  }
}

async function runTask(
  opts: {
    cwd: string;
    model: string;
    direction: string;
    focus: boolean;
    closePaneOnDone: boolean;
    timeoutMs: number;
  },
  spFiles: SpFile[],
  task: string,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: {
    paneId?: string;
    model?: string;
    agent?: string;
    done?: boolean;
    closed?: boolean;
  };
}> {
  // Generate a unique agent name (max 32 chars, must match [a-z][a-z0-9_-]*)
  const agentName = `subagent-${Date.now().toString(36)}`.slice(0, 32);

  // 1) Open a new pane via split.
  const splitArgs = [
    "pane",
    "split",
    "--direction",
    opts.direction,
    "--cwd",
    opts.cwd,
    opts.focus ? "--focus" : "--no-focus",
  ];
  const { stdout, stderr, code } = await runHerdr(splitArgs);
  if (code !== 0) {
    return {
      content: [
        {
          type: "text",
          text: `pi-subagents: pane split failed: ${stderr || stdout}`,
        },
      ],
      details: {},
    };
  }
  const pane = parseHerdrResult<{ pane_id: string }>(stdout, "pane");
  const paneId = pane?.pane_id;
  if (!paneId) {
    return {
      content: [
        {
          type: "text",
          text: `pi-subagents: could not parse pane_id: ${stdout}`,
        },
      ],
      details: {},
    };
  }

  // 2) Start a named pi agent in the pane using Herdr's agent start command.
  //    --kind pi selects the canonical pi executable; -- passes remaining args
  //    through to pi itself (--model, --append-system-prompt, etc.).
  const piArgsAfterDashes = ["--model", opts.model];
  for (const f of spFiles) {
    if (f.path) piArgsAfterDashes.push("--append-system-prompt", f.path);
  }
  const buildStartArgs = () => [
    "agent",
    "start",
    agentName,
    "--kind",
    "pi",
    "--pane",
    paneId,
    "--",
    ...piArgsAfterDashes,
  ];

  //    (retry) Start a named pi agent in the pane. The pane's shell is still
  //    coming up right after `pane split`, so readiness (screen-detection based)
  //    can fail transiently. Retry `agent_pane_busy`/`timeout` with backoff so
  //    pi has a chance to finish starting instead of leaving the pane as a ghost.
  let startOut = "";
  let startErr = "";
  let startCode = 0;
  let startAttempt = 0;
  for (; startAttempt < MAX_START_ATTEMPTS; startAttempt++) {
    const r = await runHerdr(buildStartArgs());
    startOut = r.stdout;
    startErr = r.stderr;
    startCode = r.code;
    if (startCode === 0) break;
    const errCode = parseHerdrErrorCode(startErr || startOut);
    const transient = errCode ? TRANSIENT_START_ERRORS.has(errCode) : false;
    if (!transient || startAttempt === MAX_START_ATTEMPTS - 1) break;
    await sleep(START_BACKOFF_MS * (startAttempt + 1));
  }
  if (startCode !== 0) {
    return {
      content: [
        {
          type: "text",
          text: `pi-subagents: agent start failed (after ${startAttempt + 1} attempt(s)): ${startErr || startOut}`,
        },
      ],
      details: {},
    };
  }

  // 3) Submit the task and block until the worker reaches a terminal state.
  //    The worker sends its concise summary DIRECTLY to the orchestrator's pane
  //    (per the worker's AGENT.md rule) via `herdr agent prompt '<PARENT_PANE_ID>'`.
  //    The parent pane ID is embedded in the task BY THE ORCHESTRATOR (it knows
  //    its own pane ID from HERDR_PANE_ID), so the orchestrator never reads the
  //    worker's full transcript — only the short summary flows up, so there is no
  //    context bloat. This tool itself does NOT inject the instruction, because it
  //    cannot reliably determine the parent pane ID (the herdr caller env is not
  //    guaranteed here); the agent-level rule is the reliable mechanism.
  const promptArgs = [
    "agent",
    "prompt",
    agentName,
    task,
    "--wait",
    "--timeout",
    String(opts.timeoutMs),
  ];
  const { code: promptCode } = await runHerdr(promptArgs);

  // Explicitly confirm the terminal state (prompt --wait can be lenient on
  // timeouts) before reading the summary.
  const terminalStates = new Set(["idle", "done", "blocked"]);
  const deadline = Date.now() + opts.timeoutMs;
  let agentStatus = "working";
  for (;;) {
    if (Date.now() >= deadline) break;
    const g = await runHerdr(["agent", "get", agentName]);
    const m = /"agent_status"\s*:\s*"(\w+)"/.exec(g.stdout || "");
    agentStatus = m ? m[1] : agentStatus;
    if (terminalStates.has(agentStatus)) break;
    await sleep(1000);
  }
  const done = promptCode === 0 || terminalStates.has(agentStatus);

  // 4) Optionally close the pane / agent. The worker already sent its summary to
  //    the orchestrator's pane via backchannel (see step 3), so there is nothing
  //    to read here — reading the worker's pane would defeat the no-bloat design.

  let closed = false;
  if (opts.closePaneOnDone) {
    await runHerdr(["pane", "close", paneId]);
    closed = await isPaneClosed(paneId);
    if (!closed) {
      await sleep(CLOSE_RETRY_MS);
      await runHerdr(["pane", "close", paneId]);
      closed = await isPaneClosed(paneId);
    }
  }

  const status = `pi-subagents: pane ${paneId} • ${opts.model} • agent ${agentName} • ${
    done ? "task completed" : "timed out"
  } • ${opts.closePaneOnDone ? (closed ? "pane closed" : "pane still open") : "pane open"}`;

  // The worker sends its summary directly to the orchestrator's pane (backchannel);
  // this tool returns only a status. The orchestrator consumes the summary from its
  // own pane and must NOT re-read the worker's pane (that would reintroduce bloat).
  const text = done
    ? status
    : `${status}\n\nNote: the worker did not reach a terminal state in time; its summary may be incomplete.`;

  return {
    content: [{ type: "text", text }],
    details: {
      paneId,
      model: opts.model,
      agent: agentName,
      done,
      closed,
    },
  };
}

async function listAgents(
  _id: string,
  _params: unknown,
  _signal: AbortSignal | undefined,
  _onUpdate: (data: unknown) => void,
  ctx: { cwd: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: {} }> {
  const dir = resolveAgentsDir(ctx.cwd);
  const agents = await discoverAgents(dir);
  if (agents.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No agents found in ${dir}. Create a <agent-id>/AGENT.md file there with YAML frontmatter (name, description, model) and a system prompt in the body.`,
        },
      ],
      details: {},
    };
  }
  const lines = agents.map(
    (a) =>
      `• ${a.id} — ${a.name}${a.description ? `: ${a.description}` : ""}${a.model ? ` [model: ${a.model}]` : ""}`,
  );
  return {
    content: [
      {
        type: "text",
        text: `Agents available in ${dir}:\n${lines.join("\n")}\n\nUse them with /pi-subagents --agent <id> "task".`,
      },
    ],
    details: {},
  };
}

/** Builds the "• id — name: description [model]" line for one agent. */
function formatAgentLine(a: {
  id: string;
  name: string;
  description: string;
  model?: string;
}): string {
  return `• ${a.id} — ${a.name}${a.description ? `: ${a.description}` : ""}${a.model ? ` [model: ${a.model}]` : ""}`;
}

/** Builds the "Agents available (N total)" grouped-by-source text for a cwd. */
async function agentsBySourceText(cwd: string): Promise<string> {
  const projectDir = path.join(cwd, ".pi", "agents");
  const globalDir = path.join(os.homedir(), ".pi", "agent", "agents");

  // env override is a single explicit source; otherwise show both project + global
  const sources: Array<{
    label: string;
    dir: string;
    agents: Array<{
      id: string;
      name: string;
      description: string;
      model?: string;
    }>;
  }> = [];
  if (process.env.PI_SUBAGENTS_DIR) {
    const agents = await discoverAgents(process.env.PI_SUBAGENTS_DIR);
    sources.push({
      label: `PI_SUBAGENTS_DIR (${process.env.PI_SUBAGENTS_DIR})`,
      dir: process.env.PI_SUBAGENTS_DIR,
      agents,
    });
  } else {
    sources.push({
      label: "Project (.pi/agents)",
      dir: projectDir,
      agents: await discoverAgents(projectDir),
    });
    sources.push({
      label: "Global (~/.pi/agent/agents)",
      dir: globalDir,
      agents: await discoverAgents(globalDir),
    });
  }

  const sections = sources.map((s) => {
    const header = `${s.label}:`;
    if (s.agents.length === 0) {
      return `${header}\n  (none)`;
    }
    const body = s.agents.map(formatAgentLine).join("\n");
    return `${header}\n${body}`;
  });

  const total = sources.reduce((n, s) => n + s.agents.length, 0);
  return (
    `Agents available (${total} total):\n\n` +
    sections.join("\n\n") +
    '\n\nUse them with /pi-subagents --agent <id> "task".'
  );
}

/**
 * Lists agents grouped by source directory (project-local vs global), so you
 * can see where each agent is defined. Run from the project directory to see
 * both the <project>/.pi/agents agents and the global ~/.pi/agent/agents ones.
 */
async function listAgentsBySource(
  _id: string,
  _params: unknown,
  _signal: AbortSignal | undefined,
  _onUpdate: (data: unknown) => void,
  ctx: { cwd: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: {} }> {
  const text = await agentsBySourceText(ctx.cwd);
  return {
    content: [{ type: "text", text }],
    details: {},
  };
}

/**
 * Registers the LLM tools.
 *
 * Usage (from the pi command line):
 *   /pi-subagents "Update the README"
 *   /pi-subagents --model "openai/gpt-5" --no-close "Test it and write the report"
 *   /pi-subagents --agent reviewer "Review these changes"
 *   /pi-subagents-list-agents
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi-subagents",
    label: "pi-subagents",
    description:
      "Opens a new visible pane in Herdr and launches an isolated pi subagent inside it. " +
      "Uses Herdr's agent start/prompt/get lifecycle API for reliable execution. " +
      "The subagent sends its summary back to the caller pane; this tool waits only for " +
      "the subagent to reach a terminal state and never reads its raw transcript." +
      "Inherits the current model unless --model or an agent file specifies one. " +
      "Waits until the task completes and closes the pane if requested.",
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({
          description:
            "Agent id (directory name under the agents dir). Loads that agent's model + system prompt.",
        }),
      ),
      task: Type.String({ description: "The task the subagent will perform." }),
      model: Type.Optional(
        Type.String({
          description:
            "The model to use. Overrides the agent file and the current model.",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Working directory for the pane. If omitted, the current cwd is used.",
        }),
      ),
      direction: Type.Optional(
        Type.Union(
          [
            Type.Literal("right"),
            Type.Literal("left"),
            Type.Literal("down"),
            Type.Literal("up"),
          ],
          { description: "Pane split direction." },
        ),
      ),
      focus: Type.Optional(
        Type.Boolean({
          description: "Should the new pane take focus? Default: false.",
        }),
      ),
      closePaneOnDone: Type.Optional(
        Type.Boolean({
          description: "Close the pane when the task completes? Default: true.",
        }),
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Maximum wait time in ms. Default: 360000.",
        }),
      ),
    }),
    renderCall: (args) =>
      new Text(
        `pi-subagents: ${args.task} (agent=${args.agent ?? "none"}, model=${args.model ?? "current"}, pane=${args.direction ?? "right"})`,
        0,
        0,
      ),
    renderResult: (res) => {
      const text = res.content
        .map((c) => ("text" in c ? c.text : ""))
        .join("\n");
      return new Text(text, 0, 0);
    },
    execute,
  });

  pi.registerTool({
    name: "pi-subagents-list-agents",
    label: "pi-subagents-list-agents",
    description:
      "Lists the subagents defined under the pi-subagents agents directory so they can be passed to pi-subagents via --agent.",
    parameters: Type.Object({}),
    renderCall: () => new Text("pi-subagents-list-agents", 0, 0),
    renderResult: (res) =>
      new Text(
        res.content.map((c) => ("text" in c ? c.text : "")).join("\n"),
        0,
        0,
      ),
    execute: listAgents,
  });

  pi.registerTool({
    name: "pi-subagents-list",
    label: "pi-subagents-list",
    description:
      "Lists subagents grouped by source directory (project-local <project>/.pi/agents and global ~/.pi/agent/agents) so you can see where each agent is defined. Run from the project directory to see both. Uses PI_SUBAGENTS_DIR if set.",
    parameters: Type.Object({}),
    renderCall: () => new Text("pi-subagents-list", 0, 0),
    renderResult: (res) =>
      new Text(
        res.content.map((c) => ("text" in c ? c.text : "")).join("\n"),
        0,
        0,
      ),
    execute: listAgentsBySource,
  });

  // pi's /-autocomplete only covers commands (via registerCommand), prompt
  // templates and skills — never tools — so the list tools are also exposed as
  // commands. They render into the transcript as a custom message.
  pi.registerMessageRenderer(
    "pi-subagents-list",
    (message, options, theme) =>
      new Text(
        theme.fg("accent", `[${message.customType}] `) +
          (typeof message.content === "string" ? message.content : ""),
        options.outputPad,
        0,
      ),
  );

  pi.registerCommand("pi-subagents-list", {
    description:
      "Lists subagents grouped by source directory (project-local <project>/.pi/agents and global ~/.pi/agent/agents) so you can see where each agent is defined. Run from the project directory to see both. Uses PI_SUBAGENTS_DIR if set.",
    handler: async (_args, ctx) => {
      const text = await agentsBySourceText(ctx.cwd);
      pi.sendMessage({
        customType: "pi-subagents-list",
        content: text,
        display: true,
      });
    },
  });

  pi.registerCommand("pi-subagents-list-agents", {
    description:
      "Lists the subagents defined under the pi-subagents agents directory so they can be passed to pi-subagents via --agent.",
    handler: async (_args, ctx) => {
      const dir = resolveAgentsDir(ctx.cwd);
      const agents = await discoverAgents(dir);
      const text =
        agents.length === 0
          ? `No agents found in ${dir}. Create a <agent-id>/AGENT.md file there with YAML frontmatter (name, description, model) and a system prompt in the body.`
          : `Agents available in ${dir}:\n${agents.map(formatAgentLine).join("\n")}\n\nUse them with /pi-subagents --agent <id> "task".`;
      pi.sendMessage({
        customType: "pi-subagents-list",
        content: text,
        display: true,
      });
    },
  });
}
