import type { Db } from "../db/database.js";
import { getApplication, listOutcomes, recordOutcome } from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import { OutcomeKindSchema, type OutcomeKind } from "../domain/policies/followup.js";
import { AppError } from "../util/errors.js";

/**
 * The one way an outcome is written. The record_outcome tool, confirmed and
 * auto-recorded replies and stale closing all come through here, so each
 * leaves the same audit event and the same validation.
 */

export type RecordOutcomeInput = {
  applicationId: string;
  kind: string;
  detail?: string;
  /** Audit event type. Defaults to outcome.recorded. */
  event?: string;
  payload?: Record<string, unknown>;
};

export type RecordedOutcome = {
  applicationId: string;
  kind: OutcomeKind;
  history: Array<{ status: string; notedAt: string; detail: string }>;
};

export function parseOutcomeKind(kind: string): OutcomeKind {
  const parsed = OutcomeKindSchema.safeParse(kind);
  if (!parsed.success) {
    throw new AppError("invalid_outcome", `"${kind}" is not an outcome (use one of: ${OutcomeKindSchema.options.join(", ")})`);
  }
  return parsed.data;
}

export function recordApplicationOutcome(db: Db, input: RecordOutcomeInput): RecordedOutcome {
  const kind = parseOutcomeKind(input.kind);
  const application = getApplication(db, input.applicationId);
  if (!application) throw new AppError("application_not_found", `no application ${input.applicationId}`);
  recordOutcome(db, application.id, kind, input.detail ?? "");
  appendEvent(db, input.event ?? "outcome.recorded", application.id, { status: kind, ...(input.payload ?? {}) });
  return { applicationId: application.id, kind, history: listOutcomes(db, application.id) };
}
