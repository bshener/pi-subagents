import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execute, createAgentResult } from "./task.ts";
import { THINKING_LEVELS } from "./constants.ts";
import { agentsBySourceTextForCwd, listAgentsBySource } from "./list.ts";
import { renderCall, renderResult } from "./render.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import { discoverAgentsSync, resolveAgentsDir } from "./agents.ts";
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
        noSkills: Type.Optional(
          Type.Boolean({
            description:
              "Disable skills discovery and loading in the subagent (passes --no-skills to pi). Default: false (skills loaded).",
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
        noSkills: _params.noSkills as boolean | undefined,
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

  // Register a /subagent:<agent-id> slash command for each discovered agent, so
  // they are discoverable from the "/" menu under the "subagent:" prefix
  // (e.g. /subagent:ling-tiny-worker "<task>"). Registered commands are shown
  // by pi's built-in slash-command autocomplete, so this doubles as the agent
  // menu. Best-effort: a failure here must not break the extension, since the
  // /pi-subagents tool still works.
  registerAgentCommands(pi);

  // Register the message renderer for the pi-subagents-doctor command output.
  pi.registerMessageRenderer(
    "pi-subagents-doctor",
    (message: any, options: MessageRenderOptions, _theme: Theme) =>
      new Text(message.content, options.outputPad, 0),
  );

  // Renderer for the subagent result delivered by /subagent:<id> commands. The
  // content may arrive as a string or as an array of content parts, so normalize
  // both to text before rendering. Params are contextually typed from
  // MessageRenderer<T>, so no explicit annotations are needed.
  pi.registerMessageRenderer("pi-subagents-result", (message, options) => {
    return new Text(toPlainText(message.content), options.outputPad, 0);
  });
}

/**
 * Normalizes a message/content value — either a plain string or an array of
 * content parts — into a single text string for display or delivery. Generic on
 * the content-part shape so both text and image parts typecheck; only the `text`
 * field is read, everything else is ignored.
 */
function toPlainText(
  content: string | Array<{ type: string; text?: unknown }>,
): string {
  if (!Array.isArray(content)) return content;
  return content.map((c) => ("text" in c ? String(c.text) : "")).join("\n");
}

/**
 * Registers one /subagent:<agent-id> command per discovered agent. The command
 * launches the agent in its own Herdr pane (via the same execute() path as the
 * tool). It returns immediately (fire-and-forget) so the user's turn is not
 * blocked, and when execute() finishes it delivers the result back to THIS
 * session via pi.sendMessage({triggerTurn:true}). pi converts that custom message
 * into a user message, so the parent agent sees the result and can review/comment
 * on it — mirroring the flow where the agent itself calls the tool. This is why
 * calling a subagent through the command still leaves the parent agent in the loop.
 */
function registerAgentCommands(pi: ExtensionAPI): void {
  let agents: Array<{ id: string; name: string; description: string }>;
  try {
    agents = discoverAgentsSync(resolveAgentsDir(process.cwd())).map((a) => ({
      id: a.id,
      name: a.name ?? a.id,
      description: a.description ?? "",
    }));
  } catch {
    agents = [];
  }
  for (const agent of agents) {
    pi.registerCommand(`subagent:${agent.id}`, {
      description: [
        `Launch the ${agent.name} sub-agent (opens a Herdr pane, runs the task, closes it).`,
        agent.description || undefined,
      ]
        .filter((line): line is string => Boolean(line))
        .join(" "),
      handler: (args: string, ctx: ExtensionCommandContext) => {
        const task = (args ?? "").trim();
        if (!task) {
          ctx.ui.notify(`Usage: /subagent:${agent.id} "<task>"`);
          return Promise.resolve();
        }
        ctx.ui.notify(`▶ Launching sub-agent "${agent.id}"…`);
        // Fire-and-forget: return immediately so the command completes within the
        // user's turn WITHOUT nesting a subagent turn inside it. execute() runs in
        // its own Herdr pane; when it finishes we deliver the result back to THIS
        // session via pi.sendMessage({triggerTurn:true}). pi converts that custom
        // message into a user message, so the parent agent sees the result and can
        // review/comment on it — mirroring the flow where the agent itself calls
        // the tool. Not awaiting execute() here is deliberate: awaiting it would
        // block the user's turn for the whole subagent duration.
        execute(agent.id, task, {})
          .then((res) => {
            const text = toPlainText(res.content);
            // ExtensionAPI.sendMessage returns void (fire-and-forget at the API
            // level); assertActive() can throw synchronously if the session is
            // gone, so wrap it to surface a clear status instead of an unhandled
            // rejection.
            try {
              pi.sendMessage(
                {
                  customType: "pi-subagents-result",
                  content: `Sub-agent "${agent.id}" finished its task.\n\n--- Result ---\n${text}`,
                  display: true,
                },
                { triggerTurn: true },
              );
            } catch (err) {
              ctx.ui.notify(
                `pi-subagents: could not deliver result to parent session: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          })
          .catch((err) => {
            // execute() is error-safe (returns a result), but keep a catch for the unexpected.
            ctx.ui.notify(
              `pi-subagents: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        return Promise.resolve();
      },
    });
  }
}
