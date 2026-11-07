import type { LivenessRecord, ListingPresence } from "../db/repositories/liveness.js";
import { latestLiveness, listingPresence } from "../db/repositories/liveness.js";
import type { Workspace } from "../config/load.js";
import type { Job } from "../domain/job.js";
import { assessLegitimacy, type LegitimacyAssessment } from "./legitimacy.js";
import { repostSignalFor, type RepostCluster } from "./reposts.js";

/**
 * Gathers the stored context legitimacy needs - the latest liveness verdict,
 * listing presence and the repost cluster - without touching the network.
 */

export type PostingSignals = {
  liveness: LivenessRecord | null;
  listing: ListingPresence;
  repost: RepostCluster | null;
};

export function postingSignals(workspace: Workspace, job: Job, now = new Date()): PostingSignals {
  const reposts = workspace.campaign.hygiene.reposts;
  return {
    liveness: latestLiveness(workspace.db, job.id),
    listing: listingPresence(workspace.db, job),
    repost: repostSignalFor(workspace.db, job, { windowDays: reposts.windowDays, minPostings: reposts.minPostings, now }),
  };
}

export function legitimacyFor(workspace: Workspace, job: Job, now = new Date()): LegitimacyAssessment & PostingSignals {
  const signals = postingSignals(workspace, job, now);
  return { ...assessLegitimacy(job, { now, ...signals }), ...signals };
}
