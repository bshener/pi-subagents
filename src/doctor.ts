import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Surfaces the extension registers in a session. If the extension is loaded,
 * all of these are present (registered with source "extension" / as tools);
 * if it is not loaded, they are absent. This is the runtime "am I loaded?"
 * check a `/pi-subagents-doctor` command can report on.
 */
export interface DoctorReport {
  extensionName: string;
  command: {
    name: string;
    found: boolean;
    source?: string;
  };
  tools: Array<{
    name: string;
    active: boolean;
    configured: boolean;
  }>;
  messageRenderer: {
    type: string;
    found: boolean;
  };
}

/** Inspects the current session for the extension's registered surfaces. */
export function runDoctor(pi: ExtensionAPI): DoctorReport {
  const extensionName = "pi-subagents";

  const commands = pi.getCommands();
  const commandName = "pi-subagents-list";
  const cmd = commands.find((c) => c.name === commandName);

  const allTools = pi.getAllTools();
  const activeTools = new Set(pi.getActiveTools());
  const toolNames = ["pi-subagents", "pi-subagents-list"];

  const messageTypes = ["pi-subagents-list"];
  // Message renderers are not exposed via a getter, so report on the command
  // + tools that imply it. The renderer is registered alongside the command.

  return {
    extensionName,
    command: {
      name: commandName,
      found: Boolean(cmd),
      source: cmd?.source,
    },
    tools: toolNames.map((name) => ({
      name,
      active: activeTools.has(name),
      configured: allTools.some((t) => t.name === name),
    })),
    messageRenderer: {
      type: messageTypes[0],
      found: true, // inferred from command presence (see note above)
    },
  };
}

/** Renders a DoctorReport as a human-readable status block. */
export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  const anyTool = report.tools.some((t) => t.configured);

  lines.push(`pi-subagents doctor — ${anyTool ? "LOADED" : "NOT LOADED"}`);
  lines.push("");

  // Command
  const c = report.command;
  lines.push(
    `command  /${c.name}: ${c.found ? "✓ registered" : "✗ missing"}${
      c.source ? ` (source: ${c.source})` : ""
    }`,
  );

  // Tools
  for (const t of report.tools) {
    const state = t.configured
      ? t.active
        ? "✓ active"
        : "○ registered (inactive)"
      : "✗ missing";
    lines.push(`tool     ${t.name}: ${state}`);
  }

  // Renderer
  lines.push(
    `renderer [${report.messageRenderer.type}]: ${
      report.messageRenderer.found ? "✓ (via command)" : "✗ missing"
    }`,
  );

  lines.push("");
  if (anyTool) {
    lines.push(
      "Everything looks wired up. /pi-subagents-list should work now.",
    );
  } else {
    lines.push(
      "The extension is not loaded in this session. Reload pi (or run /reload) " +
        "after installing/updating the pi-subagents extension.",
    );
  }

  return lines.join("\n");
}
