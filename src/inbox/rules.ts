/**
 * Phrase rules for classifying an employer's reply.
 *
 * Each rule is a phrase family with a weight: how strongly that wording alone
 * indicates the kind. Weights combine as independent evidence, so two
 * moderate cues outweigh one, but no pile of weak cues reaches certainty.
 *
 * Positive wording is checked for negation in its own clause: "we'd like to
 * move forward" is a step on, "we are not able to move forward" is a
 * rejection. Rejection wording carries its negation inside the pattern.
 */

export type ScoredKind =
  | "rejected"
  | "acknowledged"
  | "assessment"
  | "recruiter_screen"
  | "interview"
  | "offer"
  | "withdrawn"
  | "noise";

export type PhraseRule = {
  kind: ScoredKind;
  pattern: RegExp;
  weight: number;
  /** Ignore a match preceded by a negation in the same clause. */
  guardNegation?: boolean;
  /** The message carries a credential (a one-time code or sign-in link): never keep its text. */
  sensitive?: boolean;
};

const NOT = "(?:\\bnot|n't)";

const rule = (kind: ScoredKind, pattern: RegExp, weight: number, extra: Partial<PhraseRule> = {}): PhraseRule => ({
  kind,
  pattern,
  weight,
  ...extra,
});
const positive = (kind: ScoredKind, pattern: RegExp, weight: number): PhraseRule =>
  rule(kind, pattern, weight, { guardNegation: true });

const REJECTED: PhraseRule[] = [
  rule(
    "rejected",
    new RegExp(
      `${NOT}\\s+(?:be\\s+)?(?:able\\s+to\\s+)?(?:moving|move|proceeding|proceed|progressing|progress|advancing|advance|going\\s+to\\s+(?:move|proceed))\\s+(?:forward|ahead|further)\\b`,
    ),
    0.85,
  ),
  rule("rejected", /\b(?:unable|decided not|chosen not|elected not|not in a position)\s+to\s+(?:move|proceed|progress|advance|continue)\b/, 0.85),
  rule(
    "rejected",
    /\b(?:move|moving|proceed|proceeding|go|going)\s+(?:forward|ahead)\s+with\s+(?:other|another|a different|different|more)\s+(?:\w+\s+)?(?:candidates?|applicants?|individuals?|people|profiles?)\b/,
    0.85,
  ),
  rule(
    "rejected",
    /\b(?:pursue|pursuing|consider|considering|focus on|focusing on|selected|select|chose|chosen|hired|offered the (?:role|position) to)\s+(?:other|another|a different|different|more qualified|a more qualified)\s+(?:candidates?|applicants?|individuals?)\b/,
    0.8,
  ),
  rule("rejected", /\b(?:position|role|job|opening|requisition|req|vacancy)\s+(?:you applied (?:for|to)\s+)?(?:has|have|had|is)\s+(?:now\s+|already\s+)?(?:been\s+)?(?:filled|closed|cancel+ed|put on hold|withdrawn)\b/, 0.75),
  rule("rejected", /\b(?:has|have)\s+(?:now\s+|already\s+)?been\s+filled\b/, 0.6),
  rule("rejected", /\b(?:position|role|job|opening)\s+is\s+no\s+longer\s+(?:available|open)\b/, 0.7),
  rule("rejected", new RegExp(`${NOT}\\s+(?:been\\s+)?selected\\b`), 0.8),
  rule("rejected", /\bno\s+longer\s+(?:be\s+)?(?:being\s+)?(?:under\s+consideration|consider(?:ed|ing)\s+(?:you|your))\b/, 0.8),
  rule("rejected", new RegExp(`${NOT}\\s+(?:be\\s+)?consider(?:ed|ing)\\s+(?:you|your)\\s+(?:candidacy|application)`), 0.75),
  rule("rejected", /\b(?:regret|sorry)\s+to\s+(?:inform|let you know|tell you|share|advise)\b/, 0.6),
  rule("rejected", new RegExp(`${NOT}\\s+(?:a|the right|the best|an ideal|a good|a strong)\\s+(?:fit|match)\\b`), 0.7),
  rule("rejected", /\b(?:unable|not able|not in a position)\s+to\s+offer\s+you\b/, 0.85),
  rule("rejected", new RegExp(`${NOT}\\s+(?:be\\s+)?(?:extending|making|offering)\\s+(?:you\\s+)?(?:an?\\s+)?offer\\b`), 0.85),
  rule("rejected", /\bother\s+(?:candidates?|applicants?)\s+whose\s+(?:experience|qualifications|background|skills|profiles?)\b/, 0.7),
  rule("rejected", /\b(?:more|better|most)\s+closely\s+(?:align|aligns|aligned|match|matches|matched|fit|fits)\b/, 0.6),
  rule("rejected", /\bdecided\s+to\s+(?:go|move)\s+(?:in\s+)?(?:a\s+)?different\s+direction\b/, 0.8),
  rule("rejected", /\b(?:have|has)\s+decided\s+not\s+to\b/, 0.6),
  rule("rejected", /\bunfortunately\b/, 0.35),
  rule("rejected", /\bafter\s+(?:careful|thorough|much)\s+(?:consideration|review|deliberation)\b/, 0.3),
  rule("rejected", /\b(?:wish|wishing)\s+you\s+(?:the\s+)?(?:very\s+)?(?:best|success|luck|well)\b/, 0.3),
  rule("rejected", /\bkeep\s+(?:your\s+)?(?:resume|cv|profile|application|information|details)\s+on\s+file\b/, 0.3),
];

const ACKNOWLEDGED: PhraseRule[] = [
  rule("acknowledged", /\bthank(?:s| you)\s+(?:so much\s+)?for\s+(?:applying|your application|submitting your application|your recent application)\b/, 0.6),
  rule("acknowledged", /\b(?:we(?:'ve| have)?\s+)?(?:successfully\s+)?received\s+your\s+(?:job\s+)?application\b/, 0.7),
  rule("acknowledged", /\bapplication\s+(?:has\s+been|was)\s+(?:successfully\s+)?(?:received|submitted|sent)\b/, 0.7),
  rule("acknowledged", /\bapplication\s+(?:received|confirmation|submitted)\b/, 0.5),
  rule("acknowledged", /\bsuccessfully\s+(?:submitted|applied)\b/, 0.6),
  rule("acknowledged", /\bthank(?:s| you)\s+for\s+(?:your\s+)?interest\s+in\b/, 0.35),
  rule(
    "acknowledged",
    /\b(?:we|our\s+(?:team|recruiters?|recruiting team|hiring team))\s+(?:will|'ll)\s+(?:carefully\s+)?review\s+(?:your|the)\s+(?:application|resume|qualifications|background|profile|materials)\b/,
    0.45,
  ),
  rule("acknowledged", /\bif\s+(?:your|you(?:r)?)\s+(?:experience|background|qualifications|skills|profile)\s+(?:is|are|seems?|matches|match|aligns?)\b/, 0.4),
  rule("acknowledged", /\b(?:we(?:'ll| will)\s+be\s+in\s+touch|(?:will|we'll)\s+(?:reach out|contact you|get back to you)\s+(?:if|should|when))\b/, 0.4),
];

const ASSESSMENT: PhraseRule[] = [
  positive("assessment", /\b(?:hackerrank|codesignal|codility|karat|testgorilla|coderbyte|byteboard|qualified\.io|criteria corp|mettl|imocha)\b/, 0.6),
  positive("assessment", /\bhirevue\b/, 0.5),
  positive("assessment", /\bonline\s+(?:assessment|test|coding\s+(?:test|challenge|exercise))\b/, 0.75),
  positive("assessment", /\btake[- ]?home\b/, 0.7),
  positive("assessment", /\bcoding\s+(?:challenge|assessment|exercise|test|assignment)\b/, 0.75),
  positive("assessment", /\b(?:technical|skills?|programming|engineering)\s+(?:assessment|test|challenge|exercise)\b/, 0.6),
  positive("assessment", /\b(?:complete|completing|take|start)\s+(?:the|this|your|an?|our)\s+(?:\w+\s+)?(?:assessment|test|challenge|exercise)\b/, 0.6),
  positive("assessment", /\bassessment\s+(?:link|invitation|invite|instructions)\b/, 0.6),
  positive("assessment", /\bwork\s+sample\b/, 0.5),
];

const RECRUITER_SCREEN: PhraseRule[] = [
  positive("recruiter_screen", /\bphone\s+(?:screen|screening|interview|call|conversation)\b/, 0.75),
  positive(
    "recruiter_screen",
    /\b(?:recruiter|recruiting|initial|intro|introductory|preliminary|exploratory|first)\s+(?:phone\s+|video\s+)?(?:call|chat|conversation|screen|screening)\b/,
    0.7,
  ),
  positive("recruiter_screen", /\b(?:quick|brief|short|informal)\s+(?:[\w-]+\s+){0,2}(?:call|chat|conversation)\b/, 0.55),
  positive("recruiter_screen", /\b(?:15|20|25|30|45)[- ]?(?:minute|min)\s+(?:call|chat|conversation|phone|video|zoom|meeting|screen)\b/, 0.6),
  positive("recruiter_screen", /\bschedule\s+(?:a|an|some)?\s*(?:time|call|chat|conversation)\b/, 0.6),
  positive("recruiter_screen", /\b(?:set up|find|book|grab)\s+(?:a\s+|some\s+)?(?:[\w-]+\s+){0,2}(?:time|call|chat)\b/, 0.5),
  positive("recruiter_screen", /\blearn\s+more\s+about\s+(?:you|your\s+(?:background|experience))\b/, 0.45),
  positive(
    "recruiter_screen",
    /\b(?:calendly\.com|goodtime\.io|cal\.com|calendar link|scheduling link|pick a time|select a time|choose a time|book a time|time that works)\b/,
    0.45,
  ),
  positive("recruiter_screen", /\bavailability\b/, 0.3),
  positive("recruiter_screen", /\b(?:would|'d)\s+(?:love|like)\s+to\s+(?:connect|chat|speak|talk|learn more about (?:you|your background))\b/, 0.55),
  positive("recruiter_screen", /\b(?:move|moving)\s+(?:you\s+)?forward\b(?!\s+with\s+(?:other|another|a different|different|more)\b)/, 0.4),
  positive("recruiter_screen", /\bnext\s+steps?\b/, 0.25),
];

const INTERVIEW: PhraseRule[] = [
  positive("interview", /\binvit\w*\s+(?:you\s+)?(?:to\s+)?(?:an?\s+|the\s+|your\s+)?(?:\w+\s+){0,2}interviews?\b/, 0.75),
  positive("interview", /\b(?:schedule|scheduling|set up|arrange|book)\s+(?:an?|your|the|the next|our|a few)?\s*(?:\w+\s+){0,2}interviews?\b/, 0.7),
  positive("interview", /\breschedul\w*\s+(?:your|the|our)\s+(?:\w+\s+)?interview\b/, 0.7),
  positive("interview", /\binterview\s+(?:invitation|invite|request|confirmation|confirmed|scheduled|schedule|details|loop|panel|availability)\b/, 0.7),
  positive("interview", /\bvirtual\s+on-?site\b/, 0.65),
  positive("interview", /\bon-?site\s+(?:interview|loop|round|visit|day)s?\b/, 0.65),
  positive("interview", /\bsuper\s?day\b/, 0.6),
  positive("interview", /\bfinal\s+(?:round|interview|stage)\b/, 0.7),
  positive("interview", /\bnext\s+(?:round|stage)\b/, 0.6),
  positive("interview", /\b(?:technical|system design|coding|behavioral|behavioural|hiring manager|panel|team|virtual|video)\s+interviews?\b/, 0.6),
  positive("interview", /\bhiring\s+manager\s+(?:call|conversation|chat|screen)\b/, 0.6),
  positive("interview", /\bmeet\s+(?:with\s+)?(?:the|our)\s+(?:team|hiring manager|engineering team|engineers)\b/, 0.5),
  positive("interview", /\bpanel\b/, 0.3),
  positive("interview", /\binterview\b/, 0.25),
];

const OFFER: PhraseRule[] = [
  positive("offer", /\boffer\s+letter\b/, 0.8),
  positive("offer", /\b(?:pleased|delighted|excited|happy|thrilled)\s+to\s+(?:formally\s+)?(?:extend|offer|present)\b/, 0.85),
  positive("offer", /\bextend\s+(?:you\s+)?(?:an?\s+|our\s+)?(?:\w+\s+)?offer\b/, 0.8),
  positive("offer", /\b(?:compensation|offer)\s+package\b/, 0.6),
  positive("offer", /\b(?:verbal|formal|written|official)\s+offer\b/, 0.75),
  positive("offer", /\boffer\s+of\s+employment\b/, 0.8),
  positive("offer", /\bcongratulations\b/, 0.25),
  positive("offer", /\b(?:employment agreement|sign(?:ing|-on)\s+bonus|equity\s+grant)\b/, 0.3),
];

const WITHDRAWN: PhraseRule[] = [
  rule("withdrawn", /\byou(?:'ve| have)\s+(?:successfully\s+)?withdrawn\b/, 0.8),
  rule("withdrawn", /\bwithdrawal\s+of\s+your\s+(?:application|candidacy)\b/, 0.7),
  rule("withdrawn", /\byour\s+application\s+(?:has\s+been|was)\s+(?:successfully\s+)?withdrawn\b/, 0.7),
];

const NOISE: PhraseRule[] = [
  rule("noise", /\bjob\s+alerts?\b/, 0.8),
  rule("noise", /\b(?:jobs|roles|positions|opportunities)\s+(?:you\s+(?:may|might)\s+(?:be\s+interested\s+in|like)|for\s+you|matching\s+your)\b/, 0.75),
  rule("noise", /\brecommended\s+(?:jobs|roles|for you)\b/, 0.75),
  rule("noise", /\bsimilar\s+(?:jobs|roles|positions)\b/, 0.5),
  rule("noise", /\bnew\s+(?:jobs?|roles|openings)\s+(?:at|from|posted|matching|for you)\b/, 0.6),
  rule("noise", /\bnewsletter\b/, 0.7),
  rule("noise", /\bwebinar\b/, 0.6),
  rule("noise", /\b(?:\d+%\s+off|discount code|promo code|limited[- ]time offer)\b/, 0.6),
  rule("noise", /\bunsubscribe\b/, 0.15),
  rule("noise", /\bmanage\s+(?:your\s+)?(?:email\s+)?(?:preferences|subscriptions|notifications)\b/, 0.15),
  rule("noise", /\btalent\s+(?:community|network|pool)\b/, 0.3),
  rule("noise", /\b(?:is|are)\s+hiring\b/, 0.4),
  rule("noise", /\bpeople\s+(?:also\s+)?viewed\b/, 0.6),
  rule("noise", /\bwho\s+viewed\s+your\s+profile\b/, 0.7),
  rule("noise", /\b(?:verification|security|one[- ]time|confirmation|sign[- ]in|login)\s+(?:code|passcode|pin)\b/, 0.9, { sensitive: true }),
  rule("noise", /\bverify\s+(?:your\s+)?(?:email|e-mail|account|identity)\b/, 0.85, { sensitive: true }),
  rule("noise", /\b(?:reset|change|set)\s+(?:your\s+)?password\b/, 0.85, { sensitive: true }),
  rule("noise", /\b(?:activate|confirm)\s+(?:your\s+)?(?:candidate\s+)?(?:account|email|e-mail)\b/, 0.8, { sensitive: true }),
  rule("noise", /\b(?:candidate|applicant)\s+(?:account|home|profile)\s+(?:has\s+been\s+|was\s+)?(?:created|activated)\b/, 0.6),
  rule("noise", /\b(?:complete|finish)\s+your\s+(?:profile|application)\b/, 0.5),
];

export const PHRASE_RULES: readonly PhraseRule[] = [
  ...REJECTED,
  ...ACKNOWLEDGED,
  ...ASSESSMENT,
  ...RECRUITER_SCREEN,
  ...INTERVIEW,
  ...OFFER,
  ...WITHDRAWN,
  ...NOISE,
].map((entry) => ({ ...entry, pattern: new RegExp(entry.pattern.source, "gi") }));
