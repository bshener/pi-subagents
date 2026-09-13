import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_FILENAME, USAGE_FILENAME } from "./constants.ts";

function parseAgentManifest(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!m) return { meta: {}, body: content };
  const meta: Record<string, string> = {} as const;
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

/** Resolves an agent id to its AGENT.md file, following the documented order:
 *  1. PI_SUBAGENTS_DIR environment override
 *  2. <cwd>/.pi/agents (project-local)
 *  3. ~/.pi/agent/agents (global)
 * Returns the file path, or null if no agent file is found. */
export function resolveAgentFile(
  agent: string,
  cwd: string = process.cwd(),
): string | null {
  // 1. Explicit PI_SUBAGENTS_DIR override.
  const override = process.env.PI_SUBAGENTS_DIR;
  if (override) {
    const file = path.join(override, agent, AGENT_FILENAME);
    if (fs.existsSync(file)) return file;
  }
  // 2. Project-local .pi/agents.
  const projectFile = path.join(cwd, ".pi", "agents", agent, AGENT_FILENAME);
  if (fs.existsSync(projectFile)) return projectFile;
  // 3. Global agents dir.
  const globalFile = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "agents",
    agent,
    AGENT_FILENAME,
  );
  if (fs.existsSync(globalFile)) return globalFile;
  return null;
}

/** One discovered agent: manifest fields plus USAGE.md presence. */
export interface DiscoveredAgent {
  id: string;
  name: string;
  description: string;
  model?: string;
  /** True when `<agent-dir>/USAGE.md` (spawner contract) is present. */
  hasUsage: boolean;
}

/** Shared implementation used by both discoverAgents and the list tool. */
async function discoverAgentsIn(dir: string): Promise<Array<DiscoveredAgent>> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const agents: Array<DiscoveredAgent> = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
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
      hasUsage: fs.existsSync(path.join(dir, entry, USAGE_FILENAME)),
    });
  }
  return agents;
}

/**
 * Synchronous sibling of discoverAgentsIn(): reads the agent dirs with sync fs
 * so it can run at extension load time (before a session cwd is available).
 * Used to register the /subagent:<id> slash commands up front.
 */
export function discoverAgentsSync(dir: string): Array<DiscoveredAgent> {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const agents: Array<DiscoveredAgent> = [];
  for (const entry of entries.sort((a, b) => a.localeCompare(b))) {
    const agentFile = path.join(dir, entry, AGENT_FILENAME);
    let content: string;
    try {
      content = fs.readFileSync(agentFile, "utf8");
    } catch {
      continue; // Not an agent directory (no AGENT.md).
    }
    const { meta } = parseAgentManifest(content);
    agents.push({
      id: entry,
      name: meta.name ?? entry,
      description: meta.description ?? "",
      model: meta.model,
      hasUsage: fs.existsSync(path.join(dir, entry, USAGE_FILENAME)),
    });
  }
  return agents;
}

/**
 * Sibling of resolveAgentFile() for the spawner contract: resolves an agent id
 * to its USAGE.md file, following the same order. Returns the file path, or
 * null when the agent has no USAGE.md (the contract is optional).
 */
export function resolveAgentUsageFile(
  agent: string,
  cwd: string = process.cwd(),
): string | null {
  const override = process.env.PI_SUBAGENTS_DIR;
  if (override) {
    const file = path.join(override, agent, USAGE_FILENAME);
    if (fs.existsSync(file)) return file;
  }
  const projectFile = path.join(cwd, ".pi", "agents", agent, USAGE_FILENAME);
  if (fs.existsSync(projectFile)) return projectFile;
  const globalFile = path.join(
    os.homedir(),
    ".pi",
    "agent",
    "agents",
    agent,
    USAGE_FILENAME,
  );
  if (fs.existsSync(globalFile)) return globalFile;
  return null;
}

/**
 * Sibling of resolveAgentFile() that returns the agents *directory* (not a file)
 * for a given cwd, following the documented order. Synchronous so it can run at
 * extension load time to register /subagent:<id> commands.
 */
export function resolveAgentsDir(cwd: string): string {
  const override = process.env.PI_SUBAGENTS_DIR;
  if (override) return override;
  const projectLocal = path.join(cwd, ".pi", "agents");
  if (fs.existsSync(projectLocal)) return projectLocal;
  return path.join(os.homedir(), ".pi", "agent", "agents");
}

export { parseAgentManifest, discoverAgentsIn };
