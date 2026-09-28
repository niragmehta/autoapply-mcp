/**
 * Required fields a multi-page wizard left unfilled, kept per page.
 *
 * A Workday step that refuses to advance is filled again, and the second pass
 * reads the page as it now stands, so its result replaces the first pass's
 * rather than adding to it. Salesforce's "How Did You Hear About Us?" failed on
 * the first pass over My Information, took on the second, and the stale
 * failure alone aborted an application that had reached Review complete.
 */
export type StepFailures = ReadonlyMap<string, readonly string[]>;

/** A page's name, or its position when it has none, so unnamed pages never overwrite each other. */
export function wizardStepKey(name: string, index: number): string {
  const trimmed = name.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : `#${index}`;
}

/** Returns a new record in which `failures` is the latest word on the page `key`. */
export function recordStepFailures(byStep: StepFailures, key: string, failures: readonly string[]): StepFailures {
  const next = new Map(byStep);
  next.set(key, [...failures]);
  return next;
}

/** Every failure still standing, each once, in the order the pages were first seen. */
export function stepFailureList(byStep: StepFailures): string[] {
  return [...new Set([...byStep.values()].flat())];
}
