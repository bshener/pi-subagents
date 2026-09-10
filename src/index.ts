import { Text } from "@earendil-works/pi-tui";
import { execute, listAgentsBySource } from "./task.ts";
import { agentsBySourceText } from "./list.ts";
import { renderCall, renderResult } from "./render.ts";
import type {
  ExtensionAPI,
  MessageRenderOptions,
  Theme,
  ExtensionCommandContext,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export { execute, listAgentsBySource, renderCall, renderResult };

export default function (pi: ExtensionAPI) {
  // Register the pi-subagents tool with its execute handler.
  pi.registerTool({
    name: "pi-subagents",
    label: "pi-subagents",
    description:
      "Opens a new visible pane in Herdr and launches an isolated pi subagent inside it. " +
      "Uses Herdr's agent start/prompt/get lifecycle API for reliable execution. " +
      "The subagent sends its summary back to the caller pane; this tool waits only for " +
      "the subagent to reach a terminal state and never reads its raw transcript." +
      "Inherits the current model unless --model or an agent file specifies one. " +
      "Waits until the task completes and closes the pane if requested.",
    parameters: {
      agent: {
        type: "string",
        description:
          "Agent id (directory name under the agents dir). Loads that agent's model + system prompt.",
        optional: true,
      },
      task: {
        type: "string",
        description: "The task the subagent will perform.",
      },
      model: {
        type: "string",
        description:
          "The model to use. Overrides the agent file and the current model.",
        optional: true,
      },
      cwd: {
        type: "string",
        description:
          "Working directory for the pane. If omitted, the current cwd is used.",
        optional: true,
      },
      direction: {
        type: "enum",
        values: ["right", "left", "down", "up"],
        description: "Pane split direction.",
        optional: true,
      },
      focus: {
        type: "boolean",
        description: "Should the new pane take focus? Default: false.",
        optional: true,
      },
      closePaneOnDone: {
        type: "boolean",
        description: "Close the pane when the task completes? Default: true.",
        optional: true,
      },
      timeoutMs: {
        type: "number",
        description: "Maximum wait time in ms. Default: 360000.",
        optional: true,
      },
    },
    renderCall,
    renderResult,
    execute: async (
      _toolCallId: string,
      _params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      const agent = _params.agent as string;
      const task = _params.task as string;
      return execute(agent, task);
    },
  });

  // Register the pi-subagents-list tool with its execute handler.
  pi.registerTool({
    name: "pi-subagents-list",
    label: "pi-subagents-list",
    description:
      "Lists subagents grouped by source directory (project-local <project>/.pi/agents and global ~/.pi/agent/agents) so you can see where each agent is defined. Run from the project directory to see both. Uses PI_SUBAGENTS_DIR if set.",
    parameters: {},
    renderCall: () => new Text("pi-subagents-list", 0, 0),
    renderResult,
    execute: async (
      _toolCallId: string,
      _params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<unknown> | undefined,
      _ctx: ExtensionContext,
    ) => {
      return listAgentsBySource();
    },
  });

  // Register the message renderer for the pi-subagents-list command.
  pi.registerMessageRenderer(
    "pi-subagents-list",
    (message: any, options: MessageRenderOptions, theme: Theme) =>
      new Text(
        theme.fg("accent", `[${message.customType}] `) + message.content,
        options.outputPad,
        0,
      ),
  );

  // Register the pi-subagents-list command for -autocomplete and manual invocation.
  pi.registerCommand("pi-subagents-list", {
    description:
      "Lists subagents grouped by source directory (project-local <project>/.pi/agents and global ~/.pi/agent/agents) so you can see where each agent is defined. Run from the project directory to see both. Uses PI_SUBAGENTS_DIR if set.",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const text = await agentsBySourceText(ctx.cwd);
      pi.sendMessage({
        customType: "pi-subagents-list",
        content: text,
        display: true,
      });
    },
  });
}
