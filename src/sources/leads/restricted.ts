/**
 * Lead sources whose terms of use forbid automated access. They stay off
 * unless the candidate names them in AUTOAPPLY_ENABLE_RESTRICTED_SOURCES,
 * accepting the terms risk for explicit, person-reviewed searches.
 */
export const RESTRICTED_SOURCES: ReadonlySet<string> = new Set(["builtin", "jobbankca"]);

export const RESTRICTED_SOURCES_ENV = "AUTOAPPLY_ENABLE_RESTRICTED_SOURCES";

function optedIn(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  return new Set(
    (env[RESTRICTED_SOURCES_ENV] ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0),
  );
}

export function isRestrictedSource(id: string): boolean {
  return RESTRICTED_SOURCES.has(id);
}

/** True for every unrestricted source, and for a restricted one only once opted in. */
export function isSourceEnabled(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !RESTRICTED_SOURCES.has(id) || optedIn(env).has(id);
}
