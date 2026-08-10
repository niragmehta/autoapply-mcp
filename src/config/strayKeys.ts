import type { ZodType } from "zod";

/**
 * Finds keys present in a config file that no schema field claims.
 *
 * Zod strips unknown keys silently, which turns a misplaced setting into a
 * setting that does nothing. A campaign carrying `maxBatchSize` at the top level
 * instead of under `submission` parsed cleanly, reported no warning, and quietly
 * ran on the schema default - the file said one thing and the campaign did
 * another. Rejecting the file outright would be worse, since a stray key is
 * usually a typo in an otherwise working config, so these are surfaced as
 * warnings and the run continues.
 *
 * Paths are reported in dotted form so the fix is obvious: `maxBatchSize`
 * against a campaign whose schema puts it under `submission.maxBatchSize`.
 */

type ZodInternals = {
  _def?: {
    type?: string;
    innerType?: unknown;
    shape?: Record<string, unknown>;
    element?: unknown;
    valueType?: unknown;
  };
  shape?: Record<string, unknown>;
};

/** Strips optional/nullable/default/catch wrappers to reach the real type. */
function unwrap(schema: unknown): ZodInternals | undefined {
  let current = schema as ZodInternals | undefined;
  // Wrappers nest, but not deeply; the bound stops a malformed schema looping.
  for (let depth = 0; depth < 12; depth += 1) {
    const inner = current?._def?.innerType;
    if (!inner) return current;
    current = inner as ZodInternals;
  }
  return current;
}

function shapeOf(schema: unknown): Record<string, unknown> | undefined {
  const unwrapped = unwrap(schema);
  const shape = unwrapped?.shape ?? unwrapped?._def?.shape;
  return shape && typeof shape === "object" ? shape : undefined;
}

function elementOf(schema: unknown): unknown {
  return unwrap(schema)?._def?.element;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function walk(schema: unknown, value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    const element = elementOf(schema);
    if (!element) return;
    value.forEach((entry, index) => walk(element, entry, `${path}[${index}]`, out));
    return;
  }

  if (!isPlainObject(value)) return;
  const shape = shapeOf(schema);
  // A schema that accepts free-form objects - a record or a passthrough - has no
  // fixed key set, so nothing here is stray.
  if (!shape) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    const field = shape[key];
    if (!field) {
      out.push(childPath);
      continue;
    }
    walk(field, child, childPath, out);
  }
}

/**
 * Returns the dotted paths of every key the schema does not define. An empty
 * array means the file contains nothing that will be silently discarded.
 */
export function findStrayKeys(schema: ZodType<unknown>, value: unknown): string[] {
  const out: string[] = [];
  walk(schema, value, "", out);
  return out;
}

/**
 * Suggests where a stray key was meant to go by looking for the same name
 * elsewhere in the schema. Turns "maxBatchSize is unknown" into "maxBatchSize
 * belongs at submission.maxBatchSize", which is the whole diagnosis.
 */
export function locateInSchema(schema: ZodType<unknown>, key: string): string | undefined {
  const seen = new Set<unknown>();

  function search(node: unknown, path: string, depth: number): string | undefined {
    if (depth > 6) return undefined;
    const shape = shapeOf(node);
    if (!shape || seen.has(shape)) return undefined;
    seen.add(shape);
    for (const [name, field] of Object.entries(shape)) {
      const childPath = path ? `${path}.${name}` : name;
      if (name === key && childPath !== key) return childPath;
      const found = search(field, childPath, depth + 1) ?? search(elementOf(field), childPath, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  return search(schema, "", 0);
}
