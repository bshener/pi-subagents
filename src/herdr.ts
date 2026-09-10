import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { SpFile } from "./types.ts";
import { HERDR_BIN } from "./constants.ts";

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
 * Reads a bounded tail of an agent's terminal output.
 *
 * Used to capture the worker's summary so the caller actually receives the
 * result. `--source recent --format text --lines N` keeps this cheap and avoids
 * re-injecting the worker's entire transcript (the "context bloat" the
 * backchannel design was trying to avoid).
 */
async function readAgentOutput(
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

/** Returns true once the pane no longer exists in herdr (i.e. it was closed). */
async function isPaneClosed(paneId: string): Promise<boolean> {
  const { stdout } = await runHerdr(["pane", "list"]);
  const panes = parseHerdrResult<{ pane_id: string }[]>(stdout, "panes");
  return !panes?.some((p) => p.pane_id === paneId);
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
};
