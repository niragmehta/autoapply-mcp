import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, resolve, sep } from "node:path";
import { fileInside } from "../static.js";

/**
 * Files the dashboard offers for download - tracker exports, rendered
 * documents, evaluation reports - always by validated base name from one
 * known folder, never by a path the browser supplies.
 */

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export const DOWNLOAD_TYPES: Readonly<Record<string, string>> = {
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".ics": "text/calendar; charset=utf-8",
  ".pdf": "application/pdf",
};

export function isSafeFileName(name: string): boolean {
  return FILE_NAME.test(name) && !name.includes("..");
}

/** A file by base name inside `dir` with one of the allowed extensions, or null. */
export function resolveNamedFile(dir: string, name: string, extensions: readonly string[]): string | null {
  if (!isSafeFileName(name)) return null;
  if (!extensions.includes(extname(name).toLowerCase())) return null;
  return fileInside(resolve(dir), name);
}

/** The same check for a stored absolute path: it must sit directly or deeper inside `dir`. */
export function storedFileInside(dir: string, path: string, extensions: readonly string[]): string | null {
  if (!path) return null;
  const root = resolve(dir);
  const absolute = resolve(path);
  if (!absolute.startsWith(root + sep)) return null;
  if (!extensions.includes(extname(absolute).toLowerCase())) return null;
  return fileInside(root, absolute.slice(root.length + 1));
}

export type ListedFile = { name: string; sizeBytes: number; modifiedAt: string };

export function listFiles(dir: string, extensions: readonly string[], limit = 50): ListedFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: ListedFile[] = [];
  for (const name of names) {
    if (!isSafeFileName(name) || !extensions.includes(extname(name).toLowerCase())) continue;
    try {
      const stats = statSync(resolve(dir, name));
      if (stats.isFile()) files.push({ name, sizeBytes: stats.size, modifiedAt: stats.mtime.toISOString() });
    } catch {
      // A file removed between readdir and stat is simply not listed.
    }
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, limit);
}

/** Shortens a path under the user's home folder to `~`, for display only. */
export function displayPath(path: string, home = homedir()): string {
  if (!path) return path;
  const absolute = resolve(path);
  const root = resolve(home);
  if (absolute.toLowerCase() === root.toLowerCase()) return "~";
  return absolute.toLowerCase().startsWith(root.toLowerCase() + sep) ? `~${sep}${absolute.slice(root.length + 1)}` : path;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replaces the user's home folder inside a message (an error naming a file, say) with `~`. */
export function scrubHome(text: string, home = homedir()): string {
  if (!text || !home) return text;
  const root = resolve(home);
  const variants = [...new Set([root, root.replace(/\\/g, "/")])].sort((a, b) => b.length - a.length);
  return variants.reduce((current, variant) => current.replace(new RegExp(escapeRegExp(variant), "gi"), "~"), text);
}

export function fileNameOf(path: string): string {
  return basename(path);
}
