/**
 * pi-subagents
 * -------------------------------------------------------------------------
 * When running pi inside Herdr, this extension exposes LLM tools that open a
 * new visible Herdr pane and launch an isolated pi "subagent" inside it.
 *
 * Agents are defined as one directory per agent under:
 *   <cwd>/.pi/subagents/<agent-id>/subagent.md
 * (overridable via the PI_SUBAGENTS_DIR env var, falling back to
 *  ~/.pi/subagents/<agent-id>/subagent.md). Each file:
 *
 *   ---
 *   name: Reviewer
 *   description: Reviews code changes and lists issues
 *   model: Link-Tiny
 *   direction: right
 *   closePaneOnDone: true
 *   ---
 *
 *   # Code Reviewer
 *   You are a meticulous senior code reviewer...  <-- body = the subagent system prompt
 *
 * The directory is read on every tool call, so adding a new agent directory
 * makes it immediately available (no extension reload needed).
 *
 * Flow (uses Herdr's native agent automation API):
 *   1. herdr pane split        -> open a new pane (splitting the current one)
 *   2. herdr agent start       -> launch a named pi agent in the pane
 *   3. herdr agent prompt --wait -> submit the task and block until idle/done
 *   4. herdr agent read        -> capture the subagent's output
 *   5. herdr pane close        -> (optional) close the pane and the subagent
 * -------------------------------------------------------------------------
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERDR_BIN = process.env.HERDR_BIN ?? "herdr";
const DEFAULT_TIMEOUT_MS = 360_000; // 3 minutes
const AGENT_FILENAME = "subagent.md";
// How long to wait before retrying a close that raced with the agent exiting.
const CLOSE_RETRY_MS = 400;

interface PiSubagentsParams {
  /** Name of an agent directory under the agents dir (matches the folder name). */
  agent?: string;
  /** The task the subagent will perform (the user prompt). */
  task: string;
  /** The model to use. Order of precedence: this flag > agent file > current model. */
  model?: string;
  /** Inline system prompt appended after the agent's own system prompt. */
  systemPrompt?: string;
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
    proc.on("close", (code) => resolve({ code: code ?? 0, stdout: out, stderr: err }));
  });
}

async function writeTempSystemPrompt(content: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagents-"));
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

/**
 * A "ghost" pane is one that was split/opened but never had a pi agent launched
 * inside it. This is exactly what happens when `herdr agent start` returns the
 * `agent_pane_busy` race error: Herdr has already allocated the pane, so the
 * call fails and the pane is left behind with no running agent.
 *
 * Detection heuristic: a pane whose agent_status is "unknown" (no agent ever
 * started there) is a ghost. We never touch the focused pane (the live session)
 * and stay scoped to the current workspace/session.
 */
interface GhostPane {
  pane_id: string;
  agent_status: string;
  focused: boolean;
  workspace_id: string;
}

/** Lists panes and returns only the ghost (agent-less) ones for cleanup. */
async function findGhostPanes(): Promise<GhostPane[]> {
  const { stdout } = await runHerdr(["pane", "list"]);
  const panes = parseHerdrResult<{ pane_id: string; agent_status: string; focused: boolean; workspace_id: string }[]>(
    stdout,
    "panes",
  );
  if (!panes) return [];
  // Only clean panes in this workspace, that never got an agent, and are not
  // the focused (live) pane — never close the session we're running in.
  return panes.filter((p) => p.agent_status === "unknown" && !p.focused);
}

/**
 * Closes every ghost pane left behind by a failed subagent launch. Returns a
 * human-readable report of what was closed (or that there was nothing to do).
 */
async function cleanupPanes(
  _id: string,
  _params: unknown,
  _signal: AbortSignal | undefined,
  _onUpdate: (data: unknown) => void,
  ctx: { cwd: string },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: {} }> {
  const ghosts = await findGhostPanes();
  if (ghosts.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: "pi-subagents-cleanup: no ghost panes found — everything is clean. (A ghost is a pane that was opened but never ran an agent, e.g. left by a failed subagent launch.)",
        },
      ],
    };
  }
  const closed: string[] = [];
  const failed: string[] = [];
  for (const g of ghosts) {
    const { stdout, stderr, code } = await runHerdr(["pane", "close", g.pane_id]);
    if (code === 0) {
      closed.push(g.pane_id);
    } else {
      failed.push(`${g.pane_id} (${stderr || stdout.trim() || "unknown error"})`);
    }
  }
  const lines: string[] = [`pi-subagents-cleanup: closed ${closed.length} ghost pane(s):`, ...closed.map((p) => `  • ${p}`)];
  if (failed.length) {
    lines.push(`\nCould not close ${failed.length} (may already be gone):`, ...failed.map((p) => `  • ${p}`));
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {},
  };
}

/** Returns true once the pane no longer exists in herdr (i.e. it was closed). */
async function isPaneClosed(paneId: string): Promise<boolean> {
  const { stdout } = await runHerdr(["pane", "list"]);
  const panes = parseHerdrResult<{ pane_id: string }[]>(stdout, "panes");
  return !panes?.some((p) => p.pane_id === paneId);
}

/** Minimal YAML-frontmatter + markdown-body parser (no external dependency). */
function parseAgentManifest(content: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

/** Resolves the agents directory (env override > project-local .pi/subagents > ~/.pi/agent/subagents). */
function resolveAgentsDir(cwd: string): string {
  if (process.env.PI_SUBAGENTS_DIR) return process.env.PI_SUBAGENTS_DIR;
  const projectLocal = path.join(cwd, ".pi", "subagents");
  const globalDir = path.join(os.homedir(), ".pi", "agent", "subagents");
  return fs.existsSync(projectLocal) ? projectLocal : globalDir;
}

/** Lists agent definitions discovered in the agents directory. */
async function discoverAgents(dir: string): Promise<
  Array<{ id: string; name: string; description: string; model?: string }>
> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const agents: Array<{ id: string; name: string; description: string; model?: string }> = [];
  for (const entry of entries.sort()) {
    const agentFile = path.join(dir, entry, AGENT_FILENAME);
    let content: string;
    try {
      content = await fs.promises.readFile(agentFile, "utf8");
    } catch {
      continue; // Not an agent directory (no subagent.md).
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
  ctx: { cwd: string; model?: { provider?: string; id?: string } }
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: { paneId?: string; model?: string; agent?: string; done?: boolean; closed?: boolean };
}> {
  if (!params.task?.trim()) {
    return {
      content: [{ type: "text", text: "pi-subagents: 'task' cannot be empty." }],
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
    ? ctx.model.provider ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model.id
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
          text: `pi-subagents: no model. Set one via --model or in the agent file (${dir}/${params.agent ?? "<id>"}/subagent.md).`,
        },
      ],
      details: {},
    };
  }
  const direction = params.direction ?? agent?.direction ?? "right";
  const focus = params.focus ?? false;
  const closePaneOnDone = params.closePaneOnDone ?? agent?.closePaneOnDone ?? true;
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
  const inlinePrompt = params.systemPrompt?.trim();
  if (inlinePrompt) {
    const temp = await writeTempSystemPrompt(inlinePrompt);
    spFiles.push({ path: temp, owned: true });
  }

  try {
    const res = await runTask(
      { cwd, model, direction, focus, closePaneOnDone, timeoutMs },
      spFiles,
      params.task
    );
    // Always remove the temp system-prompt files we created, whatever happened.
    await cleanupSpFiles(spFiles);
    return res;
  } catch (err) {
    await cleanupSpFiles(spFiles);
    return {
      content: [{ type: "text", text: `pi-subagents: ${err instanceof Error ? err.message : String(err)}` }],
      details: {},
    };
  }
}

async function runTask(
  opts: { cwd: string; model: string; direction: string; focus: boolean; closePaneOnDone: boolean; timeoutMs: number },
  spFiles: SpFile[],
  task: string
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: { paneId?: string; model?: string; agent?: string; done?: boolean; closed?: boolean };
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
      content: [{ type: "text", text: `pi-subagents: pane split failed: ${stderr || stdout}` }],
      details: {},
    };
  }
  const pane = parseHerdrResult<{ pane_id: string }>(stdout, "pane");
  const paneId = pane?.pane_id;
  if (!paneId) {
    return {
      content: [{ type: "text", text: `pi-subagents: could not parse pane_id: ${stdout}` }],
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
  const startArgs = [
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

  const { stdout: startOut, stderr: startErr, code: startCode } = await runHerdr(startArgs);
  if (startCode !== 0) {
    return {
      content: [
        {
          type: "text",
          text: `pi-subagents: agent start failed: ${startErr || startOut}`,
        },
      ],
      details: {},
    };
  }

  // 3) Submit the task and wait for completion using Herdr's agent prompt --wait.
  //    This is the proper lifecycle-aware way to send a prompt and block until
  //    the agent reaches idle/done/blocked, replacing the old manual polling.
  const promptArgs = ["agent", "prompt", agentName, task, "--wait", "--timeout", String(opts.timeoutMs)];
  const { stdout: promptOut, stderr: promptErr, code: promptCode } = await runHerdr(promptArgs);
  const done = promptCode === 0;

  // 4) Capture the subagent's output via agent read (handles alternate-screen).
  let paneOutput = "";
  if (done) {
    const { stdout: readOut, code: readCode } = await runHerdr([
      "agent",
      "read",
      agentName,
      "--source",
      "recent-unwrapped",
      "--lines",
      "500",
    ]);
    paneOutput = readCode === 0 ? readOut.trim() : "";
  }

  // 5) Optionally close the pane / agent.
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
  const text = paneOutput
    ? `${status}\n\n── subagent output ──\n${paneOutput}`
    : status;

  return {
    content: [{ type: "text", text }],
    details: { paneId, model: opts.model, agent: agentName, done, closed },
  };
}

async function listAgents(
  _id: string,
  _params: unknown,
  _signal: AbortSignal | undefined,
  _onUpdate: (data: unknown) => void,
  ctx: { cwd: string }
): Promise<{ content: Array<{ type: "text"; text: string }>; details: {} }> {
  const dir = resolveAgentsDir(ctx.cwd);
  const agents = await discoverAgents(dir);
  if (agents.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No agents found in ${dir}. Create a <agent-id>/subagent.md file there with YAML frontmatter (name, description, model) and a system prompt in the body.`,
        },
      ],
    };
  }
  const lines = agents.map(
    (a) => `• ${a.id} — ${a.name}${a.description ? `: ${a.description}` : ""}${a.model ? ` [model: ${a.model}]` : ""}`
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
      "Uses Herdr's agent start/prompt/read lifecycle API for reliable execution. " +
      "Inherits the current model unless --model or an agent file specifies one. " +
      "Waits until the task completes and closes the pane if requested.",
    parameters: Type.Object({
      agent: Type.Optional(
        Type.String({
          description:
            "Agent id (directory name under the agents dir). Loads that agent's model + system prompt.",
        })
      ),
      task: Type.String({ description: "The task the subagent will perform." }),
      model: Type.Optional(
        Type.String({ description: "The model to use. Overrides the agent file and the current model." })
      ),
      systemPrompt: Type.Optional(
        Type.String({ description: "Inline system prompt appended after the agent's own system prompt." })
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory for the pane. If omitted, the current cwd is used." })
      ),
      direction: Type.Optional(
        Type.Union(
          [Type.Literal("right"), Type.Literal("left"), Type.Literal("down"), Type.Literal("up")],
          { description: "Pane split direction." }
        )
      ),
      focus: Type.Optional(
        Type.Boolean({ description: "Should the new pane take focus? Default: false." })
      ),
      closePaneOnDone: Type.Optional(
        Type.Boolean({ description: "Close the pane when the task completes? Default: true." })
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Maximum wait time in ms. Default: 360000." })
      ),
    }),
    renderCall: (args) =>
      new Text(
        `pi-subagents: ${args.task} (agent=${args.agent ?? "none"}, model=${args.model ?? "current"}, pane=${args.direction ?? "right"})`,
        0,
        0
      ),
    renderResult: (res) => {
      const text = res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
      return new Text(
        text.startsWith("pi-subagents failed:")
          ? text
          : text,
        0,
        0
      );
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
      new Text(res.content.map((c) => ("text" in c ? c.text : "")).join("\n"), 0, 0),
    execute: listAgents,
  });

  pi.registerTool({
    name: "pi-subagents-cleanup",
    label: "pi-subagents-cleanup",
    description:
      "Closes ghost panes — panes that were opened but never ran a pi agent, " +
      "typically left behind by a failed subagent launch (agent_pane_busy race). " +
      "Never closes the focused/live pane. Run this after a subagent call that " +
      "returned an error to keep your workspace clean.",
    parameters: Type.Object({}),
    renderCall: () => new Text("pi-subagents-cleanup", 0, 0),
    renderResult: (res) =>
      new Text(res.content.map((c) => ("text" in c ? c.text : "")).join("\n"), 0, 0),
    execute: cleanupPanes,
  });
}
