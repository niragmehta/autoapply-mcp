/**
 * Records stored by the career features: the story bank, interviews and their
 * prep sessions, company research, contacts, outreach drafts and offers.
 *
 * The server keeps these as structured data and computes deterministic
 * scaffolds from them; the agent writes the prose. Nothing here is ever sent.
 */

export const INTERVIEW_STAGES = [
  "recruiter_screen",
  "technical",
  "system_design",
  "behavioral",
  "hiring_manager",
  "onsite",
  "other",
] as const;
export type InterviewStage = (typeof INTERVIEW_STAGES)[number];

export const INTERVIEW_STATUSES = ["scheduled", "done", "cancelled"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const SESSION_KINDS = ["plan", "practice", "debrief", "redflags"] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const NOTE_KINDS = ["research", "culture", "comp", "news", "redflag"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const CONTACT_KINDS = ["recruiter", "hiring_manager", "peer", "referral", "other"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const OUTREACH_CHANNELS = [
  "linkedin_connect",
  "linkedin_message",
  "email",
  "referral_request",
  "follow_up",
] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];

export const OUTREACH_STATUSES = ["draft", "sent_by_user", "discarded"] as const;
export type OutreachStatus = (typeof OUTREACH_STATUSES)[number];

export const OFFER_STATUSES = ["received", "negotiating", "accepted", "declined", "expired"] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

/** Offers still in play: the ones a comparison or a negotiation should weigh. */
export const ACTIVE_OFFER_STATUSES: readonly OfferStatus[] = ["received", "negotiating", "accepted"];

/** A STAR + Reflection master story built from verified profile facts. */
export type Story = {
  id: string;
  title: string;
  situation: string;
  task: string;
  action: string;
  result: string;
  reflection: string;
  skills: string[];
  factIds: string[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type Interviewer = { name: string; role: string };

export type Interview = {
  id: string;
  applicationId: string;
  stage: InterviewStage;
  scheduledAt: string | null;
  durationMinutes: number | null;
  format: string;
  locationOrLink: string;
  interviewers: Interviewer[];
  status: InterviewStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

/** A prep plan, practice transcript, debrief or red-flag review, as Markdown. */
export type InterviewSession = {
  id: string;
  interviewId: string | null;
  applicationId: string;
  kind: SessionKind;
  content: string;
  createdAt: string;
};

export type CompanyNote = {
  id: string;
  company: string;
  kind: NoteKind;
  content: string;
  /** URLs or short citations the note was written from. */
  sources: string[];
  createdAt: string;
};

/** A person found in public sources. Never holds anything found behind a login. */
export type Contact = {
  id: string;
  company: string;
  name: string;
  role: string;
  kind: ContactKind;
  profileUrl: string;
  email: string;
  notes: string;
  /** Where the information was publicly found. */
  source: string;
  createdAt: string;
  updatedAt: string;
};

export type OutreachDraft = {
  id: string;
  applicationId: string | null;
  contactId: string | null;
  company: string;
  channel: OutreachChannel;
  subject: string;
  body: string;
  status: OutreachStatus;
  createdAt: string;
  updatedAt: string;
};

export type Offer = {
  id: string;
  applicationId: string | null;
  company: string;
  title: string;
  level: string;
  currency: string;
  base: number;
  bonusTargetAmount: number | null;
  bonusTargetPct: number | null;
  equityValueAnnual: number | null;
  equityDetails: string;
  signOn: number | null;
  relocation: number | null;
  benefitsNotes: string;
  location: string;
  remotePolicy: string;
  startDate: string | null;
  deadline: string | null;
  status: OfferStatus;
  createdAt: string;
  updatedAt: string;
};
