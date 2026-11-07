import { AppError } from "../util/errors.js";

/**
 * RFC 6901 JSON pointers with immutable edits.
 *
 * Guided profile edits address one field at a time ("/identity/phone",
 * "/skills/3") so an agent can write a single confirmed answer without
 * rewriting, and possibly corrupting, the rest of a file that took an hour to
 * write by hand.
 */

const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
const INDEX = /^(0|[1-9]\d*)$/;

export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new AppError("invalid_pointer", `JSON pointer must start with "/": ${pointer}`, { pointer });
  }
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
  for (const token of tokens) {
    if (FORBIDDEN.has(token)) throw new AppError("invalid_pointer", `JSON pointer segment "${token}" is not allowed`, { pointer });
  }
  return tokens;
}

export function formatPointer(tokens: readonly string[]): string {
  return tokens.map((token) => `/${token.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null;
}

function arrayIndex(array: readonly unknown[], token: string, pointer: string, allowEnd: boolean): number {
  if (!INDEX.test(token)) {
    throw new AppError("invalid_pointer", `"${token}" is not an array index in ${pointer}`, { pointer });
  }
  const index = Number(token);
  const max = allowEnd ? array.length : array.length - 1;
  if (index > max) throw new AppError("pointer_not_found", `index ${index} is out of range in ${pointer}`, { pointer });
  return index;
}

export function getAt(root: unknown, tokens: readonly string[]): unknown {
  let current: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!INDEX.test(token)) return undefined;
      current = current[Number(token)];
    } else if (isContainer(current)) {
      const record = current as Record<string, unknown>;
      current = Object.prototype.hasOwnProperty.call(record, token) ? record[token] : undefined;
    } else {
      return undefined;
    }
  }
  return current;
}

function notAnObject(pointer: string): AppError {
  return new AppError("pointer_not_found", `${pointer} passes through a value that is not an object`, { pointer });
}

/**
 * Returns a copy of `root` with `transform` applied at `tokens`. Objects missing
 * on the way are created, because a section the schema defaults (such as
 * identity.links) is often absent from a hand-written file.
 */
function updateAt(root: unknown, tokens: readonly string[], pointer: string, transform: (current: unknown) => unknown): unknown {
  if (tokens.length === 0) return transform(root);
  const [head, ...rest] = tokens as [string, ...string[]];
  if (Array.isArray(root)) {
    const index = arrayIndex(root, head, pointer, false);
    const next = [...root];
    next[index] = updateAt(root[index], rest, pointer, transform);
    return next;
  }
  if (root !== undefined && !isContainer(root)) throw notAnObject(pointer);
  const base: Record<string, unknown> = { ...(root as Record<string, unknown> | undefined) };
  base[head] = updateAt(base[head], rest, pointer, transform);
  return base;
}

export function setAt(root: unknown, pointer: string, value: unknown): unknown {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) throw new AppError("invalid_pointer", "cannot replace the whole document", { pointer });
  const last = tokens[tokens.length - 1]!;
  return updateAt(root, tokens.slice(0, -1), pointer, (parent) => {
    if (Array.isArray(parent)) {
      const index = arrayIndex(parent, last, pointer, true);
      const next = [...parent];
      next[index] = value;
      return next;
    }
    if (parent !== undefined && !isContainer(parent)) throw notAnObject(pointer);
    return { ...(parent as Record<string, unknown> | undefined), [last]: value };
  });
}

export function appendAt(root: unknown, pointer: string, value: unknown): unknown {
  const tokens = parsePointer(pointer);
  return updateAt(root, tokens, pointer, (current) => {
    if (current === undefined) return [value];
    if (!Array.isArray(current)) {
      throw new AppError("not_an_array", `${pointer} is not a list, so nothing can be appended to it`, { pointer });
    }
    return [...current, value];
  });
}

export function removeAt(root: unknown, pointer: string): unknown {
  const tokens = parsePointer(pointer);
  if (tokens.length === 0) throw new AppError("invalid_pointer", "cannot remove the whole document", { pointer });
  if (getAt(root, tokens) === undefined) {
    throw new AppError("pointer_not_found", `${pointer} does not exist`, { pointer });
  }
  const last = tokens[tokens.length - 1]!;
  return updateAt(root, tokens.slice(0, -1), pointer, (parent) => {
    if (Array.isArray(parent)) {
      const index = arrayIndex(parent, last, pointer, false);
      return parent.filter((_, position) => position !== index);
    }
    const { [last]: _removed, ...rest } = parent as Record<string, unknown>;
    return rest;
  });
}
