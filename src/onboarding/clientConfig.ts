/**
 * Ready-to-paste MCP client configuration.
 *
 * Every client launches the same stdio server, but each wants it described in
 * its own file, under its own top-level key, sometimes in TOML. Getting one of
 * those details wrong fails silently - the server simply never appears - so the
 * setup CLI prints each form with this checkout's absolute paths filled in.
 *
 * Formats and locations were checked against each vendor's documentation; see
 * docs/CLIENTS.md for the sources.
 */

export const MCP_CLIENTS = ["copilot-cli", "vscode", "claude-desktop", "claude-code", "codex", "cursor"] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

const ALIASES: Record<string, McpClient> = {
  copilot: "copilot-cli",
  "copilot-cli": "copilot-cli",
  "github-copilot": "copilot-cli",
  "github-copilot-cli": "copilot-cli",
  vscode: "vscode",
  "vs-code": "vscode",
  code: "vscode",
  claude: "claude-desktop",
  "claude-desktop": "claude-desktop",
  "claude-code": "claude-code",
  claudecode: "claude-code",
  codex: "codex",
  "openai-codex": "codex",
  cursor: "cursor",
};

export function resolveClient(name: string): McpClient | null {
  return ALIASES[name.trim().toLowerCase()] ?? null;
}

export type ServerLaunch = {
  /** Server name as it appears in the client. */
  name: string;
  /** Absolute path to the Node.js executable. */
  node: string;
  /** Absolute path to dist/index.js. */
  serverPath: string;
  /** Absolute AUTOAPPLY_HOME. */
  home: string;
};

export type ClientConfig = {
  client: McpClient;
  label: string;
  where: string[];
  format: "json" | "toml" | "shell";
  snippet: string;
  notes: string[];
  docs: string;
};

/** Quotes a shell argument only when it needs it; works in PowerShell, cmd and POSIX shells for ordinary paths. */
export function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:\\=@+-]+$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function stdioEntry(launch: ServerLaunch, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...extra, command: launch.node, args: [launch.serverPath], env: { AUTOAPPLY_HOME: launch.home } };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function claudeDesktopPath(platform: NodeJS.Platform): string {
  if (platform === "win32") return "%APPDATA%\\Claude\\claude_desktop_config.json";
  if (platform === "darwin") return "~/Library/Application Support/Claude/claude_desktop_config.json";
  return "~/.config/Claude/claude_desktop_config.json";
}

const MERGE_NOTE = "If the file already lists servers, add this entry to the existing object instead of replacing the file.";

export function clientConfig(client: McpClient, launch: ServerLaunch, platform: NodeJS.Platform = process.platform): ClientConfig {
  const { name } = launch;
  switch (client) {
    case "copilot-cli":
      return {
        client,
        label: "GitHub Copilot CLI",
        where: ["~/.copilot/mcp-config.json (or $COPILOT_HOME/mcp-config.json)"],
        format: "json",
        snippet: json({ mcpServers: { [name]: { ...stdioEntry(launch, { type: "local" }), tools: ["*"] } } }),
        notes: [
          MERGE_NOTE,
          `Or from a terminal: copilot mcp add ${name} --env AUTOAPPLY_HOME=${shellArg(launch.home)} -- ${shellArg(launch.node)} ${shellArg(launch.serverPath)}`,
          "Inside a session, /mcp add opens the same settings as a form.",
        ],
        docs: "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers",
      };
    case "vscode":
      return {
        client,
        label: "VS Code (GitHub Copilot agent mode)",
        where: [".vscode/mcp.json in a workspace", "your user mcp.json (Command Palette: MCP: Open User Configuration)"],
        format: "json",
        snippet: json({ servers: { [name]: stdioEntry(launch, { type: "stdio" }) } }),
        notes: [MERGE_NOTE, "VS Code uses a top-level \"servers\" key, not \"mcpServers\"."],
        docs: "https://code.visualstudio.com/docs/agents/reference/mcp-configuration",
      };
    case "claude-desktop":
      return {
        client,
        label: "Claude Desktop",
        where: [claudeDesktopPath(platform), "(Settings > Developer > Edit Config opens it)"],
        format: "json",
        snippet: json({ mcpServers: { [name]: stdioEntry(launch) } }),
        notes: [MERGE_NOTE, "Quit Claude Desktop completely and reopen it after editing; closing the window is not enough."],
        docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
      };
    case "claude-code":
      return {
        client,
        label: "Claude Code",
        where: ["run in a terminal; --scope user makes it available in every project (stored in ~/.claude.json)"],
        format: "shell",
        snippet: `claude mcp add --env AUTOAPPLY_HOME=${shellArg(launch.home)} --transport stdio --scope user ${name} -- ${shellArg(launch.node)} ${shellArg(launch.serverPath)}`,
        notes: [
          "Keep another option between --env and the server name, or the CLI reads the name as another KEY=value pair.",
          `For a project-scoped setup, put the Claude Desktop JSON block in .mcp.json at the project root instead.`,
        ],
        docs: "https://code.claude.com/docs/en/mcp",
      };
    case "codex": {
      const quoted = (value: string) => JSON.stringify(value);
      return {
        client,
        label: "OpenAI Codex (CLI, IDE extension and app share this file)",
        where: ["~/.codex/config.toml (or $CODEX_HOME/config.toml)"],
        format: "toml",
        snippet: [
          `[mcp_servers.${name}]`,
          `command = ${quoted(launch.node)}`,
          `args = [${quoted(launch.serverPath)}]`,
          "startup_timeout_sec = 30",
          "tool_timeout_sec = 600",
          "",
          `[mcp_servers.${name}.env]`,
          `AUTOAPPLY_HOME = ${quoted(launch.home)}`,
        ].join("\n"),
        notes: [
          "Codex's documented default tool timeout is 60 seconds; board discovery and proposals can take longer, hence tool_timeout_sec.",
          `Or from a terminal: codex mcp add ${name} --env AUTOAPPLY_HOME=${shellArg(launch.home)} -- ${shellArg(launch.node)} ${shellArg(launch.serverPath)}`,
        ],
        docs: "https://developers.openai.com/codex/mcp",
      };
    }
    case "cursor":
      return {
        client,
        label: "Cursor",
        where: ["~/.cursor/mcp.json (every project)", ".cursor/mcp.json in a project (that project only)"],
        format: "json",
        snippet: json({ mcpServers: { [name]: stdioEntry(launch, { type: "stdio" }) } }),
        notes: [MERGE_NOTE],
        docs: "https://cursor.com/docs/mcp",
      };
  }
}

export function allClientConfigs(launch: ServerLaunch, platform: NodeJS.Platform = process.platform): ClientConfig[] {
  return MCP_CLIENTS.map((client) => clientConfig(client, launch, platform));
}

export function renderClientConfig(config: ClientConfig): string {
  return [
    `### ${config.label}`,
    `Where: ${config.where.join("; ")}`,
    "",
    config.snippet,
    "",
    ...config.notes.map((note) => `- ${note}`),
    `- Docs: ${config.docs}`,
  ].join("\n");
}
