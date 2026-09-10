import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_FILENAME } from "./constants";

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

/** Resolves the agents directory (env override > project-local .pi/agents > ~/.pi/agent/agents). */
function resolveAgentsDir(cwd: string): string {
  if (process.env.PI_SUBAGENTS_DIR) return process.env.PI_SUBAGENTS_DIR;
  const projectLocal = path.join(cwd, ".pi", "agents");
  const globalDir = path.join(os.homedir(), ".pi", "agent", "agents");
  return fs.existsSync(projectLocal) ? projectLocal : globalDir;
}

/** Walks up from `cwd` looking for a `<dir>/.pi/agents` directory (the repo's subagent root). */
function findProjectAgentsDir(cwd: string): string | null {
  let dir = path.resolve(cwd);
  const root = path.parse(dir).root;
  for (;;) {
    const candidate = path.join(dir, ".pi", "agents");
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

/** Shared implementation used by both discoverAgents and the list tool. */
async function discoverAgentsIn(
  dir: string,
): Promise<
  Array<{ id: string; name: string; description: string; model?: string }>
> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const agents: Array<{
    id: string;
    name: string;
    description: string;
    model?: string;
  }> = [];
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
    });
  }
  return agents;
}

/** Loads a single agent by id (directory name under the agents dir). */
async function loadAgent(
  id: string,
  dir: string,
): Promise<{
  id: string;
  name: string;
  description: string;
  model?: string;
  systemPrompt?: string;
  direction?: string;
  closePaneOnDone?: boolean;
} | null> {
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

export {
  parseAgentManifest,
  resolveAgentsDir,
  findProjectAgentsDir,
  discoverAgentsIn,
  loadAgent,
};
