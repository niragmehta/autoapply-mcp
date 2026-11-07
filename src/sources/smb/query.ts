/**
 * Client-side keyword filtering for boards with no search endpoint.
 *
 * Every term must start a word somewhere in the given fields, so "engineer"
 * matches "Engineering Manager" but "net" does not match "Kubernetes". A blank
 * query (or "*") matches everything.
 */

function terms(query: string): string[] {
  return query.toLowerCase().split(/[\s,;/|]+/).map((term) => term.trim()).filter((term) => term.length > 0 && term !== "*");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesQuery(query: string, ...fields: ReadonlyArray<string | null | undefined>): boolean {
  const wanted = terms(query);
  if (wanted.length === 0) return true;
  const haystack = fields.filter((field): field is string => typeof field === "string").join(" \n ").toLowerCase();
  return wanted.every((term) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term)}`, "u").test(haystack));
}

/** True when the query asks for no keyword filtering at all. */
export function isWildcardQuery(query: string): boolean {
  return terms(query).length === 0;
}
