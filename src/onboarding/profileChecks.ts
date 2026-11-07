import { basename } from "node:path";
import type { Campaign, LocationClass } from "../domain/campaign.js";
import type { Profile } from "../domain/profile.js";
import { validateResumeFile, type ResumeCheck } from "../submission/resume.js";
import { readVerificationInboxConfig } from "../submission/verificationInbox.js";
import { maskEmail, maskPhone, presence } from "./mask.js";
import { findPlaceholders, placeholderMarker, type PlaceholderHit } from "./placeholders.js";

/**
 * The individual readiness checks behind profile_status. Each returns a
 * summary safe to show an agent (sensitive values masked) and the findings
 * that become next steps.
 */

export type Severity = "blocker" | "important" | "suggested";
export type Finding = { severity: Severity; section: string; message: string; tool?: string };

type Section<T> = { summary: T; findings: Finding[] };

const isBlank = (value: string | undefined | null): boolean => !value || value.trim().length === 0;

export function checkIdentity(profile: Profile) {
  const { identity } = profile;
  const findings: Finding[] = [];
  const need = (ok: boolean, severity: Severity, message: string) => {
    if (!ok) findings.push({ severity, section: "identity", message, tool: "update_profile" });
  };
  need(!isBlank(identity.fullName) && !placeholderMarker(identity.fullName), "blocker", "Full name is missing or still a placeholder.");
  need(!placeholderMarker(identity.email), "blocker", "Email is still a placeholder address.");
  need(!isBlank(identity.phone), "suggested", "No phone number; most application forms ask for one.");
  need(
    !isBlank(identity.location.country) && !placeholderMarker(identity.location.country),
    "blocker",
    "Home country is missing or still a placeholder; location and work-authorization answers depend on it.",
  );
  need(!isBlank(identity.location.city) && !placeholderMarker(identity.location.city), "important", "Home city is missing or still a placeholder.");
  need(!isBlank(identity.headline) && !placeholderMarker(identity.headline), "suggested", "No headline (current title), or it is still a placeholder.");
  const links = Object.entries(identity.links).filter(([, url]) => !isBlank(url)).map(([name]) => name);
  need(links.length > 0, "suggested", "No profile links (LinkedIn, GitHub, website); many forms ask for LinkedIn.");
  return {
    summary: {
      fullName: identity.fullName,
      headline: identity.headline,
      email: maskEmail(identity.email),
      phone: maskPhone(identity.phone),
      location: [identity.location.city, identity.location.region, identity.location.country].filter((part) => !isBlank(part)).join(", "),
      links,
    },
    findings,
  } satisfies Section<unknown>;
}

export function checkPersonal(profile: Profile) {
  const { personal } = profile;
  const address = personal.address;
  const parts = [address.street, address.city, address.region, address.postalCode, address.country];
  const filled = parts.filter((part) => !isBlank(part)).length;
  const demographics = Object.values(personal.demographics).filter((answer) => !isBlank(answer.value)).length;
  return {
    summary: {
      dateOfBirth: presence(personal.dateOfBirth.value),
      address: filled === 0 ? "empty" : filled === parts.length ? "set" : "partial",
      addressAutoFill: personal.addressAutoFill,
      demographicAnswersRecorded: demographics,
      note: "Personal and demographic fields are edited by hand in profile.json; they are never written by a tool.",
    },
    findings: [] as Finding[],
  };
}

/** Countries a location class targets; global and unknown classes target none in particular. */
const CLASS_COUNTRY: Partial<Record<LocationClass, string>> = {
  "bay-area": "US",
  "us-other": "US",
  "remote-us": "US",
  canada: "CA",
  "remote-canada": "CA",
};

const COUNTRY_ALIASES: Record<string, string> = {
  USA: "US",
  "UNITED STATES": "US",
  "UNITED STATES OF AMERICA": "US",
  CANADA: "CA",
  CAN: "CA",
};

export type CountryCoverage = {
  country: string;
  status: "authorized" | "no-sponsorship-needed" | "requires-sponsorship" | "unknown";
};

export function checkWorkAuthorization(profile: Profile, campaign: Campaign | null) {
  const auth = profile.workAuthorization;
  const findings: Finding[] = [];
  const add = (severity: Severity, message: string) =>
    findings.push({ severity, section: "workAuthorization", message, tool: "update_profile" });

  const lists = [auth.authorizedIn, auth.noSponsorshipRequiredIn, auth.requiresSponsorshipIn];
  const nonIso = lists.flat().filter((code) => !/^[A-Z]{2}$/.test(code.trim()));
  for (const code of new Set(nonIso)) {
    const iso = COUNTRY_ALIASES[code.trim().toUpperCase()];
    add("important", `"${code}" is not a two-letter ISO country code${iso ? ` (use "${iso}")` : ""}; the gates compare ISO codes.`);
  }
  const normalize = (codes: readonly string[]) => codes.map((code) => COUNTRY_ALIASES[code.trim().toUpperCase()] ?? code.trim().toUpperCase());
  const authorized = normalize(auth.authorizedIn);
  const noSponsorship = normalize(auth.noSponsorshipRequiredIn);
  const sponsorship = normalize(auth.requiresSponsorshipIn);

  if (auth.citizenships.some((value) => placeholderMarker(value))) add("blocker", "Citizenship is still a placeholder.");
  if (placeholderMarker(auth.statement)) add("blocker", "The work-authorization statement is still a placeholder.");

  const targets = [...new Set((campaign?.locations.allow ?? []).map((cls) => CLASS_COUNTRY[cls]).filter((code): code is string => !!code))];
  const coverage: CountryCoverage[] = targets.map((country) => ({
    country,
    status: authorized.includes(country)
      ? "authorized"
      : noSponsorship.includes(country)
        ? "no-sponsorship-needed"
        : sponsorship.includes(country)
          ? "requires-sponsorship"
          : "unknown",
  }));
  for (const gap of coverage.filter((entry) => entry.status === "unknown")) {
    add(
      "blocker",
      `The campaign targets ${gap.country} but the profile does not say whether the candidate can work there. Ask; never assume.`,
    );
  }
  if (targets.length === 0 && authorized.length + noSponsorship.length + sponsorship.length === 0) {
    add("blocker", "No country is listed as authorized, sponsorship-free or requiring sponsorship. Ask; never assume.");
  }
  const complete = !findings.some((finding) => finding.severity === "blocker");
  return {
    summary: {
      complete,
      citizenshipsRecorded: auth.citizenships.length,
      statement: presence(auth.statement),
      authorizedIn: authorized,
      noSponsorshipRequiredIn: noSponsorship,
      requiresSponsorshipIn: sponsorship,
      campaignCoverage: coverage,
      alwaysReviewManually: auth.alwaysReviewManually,
    },
    findings,
  };
}

/** Totals this small are the example profile's placeholders, not a real expectation. */
const IMPLAUSIBLE_TOTAL = 1000;

export function checkCompensation(profile: Profile, campaign: Campaign | null) {
  const pay = profile.compensation;
  const findings: Finding[] = [];
  const add = (severity: Severity, message: string, tool = "update_profile") =>
    findings.push({ severity, section: "compensation", message, tool });
  if (pay.targetTotal < IMPLAUSIBLE_TOTAL || pay.minimumTotal < IMPLAUSIBLE_TOTAL) {
    add("blocker", "Target or minimum total compensation looks like a placeholder; ask for the real figures.");
  }
  if (pay.minimumTotal > pay.targetTotal) add("blocker", "The minimum total compensation is higher than the target.");
  if (campaign && campaign.compensation.currency !== pay.currency) {
    add("suggested", `Profile compensation is in ${pay.currency} but the campaign compares pay in ${campaign.compensation.currency}.`);
  }
  if (campaign && Object.keys(campaign.compensation.floors).length === 0) {
    add("important", "The campaign has no compensation floors, so low-paying postings are not filtered.", "update_campaign");
  }
  return {
    summary: {
      currency: pay.currency,
      targetTotal: pay.targetTotal,
      minimumTotal: pay.minimumTotal,
      disclosurePolicy: pay.disclosurePolicy,
      campaignFloors: campaign?.compensation.floors ?? {},
      sane: !findings.some((finding) => finding.severity === "blocker"),
    },
    findings,
  };
}

export function checkResumes(profile: Profile, validate: (path: string) => ResumeCheck = validateResumeFile) {
  const findings: Finding[] = [];
  const resumes = profile.resumes.map((resume) => {
    const check = validate(resume.path);
    if (!check.ok) {
      findings.push({
        severity: "blocker",
        section: "resumes",
        message: `Resume "${resume.id}" is not usable: ${check.reason.replace(resume.path, basename(resume.path))}`,
        tool: "update_profile",
      });
    }
    return {
      id: resume.id,
      label: resume.label,
      file: basename(resume.path),
      ok: check.ok,
      format: check.format,
      warnings: check.warnings,
      tracks: resume.tracks,
      isDefault: resume.isDefault,
    };
  });
  if (!profile.resumes.some((resume) => resume.isDefault) && profile.resumes.length > 1) {
    findings.push({ severity: "suggested", section: "resumes", message: "No resume is marked isDefault.", tool: "update_profile" });
  }
  return { summary: resumes, findings };
}

export function checkContent(profile: Profile) {
  const counts = {
    experience: profile.experience.length,
    education: profile.education.length,
    skills: profile.skills.length,
    facts: profile.facts.length,
    factsWithMetrics: profile.facts.filter((fact) => fact.metrics.length > 0).length,
    answers: profile.answers.length,
    narratives: profile.narratives.length,
    resumes: profile.resumes.length,
  };
  const findings: Finding[] = [];
  const add = (severity: Severity, section: string, message: string, tool = "update_profile") =>
    findings.push({ severity, section, message, tool });
  if (counts.experience === 0) add("important", "experience", "No work history; import the CV with import_resume_text.", "import_resume_text");
  if (counts.skills === 0) add("important", "skills", "No skills recorded; matching and skill questions rely on them.");
  if (counts.facts === 0) add("important", "facts", "No verified facts; cover letters and essay answers can only quote facts.");
  else if (counts.factsWithMetrics === 0) add("suggested", "facts", "No fact carries a metric; ask for the numbers behind the best achievements.");
  if (counts.education === 0) add("suggested", "education", "No education recorded; most forms ask for it.");
  return { summary: counts, findings };
}

export type AnswerReview = { index: number; key: string; label: string; reason: "empty" | "flagged-review" | "placeholder" };

const ANSWER_SAMPLE = 20;

/** Each entry carries its index, so an answer can be written at /answers/<index>/answer. */
export function checkAnswers(profile: Profile) {
  const review: AnswerReview[] = [];
  profile.answers.forEach((answer, index) => {
    if (answer.skip) return;
    const entry = { index, key: answer.key, label: answer.label };
    if ((answer.note ?? "").includes("REVIEW")) review.push({ ...entry, reason: "flagged-review" });
    else if (isBlank(answer.answer)) review.push({ ...entry, reason: "empty" });
    else if (placeholderMarker(answer.answer)) review.push({ ...entry, reason: "placeholder" });
  });
  const flagged = review.filter((entry) => entry.reason !== "empty").length;
  const empty = review.length - flagged;
  const findings: Finding[] = [];
  if (flagged > 0) {
    findings.push({ severity: "important", section: "answers", message: `${flagged} recurring answer(s) are flagged REVIEW or hold a placeholder.`, tool: "update_profile" });
  }
  if (empty > 0) {
    findings.push({
      severity: "suggested",
      section: "answers",
      message: `${empty} recurring answer(s) are blank and will be asked on every application until answered or marked skip.`,
      tool: "update_profile",
    });
  }
  return {
    summary: { total: profile.answers.length, needingReview: review.length, flagged, empty, sample: review.slice(0, ANSWER_SAMPLE) },
    findings,
  };
}

const PLACEHOLDER_SECTIONS = [
  "identity",
  "personal",
  "workAuthorization",
  "compensation",
  "preferences",
  "resumes",
  "skills",
  "facts",
  "experience",
  "education",
  "narratives",
] as const;

/** Answers are reviewed separately; their notes legitimately say REVIEW. */
export function checkPlaceholders(profile: Profile): Section<{ count: number; hits: PlaceholderHit[] }> {
  const hits = [
    ...PLACEHOLDER_SECTIONS.flatMap((section) => findPlaceholders(profile[section], [section])),
    ...profile.answers.flatMap((answer, index) => findPlaceholders({ answer: answer.answer, alternatives: answer.alternatives }, ["answers", String(index)])),
  ];
  const findings: Finding[] = hits.length > 0
    ? [{ severity: "important", section: "placeholders", message: `${hits.length} value(s) still hold example placeholders.`, tool: "update_profile" }]
    : [];
  return { summary: { count: hits.length, hits: hits.slice(0, 50) }, findings };
}

export function checkCampaign(profile: Profile, campaign: Campaign, env: Record<string, string | undefined>, secretKeys: ReadonlySet<string>) {
  const findings: Finding[] = [];
  const add = (severity: Severity, message: string, tool = "update_campaign") => findings.push({ severity, section: "campaign", message, tool });
  const resumeIds = new Set(profile.resumes.map((resume) => resume.id));
  const tracks = campaign.tracks.map((track) => {
    const bound = resumeIds.has(track.resumeId);
    if (!bound) add("blocker", `Track "${track.id}" uses resumeId "${track.resumeId}", which no profile resume declares.`);
    if (track.titleIncludes.length === 0 && track.keywords.length === 0) {
      add("important", `Track "${track.id}" has no titleIncludes or keywords, so nothing can score into it.`);
    }
    return { id: track.id, label: track.label, resumeId: track.resumeId, resumeExists: bound, keywords: track.keywords.length };
  });

  const submission = campaign.submission;
  if (submission.allowedCompanies.length === 0) {
    add(
      submission.mode === "manual" ? "suggested" : "important",
      "submission.allowedCompanies is empty, so nothing can be submitted automatically. Add companies only when the candidate decides to.",
    );
  }
  const imapConfigured = readVerificationInboxConfig(env) !== null;
  const imapInSecrets = secretKeys.has("AUTOAPPLY_OTP_IMAP_USER") && secretKeys.has("AUTOAPPLY_OTP_IMAP_PASSWORD");
  if (campaign.inbox.enabled && !imapConfigured) {
    add(
      "important",
      imapInSecrets
        ? "inbox.enabled is on and the IMAP credentials are in the secrets file, but not in this server's environment; add them to the MCP client's env block."
        : "inbox.enabled is on but AUTOAPPLY_OTP_IMAP_USER / AUTOAPPLY_OTP_IMAP_PASSWORD are not set; add them to the secrets file.",
      "edit the secrets file",
    );
  }
  return {
    summary: {
      name: campaign.name,
      tracks,
      locations: campaign.locations.allow,
      submissionMode: submission.mode,
      allowedCompanies: submission.allowedCompanies.length,
      autoSubmitPossible: submission.mode !== "manual" && submission.allowedCompanies.length > 0,
      dailyLimit: submission.dailyLimit,
      maxPerCompany: submission.maxPerCompany,
      inbox: { enabled: campaign.inbox.enabled, imapConfigured, imapInSecretsFile: imapInSecrets },
    },
    findings,
  };
}
