import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { SpFile } from "./types.ts";
import { HERDR_BIN, CLOSE_ATTEMPTS, CLOSE_RETRY_MS } from "./constants.ts";

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

/**
 * Reads the worker's final textual answer from its session JSONL.
 *
 * The naive approach (`herdr agent read --source recent --format text`) returns
 * the pane's raw terminal snapshot, which includes pi's UI chrome — startup
 * banner, Skills/Extensions lists, status bar — not just the worker's answer.
 * Instead we resolve the agent's session path via `herdr agent get` and extract
 * the last assistant `text` content block: the worker's actual answer, with no
 * UI noise. Thinking/tool-call blocks are skipped so only meaningful prose is
 * returned. `lines` bounds the returned text (honours the bounded-output intent).
 */
async function readAgentOutput(
  agentName: string,
  lines: number,
): Promise<string | undefined> {
  const sessionPath = await resolveAgentSessionPath(agentName);
  if (!sessionPath) {
    // Fallback: if the session path can't be resolved (e.g. a future herdr API
    // change) fall back to the bounded terminal snapshot rather than losing the
    // summary entirely.
    return readTerminalOutput(agentName, lines);
  }
  const text = extractLastAssistantText(sessionPath);
  if (text === undefined) return undefined;
  return boundToLines(text, lines);
}

/** Resolves a named agent's session JSONL path via `herdr agent get`. */
async function resolveAgentSessionPath(
  agentName: string,
): Promise<string | undefined> {
  const { stdout, code } = await runHerdr(["agent", "get", agentName]);
  if (code !== 0) return undefined;
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  if (!line) return undefined;
  try {
    const obj = JSON.parse(line);
    return obj?.result?.agent?.agent_session?.value;
  } catch {
    return undefined;
  }
}

/** Extracts the last assistant `text` block from a session JSONL, skipping
 * thinking/tool-call blocks. Returns undefined if there is no such block. */
function extractLastAssistantText(sessionPath: string): string | undefined {
  let last: string | undefined;
  try {
    const raw = fs.readFileSync(sessionPath, "utf8");
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(t);
      } catch {
        continue;
      }
      const msg = (rec as { message?: unknown })?.message as
        | { role?: string; content?: unknown[] }
        | undefined;
      if (!msg || msg.role !== "assistant") continue;
      for (const blk of msg.content ?? []) {
        const b = blk as { type?: string; text?: string };
        if (b?.type === "text" && b.text?.trim()) {
          last = b.text.trim();
        }
      }
    }
  } catch {
    return undefined;
  }
  return last;
}

/** Reads a bounded tail of an agent's raw terminal output (fallback path). */
async function readTerminalOutput(
  agentName: string,
  lines: number,
): Promise<string | undefined> {
  const { stdout, code } = await runHerdr([
    "agent",
    "read",
    agentName,
    "--lines",
    String(lines),
    "--source",
    "recent",
    "--format",
    "text",
  ]);
  if (code !== 0) return undefined;
  return stdout.trim();
}

/** Keeps the last `lines` lines of a text block (bounds returned output). */
function boundToLines(text: string, lines: number): string {
  const parts = text.split("\n");
  return parts.slice(Math.max(0, parts.length - lines)).join("\n");
}

/** Returns true only once the pane is verifiably gone from herdr.
 *
 * Unknown means "still open": when `pane list` fails or its output cannot be
 * parsed we return false instead of true, so the caller retries the close
 * rather than reporting a phantom success and leaking a ghost pane. */
async function isPaneClosed(paneId: string): Promise<boolean> {
  const { stdout, code } = await runHerdr(["pane", "list"]);
  if (code !== 0) return false;
  const panes = parseHerdrResult<{ pane_id: string }[]>(stdout, "panes");
  if (!Array.isArray(panes)) return false;
  return !panes.some((p) => p.pane_id === paneId);
}

/** Closes a pane and verifies it is actually gone.
 *
 * `pane close` can fail transiently (Herdr busy, agent exiting race), and the
 * old call-site ignored its exit code and retried only once — the classic
 * ghost-pane leak. This helper retries up to `attempts` times with
 * `retryMs` delay, checking isPaneClosed() after every attempt, and returns
 * the last herdr error so the caller can surface WHY the pane is still open.
 * Never throws. */
async function closePaneRobustly(
  paneId: string,
  opts: { attempts?: number; retryMs?: number } = {},
): Promise<{ closed: boolean; attempts: number; lastError?: string }> {
  const attempts = opts.attempts ?? CLOSE_ATTEMPTS;
  const retryMs = opts.retryMs ?? CLOSE_RETRY_MS;
  let lastError: string | undefined;
  for (let i = 1; i <= attempts; i++) {
    if (await isPaneClosed(paneId)) return { closed: true, attempts: i, lastError };
    const r = await runHerdr(["pane", "close", paneId]);
    if (r.code !== 0) {
      lastError = (r.stderr || r.stdout || `exit ${r.code}`).trim();
    }
    if (await isPaneClosed(paneId)) return { closed: true, attempts: i, lastError };
    if (i < attempts) await sleep(retryMs);
  }
  return { closed: await isPaneClosed(paneId), attempts, lastError };
}

export {
  parseHerdrErrorCode,
  parseHerdrResult,
  sleep,
  runHerdr,
  writeTempSystemPrompt,
  cleanupSpFiles,
  readAgentOutput,
  isPaneClosed,
  closePaneRobustly,
};
