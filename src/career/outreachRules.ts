import type { ContactKind, OutreachChannel } from "./types.js";

/**
 * Per-channel limits and message structures for outreach. The 300-character
 * LinkedIn connection limit and the persona structures follow career-ops
 * modes/contacto.md and modes/email.md (MIT).
 */

export type ChannelLimit = {
  /** Hard ceiling: a longer draft is rejected. */
  maxChars: number;
  /** Soft ceiling: a longer draft is saved with a warning. */
  recommendedMaxChars: number;
  maxWords: number | null;
  subject: "required" | "optional" | "none";
  note: string;
};

export const CHANNEL_LIMITS: Readonly<Record<OutreachChannel, ChannelLimit>> = {
  linkedin_connect: {
    maxChars: 300,
    recommendedMaxChars: 200,
    maxWords: null,
    subject: "none",
    note: "LinkedIn connection notes allow 300 characters; free accounts may be cut off at 200, so stay under 200 when you can.",
  },
  linkedin_message: {
    maxChars: 1900,
    recommendedMaxChars: 700,
    maxWords: 150,
    subject: "optional",
    note: "Readable on a phone: three or four sentences.",
  },
  email: {
    maxChars: 3000,
    recommendedMaxChars: 1500,
    maxWords: 300,
    subject: "required",
    note: "A specific subject line, then greeting, intent, two or three fit points, one clear ask and a signature.",
  },
  referral_request: {
    maxChars: 1500,
    recommendedMaxChars: 900,
    maxWords: 200,
    subject: "optional",
    note: "Only for someone with a real prior relationship: the shared history, the role, a direct low-pressure ask.",
  },
  follow_up: {
    maxChars: 1500,
    recommendedMaxChars: 900,
    maxWords: 180,
    subject: "optional",
    note: "Reference the conversation or application once, add one new point, make one ask.",
  },
};

/** Three-beat structures per recipient (career-ops contacto.md). */
export const PERSONA_STRUCTURES: Readonly<Record<ContactKind, readonly string[]>> = {
  recruiter: [
    "Fit: the role and why you match, in one line.",
    "Proof: one verified figure or achievement.",
    "Ask: offer to share your resume or a short call.",
  ],
  hiring_manager: [
    "A challenge their team is working on, from cited research.",
    "Your quantified proof against that challenge.",
    "Ask how the team is approaching it.",
  ],
  peer: [
    "A genuine reference to their public work.",
    "Your connection to the same space.",
    "Ask for their perspective. Never ask a peer for a job.",
  ],
  referral: [
    "Acknowledge the real history you share.",
    "Bridge to the specific role.",
    "A direct, low-pressure referral ask.",
  ],
  other: ["Why you are reaching out.", "One verified proof point.", "One light ask."],
};

/** Structures used when the draft has no named recipient. */
export const CHANNEL_STRUCTURES: Readonly<Record<OutreachChannel, readonly string[]>> = {
  linkedin_connect: PERSONA_STRUCTURES.recruiter,
  linkedin_message: PERSONA_STRUCTURES.recruiter,
  email: [
    "Greeting, then the role you are applying for and what is attached.",
    "Two or three fit points: role match, a verified proof point, a differentiator.",
    "Why it matters for this team, in one sentence.",
    "One clear ask, then a signature with your contact details.",
  ],
  referral_request: PERSONA_STRUCTURES.referral,
  follow_up: [
    "Reference the conversation or application once, with its date.",
    "One new, relevant point or a thank-you for something specific.",
    "One ask: next steps, timeline or availability.",
  ],
};

export const OUTREACH_GUIDELINES: readonly string[] = [
  "Write in the candidate's plain voice; no filler such as 'I'm passionate about' or 'I hope this finds you well'.",
  "Use only facts from factsToCite and the profile. Every figure is checked against the profile when the draft is saved.",
  "No phone numbers in LinkedIn notes, and never promise an attachment that does not exist.",
  "One clear ask per message.",
  "Never guess an email address; use only one found publicly.",
  "Never send anything. Save the draft; the candidate sends it and then marks it sent_by_user.",
];

/** Phrases that read as boilerplate and cost credibility. */
export const FILLER_PATTERN =
  /\b(?:i'?m (?:very )?passionate about|i hope this (?:email|message|note) finds you well|to whom it may concern|synerg\w*|rockstar|ninja)\b/i;

/** A peer is asked for perspective, never for a job (career-ops contacto.md). */
export const JOB_ASK_PATTERN = /\b(?:refer(?:ral)?|job|position|opening|hire me|role for me)\b/i;
