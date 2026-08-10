import type { Personal, Profile, StoredAnswer } from "../domain/profile.js";
import { normalizeQuestionLabel } from "./blockedQuestions.js";

/**
 * Resolvers for personal and demographic form fields.
 *
 * These questions are sensitive, so the rule is strict: a value is only used
 * when the candidate has set `autoFill` on that specific field. Storing a value
 * is not consent to send it; the flag is.
 */

export type PersonalResolution = {
  answer: string;
  citation: string;
  /** True when the candidate pre-authorized this exact field. */
  authorized: boolean;
};

type Resolver = {
  pattern: RegExp;
  category: string;
  resolve: (personal: Personal, profile: Profile) => StoredAnswer | string;
  citation: string;
};

function formatAddress(personal: Personal): string {
  const { street, city, region, postalCode, country } = personal.address;
  return [street, city, region, postalCode, country].filter((part) => part.length > 0).join(", ");
}

/**
 * The most recently completed qualification, which is what boards mean by "most
 * recent school" or "highest degree".
 */
function latestEducation(profile: Profile) {
  const entries = profile.education.filter((entry) => entry.institution.trim().length > 0);
  if (entries.length === 0) return null;
  return entries.reduce((best, entry) => (entry.end > best.end ? entry : best));
}

/**
 * Education is a resume fact, not a sensitive disclosure, so it carries the
 * same standing authorization as employment history. Nothing sourced these
 * before: `profile.education` was validated and stored but never read, so every
 * "What is the most recent school you attended?" blocked its application and
 * required School boxes were simply left empty.
 */
function education(part: "institution" | "credential" | "field" | "end"): Resolver["resolve"] {
  return (_personal, profile) => {
    const entry = latestEducation(profile);
    if (!entry) return "";
    const value = part === "end" ? (entry.end.split("-")[0] ?? "") : entry[part];
    return { value, autoFill: true };
  };
}

const RESOLVERS: readonly Resolver[] = [
  {
    pattern: /\b(date of birth|birth ?date|d\.?o\.?b\.?)\b/i,
    category: "personal-identifier",
    resolve: (personal) => personal.dateOfBirth,
    citation: "personal.dateOfBirth",
  },
  {
    // Forms with numbered address lines have separate city and postal fields,
    // so only the street belongs here.
    pattern: /\baddress line\b|\bstreet$/i,
    category: "contact",
    resolve: (personal) => ({ value: personal.address.street, autoFill: personal.addressAutoFill }),
    citation: "personal.address.street",
  },
  {
    // Bare "Address" fields, guarded so "Email Address" does not match.
    pattern: /^(?!.*\be-?mail\b).*\b(street address|mailing address|home address|residential address|current address|address)\b/i,
    category: "contact",
    resolve: (personal) => ({ value: formatAddress(personal), autoFill: personal.addressAutoFill }),
    citation: "personal.address",
  },
  {
    pattern: /\b(postal code|zip ?code|post code)\b/i,
    category: "contact",
    resolve: (personal) => ({ value: personal.address.postalCode, autoFill: personal.addressAutoFill }),
    citation: "personal.address.postalCode",
  },
  {
    pattern: /\bpronouns?\b/i,
    category: "demographic",
    resolve: (personal) => personal.demographics.pronouns,
    citation: "personal.demographics.pronouns",
  },
  {
    pattern: /(?:\bsexual orientation\b|\borientation\b|\blgbtq[a-z]*\+?)/i,
    category: "demographic",
    resolve: (personal) => personal.demographics.sexualOrientation,
    citation: "personal.demographics.sexualOrientation",
  },
  {
    pattern: /\b(transgender|gender identity)\b/i,
    category: "demographic",
    resolve: (personal) => personal.demographics.transgenderIdentity,
    citation: "personal.demographics.transgenderIdentity",
  },
  {
    pattern: /\b(hispanic|latino|latinx)\b/i,
    category: "demographic",
    resolve: (personal) => personal.demographics.hispanicLatino,
    citation: "personal.demographics.hispanicLatino",
  },
  {
    pattern: /\b(race|racial|ethnic\w*)\b/i,
    category: "demographic",
    resolve: (personal) => personal.demographics.raceEthnicity,
    citation: "personal.demographics.raceEthnicity",
  },
  {
    pattern: /\b(gender|sex)\b/i,
    category: "demographic",
    resolve: (personal) => personal.demographics.gender,
    citation: "personal.demographics.gender",
  },
  {
    pattern: /\b(veteran|military service|armed forces|protected veteran)\b/i,
    category: "veteran",
    resolve: (personal) => personal.demographics.veteranStatus,
    citation: "personal.demographics.veteranStatus",
  },
  {
    pattern: /\b(disabilit|impairment)\w*/i,
    category: "disability",
    resolve: (personal) => personal.demographics.disabilityStatus,
    citation: "personal.demographics.disabilityStatus",
  },
  {
    pattern: /\b(at least 18|over 18|18 years of age|age of majority|legal working age)\b/i,
    category: "personal-identifier",
    resolve: (personal) => personal.legalAgeConfirmation,
    citation: "personal.legalAgeConfirmation",
  },
  {
    pattern: /\b(previously (?:been )?employed|worked (?:for|at) (?:this|our) company|former employee|prior employment with)\b/i,
    category: "general",
    resolve: (personal) => personal.previousEmployment,
    citation: "personal.previousEmployment",
  },
  // Education. These sit last so a more specific question - a disability
  // question mentioning "major life activities", or a school-district employer
  // - is claimed by the resolver above that actually means it.
  {
    pattern: /\b(school|university|college|alma mater|institution attended)\b/i,
    category: "education",
    resolve: education("institution"),
    citation: "education[0].institution",
  },
  {
    pattern: /\b(degree|qualification obtained|level of education|education level)\b/i,
    category: "education",
    resolve: education("credential"),
    citation: "education[0].credential",
  },
  {
    pattern: /\b(field of study|area of study|course of study|discipline|major)\b/i,
    category: "education",
    resolve: education("field"),
    citation: "education[0].field",
  },
  {
    pattern: /\b(graduation (?:year|date)|year of graduation|graduated)\b/i,
    category: "education",
    resolve: education("end"),
    citation: "education[0].end",
  },
];

/**
 * Returns a stored personal answer for a question label, or null when nothing
 * in the profile addresses it. `authorized` reports whether the candidate
 * opted this field in for automatic use.
 */
export function resolvePersonal(label: string, profile: Profile): (PersonalResolution & { category: string }) | null {
  const normalized = normalizeQuestionLabel(label);
  for (const resolver of RESOLVERS) {
    if (!resolver.pattern.test(label) && !resolver.pattern.test(normalized)) continue;
    const raw = resolver.resolve(profile.personal, profile);
    const stored: StoredAnswer = typeof raw === "string" ? { value: raw, autoFill: false } : raw;
    if (stored.value.trim().length === 0) return null;
    return {
      answer: stored.value,
      citation: resolver.citation,
      authorized: stored.autoFill,
      category: resolver.category,
    };
  }
  return null;
}

/** Fields the candidate has opted into automatic use, for reporting. */
export function autoFillableFields(profile: Profile): string[] {
  const personal = profile.personal;
  const entries: Array<[string, StoredAnswer | boolean]> = [
    ["personal.dateOfBirth", personal.dateOfBirth],
    ["personal.address", personal.addressAutoFill],
    ["personal.legalAgeConfirmation", personal.legalAgeConfirmation],
    ["personal.previousEmployment", personal.previousEmployment],
    ["personal.demographics.gender", personal.demographics.gender],
    ["personal.demographics.pronouns", personal.demographics.pronouns],
    ["personal.demographics.raceEthnicity", personal.demographics.raceEthnicity],
    ["personal.demographics.hispanicLatino", personal.demographics.hispanicLatino],
    ["personal.demographics.veteranStatus", personal.demographics.veteranStatus],
    ["personal.demographics.disabilityStatus", personal.demographics.disabilityStatus],
    ["personal.demographics.sexualOrientation", personal.demographics.sexualOrientation],
    ["personal.demographics.transgenderIdentity", personal.demographics.transgenderIdentity],
  ];
  return entries
    .filter(([, value]) => (typeof value === "boolean" ? value : value.autoFill && value.value.trim().length > 0))
    .map(([name]) => name);
}
