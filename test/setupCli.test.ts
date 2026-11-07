import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { WorkspacePaths } from "../src/config/paths.js";
import { parseSecrets } from "../src/config/secrets.js";
import { runInit, SECRETS_TEMPLATE, type InitFs } from "../src/cli/init.js";
import { runUpdate, type CommandRunner } from "../src/cli/update.js";
import { allClientConfigs, clientConfig, resolveClient, shellArg } from "../src/onboarding/clientConfig.js";

/** File system and command runner are injected: nothing here touches disk, git or npm. */

const REPO = join("C:", "repo", "autoapply-mcp");
const HOME = join("C:", "Users", "alex", ".autoapply");

function memoryFs(files: Record<string, string> = {}) {
  const contents = new Map(Object.entries(files));
  const directories = new Set<string>();
  const fs: InitFs = {
    existsSync: (path) => contents.has(path) || directories.has(path),
    mkdirSync: (path) => {
      directories.add(path);
    },
    copyFileSync: (source, target) => {
      const value = contents.get(source);
      if (value === undefined) throw new Error(`ENOENT ${source}`);
      contents.set(target, value);
    },
    writeFileSync: (path, data, options) => {
      if (options.flag === "wx" && contents.has(path)) throw new Error(`EEXIST ${path}`);
      contents.set(path, data);
    },
  };
  return { fs, contents, directories };
}

function paths(): WorkspacePaths {
  return {
    home: HOME,
    profile: join(HOME, "profile.json"),
    campaign: join(HOME, "campaign.json"),
    companies: join(HOME, "companies.json"),
    database: join(HOME, "data", "autoapply.sqlite"),
    artifacts: join(HOME, "artifacts"),
    resumeSource: join(HOME, "resume.json"),
    fonts: join(HOME, "resumes", "fonts"),
    documents: join(HOME, "documents"),
    reports: join(HOME, "reports"),
    exports: join(HOME, "exports"),
    secrets: join(HOME, ".env"),
  };
}

const TEMPLATES = {
  [join(REPO, "examples", "profile.example.json")]: '{"version":1,"profile":"template"}',
  [join(REPO, "examples", "campaign.example.json")]: '{"version":1,"campaign":"template"}',
  [join(REPO, "presets", "ai-security-us-canada.json")]: '{"version":1,"companies":[]}',
  [join(REPO, "dist", "index.js")]: "// built server",
};

function init(argv: string[], files: Record<string, string> = TEMPLATES) {
  const memory = memoryFs(files);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = runInit({
    paths: paths(),
    repoRoot: REPO,
    argv,
    fs: memory.fs,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    node: join("C:", "Program Files", "nodejs", "node.exe"),
    platform: "win32",
  });
  return { code, ...memory, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

describe("init", () => {
  it("scaffolds a fresh home, the directories and a private secrets template", () => {
    const run = init([]);
    expect(run.code).toBe(0);
    expect(run.contents.get(paths().profile)).toBe('{"version":1,"profile":"template"}');
    expect(run.contents.get(paths().campaign)).toBe('{"version":1,"campaign":"template"}');
    expect(run.contents.get(paths().companies)).toBe('{"version":1,"companies":[]}');
    for (const directory of ["resumes", join("resumes", "fonts"), "documents", "reports", "exports", "artifacts", "data"]) {
      expect(run.directories.has(join(HOME, directory)), directory).toBe(true);
    }
    const secrets = run.contents.get(paths().secrets);
    expect(secrets).toBe(SECRETS_TEMPLATE);
    // Every key is present but commented out, so nothing is set by accident.
    expect(parseSecrets(secrets!)).toEqual({});
    for (const key of [
      "AUTOAPPLY_ATS_PASSWORD",
      "AUTOAPPLY_OTP_IMAP_USER",
      "AUTOAPPLY_OTP_IMAP_PASSWORD",
      "AUTOAPPLY_OTP_IMAP_HOST",
      "AUTOAPPLY_FOORILLA_API_KEY",
      "AUTOAPPLY_DASHBOARD_TOKEN",
    ]) {
      expect(secrets).toContain(`# ${key}=`);
    }
    expect(secrets).toContain("Keep this file private");
    // resume.example.json is absent, so it is skipped without a word.
    expect(run.stdout).not.toContain("resume.json");
  });

  it("seeds resume.json when the example exists", () => {
    const run = init([], { ...TEMPLATES, [join(REPO, "examples", "resume.example.json")]: '{"basics":{}}' });
    expect(run.contents.get(paths().resumeSource)).toBe('{"basics":{}}');
    expect(run.stdout).toContain("created from examples/resume.example.json");
  });

  it("never overwrites existing files", () => {
    const run = init([], { ...TEMPLATES, [paths().profile]: "MINE", [paths().secrets]: "AUTOAPPLY_ATS_PASSWORD=kept" });
    expect(run.code).toBe(0);
    expect(run.contents.get(paths().profile)).toBe("MINE");
    expect(run.contents.get(paths().secrets)).toBe("AUTOAPPLY_ATS_PASSWORD=kept");
    expect(run.stdout).toContain(`${paths().profile} - already present, left untouched`);
    expect(run.stdout).toContain(`${paths().secrets} - already present, left untouched`);
  });

  it("refuses --force and writes nothing", () => {
    const run = init(["--force"]);
    expect(run.code).toBe(1);
    expect(run.contents.has(paths().profile)).toBe(false);
    expect(run.stderr).toContain("does not overwrite");
  });

  it("fails when a required template is missing", () => {
    const { [join(REPO, "examples", "campaign.example.json")]: _missing, ...rest } = TEMPLATES;
    const run = init([], rest);
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("FAIL");
  });

  it("prints every client configuration with absolute paths", () => {
    const run = init([]);
    for (const label of ["GitHub Copilot CLI", "VS Code", "Claude Desktop", "Claude Code", "OpenAI Codex", "Cursor"]) {
      expect(run.stdout).toContain(`### ${label}`);
    }
    expect(run.stdout).toContain(JSON.stringify(join(REPO, "dist", "index.js")));
    expect(run.stdout).toContain(`"AUTOAPPLY_HOME": ${JSON.stringify(HOME)}`);
    expect(run.stdout).not.toContain("does not exist yet");
  });

  it("prints just one client's snippet with --print-config, ready to redirect", () => {
    const run = init(["--print-config", "vscode"]);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as { servers: Record<string, { type: string; args: string[]; env: Record<string, string> }> };
    expect(parsed.servers.autoapply).toMatchObject({ type: "stdio", args: [join(REPO, "dist", "index.js")], env: { AUTOAPPLY_HOME: HOME } });
    expect(run.stderr).toContain(".vscode/mcp.json");
    expect(run.contents.size).toBe(Object.keys(TEMPLATES).length);
    expect(init(["--print-config=nope"]).code).toBe(1);
    expect(init(["--print-config"]).stderr).toContain("copilot-cli, vscode, claude-desktop, claude-code, codex, cursor");
  });
});

describe("client configuration", () => {
  const launch = { name: "autoapply", node: "/usr/local/bin/node", serverPath: "/opt/My Tools/autoapply-mcp/dist/index.js", home: "/home/alex/.autoapply" };

  it("uses each client's own top-level key and fields", () => {
    const byClient = Object.fromEntries(allClientConfigs(launch, "darwin").map((config) => [config.client, config]));
    const copilot = JSON.parse(byClient["copilot-cli"]!.snippet);
    expect(copilot.mcpServers.autoapply).toEqual({
      type: "local",
      command: "/usr/local/bin/node",
      args: ["/opt/My Tools/autoapply-mcp/dist/index.js"],
      env: { AUTOAPPLY_HOME: "/home/alex/.autoapply" },
      tools: ["*"],
    });
    expect(JSON.parse(byClient.vscode!.snippet).servers.autoapply.type).toBe("stdio");
    expect(JSON.parse(byClient["claude-desktop"]!.snippet).mcpServers.autoapply.type).toBeUndefined();
    expect(byClient["claude-desktop"]!.where[0]).toBe("~/Library/Application Support/Claude/claude_desktop_config.json");
    expect(JSON.parse(byClient.cursor!.snippet).mcpServers.autoapply.command).toBe("/usr/local/bin/node");
    expect(byClient.codex!.snippet).toContain('[mcp_servers.autoapply]\ncommand = "/usr/local/bin/node"');
    expect(byClient.codex!.snippet).toContain('[mcp_servers.autoapply.env]\nAUTOAPPLY_HOME = "/home/alex/.autoapply"');
    expect(byClient.codex!.snippet).toContain("tool_timeout_sec = 600");
    expect(byClient["claude-code"]!.snippet).toBe(
      'claude mcp add --env AUTOAPPLY_HOME=/home/alex/.autoapply --transport stdio --scope user autoapply -- /usr/local/bin/node "/opt/My Tools/autoapply-mcp/dist/index.js"',
    );
  });

  it("escapes Windows paths for TOML and picks the platform's Claude Desktop file", () => {
    const windows = { ...launch, node: "C:\\Program Files\\nodejs\\node.exe", serverPath: "C:\\repo\\dist\\index.js", home: "C:\\Users\\alex\\.autoapply" };
    expect(clientConfig("codex", windows).snippet).toContain('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(clientConfig("claude-desktop", windows, "win32").where[0]).toBe("%APPDATA%\\Claude\\claude_desktop_config.json");
    expect(clientConfig("claude-desktop", windows, "linux").where[0]).toBe("~/.config/Claude/claude_desktop_config.json");
  });

  it("resolves client aliases and quotes shell arguments only when needed", () => {
    expect(resolveClient("Copilot")).toBe("copilot-cli");
    expect(resolveClient("claude")).toBe("claude-desktop");
    expect(resolveClient("emacs")).toBeNull();
    expect(shellArg("C:\\repo\\dist\\index.js")).toBe("C:\\repo\\dist\\index.js");
    expect(shellArg("/opt/My Tools/x.js")).toBe('"/opt/My Tools/x.js"');
  });
});

describe("update", () => {
  function recorder(results: Record<string, { status: number; stdout?: string }> = {}) {
    const calls: string[] = [];
    const runner: CommandRunner = (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      calls.push(key);
      return results[key] ?? { status: 0, stdout: "" };
    };
    return { calls, runner };
  }

  function update(options: { files?: string[]; results?: Record<string, { status: number; stdout?: string }>; home?: string } = {}) {
    const present = new Set((options.files ?? [".git", "package-lock.json"]).map((file) => join(REPO, file)));
    const { calls, runner } = recorder(options.results);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = runUpdate({
      repoRoot: REPO,
      home: options.home ?? HOME,
      runner,
      exists: (path) => present.has(path),
      out: (line) => stdout.push(line),
      err: (line) => stderr.push(line),
      node: "node-bin",
    });
    return { code, calls, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  }

  const STATUS = "git status --porcelain --untracked-files=all -- src";

  it("runs pull, ci, build and doctor in order on a clean checkout", () => {
    const run = update();
    expect(run.code).toBe(0);
    expect(run.calls).toEqual([STATUS, "git pull --ff-only", "npm ci", "npm run build", `node-bin ${join("dist", "cli", "doctor.js")}`]);
    expect(run.stdout).toContain("was not touched");
  });

  it("uses npm install when there is no lockfile", () => {
    expect(update({ files: [".git"] }).calls).toContain("npm install");
  });

  it("refuses when src/ has uncommitted changes and lists them", () => {
    const run = update({ results: { [STATUS]: { status: 0, stdout: " M src/server.ts\n?? src/local-hack.ts\n" } } });
    expect(run.code).toBe(1);
    expect(run.calls).toEqual([STATUS]);
    expect(run.stderr).toContain("M src/server.ts");
    expect(run.stderr).toContain("?? src/local-hack.ts");
  });

  it("refuses outside a git checkout without running anything", () => {
    const run = update({ files: [] });
    expect(run.code).toBe(1);
    expect(run.calls).toEqual([]);
    expect(run.stderr).toContain("npm install -g autoapply-mcp@latest");
  });

  it("stops at the first failing step", () => {
    const run = update({ results: { "npm run build": { status: 2 } } });
    expect(run.code).toBe(2);
    expect(run.calls.at(-1)).toBe("npm run build");
    expect(run.stderr).toContain("stopping");
  });

  it("reports doctor problems after a successful install", () => {
    const run = update({ results: { [`node-bin ${join("dist", "cli", "doctor.js")}`]: { status: 1 } } });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("The update is installed, but doctor reported problems");
  });

  it("warns when AUTOAPPLY_HOME sits inside the checkout", () => {
    expect(update({ home: join(REPO, "data-home") }).stderr).toContain("AUTOAPPLY_HOME is inside the checkout");
  });
});
