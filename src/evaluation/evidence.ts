import type { Job } from "../domain/job.js";
import type { Fact, Profile, Skill } from "../domain/profile.js";
import { extractRequiredYears } from "../hygiene/experienceYears.js";
import { findKnownTerms, lookupTerm, mentionsTerm } from "../text/techTerms.js";
import type { TechTerm } from "../text/techVocabulary.js";
import { containsPhrase, shortQuote, significantWords } from "../text/words.js";
import type { RequirementItem } from "./requirements.js";

/**
 * Evidence for each requirement, from the verified profile only.
 *
 * Tiers: `direct` - the profile names the skill or holds a fact or highlight
 * that does the thing; `adjacent` - related evidence that transfers (a sibling
 * technology, a skill held only at "familiar", years within tolerance);
 * `none` - nothing in the profile supports it. Every tier carries citations
 * (skill names, fact ids, experience entries and short quotes) so the
 * narrative can point at the evidence instead of asserting it.
 */

export type EvidenceTier = "direct" | "adjacent" | "none";

type Citation = {
  kind: "skill" | "fact" | "experience" | "education" | "authorization" | "years";
  ref: string;
  quote: string;
  strength: Exclude<EvidenceTier, "none">;
};

export type RequirementEvidence = { tier: EvidenceTier; citations: Citation[]; note?: string };

/** Technologies that transfer to each other; one held is adjacent evidence for another. */
const ADJACENT_GROUPS: ReadonlyArray<readonly string[]> = [
  ["AWS", "GCP", "Azure"],
  ["Kubernetes", "Docker", "EKS", "GKE", "AKS", "Helm", "ECS"],
  ["Terraform", "Pulumi", "CloudFormation", "Ansible"],
  ["PostgreSQL", "MySQL", "SQL Server", "Oracle", "SQLite", "CockroachDB", "Spanner", "SQL"],
  ["MongoDB", "DynamoDB", "Cassandra", "Redis", "NoSQL"],
  ["Java", "Kotlin", "Scala", "Groovy"],
  ["JavaScript", "TypeScript", "Node.js"],
  ["React", "Vue", "Angular", "Svelte", "Next.js"],
  ["Django", "Flask", "FastAPI"],
  ["Kafka", "RabbitMQ", "Kinesis", "Pub/Sub", "SQS"],
  ["Snowflake", "BigQuery", "Redshift", "Databricks"],
  ["PyTorch", "TensorFlow", "JAX", "Keras"],
  ["Prometheus", "Grafana", "Datadog", "Splunk", "ELK", "OpenTelemetry", "New Relic"],
  ["Jenkins", "GitHub Actions", "GitLab CI", "CircleCI", "Argo CD"],
  ["OAuth", "OIDC", "SAML", "SSO", "IAM", "MFA"],
  ["SIEM", "SOAR", "EDR", "XDR", "detection engineering", "threat hunting"],
  ["LLM", "RAG", "LangChain", "LlamaIndex", "generative AI", "prompt engineering", "fine-tuning", "embeddings", "vector databases", "agentic"],
  ["C++", "Rust"],
  ["iOS", "Swift", "SwiftUI", "Objective-C"],
  ["Android", "Kotlin", "Jetpack Compose"],
];

const DEGREE = /\b(?:bachelor'?s?|master'?s?|ph\.?\s?d|doctorate|b\.?s\.?c?|m\.?s\.?c?|b\.?a\.?|degree)\b/i;
const EQUIVALENT = /\b(?:or equivalent|equivalent (?:practical |work )?experience|or related experience)\b/i;
const AUTHORIZATION = /\b(?:authori[sz]ed to work|work authori[sz]ation|right to work|visa sponsorship|sponsorship|citizenship|u\.?s\.? citizen)\b/i;
const SKILL_LEVELS_DIRECT = new Set(["expert", "strong", "working"]);

type SkillEntry = { skill: Skill; term: TechTerm | null; names: string[] };
type ProseEntry = { kind: "fact" | "experience"; ref: string; text: string; words: Set<string>; tags: string[]; terms: Set<string> };

type EvidenceContext = {
  profile: Profile;
  candidateYears: number;
  toleranceYears: number;
  jobCountry: string;
  skills: SkillEntry[];
  prose: ProseEntry[];
};

function proseEntry(kind: ProseEntry["kind"], ref: string, text: string, tags: readonly string[] = []): ProseEntry {
  return {
    kind,
    ref,
    text,
    words: new Set(significantWords(`${text} ${tags.join(" ")}`)),
    tags: tags.filter((tag) => tag.trim().length >= 3),
    terms: new Set(findKnownTerms(`${text} ${tags.join(" ")}`).map((entry) => entry.term.term)),
  };
}

export function buildEvidenceContext(
  profile: Profile,
  job: Pick<Job, "country">,
  years: { candidateYears: number; toleranceYears: number },
): EvidenceContext {
  const factText = (fact: Fact) => [fact.statement, ...fact.metrics].join(" ");
  return {
    profile,
    candidateYears: years.candidateYears,
    toleranceYears: years.toleranceYears,
    jobCountry: job.country.toUpperCase(),
    skills: profile.skills.map((skill) => ({
      skill,
      term: lookupTerm(skill.name) ?? skill.aliases.map(lookupTerm).find((term) => term !== null) ?? null,
      names: [skill.name, ...skill.aliases],
    })),
    prose: [
      ...profile.facts.map((fact) => proseEntry("fact", fact.id, factText(fact), fact.tags)),
      ...profile.experience.flatMap((role, index) => [
        proseEntry("experience", `experience[${index}] ${role.title}, ${role.company}`, role.title),
        ...role.highlights.map((highlight) => proseEntry("experience", `experience[${index}] ${role.title}, ${role.company}`, highlight)),
      ]),
    ],
  };
}

function skillCitations(text: string, terms: readonly TechTerm[], context: EvidenceContext): Citation[] {
  const citations: Citation[] = [];
  for (const entry of context.skills) {
    const named = entry.names.some((name) => containsPhrase(text, name)) || (entry.term !== null && mentionsTerm(text, entry.term));
    if (named) {
      citations.push({
        kind: "skill",
        ref: entry.skill.name,
        quote: `${entry.skill.name} (${entry.skill.level})`,
        strength: SKILL_LEVELS_DIRECT.has(entry.skill.level) ? "direct" : "adjacent",
      });
      continue;
    }
    const sibling = terms.find((term) =>
      ADJACENT_GROUPS.some((group) => group.includes(term.term) && entry.term !== null && group.includes(entry.term.term)),
    );
    const tag = entry.skill.tags.find((value) => value.length >= 3 && containsPhrase(text, value));
    if (sibling || tag) {
      citations.push({
        kind: "skill",
        ref: entry.skill.name,
        quote: sibling ? `${entry.skill.name} (${entry.skill.level}), related to ${sibling.term}` : `${entry.skill.name} (${entry.skill.level}), tagged ${tag}`,
        strength: "adjacent",
      });
    }
  }
  return citations;
}

function proseCitations(text: string, terms: readonly TechTerm[], context: EvidenceContext): Array<Citation & { score: number }> {
  const words = significantWords(text);
  const citations: Array<Citation & { score: number }> = [];
  for (const entry of context.prose) {
    const techShared = terms.filter((term) => entry.terms.has(term.term)).length;
    const tagHits = entry.tags.filter((tag) => containsPhrase(text, tag)).length;
    const wordShared = words.filter((word) => entry.words.has(word)).length;
    const direct = techShared >= 1 || tagHits >= 2 || (tagHits >= 1 && wordShared >= 2) || wordShared >= 4;
    const adjacent = tagHits >= 1 || wordShared >= 2;
    if (!direct && !adjacent) continue;
    citations.push({
      kind: entry.kind,
      ref: entry.ref,
      quote: shortQuote(entry.text),
      strength: direct ? "direct" : "adjacent",
      score: techShared * 3 + tagHits * 2 + wordShared,
    });
  }
  return citations.sort((a, b) => b.score - a.score);
}

function yearsCitation(text: string, context: EvidenceContext): { citation: Citation | null; note?: string; tier: EvidenceTier } | null {
  const required = extractRequiredYears(text);
  if (required.minYears === null) return null;
  const held = context.candidateYears;
  const quote = `${held} years of professional experience (profile.experience)`;
  if (held >= required.minYears) return { citation: { kind: "years", ref: "profile.experience", quote, strength: "direct" }, tier: "direct" };
  if (required.minYears - held <= context.toleranceYears) {
    return { citation: { kind: "years", ref: "profile.experience", quote, strength: "adjacent" }, tier: "adjacent", note: `asks for ${required.minYears}+ years; within tolerance` };
  }
  return { citation: null, tier: "none", note: `asks for ${required.minYears}+ years; the profile shows ${held}` };
}

function degreeAspect(text: string, context: EvidenceContext): { citation: Citation | null; tier: EvidenceTier; note?: string } {
  const degrees = context.profile.education;
  if (degrees.length === 0) {
    if (EQUIVALENT.test(text) && context.candidateYears >= 4) {
      return {
        citation: { kind: "years", ref: "profile.experience", quote: `${context.candidateYears} years of experience as the stated equivalent`, strength: "adjacent" },
        tier: "adjacent",
        note: "no degree recorded; the posting accepts equivalent experience",
      };
    }
    return { citation: null, tier: "none", note: "no degree recorded in profile.education" };
  }
  const GENERIC = new Set(["bachelor", "bachelors", "master", "masters", "science", "sciences", "arts", "degree", "doctor", "philosophy", "diploma", "honours", "honors", "associate", "applied"]);
  const fieldMatch = degrees.find((degree) =>
    significantWords(`${degree.credential} ${degree.field}`).some((word) => !GENERIC.has(word) && containsPhrase(text, word)),
  );
  const chosen = fieldMatch ?? degrees[0]!;
  // A degree in an unnamed field satisfies any degree; a named field needs a match.
  const namesField = /\b(?:in|of)\s+(?:a\s+)?(?:computer|software|electrical|engineering|mathematics|math|physics|statistics|science|information|data|cyber)/i.test(text);
  const strength = fieldMatch || !namesField ? "direct" : "adjacent";
  return {
    citation: {
      kind: "education",
      ref: chosen.institution,
      quote: shortQuote(`${chosen.credential}${chosen.field ? `, ${chosen.field}` : ""} (${chosen.institution})`),
      strength,
    },
    tier: strength,
  };
}

function authorizationCitation(context: EvidenceContext): { citation: Citation | null; note: string } {
  const auth = context.profile.workAuthorization;
  const country = context.jobCountry;
  if (auth.authorizedIn.map((code) => code.toUpperCase()).includes(country)) {
    return { citation: { kind: "authorization", ref: "workAuthorization.authorizedIn", quote: `authorized in ${country}`, strength: "direct" }, note: "" };
  }
  if (auth.noSponsorshipRequiredIn.map((code) => code.toUpperCase()).includes(country)) {
    return {
      citation: { kind: "authorization", ref: "workAuthorization.noSponsorshipRequiredIn", quote: `can work in ${country} without sponsorship`, strength: "adjacent" },
      note: "authorization through a route that needs no sponsorship; a person must confirm it fits this wording",
    };
  }
  return { citation: null, note: `profile.workAuthorization does not cover ${country === "UNKNOWN" ? "this location" : country}` };
}

const ORDER: Readonly<Record<EvidenceTier, number>> = { direct: 2, adjacent: 1, none: 0 };
const weakest = (a: EvidenceTier, b: EvidenceTier): EvidenceTier => (ORDER[a] <= ORDER[b] ? a : b);
const strongest = (citations: readonly Citation[]): EvidenceTier =>
  citations.some((citation) => citation.strength === "direct") ? "direct" : citations.length > 0 ? "adjacent" : "none";

export function evidenceFor(item: Pick<RequirementItem, "text">, context: EvidenceContext): RequirementEvidence {
  const text = item.text;
  if (AUTHORIZATION.test(text)) {
    const { citation, note } = authorizationCitation(context);
    return { tier: citation ? citation.strength : "none", citations: citation ? [citation] : [], ...(note ? { note } : {}) };
  }

  const terms = findKnownTerms(text).map((entry) => entry.term);
  const skills = skillCitations(text, terms, context);
  const prose = proseCitations(text, terms, context);
  let tier = strongest([...skills, ...prose]);

  // Several named technologies joined by "and" are all asked for; evidence for
  // only some of them is adjacent, not direct.
  if (tier === "direct" && terms.length >= 2 && !/\bor\b/i.test(text)) {
    const evidenced = terms.filter(
      (term) =>
        skills.some((citation) => citation.strength === "direct" && (lookupTerm(citation.ref)?.term === term.term || containsPhrase(citation.ref, term.term))) ||
        prose.some((citation) => citation.strength === "direct" && context.prose.some((entry) => entry.ref === citation.ref && entry.terms.has(term.term))),
    ).length;
    if (evidenced < terms.length) tier = "adjacent";
  }

  const citations: Citation[] = [...skills, ...prose.map(({ score: _score, ...citation }) => citation)];
  let note: string | undefined;

  // A requirement can bundle several asks ("BS in CS and 5+ years with Go"):
  // each present aspect is judged and the weakest decides. Content counts as
  // an aspect when technologies are named, or when there is nothing else.
  const years = yearsCitation(text, context);
  const degree = DEGREE.test(text) ? degreeAspect(text, context) : null;
  const aspects: EvidenceTier[] = terms.length > 0 || (!years && !degree) ? [tier] : [];
  if (years) {
    if (years.citation) citations.unshift(years.citation);
    if (years.note) note = years.note;
    aspects.push(years.tier);
  }
  if (degree) {
    if (degree.citation) citations.unshift(degree.citation);
    if (degree.note) note = note ? `${note}; ${degree.note}` : degree.note;
    aspects.push(degree.tier);
  }
  tier = aspects.reduce(weakest, "direct");

  const ordered = citations.sort((a, b) => ORDER[b.strength] - ORDER[a.strength]).slice(0, 3);
  return { tier, citations: ordered, ...(note ? { note } : {}) };
}
