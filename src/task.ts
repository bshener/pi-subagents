import * as fs from "node:fs";

import {
  TRANSIENT_START_ERRORS,
  MAX_START_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  CLOSE_RETRY_MS,
  WORKER_OUTPUT_LINES,
  START_BACKOFF_MS,
} from "./constants.ts";
import type { ThinkingLevel } from "./constants.ts";
import { THINKING_LEVELS } from "./constants.ts";
import { parseAgentManifest, resolveAgentFile } from "./agents.ts";
import { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { SpFile } from "./types.ts";
import {
  parseHerdrErrorCode,
  parseHerdrResult,
  readAgentOutput,
  sleep,
  runHerdr,
  writeTempSystemPrompt,
  cleanupSpFiles,
  isPaneClosed,
} from "./herdr.ts";

/** Converts a formatted agent listing string into a typed AgentToolResult. */
export function createAgentResult(text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: {},
  };
}

/** Coerces a raw string into a valid ThinkingLevel, or undefined if invalid. */
function normalizeThinkingLevel(
  value: string | undefined,
): ThinkingLevel | undefined {
  if (!value) return undefined;
  return (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

/** Returns a single agent's parsed model information. */
export async function execute(
  agent: string,
  task: string,
  options: { thinkingLevel?: string } = {},
): Promise<AgentToolResult<unknown>> {
  // `agent` must be a non-empty string (the tool marks it optional, so a call
  // with no agent reaches here with agent === undefined). Reject it up front with
  // a clear message instead of letting the later resolveAgentFile call choke on a
  // bad id. The check is strict (typeof string, non-empty) so a non-string value
  // can never slip through and cause a confusing error.
  if (typeof agent !== "string" || agent.length === 0) {
    return createAgentResult(
      "Error: the 'agent' argument is required and must be a non-empty string " +
        "(an agent id under the agents dir).",
    );
  }
  // Resolve the agent id to its AGENT.md file following the documented order
  // (PI_SUBAGENTS_DIR override -> project-local .pi/agents -> global agents dir).
  // This is done outside the try so the not-found message can name the agent.
  const file = resolveAgentFile(agent);
  if (!file) {
    return createAgentResult(
      `Error: Could not find agent file for agent "${agent}" ` +
        "(an agent id under the agents dir).",
    );
  }
  let content: string;
  try {
    content = await fs.promises.readFile(file, "utf8");
  } catch {
    return createAgentResult(`Error: Could not read agent file at ${file}`);
  }
  const { meta } = parseAgentManifest(content);
  const model = meta.model ?? "default";
  const systemPrompt = meta.systemPrompt ?? "";
  // Thinking level precedence: explicit tool argument beats the agent's
  // frontmatter default. When neither is set, pi keeps its own default (which
  // inherits the dispatching session's level), so we pass nothing.
  const thinkingLevel = normalizeThinkingLevel(
    options.thinkingLevel ?? meta.thinkingLevel,
  );

  // Build the system prompt files to pass to pi (--append-system-prompt).
  // The agent's system prompt is the markdown BODY of its md file (everything
  // after the YAML frontmatter), so we write that body to a temp file rather
  // than passing the whole md — passing the whole file would inject the
  // frontmatter metadata (name/description/model/...) into the prompt.
  const spFiles: SpFile[] = [];
  if (systemPrompt) {
    const agentSp = await writeTempSystemPrompt(systemPrompt);
    spFiles.push({ path: agentSp, owned: true });
  }

  try {
    const res = await runTask(
      {
        cwd: process.cwd(),
        model,
        thinkingLevel,
        direction: "right",
        focus: false,
        closePaneOnDone: true,
        timeoutMs: DEFAULT_TIMEOUT_MS,
      },
      spFiles,
      task,
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

/** Loads an agent and runs the specified task in a subagent process. */
async function runTask(
  opts: {
    cwd: string;
    model: string;
    thinkingLevel?: ThinkingLevel;
    direction: string;
    focus: boolean;
    closePaneOnDone: boolean;
    timeoutMs: number;
  },
  spFiles: SpFile[],
  task: string,
): Promise<AgentToolResult<unknown>> {
  // Generate a unique agent name (max 32 chars, must match [a-z][a-z0-9_-]*)
  const agentName = `subagent-${Date.now().toString(36)}`.slice(0, 32);

  // 1) Open a new pane via split. Target the parent agent's pane explicitly so
  //    the split happens in the parent's workspace/tab. Without a target herdr
  //    splits the UI-focused pane, which may live in a different (currently
  //    active) workspace. Outside Herdr (no HERDR_PANE_ID) fall back to the
  //    old behavior and let herdr pick the focused pane.
  const parentPaneId = process.env.HERDR_PANE_ID;
  const splitArgs = [
    "pane",
    "split",
    ...(parentPaneId ? ["--pane", parentPaneId] : []),
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
  if (opts.thinkingLevel) {
    piArgsAfterDashes.push("--thinking", opts.thinkingLevel);
  }
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

  // Capture the worker's recent terminal output BEFORE closing the pane, so the
  // caller actually receives the result instead of only a status line.
  //
  // In the intended Herdr-orchestrator setup the worker posts its summary to the
  // orchestrator's own pane via `herdr agent prompt`, and this tool returns only
  // a status because the orchestrator reads that summary from its own pane. But
  // when the orchestrator runs OUTSIDE a Herdr pane (e.g. directly in the pi
  // harness, where HERDR_PANE_ID is unset) that backchannel has nowhere to land,
  // so the summary is silently lost. Reading a bounded tail fixes that without
  // re-injecting the whole transcript.
  // Capture the worker's final answer BEFORE closing the pane. Guarded so a
  // failure here can never skip the pane close below (a worker pane must not leak).
  let workerOutput: string | undefined;
  try {
    workerOutput = await readAgentOutput(agentName, WORKER_OUTPUT_LINES);
  } catch {
    workerOutput = undefined;
  }

  // 4) Optionally close the pane / agent. The worker already sent its summary to the
  //    orchestrator's pane via backchannel (see step 3); we additionally read it
  //    back here so the summary is not lost when there is no orchestrator pane.
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

  const tl = opts.thinkingLevel ? ` • thinking:${opts.thinkingLevel}` : "";
  const status = `pi-subagents: pane ${paneId} • ${opts.model}${tl} • agent ${agentName} • ${
    done ? "task completed" : "timed out"
  } • ${opts.closePaneOnDone ? (closed ? "pane closed" : "pane still open") : "pane open"}`;

  // The close reason is always surfaced to the caller: when the worker finished
  // normally that is "task completed"; when it did not reach a terminal state in
  // time the pane was closed by the orchestrator due to a timeout. Never leave
  // the parent guessing why the subagent disappeared.
  const closeReason = done
    ? "task completed"
    : "timed out (worker did not reach a terminal state before the pane was closed)";

  const summaryBlock = workerOutput
    ? `\n\n--- Worker output ---\n${workerOutput}`
    : "";
  const text = done
    ? `${status}${summaryBlock}`
    : `${status}\n\nClose reason: ${closeReason}\nThe worker may not have finished; its summary is possibly incomplete.${summaryBlock}`;

  return {
    content: [{ type: "text", text }],
    details: {
      paneId,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      agent: agentName,
      done,
      closed,
      closeReason,
    },
  };
}
