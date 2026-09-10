import * as fs from "node:fs";
import * as path from "node:path";

import { AGENT_FILENAME } from "./constants";
import { parseAgentManifest } from "./agents";

/** Formats a single agent entry for display. */
export function formatAgentLine(entry: {
  id: string;
  name: string;
  description: string;
  model?: string;
}): string {
  const model = entry.model ?? "default";
  return `[${entry.id}] ${entry.name} — ${entry.description} (${model})`;
}

/** Lists agents by source text, scanning all agent directories under the given directory. */
export async function agentsBySourceText(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return "";
  }
  const result: string[] = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    const agentFile = path.join(dir, entry, AGENT_FILENAME);
    let content: string;
    try {
      content = await fs.promises.readFile(agentFile, "utf8");
    } catch {
      continue; // Not an agent directory (no AGENT.md).
    }
    const { meta } = parseAgentManifest(content);
    result.push(
      formatAgentLine({
        id: entry,
        name: meta.name ?? entry,
        description: meta.description ?? "",
        model: meta.model,
      }),
    );
  }
  return result.join("\n");
}

/** Groups agents by their source directory (e.g., project-local vs global). */
export async function listAgentsBySource(): Promise<string> {
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(".");
  } catch {
    return "";
  }
  const result: string[] = [];
  for (const dir of dirs.sort()) {
    const agentsDir = path.join(dir, ".pi", "agents");
    if (!fs.existsSync(agentsDir)) continue;
    let subdirs: string[];
    try {
      subdirs = await fs.promises.readdir(agentsDir);
    } catch {
      continue;
    }
    for (const subdir of subdirs.sort((a, b) => a.localeCompare(b))) {
      const agentFile = path.join(agentsDir, subdir, AGENT_FILENAME);
      if (fs.existsSync(agentFile)) {
        const content = await fs.promises.readFile(agentFile, "utf8");
        const { meta } = parseAgentManifest(content);
        result.push(
          `[${dir}/${subdir}] ${meta.name ?? subdir} — ${meta.description ?? ""}`,
        );
      }
    }
  }
  return result.join("\n");
}
