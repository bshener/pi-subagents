/** Active-subagent registry for the parent TUI.
 *
 * Each `pi-subagents` tool call registers itself here while its worker runs,
 * so the parent session can show a persistent in-TUI list (via
 * `ctx.ui.setWidget`) of the subagents IT called — independent of the Herdr
 * pane UI. Entries are keyed by tool-call id, so parallel subagents each get
 * their own row. When the registry is empty the widget must be cleared
 * (`setWidget(key, undefined)`).
 *
 * Non-interactive modes (print/JSON) never touch this; callers guard with
 * `ctx.hasUI` before refreshing the widget.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

/** One row in the parent's active-subagents list. */
export interface ActiveEntry {
  agentId: string;
  agentName?: string;
  paneId?: string;
  timeoutMs?: number;
  remainingMs?: number;
  phase: "starting" | "working";
  /** Live worker status: Herdr `agent_status` (`working`, `idle`, `blocked`,
   * `done`, `unknown`) or a synthetic watchdog state (`stale — killed`). */
  status?: string;
}

const entries = new Map<string, ActiveEntry>();

/** Adds or updates the entry for one tool call. */
export function activeUpsert(toolCallId: string, patch: ActiveEntry): void {
  const prev = entries.get(toolCallId);
  entries.set(toolCallId, { ...prev, ...patch } as ActiveEntry);
}

/** Removes the entry for one tool call. Returns true if one existed. */
export function activeRemove(toolCallId: string): boolean {
  return entries.delete(toolCallId);
}

/** Removes all entries (session shutdown / reload safety). */
export function activeClear(): void {
  entries.clear();
}

/** Max inner width of the boxed widget, so long agent ids never overflow. */
const MAX_BOX_INNER = 56;

/** Formats milliseconds as MM:SS (or H:MM:SS past one hour). */
function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/** Snapshot of the title + one row per active subagent, or undefined when empty. */
export function activeSnapshot(): { title: string; rows: string[] } | undefined {
  if (entries.size === 0) return undefined;
  const title = `\u{1F916} Active subagents (${entries.size})`;
  const rows: string[] = [];
  for (const e of entries.values()) {
    const total =
      e.timeoutMs !== undefined && Number.isFinite(e.timeoutMs)
        ? e.timeoutMs
        : undefined;
    let time = "";
    if (total !== undefined && e.remainingMs !== undefined) {
      time = ` \u23F3 ${formatMs(e.remainingMs)}/${formatMs(total)}`;
    } else if (total !== undefined) {
      time = ` \u23F3 ${formatMs(total)}`;
    }
    const where = e.paneId ? ` • ${e.paneId}` : "";
    const shown = e.status ?? e.phase;
    rows.push(`\u2022 ${e.agentId}${time}${where} • ${shown}`);
  }
  return { title, rows };
}

/** Renders the widget as plain lines, or undefined when empty (caller clears). */
export function renderActiveLines(): string[] | undefined {
  const snap = activeSnapshot();
  return snap ? [snap.title, ...snap.rows] : undefined;
}

/** Renders the widget inside a bordered box, or undefined when empty.
 * The box partially isolates the list from the surrounding transcript —
 * it is still a widget row (below the editor), not an overlay. */
export function renderActiveBox(): string[] | undefined {
  const snap = activeSnapshot();
  if (!snap) return undefined;
  const content = [snap.title, ...snap.rows];
  const measured = content.map((line) => visibleWidth(line));
  const inner = Math.min(MAX_BOX_INNER, ...measured);
  const rule = `\u2500`.repeat(inner + 2);
  const frame = (line: string): string => {
    const clipped = truncateToWidth(line, inner);
    const padded = clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
    return `\u2502 ${padded} \u2502`;
  };
  return [
    `\u250C${rule}\u2510`,
    ...content.map(frame),
    `\u2514${rule}\u2518`,
  ];
}

/** Builds a full-width, responsive box component from a snapshot.
 * The component measures the real widget width on every render, so the box
 * always spans the available space (terminal resizes included). Data comes
 * from the snapshot — the caller pushes a fresh component on each refresh. */
export function createActiveBoxComponent(
  title: string,
  rows: string[],
  titleFg: (text: string) => string,
): Component {
  const styled = titleFg(title);
  return {
    invalidate() {},
    render(width: number): string[] {
      const contentWidth = Math.max(1, width - 4);
      const frame = (line: string): string => {
        const clipped = truncateToWidth(line, contentWidth);
        const padded =
          clipped + " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
        return `\u2502 ${padded} \u2502`;
      };
      const rule = `\u2500`.repeat(contentWidth + 2);
      return [
        `\u250C${rule}\u2510`,
        frame(styled),
        ...rows.map(frame),
        `\u2514${rule}\u2518`,
      ];
    },
  };
}
