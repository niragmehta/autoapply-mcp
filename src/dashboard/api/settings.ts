import { z } from "zod";
import { existsSync } from "node:fs";
import type { Campaign } from "../../domain/campaign.js";
import type { Profile } from "../../domain/profile.js";
import { displayPath } from "../queries/files.js";
import { parseBody, type Router } from "../router.js";
import { DOCUMENT_TOGGLES, writeDocumentToggles } from "../settings/configFiles.js";

/**
 * Read-only summaries of campaign.json and profile.json, and the three
 * documents settings the dashboard may change (tailoring on or off, and its
 * two limits). Everything else in the campaign is edited in the file itself.
 */

const DocumentsBody = z
  .object({
    tailorResume: z.boolean().optional(),
    maxSwaps: z.number().int().min(0).max(10).optional(),
    maxAddedSkills: z.number().int().min(0).max(10).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "change at least one of tailorResume, maxSwaps or maxAddedSkills");

function campaignSummary(campaign: Campaign) {
  const { submission, scoring } = campaign;
  return {
    name: campaign.name,
    targetApplications: campaign.targetApplications,
    tracks: campaign.tracks.map((track) => ({
      id: track.id,
      label: track.label,
      allocation: track.allocation,
      resumeId: track.resumeId,
      titleIncludes: track.titleIncludes,
      titleExcludes: track.titleExcludes,
      keywords: track.keywords.map((keyword) => keyword.term),
    })),
    tiers: { A: scoring.thresholds.tierA, B: scoring.thresholds.tierB, C: scoring.thresholds.tierC },
    weights: scoring.weights,
    locations: campaign.locations.allow,
    workplaceTypes: campaign.locations.workplaceTypes,
    seniority: campaign.seniority,
    freshnessDays: campaign.freshnessDays,
    compensation: { currency: campaign.compensation.currency, floors: campaign.compensation.floors, fx: campaign.compensation.fx, allowUnknown: campaign.compensation.allowUnknown },
    submission: {
      mode: submission.mode,
      dailyLimit: submission.dailyLimit,
      maxBatchSize: submission.maxBatchSize,
      maxPerCompany: submission.maxPerCompany,
      minDelaySeconds: submission.minDelaySeconds,
      allowedCompanies: submission.allowedCompanies,
      allowedAtsDomains: submission.allowedAtsDomains,
      blockedQuestionCategories: submission.blockedQuestionCategories,
    },
    runner: campaign.runner,
    documents: campaign.documents,
    followUps: campaign.followUps,
    editable: DOCUMENT_TOGGLES.map((key) => `documents.${key}`),
  };
}

function profileSummary(profile: Profile) {
  const { identity, workAuthorization, compensation, preferences } = profile;
  return {
    identity: { fullName: identity.fullName, headline: identity.headline, location: identity.location, links: Object.keys(identity.links) },
    workAuthorization: {
      citizenships: workAuthorization.citizenships,
      authorizedIn: workAuthorization.authorizedIn,
      noSponsorshipRequiredIn: workAuthorization.noSponsorshipRequiredIn,
      requiresSponsorshipIn: workAuthorization.requiresSponsorshipIn,
      alwaysReviewManually: workAuthorization.alwaysReviewManually,
    },
    compensation: { currency: compensation.currency, targetTotal: compensation.targetTotal, minimumTotal: compensation.minimumTotal, disclosurePolicy: compensation.disclosurePolicy },
    preferences: { willingToRelocate: preferences.willingToRelocate, relocationTargets: preferences.relocationTargets, workplaceTypes: preferences.workplaceTypes, noticePeriod: preferences.noticePeriod },
    resumes: profile.resumes.map((resume) => ({ id: resume.id, label: resume.label, tracks: resume.tracks, isDefault: resume.isDefault, file: displayPath(resume.path), exists: existsSync(resume.path) })),
    experience: profile.experience.map((role) => ({ company: role.company, title: role.title, start: role.start, end: role.end })),
    counts: {
      facts: profile.facts.length,
      skills: profile.skills.length,
      experience: profile.experience.length,
      education: profile.education.length,
      resumes: profile.resumes.length,
      answers: profile.answers.length,
      narratives: profile.narratives.length,
    },
  };
}

export function registerRoutes(router: Router): void {
  router.get("/api/settings/campaign", (request) => {
    const workspace = request.ctx.workspace();
    return { ...campaignSummary(workspace.campaign), file: displayPath(workspace.paths.campaign) };
  });

  router.get("/api/settings/profile", (request) => {
    const workspace = request.ctx.workspace();
    return { ...profileSummary(workspace.profile), file: displayPath(workspace.paths.profile) };
  });

  router.patch("/api/settings/documents", (request) => {
    const body = parseBody(DocumentsBody, request);
    const saved = writeDocumentToggles(request.ctx.workspace().paths.campaign, body);
    return { documents: request.ctx.workspace().campaign.documents, saved };
  });
}
