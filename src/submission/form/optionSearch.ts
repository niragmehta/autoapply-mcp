import type { DraftAnswer } from "../../domain/job.js";
import { skillSearches } from "../../drafting/skillsAnswer.js";
import { isRecruitingSourceLabel } from "../sourceQuestion.js";
import { DECLINE_ANSWER_PATTERN, DECLINE_OPTION_CANDIDATES } from "./answerVocabulary.js";
import { asksResidenceOrRelocation } from "./compatibility.js";
import { normalizeLabel, type FieldDescriptor } from "./fieldModel.js";
import { TRUNCATED_LABEL_MIN_LENGTH, answerValueForField } from "./matching.js";
import { AFFIRMATIVE_CANDIDATE, NEGATIVE_CANDIDATE, normalizeOptionText } from "./optionMatching.js";

/**
 * The page extractor keeps a Greenhouse label to its first 200 characters,
 * which can cut off the words that say what a question asks: Justworks'
 * education question ended at "...Please select the highest level of", so the
 * degree wording was never offered and a required select failed while the
 * accurate answer sat in the packet. Where the drafted answer carries that
 * question in full - the cut label is the start of its own text - the option
 * search reads the full question. Short labels are never treated as cut.
 */
function withFullQuestion(field: FieldDescriptor, answer: DraftAnswer): FieldDescriptor {
  const fieldLabel = normalizeLabel(field.label);
  const answerLabel = normalizeLabel(answer.label);
  const cut =
    fieldLabel.length >= TRUNCATED_LABEL_MIN_LENGTH && answerLabel.length > fieldLabel.length && answerLabel.startsWith(fieldLabel);
  return cut ? { ...field, label: answer.label } : field;
}

/** Ordered search strings to try when driving a typeahead combobox. */
export function optionSearchCandidates(pageField: FieldDescriptor, answer: DraftAnswer, employer?: string): string[] {
  const field = withFullQuestion(pageField, answer);
  if (DECLINE_ANSWER_PATTERN.test(answer.answer.trim())) {
    // Every decline wording is tried first; the stored value is reached only
    // when the form offers no way to decline at all. An optional field is
    // declined by leaving it blank.
    const fallback = field.required ? answer.whenNoDecline?.trim() : undefined;
    return fallback ? [...DECLINE_OPTION_CANDIDATES, fallback] : [...DECLINE_OPTION_CANDIDATES];
  }
  const value = answerValueForField(field, answer);
  const skills = skillSearches(answer.citation, value);
  if (skills.length > 0) return skills;
  const veteran = veteranCandidates(value);
  if (veteran.length > 0) return veteran;
  const source = sourceCandidates(field, value, employer);
  if (source.length > 0) return source;
  const degree = degreeCandidates(field, value);
  if (degree.length > 0) return degree;
  const major = majorCandidates(field, value);
  if (major.length > 0) return major;
  const month = monthCandidates(value);
  if (month.length > 0) return month;
  const productUsage = productUsageCandidates(field, value);
  if (productUsage.length > 0) return productUsage;
  const acknowledgement = acknowledgementCandidates(field, value);
  if (acknowledgement.length > 0) return acknowledgement;
  const relocation = relocationCandidates(field, value);
  if (relocation.length > 0) {
    // Brex offers "Yes, I live here" beside "Yes, I plan to relocate". A bare
    // "Yes" tried first reads both, and the shorter one - a claim to live there
    // already - won. Where relocating satisfies the question, its wording leads.
    const relocationFirst = /^(yes|true|1)$/i.test(value.trim()) && asksResidenceOrRelocation(normalizeLabel(field.label));
    return relocationFirst ? [...relocation, value] : [value, ...relocation];
  }
  const onsite = onsiteCandidates(field, value);
  if (onsite.length > 0) return onsite;
  const optChoice = optChoiceCandidates(field, value);
  if (optChoice.length > 0) return optChoice;
  const authorization = authorizationStatementCandidates(field, value);
  if (authorization.length > 0) return authorization;
  // Split at a list comma only: "Around USD 222,480 base" cut at its thousands
  // separator became "Around USD 222", a figure that landed in CVS Health's
  // "Under $20,000" pay band.
  const locality = value.split(/,(?!\d)/)[0]?.trim() ?? "";
  if (/^no$/i.test(value.trim()) && ASKS_WHAT_IS_KNOWN.test(normalizeLabel(field.label))) {
    return [value, ...HEDGED_NEGATIVE_CANDIDATES];
  }
  return locality.length > 1 && locality !== value ? [value, locality] : [value];
}

/**
 * A no the form words as a hedge. Nike asks whether he will work with an
 * employee he has a close personal relationship with and offers only "Yes"
 * and "Not to my knowledge". A hedged no claims less than the stored no, never
 * more, so it is tried only after the plain word, and only where the question
 * is about relationships or awareness - a hedge would read oddly on a
 * question of fact such as work authorization.
 */
const ASKS_WHAT_IS_KNOWN =
  /\b(?:relationships?|related|relatives?|family|familial|know|knowledge|aware|acquainted|conflicts? of interest)\b/;
const HEDGED_NEGATIVE_CANDIDATES = ["Not to my knowledge", "Not that I know of", "None to my knowledge", "None that I know of"] as const;

/**
 * The approved work-authorization answer is a sentence - "I am authorized to
 * work for any employer in the country in which this position is based." -
 * written for boards that offer it as an option. Flexera's Workday asks "Are you
 * eligible to work for any employer in the country ...?" with only Yes and No,
 * and the sentence opened with neither. Where the question asks about being
 * authorized or eligible to work, and not about sponsorship, the statement's
 * own polarity is the answer.
 */
const AUTHORIZATION_QUESTION = /\b(?:authori[sz]ed|eligible|eligibility|permitted|entitled|legally able)\b.*\bwork\b|\bwork authori[sz]ation\b/;
const AUTHORIZED_STATEMENT = /^i am (?:legally )?(?:authori[sz]ed|eligible|permitted|entitled) to work\b/i;
const NOT_AUTHORIZED_STATEMENT = /^i am not (?:legally )?(?:authori[sz]ed|eligible|permitted|entitled) to work\b/i;

function authorizationStatementCandidates(field: FieldDescriptor, value: string): string[] {
  const label = normalizeLabel(field.label);
  if (!AUTHORIZATION_QUESTION.test(label) || /\bsponsor/.test(label)) return [];
  const stated = value.trim();
  if (NOT_AUTHORIZED_STATEMENT.test(stated)) return [value, "No"];
  if (AUTHORIZED_STATEMENT.test(stated)) return [value, "Yes"];
  return [];
}

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/**
 * Employment-history blocks render the month as a closed list, and boards do
 * not agree on how to write it: "February", "Feb", "02" and "2" all occur. The
 * profile states a month, so offer every spelling of that same month rather
 * than leaving a required select empty. Nothing here changes which month is
 * being claimed.
 */
function monthCandidates(value: string): string[] {
  const index = MONTH_NAMES.indexOf(normalizeLabel(value) as (typeof MONTH_NAMES)[number]);
  const name = MONTH_NAMES[index];
  if (!name) return [];
  const padded = String(index + 1).padStart(2, "0");
  return [value, name.slice(0, 3), padded, String(index + 1)];
}

const DEGREE_QUESTION = /\b(degree|level of education|education level|highest (?:level of )?education)\b/;

const PRODUCT_USAGE_QUESTION = /\bhave you (?:ever )?used\b|\bare you a (?:user|customer) of\b|\bdo you use\b/;

/**
 * "Have you used our product?" is rarely a yes/no list. Tailscale offers three
 * flavours of yes and "I haven't used it, but I'm excited to learn more!", so a
 * stored "No" matched nothing and blocked a required field. Offer phrasings of
 * the same negative answer so the honest option is reachable. Only the negative
 * is expanded: a stored "Yes" is never widened into a claim about where or how
 * the product was used.
 */
function productUsageCandidates(field: FieldDescriptor, value: string): string[] {
  if (!PRODUCT_USAGE_QUESTION.test(normalizeLabel(field.label))) return [];
  if (!/^(?:no|not yet|never)\b/i.test(value.trim())) return [];
  return [value, "I have not used it", "I haven't used it", "Have not used", "Not yet", "No"];
}

const NOTICE_QUESTION = /\b(notice|policy|privacy|terms|acknowledg\w*|disclosure|statement)\b/;

/**
 * A notice is acknowledged in the employer's words rather than with "Yes":
 * Unity's Global Data Privacy Notice offers only "Acknowledged" and "Not
 * Acknowledged", so the approved "Yes" led neither option and a required field
 * held the wizard at step 3. Sony's at-will notice offers "Yes, I understand"
 * and "No", and stating that a notice was understood is the same assent. Only
 * an affirmative answer is expanded, and only into acknowledgement or
 * understanding - the weakest forms of assent - never into agreeing or
 * consenting, which say more than the candidate approved.
 */
function acknowledgementCandidates(field: FieldDescriptor, value: string): string[] {
  if (!NOTICE_QUESTION.test(normalizeLabel(field.label))) return [];
  if (!AFFIRMATIVE_CANDIDATE.test(normalizeOptionText(value))) return [];
  return [value, "Acknowledged", "I Acknowledge", "Acknowledge", "I understand", "Understood"];
}

/**
 * Boards render the degree field as a closed list in the platform's own
 * vocabulary ("Bachelor's Degree"), while a profile states the credential as
 * awarded ("Bachelor of Science (BSc)"). Neither string contains the other, so
 * an accurate answer found no option at all. Walk from the exact credential to
 * the platform's wording for the same level, most specific first, so nothing
 * broader than the degree actually held is ever selected.
 */
function degreeCandidates(field: FieldDescriptor, value: string): string[] {
  if (!DEGREE_QUESTION.test(normalizeLabel(field.label))) return [];
  const normalized = normalizeOptionText(value);
  const level = DEGREE_LEVELS.find((entry) => entry.test.test(normalized));
  return level ? [value, ...level.candidates] : [];
}

const MASTERS_WORDING = ["Master's Degree", "Masters Degree", "Master's", "Masters", "Master"] as const;
// HP's Workday spells the level "Bachelors (±16 years of education)", which
// neither "Bachelor's" nor the whole word "Bachelor" matches.
const BACHELORS_WORDING = ["Bachelor's Degree", "Bachelors Degree", "Bachelor's", "Bachelors", "Bachelor"] as const;

/**
 * Some boards list only abbreviations - Snap's Workday offers "B.A.", "B.S.",
 * "M.A.", "M.S." and nothing spelled out - so each level also carries the
 * abbreviation for its own discipline. A science degree is never offered the
 * arts abbreviation, nor the reverse, and an applied-science degree counts as
 * science. The platform's spelled-out wording is still tried first.
 */
const DEGREE_LEVELS: ReadonlyArray<{ test: RegExp; candidates: readonly string[] }> = [
  {
    test: /\b(phd|ph d|doctor of philosophy|doctorate|doctoral)\b/,
    candidates: ["Doctor of Philosophy (Ph.D.)", "Doctorate", "Ph.D.", "PhD"],
  },
  {
    test: /\bm b a\b|\bmba\b|master of business administration/,
    candidates: ["Master of Business Administration (M.B.A.)", "MBA", "Master's Degree"],
  },
  {
    test: /\b(m sc|msc|m s|m a sc|masc|master of (?:applied )?science)\b/,
    candidates: [...MASTERS_WORDING.slice(0, 2), "Master of Science", ...MASTERS_WORDING.slice(2), "M.S.", "M.Sc.", "MSc", "MS"],
  },
  {
    test: /\b(m a|master of arts)\b/,
    candidates: [...MASTERS_WORDING.slice(0, 2), "Master of Arts", ...MASTERS_WORDING.slice(2), "M.A.", "MA"],
  },
  {
    test: /\b(masters?|m eng|meng|master of)\b/,
    candidates: MASTERS_WORDING,
  },
  {
    test: /\b(b sc|bsc|b s|b a sc|basc|bachelor of (?:applied )?science)\b/,
    candidates: [...BACHELORS_WORDING.slice(0, 2), "Bachelor of Science", ...BACHELORS_WORDING.slice(2), "B.S.", "B.Sc.", "BSc", "BS"],
  },
  {
    test: /\b(b a|ba|bachelor of arts)\b/,
    candidates: [...BACHELORS_WORDING.slice(0, 2), "Bachelor of Arts", ...BACHELORS_WORDING.slice(2), "B.A.", "BA"],
  },
  {
    test: /\b(bachelors?|b eng|beng|bachelor of)\b/,
    candidates: BACHELORS_WORDING,
  },
  {
    test: /\b(associates?|a a|a s)\b/,
    candidates: ["Associate's Degree", "Associates Degree", "Associate's"],
  },
  {
    test: /\bhigh school|secondary school|ged\b/,
    candidates: ["High School", "High School Diploma", "GED"],
  },
];

const MAJOR_QUESTION = /\b(field of study|area of study|course of study|discipline|major|concentration|specialization)\b/;

/**
 * A field-of-study list names disciplines in its own taxonomy: Adobe's offers
 * "Computer Science, General" and Snap's "Computer and Information Science",
 * and neither has a plain "Computer Science". Offer the names the same
 * discipline is catalogued under, including the Computer and Information
 * Sciences category that contains it, but never a neighbouring discipline such
 * as Computer Engineering or Information Technology, which was not studied.
 */
const MAJOR_SYNONYMS: ReadonlyArray<{ test: RegExp; candidates: readonly string[] }> = [
  {
    test: /^(computer science|computer sciences|computing science|comp sci)$/,
    candidates: [
      "Computer Science",
      "Computer Science, General",
      "Computing Science",
      "Computer Sciences",
      "Computer and Information Science",
      "Computer and Information Sciences",
      "Computer and Information Sciences, General",
    ],
  },
];

function majorCandidates(field: FieldDescriptor, value: string): string[] {
  if (!MAJOR_QUESTION.test(normalizeLabel(field.label))) return [];
  const normalized = normalizeOptionText(value);
  const entry = MAJOR_SYNONYMS.find((item) => item.test.test(normalized));
  return entry ? [value, ...entry.candidates.filter((name) => name !== value)] : [];
}

/**
 * "How did you hear about us?" is a closed list that differs on every board, and
 * the preferred answer is frequently absent — Notion offers neither "Friend" nor
 * a generic "Referral". Rather than leave a required question blank, walk the
 * candidate's stated order of preference until an option exists.
 *
 * The walk never climbs to a stronger or different claim than the approved
 * answer already makes. A generic "Referral" candidate substring-matches
 * Zoox's "Employee Referral" option, so an approved "Careers page" answer was
 * selecting an employee referral that never happened. Friend and referral
 * options are therefore offered only when the approved answer itself states
 * one, and a named channel such as LinkedIn is never offered in place of the
 * approved answer. The fallbacks are impersonal wordings and "Other". They also
 * stand in for an approved named channel that the board does not list, so an
 * approved "LinkedIn" can land on "Careers page": the candidate's stated order
 * (Friend > Referral > Careers page > LinkedIn) ranks the careers page higher.
 *
 * An employer's own site is the same channel as its careers page, in the
 * employer's words. Adobe offers no generic careers-page option: its site is
 * "Adobe.com", filed under "Adobe Source". So an approved careers-page answer
 * also tries the employer's domain and its careers-site wordings, right after
 * the approved wording itself. The bare employer name is never offered - it
 * matches "Adobe MAX" and "Adobe Recruiting Team" as readily as the site.
 *
 * "Career site" is the impersonal name Workday tenants give that channel.
 * Salesforce's single-select offers only "Current or Former Employee",
 * "External Career Site Sources" and "Referral" at its top level, and no
 * careers-page wording shares a word with any of them, so the category holding
 * the employer's site was never opened.
 */
const SOCIAL_SOURCE_PATTERN = /\b(friend|referr|colleague|employee|recruiter|word of mouth)\b/i;
const OWN_SITE_SOURCE = /\b(careers?|company (?:website|site)|website)\b/i;

const IMPERSONAL_SOURCE_CANDIDATES = [
  "Careers page",
  "Career site",
  "Careersite",
  // Bio-Techne offers "Career Websites", and Nasdaq "Career Websites and Job
  // Boards"; the plural is no whole-word match for "Website".
  "Career Websites",
  "Company website",
  "Website",
  "Job board",
  "Job posting",
  "Other",
] as const;

function sourceCandidates(field: FieldDescriptor, value: string, employer?: string): string[] {
  if (!isRecruitingSourceLabel(normalizeLabel(field.label))) return [];
  if (SOCIAL_SOURCE_PATTERN.test(value)) {
    return [value, "Friend", "Referral", ...IMPERSONAL_SOURCE_CANDIDATES];
  }
  const ownSite = OWN_SITE_SOURCE.test(value) ? [...employerSiteCandidates(employer), ...CORPORATE_SITE_CANDIDATES] : [];
  return [value, ...ownSite, ...IMPERSONAL_SOURCE_CANDIDATES];
}

/**
 * The employer's own site in the company's own words. Equifax lists "Corporate
 * Site" among job boards and social networks, and none of the careers-page
 * wordings shares a whole word with it.
 */
const CORPORATE_SITE_CANDIDATES = ["Corporate Site", "Corporate Website", "Corporate Careers"] as const;

function employerSiteCandidates(employer?: string): string[] {
  const name = employer?.trim() ?? "";
  const compact = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact.length < 2) return [];
  return [
    `${compact}.com`,
    `${name} Careers`,
    `${name} Careers Page`,
    `${name} Careers Website`,
    `${name} Career Site`,
    // Netflix files its careers page as "Netflix Careersite", one word, which
    // shares no whole word with "Careers" or "Career Site".
    `${name} Careersite`,
    `${name} Website`,
  ];
}

/**
 * Boards ask about military service either in EEOC "protected veteran" terms or
 * as a plain "have you served?" question. These phrasings all assert the same
 * fact, so an approved not-a-protected-veteran answer can select any of them.
 */
function veteranCandidates(value: string): string[] {
  if (!/^i am not a protected veteran$/i.test(value.trim())) return [];
  return [
    "I am not a protected veteran",
    "I am not a veteran",
    "not a veteran",
    "I have not served in the military",
    "No",
  ];
}

/**
 * Some boards replace Yes/No on relocation questions with full sentences such
 * as "I am willing to relocate to this job's location." Offer the phrase so an
 * approved yes/no answer still selects the truthful option.
 */
/**
 * Relocation questions are rarely a yes/no list. Lyft offers three sentences,
 * none of which is "Yes", so a stored decision reached none of them.
 *
 * The affirmative candidate carries "am" deliberately: "willing to relocate" is
 * a substring of "I am **not** willing to relocate before starting employment.",
 * so the looser phrase could select the exact opposite of the stored answer.
 * "am willing to relocate" cannot match the negated sentence.
 *
 * Nothing here widens a stored answer into a claim about where the candidate
 * already lives - an option such as "I already reside within commutable
 * distance" is a statement of fact the profile has not made.
 */
function relocationCandidates(field: FieldDescriptor, value: string): string[] {
  // A relocation question does not always say so in its label. Abridge asks
  // "Where in the United States will you be working from?" and puts the
  // decision in the options ("I am willing to relocate within 6 months"), so
  // reading the label alone left a required question unanswerable. The option
  // text is part of the question being asked, so it counts too.
  // "relocating" does not contain "relocate", so match the shared stem.
  const haystack = `${normalizeLabel(field.label)} ${normalizeOptionText(field.optionLabel ?? "")}`;
  if (!haystack.includes("relocat")) return [];
  // "open to relocation" and "plan to relocate" are safe for the same reason as
  // "am willing to relocate": the negated forms put "not" in front of them,
  // which optionNegatesCandidate rejects.
  if (/^(yes|true|1)$/i.test(value.trim())) {
    return ["am willing to relocate", "open to relocating", "open to relocation", "plan to relocate"];
  }
  if (/^(no|false|0)$/i.test(value.trim())) return ["not willing to relocate", "not open to relocating"];
  return [];
}

const ONSITE_QUESTION = /\b(?:on ?site|office|in person|hybrid)\b/;

/**
 * Nordstrom answers its onsite question with "I am able to meet the onsite
 * requirements for the role" or "I am unable to ...", so a stored "Yes"
 * matched neither and a required field held the Workday wizard. The
 * affirmative phrases open with "am" or "can" for the reason relocation's do:
 * "able to meet" sits inside "unable to meet", while "am able to meet" does
 * not, and "can work" is not part of "cannot work".
 */
function onsiteCandidates(field: FieldDescriptor, value: string): string[] {
  if (!ONSITE_QUESTION.test(normalizeLabel(field.label))) return [];
  if (/^(yes|true|1)$/i.test(value.trim())) {
    return [
      value,
      "am able to meet the onsite",
      "am able to meet the on site",
      "am able to work onsite",
      "am able to work on site",
      "can work onsite",
      "can work on site",
      "am willing to work onsite",
      "am willing to work on site",
    ];
  }
  if (/^(no|false|0)$/i.test(value.trim())) {
    return [
      value,
      "am unable to meet the onsite",
      "am unable to meet the on site",
      "am not able to meet the onsite",
      "am unable to work onsite",
      "am not able to work onsite",
      "cannot work onsite",
      "cannot work on site",
    ];
  }
  return [];
}

/** A question that offers opting in or out, in any of its spellings. */
const OPT_QUESTION = /\bopt ?(?:in|out)\b/;
/** A question asking whether to opt out, where "No" means staying opted in. */
const ASKS_TO_OPT_OUT = /\b(?:like|want|wish|prefer|choose|elect)s? to opt ?out\b/;

/**
 * Visa answers consent questions with "Opt-In" and "Opt-Out" instead of Yes and
 * No, so stored consent decisions - "Yes" to AI-assisted review, "No - I do not
 * consent to receiving text messages" - matched neither option. A stored
 * consent opts in and a stored refusal opts out. Only a question that speaks
 * of opting is widened, so other yes/no prompts are not probed for options
 * they never offer, and one that itself asks whether to opt out inverts the
 * mapping, so it is left alone.
 */
function optChoiceCandidates(field: FieldDescriptor, value: string): string[] {
  const label = normalizeLabel(field.label);
  if (!OPT_QUESTION.test(label) || ASKS_TO_OPT_OUT.test(label)) return [];
  const normalized = normalizeOptionText(value);
  if (AFFIRMATIVE_CANDIDATE.test(normalized)) return [value, "Opt-In", "Opt In", "I opt in"];
  if (NEGATIVE_CANDIDATE.test(normalized)) return [value, "Opt-Out", "Opt Out", "I opt out"];
  return [];
}
