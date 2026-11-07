import type { Workspace } from "../../config/load.js";
import { buildFactCorpus, checkFacts, withContext, type FactCheckResult } from "../../documents/factCheck.js";
import { loadResumeSourceIfPresent } from "../../documents/resumeSource.js";
import type { Job } from "../../domain/job.js";
import { toErrorMessage } from "../../util/errors.js";

/**
 * The cover-letter fact check save_cover_letter runs, used here to inform
 * rather than refuse: a person editing their own letter sees every claim the
 * resume source and profile do not support, and decides.
 */

export type LetterCheck = FactCheckResult & { note: string | null };

export function checkLetter(workspace: Workspace, job: Job, text: string): LetterCheck {
  let note: string | null = null;
  let source = null;
  try {
    source = loadResumeSourceIfPresent(workspace.paths);
    if (!source) note = "No resume source: checked against the profile only.";
  } catch (error) {
    note = `The resume source could not be read (${toErrorMessage(error)}); checked against the profile only.`;
  }
  const corpus = withContext(buildFactCorpus({ source, profile: workspace.profile }), {
    company: job.companyName,
    role: job.title,
    locations: job.locationsRaw,
    posting: job.descriptionText,
  });
  return { ...checkFacts(text, corpus), note };
}
