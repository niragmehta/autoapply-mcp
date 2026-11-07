import { existsSync } from "node:fs";
import type { Workspace } from "../config/load.js";
import type { ApplicationStatus } from "../domain/job.js";
import { toErrorMessage } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { generateTailoredResume } from "./resumeService.js";

/**
 * The last step of prepare_application when campaign.documents.tailorResume
 * is on: replace the track's fixed resume with one tailored to the posting.
 * A failure keeps the variant PDF the application was prepared with and is
 * reported, never thrown, so tailoring can never block a preparation.
 */

type PreparedDocuments = { tailored: boolean; warning?: string; resumePath?: string; sha256?: string; pages?: number; changes?: number };

type Prepared = { applicationId: string; status: ApplicationStatus; packetHash: string; resumeBlocker?: string; nextStep: string };

export async function attachTailoredResume<T extends Prepared>(workspace: Workspace, prepared: T): Promise<T & { documents?: PreparedDocuments }> {
  if (!workspace.campaign.documents.tailorResume) return prepared;
  if (!existsSync(workspace.paths.resumeSource)) {
    return {
      ...prepared,
      documents: { tailored: false, warning: `campaign.documents.tailorResume is on but there is no resume source at ${workspace.paths.resumeSource}` },
    };
  }
  try {
    const result = await generateTailoredResume(workspace, prepared.applicationId);
    // The variant's problems no longer matter once a verified tailored file replaces it.
    const unblocked = prepared.resumeBlocker
      ? {
          resumeBlocker: undefined,
          nextStep:
            result.status === "needs_human"
              ? "Answer the flagged questions with set_application_content, then approve_application."
              : "Review with preview_application, then approve_application.",
        }
      : {};
    return {
      ...prepared,
      ...unblocked,
      status: result.status,
      packetHash: result.packetHash,
      documents: { tailored: true, resumePath: result.path, sha256: result.sha256, pages: result.pages, changes: result.changes.length },
    };
  } catch (error) {
    const warning = toErrorMessage(error);
    logger.warn("tailored resume failed; keeping the track variant", { applicationId: prepared.applicationId, warning });
    return { ...prepared, documents: { tailored: false, warning: `tailored resume not used, the track variant stays attached: ${warning}` } };
  }
}
