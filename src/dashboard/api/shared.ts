import { z } from "zod";

/** Query-string and path schemas shared by the API modules. */

function listFrom(value: unknown): string[] | undefined {
  if (value === undefined || value === "") return undefined;
  const parts = (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry).split(","))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts : undefined;
}

/** `?tier=A,B` or `?tier=A&tier=B`. */
export function csvList<T extends z.ZodType>(item: T) {
  return z.preprocess(listFrom, z.array(item).max(100).optional());
}

const blankToUndefined = (value: unknown) => (value === "" || value === undefined ? undefined : value);

export function queryInt(min: number, max: number, fallback: number) {
  return z.preprocess(blankToUndefined, z.coerce.number().int().min(min).max(max).default(fallback));
}

export const queryNumber = z.preprocess(blankToUndefined, z.coerce.number().finite().optional());

export const queryBool = z.preprocess((value) => {
  if (value === undefined || value === "") return undefined;
  const text = String(value).toLowerCase();
  if (["1", "true", "yes"].includes(text)) return true;
  if (["0", "false", "no"].includes(text)) return false;
  return value;
}, z.boolean().optional());

export const queryText = (max = 200) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

export const IdParams = z.object({ id: z.string().trim().min(1).max(200) });

export const sortDir = z.enum(["asc", "desc"]);

export function paged<T>(total: number, page: number, pageSize: number, rows: T[]) {
  return { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), rows };
}
