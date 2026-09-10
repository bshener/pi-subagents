import * as fs from "node:fs";
import * as path from "node:path";

import { discoverAgentsIn } from "./agents.ts";

/** Formats a single agent entry for display. */
function formatAgentLine(entry: {
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
  const agents = await discoverAgentsIn(dir);
  return agents.map(formatAgentLine).join("\n");
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
  for (const dir of dirs.sort((a, b) => a.localeCompare(b))) {
    const agentsDir = path.join(dir, ".pi", "agents");
    if (!fs.existsSync(agentsDir)) continue;
    const agents = await discoverAgentsIn(agentsDir);
    for (const a of agents) {
      result.push(`[${dir}/${a.id}] ${a.name} — ${a.description}`);
    }
  }
  return result.join("\n");
}
