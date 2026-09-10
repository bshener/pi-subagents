export interface PiSubagentsParams {
  /** Name of an agent directory under the agents dir (matches the folder name). */
  agent?: string;
  /** The task the subagent will perform (the user prompt). */
  task: string;
  /** The model to use. Order of precedence: this flag > agent file > current model. */
  model?: string;
  /** Working directory for the pane. If omitted, the current cwd is used. */
  cwd?: string;
  /** Pane split direction: right | left | down | up. */
  direction?: string;
  /** Should the new pane take focus? false = does not steal focus. */
  focus?: boolean;
  /** Close the pane (and pi agent) when the task completes? */
  closePaneOnDone?: boolean;
  /** Maximum wait time in ms. */
  timeoutMs?: number;
}

export interface LoadedAgent {
  id: string;
  name: string;
  description: string;
  model?: string;
  systemPrompt?: string;
  direction?: string;
  closePaneOnDone?: boolean;
}

export interface ExecuteResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    paneId?: string;
    model?: string;
    agent?: string;
    done?: boolean;
    closed?: boolean;
  };
}

export interface RunTaskResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    paneId?: string;
    model?: string;
    agent?: string;
    done?: boolean;
    closed?: boolean;
  };
}

export interface PaneInfo {
  paneId: string;
  model: string;
  agent: string;
  done: boolean;
  closed: boolean;
}

/** A single agent file's YAML frontmatter + markdown body. */
export interface AgentManifest {
  meta: Record<string, string>;
  body: string;
}

/** A file owned by the extension, to be cleaned up after use. */
export interface SpFile {
  path: string;
  /** true = this extension created the file and should delete it after. */
  owned: boolean;
}
