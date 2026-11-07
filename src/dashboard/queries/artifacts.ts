import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileInside } from "../static.js";

/**
 * Screenshots the submission engine saved in the artifacts directory, named
 * `<applicationId>-<stage>-<timestamp>.png`. Only flat image names are ever
 * resolved, so a request cannot reach any other file.
 */

const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.(png|jpe?g)$/i;
const MAX_NAME = 200;

export type ArtifactInfo = { name: string; stage: string; modifiedAt: string; sizeBytes: number };

export function isArtifactName(name: string): boolean {
  return name.length <= MAX_NAME && ARTIFACT_NAME.test(name) && !name.includes("..");
}

export function artifactContentType(name: string): string {
  return /\.png$/i.test(name) ? "image/png" : "image/jpeg";
}

/** Absolute path of a screenshot inside `dir`, or null. */
export function resolveArtifact(dir: string, name: string): string | null {
  if (!isArtifactName(name)) return null;
  return fileInside(dir, name);
}

function stageOf(name: string, applicationId: string): string {
  const rest = name.slice(applicationId.length + 1).replace(/\.(png|jpe?g)$/i, "");
  return rest.replace(/-\d{10,}$/, "") || "screenshot";
}

/** Screenshots per application id, newest first. A missing directory simply has none. */
export function listArtifacts(dir: string): Map<string, ArtifactInfo[]> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return new Map();
  }
  const byApplication = new Map<string, ArtifactInfo[]>();
  for (const name of names) {
    if (!isArtifactName(name)) continue;
    const applicationId = name.split("-")[0] ?? "";
    if (!applicationId.startsWith("app_")) continue;
    try {
      const stat = statSync(join(dir, name));
      if (!stat.isFile()) continue;
      const entry = { name, stage: stageOf(name, applicationId), modifiedAt: stat.mtime.toISOString(), sizeBytes: stat.size };
      byApplication.set(applicationId, [...(byApplication.get(applicationId) ?? []), entry]);
    } catch {
      continue;
    }
  }
  for (const [key, list] of byApplication) {
    byApplication.set(key, [...list].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)));
  }
  return byApplication;
}

/** The artifact name for a stored path, when it is a servable screenshot. */
export function artifactNameOf(path: string | null): string | null {
  if (!path) return null;
  const name = basename(path);
  return isArtifactName(name) ? name : null;
}
