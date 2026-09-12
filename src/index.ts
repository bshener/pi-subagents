import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execute, createAgentResult } from "./task.ts";
import { THINKING_LEVELS } from "./constants.ts";
import { agentsBySourceTextForCwd, listAgentsBySource } from "./list.ts";
import { renderCall, renderResult } from "./render.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import type {
  ExtensionAPI,
  MessageRenderOptions,
  Theme,
  ExtensionCommandContext,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export {
  execute,
  createAgentResult,
  listAgentsBySource,
  renderCall,
  renderResult,
};

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
    parameters: Type.Object(
      {
        agent: Type.String({
          description:
            "Agent id (directory name under the agents dir). Loads that agent's model + system prompt.",
        }),
        task: Type.String({
          description: "The task the subagent will perform.",
        }),
        model: Type.Optional(
          Type.String({
            description:
              "The model to use. Overrides the agent file and the current model.",
          }),
        ),
        thinkingLevel: Type.Optional(
          Type.Enum(
            {
              ...Object.fromEntries(THINKING_LEVELS.map((l) => [l, l])),
            } as const,
            {
              description:
                "Thinking level for the subagent (off/minimal/low/medium/high/xhigh/max). " +
                "Overrides the agent file's frontmatter and the current model. If omitted, " +
                "the agent file default is used, otherwise pi keeps its own default.",
            },
          ),
        ),
        cwd: Type.Optional(
          Type.String({
            description:
              "Working directory for the pane. If omitted, the current cwd is used.",
          }),
        ),
        direction: Type.Optional(
          Type.Enum(
            { right: "right", left: "left", down: "down", up: "up" } as const,
            {
              description: "Pane split direction.",
            },
          ),
        ),
        focus: Type.Optional(
          Type.Boolean({
            description: "Should the new pane take focus? Default: false.",
          }),
        ),
        closePaneOnDone: Type.Optional(
          Type.Boolean({
            description:
              "Close the pane when the task completes? Default: true.",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({
            description: "Maximum wait time in ms. Default: 360000.",
          }),
        ),
      },
      { required: ["agent", "task"] },
    ),
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
      return execute(agent, task, {
        thinkingLevel: _params.thinkingLevel as string | undefined,
      });
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
      return createAgentResult(await listAgentsBySource());
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
      const text = await agentsBySourceTextForCwd(ctx.cwd);
      pi.sendMessage({
        customType: "pi-subagents-list",
        content: text,
        display: true,
      });
    },
  });

  // Register the pi-subagents-doctor command: reports whether this extension is
  // actually loaded in the current session by inspecting its own registered
  // command + tools.
  pi.registerCommand("pi-subagents-doctor", {
    description:
      "Checks whether the pi-subagents extension is loaded in the current session and reports the status of its registered command and tools.",
    handler: async (_args: string, _ctx: ExtensionCommandContext) => {
      const report = runDoctor(pi);
      pi.sendMessage({
        customType: "pi-subagents-doctor",
        content: formatDoctorReport(report),
        display: true,
      });
    },
  });

  // Register the message renderer for the pi-subagents-doctor command output.
  pi.registerMessageRenderer(
    "pi-subagents-doctor",
    (message: any, options: MessageRenderOptions, _theme: Theme) =>
      new Text(message.content, options.outputPad, 0),
  );
}
