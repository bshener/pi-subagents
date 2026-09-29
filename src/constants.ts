export const HERDR_BIN = process.env.HERDR_BIN ?? "herdr";
// Workers notify the parent when their task completes, so the timeout is only
// a safety net against stuck/lost workers — not a performance target. Floor and
// default are deliberately generous (30 minutes).
export const MIN_TIMEOUT_MS = 30 * 60 * 1_000; // 30 minutes
export const DEFAULT_TIMEOUT_MS = MIN_TIMEOUT_MS; // 30 minutes
// Stale watchdog: while supervising a worker, `agent get` is polled every
// WAIT_POLL_MS. A poll counts as suspicious when the lookup fails, reports no
// status, or reports "unknown". STALE_STREAK_THRESHOLD consecutive suspicious
// polls means the worker is gone/stuck: its pane is closed (killed) and the
// tool reports what happened instead of waiting out the full timeout.
export const WAIT_POLL_MS = 1_000;
export const STALE_STREAK_THRESHOLD = 5;
export const AGENT_FILENAME = "AGENT.md";
// Optional spawner contract: "<agent-dir>/USAGE.md" holds instructions for the
// *parent* agent (how to spawn this agent: timeouts, task contents, gotchas).
// The runner itself never reads it; `pi-subagents-list` flags its presence.
export const USAGE_FILENAME = "USAGE.md";
// How long to wait between close attempts. Pane close can race with the
// agent exiting / Herdr re-rendering, so a single retry is not enough —
// closePaneRobustly() retries several times with this delay.
export const CLOSE_RETRY_MS = 800;
// How many times to attempt `pane close` before giving up and reporting
// "pane still open". Each attempt is followed by an isPaneClosed() check,
// so a transient Herdr hiccup no longer leaves a ghost pane behind.
export const CLOSE_ATTEMPTS = 5;
// How many recent lines of the worker's terminal to read back so the caller
// receives the actual result instead of only a status line. Bounded on purpose:
// reading the whole transcript would reintroduce the context bloat the backchannel
// design was meant to avoid; a tail is cheap and always contains the summary.
export const WORKER_OUTPUT_LINES = 60;

// `agent start` readiness is screen-detection based: Herdr only succeeds once
// pi has fully launched and rendered inside the freshly split pane. Right after
// `pane split` the pane's shell is still coming up, so the first attempt often
// fails with a transient error. These codes mean "pi isn't ready yet" (as
// opposed to a real misconfiguration), so we retry them with backoff instead of
// abandoning the already-allocated pane — which would leave a ghost/host pane.
// The per-attempt readiness timeout is left to Herdr's default (30s) on purpose:
// a cold llama.cpp model can take a while, and shortening it would regress the
// cold-start case that the original default handled fine.
// Thinking levels accepted by pi (`--thinking <level>`). Kept in one place so the
// tool schema and the agent frontmatter both validate against the same set.
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

// `agent start` readiness is screen-detection based: Herdr only succeeds once
// pi has fully launched and rendered inside the freshly split pane. Right after
// `pane split` the pane's shell is still coming up, so the first attempt often
// fails with a transient error. These codes mean "pi isn't ready yet" (as
// opposed to a real misconfiguration), so we retry them with backoff instead of
// abandoning the already-allocated pane — which would leave a ghost/host pane.
// The per-attempt readiness timeout is left to Herdr's default (30s) on purpose:
// a cold llama.cpp model can take a while, and shortening it would regress the
// cold-start case that the original default handled fine.
export const TRANSIENT_START_ERRORS = new Set(["agent_pane_busy", "timeout"]);
export const MAX_START_ATTEMPTS = 3; // bounds worst case to ~3×30s if pi never starts
export const START_BACKOFF_MS = 1_500;
