import * as fs from "node:fs";

import {
  TRANSIENT_START_ERRORS,
  MAX_START_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  WAIT_POLL_MS,
  STALE_STREAK_THRESHOLD,
  WORKER_OUTPUT_LINES,
  START_BACKOFF_MS,
} from "./constants.ts";
import type { ThinkingLevel } from "./constants.ts";
import { THINKING_LEVELS } from "./constants.ts";
import { parseAgentManifest, resolveAgentFile } from "./agents.ts";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import type { SpFile } from "./types.ts";
import {
  parseHerdrErrorCode,
  parseHerdrResult,
  readAgentOutput,
  sleep,
  runHerdr,
  writeTempSystemPrompt,
  cleanupSpFiles,
  isPaneClosed,
  closePaneRobustly,
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

/** Builds a unique Herdr agent name from the subagent id.
 * Format: "<agentId>-<timestamp36>-<rand4>", truncated to 32 chars to satisfy
 * Herdr's `[a-z][a-z0-9_-]{0,31}` rule. Timestamp + random suffix prevents
 * collisions when several subagents spawn within the same millisecond. */
function makeAgentName(agentId: string): string {
  const raw = agentId.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const clean = raw.replace(/^[^a-z]+/, "a") || "subagent";
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, "0");
  const suffix = `${Date.now().toString(36)}-${rand}`;
  const maxBase = Math.max(1, 32 - suffix.length - 1);
  return `${clean.slice(0, maxBase)}-${suffix}`.slice(0, 32);
}

/** Formats a millisecond duration as MM:SS (or H:MM:SS past one hour). */
function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/** Starts the timeout countdown for a worker pane.
 *
 * Why a pane-label ticker: the worker pane runs its own pi TUI, and anything
 * written into that terminal would land in the worker's input — so the only
 * non-intrusive surface we own is the pane chrome. Every second
 * the pane label becomes `<base> ⏳ MM:SS`, and the same value is pushed to the
 * parent TUI via onUpdate/onStatus. All updates are best-effort and never fail
 * the task. Returns a stop function that restores the base label and clears the
 * parent status; the caller must await it in a finally block. */
function startCountdown(opts: {
  paneId: string;
  baseLabel: string;
  agentId: string;
  agentName: string;
  deadline: number;
  timeoutMs: number;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  onStatus?: (text: string | undefined) => void;
  onActive?: (tick: ActiveTick) => void;
}): () => Promise<void> {
  const total = formatRemaining(opts.timeoutMs);
  // Overlap guard: setInterval fires every second but a tick is async (pane
  // rename + callbacks). Without this, a slow tick overlaps the next one and
  // the two finish out of order — the displayed countdown visibly fluctuates
  // instead of decreasing monotonically. `stopped` additionally prevents a
  // late tick from repainting UI after stop() cleared it.
  let inFlight = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const remainingMs = Math.max(0, opts.deadline - Date.now());
      const remaining = formatRemaining(remainingMs);
      await runHerdr([
        "pane",
        "rename",
        opts.paneId,
        `${opts.baseLabel} ⏳ ${remaining}`,
      ]).catch(() => undefined);
      if (stopped || opts.signal?.aborted) return;
    try {
      opts.onStatus?.(
        `\u{1F916} ${opts.agentId} \u23F3 ${remaining}/${total} • ${opts.agentName}`,
      );
    } catch {
      // Parent UI gone — pane label above is the source of truth.
    }
    try {
      opts.onUpdate?.({
        content: [
          {
            type: "text",
            text: `\u{1F916} ${opts.agentId} \u23F3 ${remaining}/${total} remaining • agent ${opts.agentName} • pane ${opts.paneId}`,
          },
        ],
        details: {
          paneId: opts.paneId,
          agentId: opts.agentId,
          agent: opts.agentName,
          remainingMs,
          timeoutMs: opts.timeoutMs,
        },
      });
    } catch {
      // A throwing onUpdate must never break the wait.
    }
      try {
        opts.onActive?.({
          agentId: opts.agentId,
          agentName: opts.agentName,
          paneId: opts.paneId,
          remainingMs,
          timeoutMs: opts.timeoutMs,
          phase: "working",
        });
      } catch {
        // Parent UI gone — same policy as onStatus/onUpdate above.
      }
    } finally {
      inFlight = false;
    }
  };
  void tick();
  // Refresh cadence: 1s (cheap local socket calls; the pane label is the
  // fallback surface when the parent has no TUI). Rename failures are
  // best-effort, never fatal.
  const timer = setInterval(() => {
    void tick();
  }, 1_000);
  return async (): Promise<void> => {
    stopped = true;
    clearInterval(timer);
    // Let an in-flight tick finish first: its pane rename would otherwise
    // land after the label restore below and leave a stale "⏳" behind.
    for (let i = 0; i < 20 && inFlight; i++) await sleep(50);
    await runHerdr(["pane", "rename", opts.paneId, opts.baseLabel]).catch(
      () => undefined,
    );
    try {
      opts.onStatus?.(undefined);
    } catch {
      // Parent UI gone — nothing to clear.
    }
  };
}

/** Progress snapshot for the parent-TUI active-subagents list.
 * Emitted best-effort at key lifecycle points (start, pane split, agent
 * start, every countdown tick). Never fails the task. */
export interface ActiveTick {
  agentId: string;
  agentName: string;
  paneId?: string;
  remainingMs?: number;
  timeoutMs?: number;
  phase: "starting" | "working";
  /** Live `agent_status` from Herdr (`working`, `idle`, `blocked`, `done`,
   * `unknown`) or a synthetic watchdog state (`stale — killed`). Absent until
   * the supervise loop observes the worker. */
  status?: string;
}

/** Options accepted by execute(): tool params + live-update wiring. */
export interface ExecuteOptions {
  thinkingLevel?: string;
  noSkills?: boolean;
  nestedSubagentAllowed?: boolean;
  timeoutMs?: number;
  direction?: string;
  focus?: boolean;
  closePaneOnDone?: boolean;
  cwd?: string;
  model?: string;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback<unknown>;
  onStatus?: (text: string | undefined) => void;
  onActive?: (tick: ActiveTick) => void;
}

/** Returns a single agent's parsed model information. */
export async function execute(
  agent: string,
  task: string,
  options: ExecuteOptions = {},
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
  // Model precedence: explicit tool argument > agent frontmatter > "default".
  const model = options.model ?? meta.model ?? "default";
  const systemPrompt = meta.systemPrompt ?? "";
  // Thinking level precedence: explicit tool argument beats the agent's
  // frontmatter default. When neither is set, pi keeps its own default (which
  // inherits the dispatching session's level), so we pass nothing.
  const thinkingLevel = normalizeThinkingLevel(
    options.thinkingLevel ?? meta.thinkingLevel,
  );
  // Skills precedence: explicit tool argument beats the agent's frontmatter
  // default. When neither is set, skills stay enabled (current behavior).
  const rawNoSkills =
    options.noSkills ??
    (meta.noSkills === undefined
      ? undefined
      : meta.noSkills.toLowerCase() === "true");
  const noSkills = rawNoSkills ?? false;
  // Nesting precedence: explicit tool argument beats the agent's frontmatter
  // default. When neither is set, nesting stays disabled (current behavior).
  const rawNestedSubagentAllowed =
    options.nestedSubagentAllowed ??
    (meta.nestedSubagentAllowed === undefined
      ? undefined
      : meta.nestedSubagentAllowed.toLowerCase() === "true");
  const nestedSubagentAllowed = rawNestedSubagentAllowed ?? false;
  // Timeout: explicit tool argument wins; must be a finite positive number.
  // Floored at MIN_TIMEOUT_MS (30 min): workers notify the parent when done,
  // so the timeout is only a safety net against stuck/lost workers. The
  // countdown ticker (see startCountdown) is driven by this same value, so a
  // custom --timeoutMs is always reflected in the displayed counter.
  const requestedMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, requestedMs);
  // Direction precedence: explicit tool argument > agent frontmatter > "right".
  const DIRECTIONS = ["right", "left", "up", "down"] as const;
  const rawDirection = options.direction ?? meta.direction ?? "right";
  const direction = (DIRECTIONS as readonly string[]).includes(rawDirection)
    ? rawDirection
    : "right";
  // closePaneOnDone precedence: explicit tool argument > agent frontmatter.
  const closePaneOnDone =
    options.closePaneOnDone ??
    (meta.closePaneOnDone === undefined
      ? true
      : meta.closePaneOnDone.toLowerCase() !== "false");

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
        agentId: agent,
        cwd: options.cwd ?? process.cwd(),
        model,
        thinkingLevel,
        noSkills,
        nestedSubagentAllowed,
        direction,
        focus: options.focus ?? false,
        closePaneOnDone,
        timeoutMs,
        signal: options.signal,
        onUpdate: options.onUpdate,
        onStatus: options.onStatus,
        onActive: options.onActive,
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
    agentId: string;
    cwd: string;
    model: string;
    thinkingLevel?: ThinkingLevel;
    noSkills: boolean;
    nestedSubagentAllowed: boolean;
    direction: string;
    focus: boolean;
    closePaneOnDone: boolean;
    timeoutMs: number;
    signal?: AbortSignal;
    onUpdate?: AgentToolUpdateCallback<unknown>;
    onStatus?: (text: string | undefined) => void;
    onActive?: (tick: ActiveTick) => void;
  },
  spFiles: SpFile[],
  task: string,
): Promise<AgentToolResult<unknown>> {
  // Unique agent name (max 32 chars, must match [a-z][a-z0-9_-]*).
  // See makeAgentName: "<agentId>-<timestamp36>-<rand4>".
  const agentName = makeAgentName(opts.agentId);
  // Best-effort progress for the parent-TUI active-subagents list. Emits are
  // wrapped so a throwing callback can never fail the task.
  const emitActive = (tick: ActiveTick): void => {
    try {
      opts.onActive?.(tick);
    } catch {
      // Parent UI gone — the Herdr pane label is the source of truth.
    }
  };
  emitActive({
    agentId: opts.agentId,
    agentName,
    timeoutMs: opts.timeoutMs,
    phase: "starting",
  });

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

  emitActive({
    agentId: opts.agentId,
    agentName,
    paneId,
    timeoutMs: opts.timeoutMs,
    phase: "starting",
  });

  // Label the pane with the agent name so it is identifiable in the Herdr UI.
  // Pane labels live in a different (display-only) namespace than agent names,
  // so this can never collide with `agent start`. Best-effort on purpose: a
  // rename failure must never fail the task.
  await runHerdr(["pane", "rename", paneId, agentName]).catch(() => undefined);

  // 2) Start a named pi agent in the pane using Herdr's agent start command.
  //    --kind pi selects the canonical pi executable; -- passes remaining args
  //    through to pi itself (--model, --append-system-prompt, etc.).
  const piArgsAfterDashes = ["--model", opts.model];
  if (opts.thinkingLevel) {
    piArgsAfterDashes.push("--thinking", opts.thinkingLevel);
  }
  if (opts.noSkills) {
    piArgsAfterDashes.push("--no-skills");
  }
  // A subagent must not spawn its own subagents unless the agent opts in
  // via nestedSubagentAllowed (default false: accidental recursion is
  // expensive and never intended). pi has no single-extension exclude flag
  // (--no-extensions would kill every extension the worker needs), so deny
  // just our two tools instead; other extensions keep working. Slash commands
  // (/subagent:...) stay registered but only a user can invoke those, not the
  // model, so the nesting vector is closed when this is false.
  if (!opts.nestedSubagentAllowed) {
    piArgsAfterDashes.push("--exclude-tools", "pi-subagents,pi-subagents-list");
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
    // Ghost-pane guard: the split already allocated a pane, so a failed start
    // must not leave it behind. Best-effort close (never fails the report).
    const close = await closePaneRobustly(paneId).catch(() => undefined);
    const closedSuffix = close ? (close.closed ? " • pane closed" : ` • pane still open${close.lastError ? ` (close error: ${close.lastError})` : ""}`) : "";
    return {
      content: [
        {
          type: "text",
          text: `pi-subagents: agent start failed (after ${startAttempt + 1} attempt(s)): ${startErr || startOut}${closedSuffix}`,
        },
      ],
      details: { paneId, agentId: opts.agentId, agent: agentName, done: false, closed: close?.closed ?? false },
    };
  }

  emitActive({
    agentId: opts.agentId,
    agentName,
    paneId,
    timeoutMs: opts.timeoutMs,
    phase: "working",
  });

  // 3) Submit the task and block until the worker reaches a terminal state.
  //    The worker sends its concise summary DIRECTLY to the orchestrator's pane
  //    (per the worker's AGENT.md rule) via `herdr agent prompt '<PARENT_PANE_ID>'`.
  //    The parent pane ID is embedded in the task BY THE ORCHESTRATOR (it knows
  //    its own pane ID from HERDR_PANE_ID), so the orchestrator never reads the
  //    worker's full transcript — only the short summary flows up, so there is no
  //    context bloat. This tool itself does NOT inject the instruction, because it
  //    cannot reliably determine the parent pane ID (the herdr caller env is not
  //    guaranteed here); the agent-level rule is the reliable mechanism.
  // Submit WITHOUT --wait, then supervise the worker ourselves. A blocking
  // `prompt --wait` cannot be supervised: a stuck worker would hold it until
  // the full timeout with no chance to intervene. Our own poll loop observes
  // the live `agent_status` every WAIT_POLL_MS (feeding the parent-TUI widget
  // via onActive), stops at the first terminal state, and kills workers that
  // go stale (see STALE_STREAK_THRESHOLD) instead of waiting out the timeout.
  const { code: submitCode, stdout: submitOut, stderr: submitErr } =
    await runHerdr(["agent", "prompt", agentName, task]);
  if (submitCode !== 0) {
    // Same ghost-pane guard as start failure: do not leave the pane behind.
    // Honor closePaneOnDone so explicit `false` still keeps the pane for debug.
    let closed = false;
    let closeError: string | undefined;
    if (opts.closePaneOnDone) {
      const r = await closePaneRobustly(paneId).catch(() => undefined);
      closed = r?.closed ?? false;
      closeError = r?.lastError;
    } else {
      closed = await isPaneClosed(paneId).catch(() => false);
    }
    const suffix = opts.closePaneOnDone ? (closed ? " • pane closed" : ` • pane still open${closeError ? ` (close error: ${closeError})` : ""}`) : " • pane open";
    return {
      content: [
        {
          type: "text",
          text: `pi-subagents: prompt submit failed: ${submitErr || submitOut}${suffix}`,
        },
      ],
      details: { paneId, agentId: opts.agentId, agent: agentName, done: false, closed },
    };
  }
  // One deadline bounds the whole supervision, and the same deadline drives
  // the countdown ticker — so the displayed counter always matches the actual
  // remaining wait.
  const deadline = Date.now() + opts.timeoutMs;
  const stopCountdown = startCountdown({
    paneId,
    baseLabel: agentName,
    agentId: opts.agentId,
    agentName,
    deadline,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onUpdate: opts.onUpdate,
    onStatus: opts.onStatus,
    onActive: (tick) => emitActive(tick),
  });
  // Herdr's terminal states. `idle` only counts after the worker was observed
  // busy at least once — a fresh agent reports `idle` before its first turn,
  // and `done` only ever appears after a turn ran.
  const terminalStates = new Set(["idle", "done", "blocked"]);
  let agentStatus = "submitted";
  let sawActive = false;
  let staleStreak = 0;
  let staleKilled = false;
  let done = false;
  let cancelled = false;
  // Only push status updates when the observed value actually changed. The
  // countdown ticker already refreshes the widget every second — re-pushing
  // an identical "working" here would tear down and rebuild the widget
  // component twice per second for no visible change (visible flicker).
  let lastReported: string | undefined;
  const reportStatus = (status: string): void => {
    agentStatus = status;
    emitActive({
      agentId: opts.agentId,
      agentName,
      paneId,
      timeoutMs: opts.timeoutMs,
      phase: "working",
      status,
    });
  };
  try {
    for (;;) {
      if (opts.signal?.aborted) {
        cancelled = true;
        agentStatus = "cancelled";
        break;
      }
      if (Date.now() >= deadline) break;
      const g = await runHerdr(["agent", "get", agentName]);
      const m = /"agent_status"\s*:\s*"(\w+)"/.exec(g.stdout || "");
      if (g.code !== 0 || !m) {
        // Lookup failed or reported no status: the worker may be gone.
        // Tolerate a few transient socket hiccups before acting.
        staleStreak++;
      } else {
        const observed = m[1];
        if (observed === "working" || observed === "blocked") sawActive = true;
        staleStreak = observed === "unknown" ? staleStreak + 1 : 0;
        if (observed !== lastReported) {
          lastReported = observed;
          reportStatus(observed);
        }
        if (
          terminalStates.has(observed) &&
          (observed !== "idle" || sawActive)
        ) {
          done = true;
          break;
        }
      }
      if (staleStreak >= STALE_STREAK_THRESHOLD) {
        // Gone/stuck: kill the pane now instead of waiting out the timeout.
        // Robust close here too — a single `pane close` can fail transiently
        // and the final cleanup below re-verifies anyway.
        await closePaneRobustly(paneId).catch(() => undefined);
        staleKilled = true;
        reportStatus("stale — killed");
        break;
      }
      await sleep(WAIT_POLL_MS);
    }
  } finally {
    // Always restore the pane label and clear the parent status, even when the
    // wait throws — a stale "⏳ 00:00" label must never outlive the task.
    await stopCountdown();
  }

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
  // A stale-killed pane is already closed by the watchdog; otherwise close it
  // here when requested. The worker already sent its summary to the
  // orchestrator's pane via backchannel (see step 3); we additionally read it
  // back here so the summary is not lost when there is no orchestrator pane.
  let closed = false;
  let closeError: string | undefined;
  if (staleKilled) {
    closed = await isPaneClosed(paneId);
    if (!closed) {
      const r = await closePaneRobustly(paneId);
      closed = r.closed;
      closeError = r.lastError;
    }
  }
  if (opts.closePaneOnDone && !closed) {
    // Focused-pane guard: Herdr occasionally refuses to close the focused
    // pane, so best-effort focus the parent first (never fails the task).
    if (parentPaneId) {
      await runHerdr(["pane", "focus", parentPaneId]).catch(() => undefined);
    }
    const r = await closePaneRobustly(paneId);
    closed = r.closed;
    closeError = r.lastError;
  }

  const tl = opts.thinkingLevel ? ` • thinking:${opts.thinkingLevel}` : "";
  const ns = opts.noSkills ? " • no-skills" : "";
  const nest = opts.nestedSubagentAllowed ? " • nested" : "";
  const outcome = done
    ? "task completed"
    : cancelled
      ? `cancelled (${agentStatus}) — worker stopped`
      : staleKilled
        ? `stale (${agentStatus}) — worker killed`
        : "timed out";
  const statusBase = `pi-subagents: pane ${paneId} • ${opts.model}${tl}${ns}${nest} • agent ${agentName} • ${outcome} • ${opts.closePaneOnDone || staleKilled ? (closed ? "pane closed" : "pane still open") : "pane open"}`;
  const status = !closed && (opts.closePaneOnDone || staleKilled) && closeError ? `${statusBase} (close error: ${closeError})` : statusBase;

  // The close reason is always surfaced to the caller: when the worker finished
  // normally that is "task completed"; when it went stale the watchdog killed
  // it; when it did not reach a terminal state in time the pane was closed by
  // the orchestrator due to a timeout. Never leave the parent guessing why
  // the subagent disappeared.
  const closeReason = done
    ? "task completed"
    : cancelled
      ? "cancelled by parent (AbortSignal) — pane closed during cleanup"
      : staleKilled
        ? `stale worker (last status "${agentStatus}") — pane closed by the stale watchdog`
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
      agentId: opts.agentId,
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      noSkills: opts.noSkills,
      nestedSubagentAllowed: opts.nestedSubagentAllowed,
      agent: agentName,
      agentStatus,
      done,
      closed,
      staleKilled,
      cancelled,
      closeReason,
      closeError,
    },
  };
}
