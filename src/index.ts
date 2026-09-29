import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execute, createAgentResult } from "./task.ts";
import { THINKING_LEVELS } from "./constants.ts";
import { agentsBySourceTextForCwd, listAgentsBySource } from "./list.ts";
import { renderCall, renderResult } from "./render.ts";
import { formatDoctorReport, runDoctor } from "./doctor.ts";
import { discoverAgentsSync, resolveAgentsDir } from "./agents.ts";
import {
  activeClear,
  activeRemove,
  activeSnapshot,
  activeUpsert,
  createActiveBoxComponent,
  renderActiveBox,
} from "./active.ts";
import type { ActiveTick } from "./task.ts";

/** Widget key for the parent-TUI active-subagents list (below the editor,
 * near the footer). Undefined content hides the widget. */
const ACTIVE_WIDGET_KEY = "pi-subagents-active";
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
            description:
              "Maximum wait time in ms. Minimum 1800000 (30 minutes) — smaller values " +
              "are raised to the minimum. Workers notify the parent when done, so this " +
              "is only a safety net against stuck workers. Default: 1800000.",
          }),
        ),
        noSkills: Type.Optional(
          Type.Boolean({
            description:
              "Disable skills discovery and loading in the subagent (passes --no-skills to pi). Default: false (skills loaded).",
          }),
        ),
        nestedSubagentAllowed: Type.Optional(
          Type.Boolean({
            description:
              "Allow the subagent to spawn its own subagents (keeps pi-subagents tools enabled in the worker). Default: false.",
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
      // A per-tool-call status key so concurrent subagents don't overwrite
      // each other's footer countdown.
      const statusKey = `pi-subagents:${_toolCallId}`;
      // Persistent in-TUI list of the subagents THIS session called. Widget
      // updates are best-effort and skipped entirely without a UI (print/JSON
      // modes) — the Herdr pane label remains the source of truth there.
      const canShow = _ctx.hasUI === true;
      // Skip pushing an identical snapshot twice. Re-setting the widget tears
      // down and rebuilds its component — doing that with unchanged content
      // (countdown tick + supervise poll fire in different phases) makes the
      // box visibly flicker at the bottom of the screen.
      let lastWidgetSig: string | undefined;
      const refreshWidget = (): void => {
        if (!canShow) return;
        try {
          const snap = activeSnapshot();
          const sig = snap ? `${snap.title}\n${snap.rows.join("\n")}` : "";
          if (sig === lastWidgetSig) return;
          lastWidgetSig = sig;
          if (_ctx.mode === "tui") {
            // Full-width responsive box: the factory measures the real
            // widget width on every render, so resizes just work.
            if (snap === undefined) {
              _ctx.ui.setWidget(ACTIVE_WIDGET_KEY, undefined);
            } else {
              _ctx.ui.setWidget(
                ACTIVE_WIDGET_KEY,
                (_tui, theme) =>
                  createActiveBoxComponent(snap.title, snap.rows, (text) =>
                    theme.fg("accent", text),
                  ),
                { placement: "belowEditor" },
              );
            }
          } else {
            // RPC and friends cannot render custom components — fall back
            // to the fixed-width boxed lines.
            _ctx.ui.setWidget(ACTIVE_WIDGET_KEY, renderActiveBox(), {
              placement: "belowEditor",
            });
          }
        } catch {
          // Widget unsupported here — footer status above still applies.
        }
      };
      const rawTimeout = _params.timeoutMs as number | undefined;
      activeUpsert(_toolCallId, {
        agentId: agent,
        timeoutMs:
          typeof rawTimeout === "number" && Number.isFinite(rawTimeout)
            ? Math.floor(rawTimeout)
            : undefined,
        phase: "starting",
      });
      refreshWidget();
      try {
        return await execute(agent, task, {
          thinkingLevel: _params.thinkingLevel as string | undefined,
          noSkills: _params.noSkills as boolean | undefined,
          nestedSubagentAllowed: _params.nestedSubagentAllowed as boolean | undefined,
          timeoutMs: _params.timeoutMs as number | undefined,
          direction: _params.direction as string | undefined,
          focus: _params.focus as boolean | undefined,
          closePaneOnDone: _params.closePaneOnDone as boolean | undefined,
          cwd: _params.cwd as string | undefined,
          model: _params.model as string | undefined,
          signal: _signal,
          onUpdate: (update) => {
            // Mirror countdown progress into the widget row, then forward.
            try {
              const details = (update as { details?: Record<string, unknown> })
                ?.details;
              if (details) {
                activeUpsert(_toolCallId, {
                  agentId: agent,
                  agentName: details["agent"] as string | undefined,
                  paneId: details["paneId"] as string | undefined,
                  remainingMs: details["remainingMs"] as number | undefined,
                  timeoutMs: details["timeoutMs"] as number | undefined,
                  phase: "working",
                });
                refreshWidget();
              }
            } catch {
              // Registry refresh must never break the tool result.
            }
            return _onUpdate?.(update);
          },
          onStatus: (text) => {
            try {
              _ctx.ui.setStatus(statusKey, text);
            } catch {
              // No status-capable UI (e.g. print/RPC mode) — the worker pane
              // label still shows the countdown.
            }
          },
          onActive: (tick: ActiveTick) => {
            activeUpsert(_toolCallId, {
              agentId: tick.agentId,
              agentName: tick.agentName,
              paneId: tick.paneId,
              remainingMs: tick.remainingMs,
              timeoutMs: tick.timeoutMs,
              phase: tick.phase,
              status: tick.status,
            });
            refreshWidget();
          },
        });
      } finally {
        activeRemove(_toolCallId);
        refreshWidget();
        try {
          _ctx.ui.setStatus(statusKey, undefined);
        } catch {
          // UI already gone — nothing to clear.
        }
      }
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

  // Never leave a stale active-subagents widget behind on quit, reload, or
  // session replacement. The registry is process-scoped, so a shutdown must
  // clear both it and the widget.
  pi.on("session_shutdown", (_event, ctx) => {
    activeClear();
    try {
      ctx.ui.setWidget(ACTIVE_WIDGET_KEY, undefined);
    } catch {
      // UI already gone — nothing to clear.
    }
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
