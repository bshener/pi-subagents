import * as fs from "node:fs";
import * as path from "node:path";

import { AGENT_FILENAME } from "./constants";
import { parseAgentManifest } from "./agents";
import { AgentToolResult } from "@earendil-works/pi-coding-agent";

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

/** Converts a formatted agent listing string into a typed AgentToolResult. */
function createAgentResult(text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: {},
  };
}

/** Lists agents by source directory, scanning all agent directories under the given directory. */
export async function listAgentsBySource(): Promise<AgentToolResult<unknown>> {
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(".");
  } catch {
    return createAgentResult("");
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
  return createAgentResult(result.join("\n"));
}

/** Returns a single agent's parsed model information. */
export async function execute(
  agent: string,
  task: string,
): Promise<AgentToolResult<unknown>> {
  const file = path.join(agent, AGENT_FILENAME);
  let content: string;
  try {
    content = await fs.promises.readFile(file, "utf8");
  } catch {
    return createAgentResult(`Error: Could not find agent file at ${file}`);
  }
  const { meta } = parseAgentManifest(content);
  const model = meta.model ?? "default";
  const systemPrompt = meta.systemPrompt ?? "";
  return createAgentResult(
    `Agent: ${meta.name ?? agent} (model=${model})\nSystem prompt:\n${systemPrompt}\nTask: ${task}`,
  );
}

/** Loads an agent and runs the specified task in a subagent process. */
export async function runTask(
  agent: string,
  task: string,
): Promise<AgentToolResult<unknown>> {
  const file = path.join(agent, AGENT_FILENAME);
  let content: string;
  try {
    content = await fs.promises.readFile(file, "utf8");
  } catch {
    return createAgentResult(`Error: Could not find agent file at ${file}`);
  }
  const { meta } = parseAgentManifest(content);
  const model = meta.model ?? "default";
  return createAgentResult(
    `Running task "${task}" for agent "${meta.name ?? agent}" (model=${model})...`,
  );
}
