import { Text } from "@earendil-works/pi-tui";
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

/** Build the call display string for a pi-subagents tool call. */
export function renderCall(args: any, _theme: Theme, _context: any): Text {
  return new Text(
    `pi-subagents: ${args.task} (agent=${args.agent ?? "none"}, model=${args.model ?? "current"}, pane=${args.direction ?? "right"})`,
    0,
    0,
  );
}

/** Build the result display string for a pi-subagents tool result. */
export function renderResult(
  res: AgentToolResult<unknown>,
  _options: ToolRenderResultOptions,
  _theme: Theme,
  _context: any,
): Text {
  const text = res.content.map((c) => ("text" in c ? c.text : "")).join("\n");
  return new Text(text, 0, 0);
}
