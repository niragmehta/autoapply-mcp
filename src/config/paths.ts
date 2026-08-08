import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Configuration locations.
 *
 * Everything is resolved from environment variables so an MCP client can launch
 * the server from any working directory.
 */

export type WorkspacePaths = {
  home: string;
  profile: string;
  campaign: string;
  companies: string;
  database: string;
  artifacts: string;
};

function fromEnv(name: string, fallback: string, home: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return join(home, fallback);
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

export function resolvePaths(): WorkspacePaths {
  const home = process.env.AUTOAPPLY_HOME
    ? resolve(process.env.AUTOAPPLY_HOME)
    : join(homedir(), ".autoapply");

  return {
    home,
    profile: fromEnv("AUTOAPPLY_PROFILE", "profile.json", home),
    campaign: fromEnv("AUTOAPPLY_CAMPAIGN", "campaign.json", home),
    companies: fromEnv("AUTOAPPLY_COMPANIES", "companies.json", home),
    database: fromEnv("AUTOAPPLY_DB", join("data", "autoapply.sqlite"), home),
    artifacts: fromEnv("AUTOAPPLY_ARTIFACTS", "artifacts", home),
  };
}
