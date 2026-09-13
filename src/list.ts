import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { discoverAgentsIn, type DiscoveredAgent } from "./agents.ts";

/** Marker appended (only) when the agent ships a USAGE.md spawner contract. */
function usageMarker(a: Pick<DiscoveredAgent, "hasUsage">): string {
  return a.hasUsage ? " [+usage]" : "";
}

/** Formats a single agent entry for display. */
function formatAgentLine(entry: DiscoveredAgent): string {
  const model = entry.model ?? "default";
  return `[${entry.id}] ${entry.name} — ${entry.description} (${model})${usageMarker(entry)}`;
}

/** Lists agents by source text, scanning all agent directories under the given directory. */
export async function agentsBySourceText(dir: string): Promise<string> {
  const agents = await discoverAgentsIn(dir);
  return agents.map(formatAgentLine).join("\n");
}

/** Resolves the global agent directory, honoring PI_SUBAGENTS_DIR when set. */
export function globalAgentsDir(): string {
  const override = process.env.PI_SUBAGENTS_DIR;
  if (override) return override;
  return path.join(os.homedir(), ".pi", "agent", "agents");
}

/** Lists project-local agents (from <cwd>/.pi/agents) and global agents together. */
export async function agentsBySourceTextForCwd(cwd: string): Promise<string> {
  const lines: string[] = [];
  const projectDir = path.join(cwd, ".pi", "agents");
  const projectAgents = await discoverAgentsIn(projectDir);
  for (const a of projectAgents) {
    lines.push(
      `[${projectDir}] ${a.name} — ${a.description} (${a.model ?? "default"})${usageMarker(a)}`,
    );
  }
  const globalDir = globalAgentsDir();
  const globalAgents = await discoverAgentsIn(globalDir);
  for (const a of globalAgents) {
    lines.push(
      `[${globalDir}] ${a.name} — ${a.description} (${a.model ?? "default"})${usageMarker(a)}`,
    );
  }
  if (lines.length === 0) return "(no agents found)";
  return lines.join("\n");
}

/** Groups agents by their source directory (e.g., project-local vs global). */
export async function listAgentsBySource(): Promise<string> {
  const lines: string[] = [];
  // Project-local agents: scan cwd's own .pi/agents directory.
  const projectDir = path.join(".", ".pi", "agents");
  if (fs.existsSync(projectDir)) {
    const agents = await discoverAgentsIn(projectDir);
    for (const a of agents) {
      lines.push(
        `[${projectDir}] ${a.name} — ${a.description} (${a.model ?? "default"})${usageMarker(a)}`,
      );
    }
  }
  // Global agents (shared across all project directories).
  const globalDir = globalAgentsDir();
  if (fs.existsSync(globalDir)) {
    const agents = await discoverAgentsIn(globalDir);
    for (const a of agents) {
      lines.push(
        `[${globalDir}] ${a.name} — ${a.description} (${a.model ?? "default"})${usageMarker(a)}`,
      );
    }
  }
  if (lines.length === 0) return "(no agents found)";
  return lines.join("\n");
}
