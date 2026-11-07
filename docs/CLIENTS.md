# Connecting an MCP client

autoapply-mcp is a local stdio server: the client launches
`node <checkout>/dist/index.js` and talks to it over stdin and stdout. Every
client needs the same three things - the Node executable, the absolute path to
`dist/index.js`, and `AUTOAPPLY_HOME` - written in its own format.

`npm run init` prints all six blocks with this checkout's paths filled in, and
`npm run init -- --print-config <client>` prints one on its own:

| Client | `--print-config` | Configuration |
|---|---|---|
| GitHub Copilot CLI | `copilot-cli` | `~/.copilot/mcp-config.json` |
| VS Code (Copilot agent mode) | `vscode` | `.vscode/mcp.json` or the user `mcp.json` |
| Claude Desktop | `claude-desktop` | `claude_desktop_config.json` |
| Claude Code | `claude-code` | `claude mcp add ...` |
| OpenAI Codex | `codex` | `~/.codex/config.toml` |
| Cursor | `cursor` | `~/.cursor/mcp.json` or `.cursor/mcp.json` |

The printed `command` is the absolute path of the Node.js that ran `init`,
because desktop apps often start without your shell's `PATH`. If you later
switch Node versions, print the configuration again.

Secrets are not part of these blocks. Variables the server needs, such as
`AUTOAPPLY_OTP_IMAP_USER` and `AUTOAPPLY_OTP_IMAP_PASSWORD` for the verification
mailbox, go in the same `env` object next to `AUTOAPPLY_HOME`. Never commit a
configuration file that holds them.

Formats and locations below were checked against each vendor's documentation
on 2026-11-06.

## GitHub Copilot CLI

User configuration lives in `~/.copilot/mcp-config.json`
(`$COPILOT_HOME/mcp-config.json` when `COPILOT_HOME` is set) under a top-level
`mcpServers` object. `type` is `local` or `stdio`, which behave the same.

```json
{
  "mcpServers": {
    "autoapply": {
      "type": "local",
      "command": "/usr/local/bin/node",
      "args": ["/path/to/autoapply-mcp/dist/index.js"],
      "env": { "AUTOAPPLY_HOME": "/home/alex/.autoapply" },
      "tools": ["*"]
    }
  }
}
```

The same entry can be added from a terminal with
`copilot mcp add autoapply --env AUTOAPPLY_HOME=/home/alex/.autoapply -- node /path/to/autoapply-mcp/dist/index.js`,
or inside a session with `/mcp add`. Copilot CLI does not read
`.vscode/mcp.json`.

Source: [Adding MCP servers for GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).

## VS Code

VS Code reads `.vscode/mcp.json` in a workspace, or the user `mcp.json` opened
with the command **MCP: Open User Configuration**. Its format uses a top-level
`servers` object, not `mcpServers`:

```json
{
  "servers": {
    "autoapply": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["/path/to/autoapply-mcp/dist/index.js"],
      "env": { "AUTOAPPLY_HOME": "/home/alex/.autoapply" }
    }
  }
}
```

VS Code also understands the portable format (`mcpServers` in a workspace-root
`.mcp.json` or `~/.copilot/mcp-config.json`), shared with Copilot CLI.

Source: [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

## Claude Desktop

Edit `claude_desktop_config.json` (Settings > Developer > Edit Config opens it):

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "autoapply": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\path\\to\\autoapply-mcp\\dist\\index.js"],
      "env": { "AUTOAPPLY_HOME": "C:\\Users\\alex\\.autoapply" }
    }
  }
}
```

Paths must be absolute. Quit Claude Desktop completely and reopen it after
editing; closing the window is not enough.

Source: [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

## Claude Code

```bash
claude mcp add --env AUTOAPPLY_HOME=/home/alex/.autoapply --transport stdio --scope user autoapply -- /usr/local/bin/node /path/to/autoapply-mcp/dist/index.js
```

`--` separates Claude's options from the server command. Keep another option
between `--env` and the server name, or the name is read as another
`KEY=value` pair. `--scope user` makes the server available in every project;
for one project, put the Claude Desktop JSON block in `.mcp.json` at the
project root instead.

Source: [Connect Claude Code to tools via MCP](https://code.claude.com/docs/en/mcp).

## OpenAI Codex

The Codex CLI, IDE extension and app share `~/.codex/config.toml`
(`$CODEX_HOME/config.toml` when set):

```toml
[mcp_servers.autoapply]
command = "/usr/local/bin/node"
args = ["/path/to/autoapply-mcp/dist/index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 600

[mcp_servers.autoapply.env]
AUTOAPPLY_HOME = "/home/alex/.autoapply"
```

Codex documents a default tool timeout of 60 seconds. `discover_jobs` across
many boards and `propose_companies` can take longer, hence `tool_timeout_sec`.
The same entry can be added with
`codex mcp add autoapply --env AUTOAPPLY_HOME=/home/alex/.autoapply -- node /path/to/autoapply-mcp/dist/index.js`.

Source: [Model Context Protocol - Codex](https://developers.openai.com/codex/mcp).

## Cursor

Use `~/.cursor/mcp.json` for every project, or `.cursor/mcp.json` in one
project:

```json
{
  "mcpServers": {
    "autoapply": {
      "type": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["/path/to/autoapply-mcp/dist/index.js"],
      "env": { "AUTOAPPLY_HOME": "/home/alex/.autoapply" }
    }
  }
}
```

Source: [Model Context Protocol (MCP) - Cursor](https://cursor.com/docs/mcp).

## Other agent CLIs

Any client that launches a stdio MCP server with a command, arguments and
environment variables works the same way: point it at `node` with
`dist/index.js` as the only argument and set `AUTOAPPLY_HOME`. Long-running
work - board harvesting in particular - runs from a terminal
(`npm run harvest`), never inside a tool call, so a client's tool timeout does
not limit it.
