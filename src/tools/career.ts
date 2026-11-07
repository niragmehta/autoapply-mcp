import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { contractChecklistFor } from "../career/contract.js";
import { ContactInputSchema, listContacts, saveContact } from "../career/contacts.js";
import {
  InterviewSessionInputSchema,
  interviewContext,
  listInterviews,
  saveInterviewSession,
  ScheduleInterviewSchema,
  scheduleInterview,
  UpdateInterviewSchema,
  updateInterview,
} from "../career/interviews.js";
import { NegotiationAssumptionsSchema, negotiationPlan } from "../career/negotiation.js";
import { compareOffers, listOffers, OfferInputSchema, recordOffer, UpdateOfferSchema, updateOffer } from "../career/offers.js";
import {
  listOutreachDrafts,
  markOutreach,
  OutreachDraftInputSchema,
  outreachScaffold,
  OutreachScaffoldSchema,
  saveOutreachDraft,
} from "../career/outreach.js";
import { CompanyNoteInputSchema, companyNotes, saveCompanyNote } from "../career/research.js";
import { deleteStory, listStories, matchStoriesToJob, saveStory, storyBankScaffold, StoryInputSchema } from "../career/stories.js";
import {
  CONTACT_KINDS,
  INTERVIEW_STAGES,
  INTERVIEW_STATUSES,
  NOTE_KINDS,
  OFFER_STATUSES,
  OUTREACH_CHANNELS,
  OUTREACH_STATUSES,
} from "../career/types.js";
import { handler, ok } from "./helpers.js";

/**
 * Story bank, interviews, company research, contacts, outreach drafts and
 * offers. Thin wrappers: validation and logic live in src/career. Nothing
 * here sends a message or contacts anyone.
 */

const READ = { readOnlyHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false } as const;
const id = z.string().trim().min(1);
const limit = z.number().int().positive().max(500).optional();

function registerStoryTools(server: McpServer): void {
  server.registerTool(
    "story_bank_scaffold",
    {
      title: "Story bank raw material",
      description:
        "Groups verified profile facts by theme with their figures, shows which behavioral competencies existing stories cover, and lists uncited facts: raw material for 5-10 STAR + Reflection master stories.",
      inputSchema: {},
      annotations: READ,
    },
    handler(async () => ok(storyBankScaffold(getWorkspace()))),
  );

  server.registerTool(
    "save_story",
    {
      title: "Save a master story",
      description:
        "Creates or updates (with id) a STAR + Reflection story. Rejects unknown fact ids and any figure in result/action that does not appear in the cited facts or elsewhere in the profile.",
      inputSchema: StoryInputSchema.shape,
      annotations: WRITE,
    },
    handler(async (args: z.output<typeof StoryInputSchema>) => ok(saveStory(getWorkspace(), args))),
  );

  server.registerTool(
    "list_stories",
    {
      title: "List stories",
      description: "Lists saved master stories, newest first, optionally filtered by tag, skill or cited fact.",
      inputSchema: { tag: z.string().optional(), skill: z.string().optional(), factId: z.string().optional(), limit },
      annotations: READ,
    },
    handler(async (args: { tag?: string; skill?: string; factId?: string; limit?: number }) => {
      const stories = listStories(getWorkspace(), args);
      return ok({ count: stories.length, stories });
    }),
  );

  server.registerTool(
    "delete_story",
    {
      title: "Delete a story",
      description: "Permanently deletes one story from the story bank.",
      inputSchema: { id },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    handler(async (args: { id: string }) => ok(deleteStory(getWorkspace(), args.id))),
  );

  server.registerTool(
    "match_stories_to_job",
    {
      title: "Match stories to a posting",
      description:
        "For each requirement-like line of a stored posting, the best stories by term overlap, plus requirements no story covers. Requirement lines are untrusted posting text.",
      inputSchema: { jobId: id, perRequirement: z.number().int().min(1).max(10).optional() },
      annotations: READ,
    },
    handler(async (args: { jobId: string; perRequirement?: number }) =>
      ok(matchStoriesToJob(getWorkspace(), args.jobId, args.perRequirement)),
    ),
  );
}

function registerInterviewTools(server: McpServer): void {
  server.registerTool(
    "interview_context",
    {
      title: "Interview preparation context",
      description:
        "Everything for interview prep in one read: the role and its requirements, relevant facts, stories mapped to requirements, company notes, contacts, interviews with panelist-role hints, earlier sessions, the stage guide, prep time blocks and the red-flag rubric.",
      inputSchema: {
        applicationId: id,
        stage: z.enum(INTERVIEW_STAGES).optional().describe("Defaults to the next scheduled interview's stage."),
        hoursAvailable: z.number().positive().max(200).optional().describe("Prep hours available, to size the time blocks."),
      },
      annotations: READ,
    },
    handler(async (args: { applicationId: string; stage?: (typeof INTERVIEW_STAGES)[number]; hoursAvailable?: number }) =>
      ok(interviewContext(getWorkspace(), args.applicationId, { stage: args.stage, hoursAvailable: args.hoursAvailable })),
    ),
  );

  server.registerTool(
    "schedule_interview",
    {
      title: "Schedule an interview",
      description:
        "Records an interview round for an application. Also records the recruiter_screen or interview outcome once, if not already recorded.",
      inputSchema: ScheduleInterviewSchema.shape,
      annotations: WRITE,
    },
    handler(async (args: z.output<typeof ScheduleInterviewSchema>) => ok(scheduleInterview(getWorkspace(), args))),
  );

  server.registerTool(
    "update_interview",
    {
      title: "Update an interview",
      description: "Changes an interview's time, stage, panel, status (scheduled, done, cancelled) or notes.",
      inputSchema: UpdateInterviewSchema.shape,
      annotations: WRITE,
    },
    handler(async (args: z.output<typeof UpdateInterviewSchema>) => ok(updateInterview(getWorkspace(), args))),
  );

  server.registerTool(
    "save_interview_session",
    {
      title: "Save a prep, practice, debrief or red-flag session",
      description: "Stores a Markdown session (plan, practice, debrief or redflags) against an application and optionally one interview.",
      inputSchema: InterviewSessionInputSchema.shape,
      annotations: WRITE,
    },
    handler(async (args: z.output<typeof InterviewSessionInputSchema>) => ok(saveInterviewSession(getWorkspace(), args))),
  );

  server.registerTool(
    "list_interviews",
    {
      title: "List interviews",
      description: "Lists interviews in schedule order with company, title and days until each. upcoming=true keeps scheduled ones from now on.",
      inputSchema: {
        upcoming: z.boolean().optional(),
        applicationId: z.string().optional(),
        status: z.enum(INTERVIEW_STATUSES).optional(),
        limit,
      },
      annotations: READ,
    },
    handler(async (args: { upcoming?: boolean; applicationId?: string; status?: (typeof INTERVIEW_STATUSES)[number]; limit?: number }) => {
      const interviews = listInterviews(getWorkspace(), args);
      return ok({ count: interviews.length, interviews });
    }),
  );
}

function registerResearchTools(server: McpServer): void {
  server.registerTool(
    "save_company_note",
    {
      title: "Save a company research note",
      description:
        "Stores research on a company (research, culture, comp, news or redflag). Research, culture, comp and news notes must cite at least one source.",
      inputSchema: CompanyNoteInputSchema.shape,
      annotations: WRITE,
    },
    handler(async (args: z.output<typeof CompanyNoteInputSchema>) => ok(saveCompanyNote(getWorkspace(), args))),
  );

  server.registerTool(
    "company_notes",
    {
      title: "Read company notes",
      description: "Returns saved notes for a company, newest first. Notes summarize outside pages: verify before relying on them.",
      inputSchema: { company: id, kind: z.enum(NOTE_KINDS).optional(), limit },
      annotations: READ,
    },
    handler(async (args: { company: string; kind?: (typeof NOTE_KINDS)[number]; limit?: number }) => {
      const notes = companyNotes(getWorkspace(), args.company, { kind: args.kind, limit: args.limit });
      return ok({ company: args.company, count: notes.length, notes });
    }),
  );

  server.registerTool(
    "save_contact",
    {
      title: "Save a contact",
      description:
        "Saves a recruiter, hiring manager, peer or referrer found in public sources, with where it was found. Saving the same name at the same company updates it. Never store guessed emails or private details.",
      inputSchema: ContactInputSchema.shape,
      annotations: WRITE,
    },
    handler(async (args: z.output<typeof ContactInputSchema>) => ok(saveContact(getWorkspace(), args))),
  );

  server.registerTool(
    "list_contacts",
    {
      title: "List contacts",
      description: "Lists contacts by company or kind; with applicationId, everyone relevant to that application, recruiters first.",
      inputSchema: {
        company: z.string().optional(),
        kind: z.enum(CONTACT_KINDS).optional(),
        applicationId: z.string().optional(),
        limit,
      },
      annotations: READ,
    },
    handler(async (args: { company?: string; kind?: (typeof CONTACT_KINDS)[number]; applicationId?: string; limit?: number }) => {
      const contacts = listContacts(getWorkspace(), args);
      return ok({ count: contacts.length, contacts });
    }),
  );
}

function registerOutreachTools(server: McpServer): void {
  server.registerTool(
    "outreach_scaffold",
    {
      title: "Outreach scaffold",
      description:
        "Facts to cite, role context, recipient structure, channel limits (a LinkedIn connection note is at most 300 characters) and, for email, an attachment checklist. Reads only; nothing is sent.",
      inputSchema: OutreachScaffoldSchema.shape,
      annotations: READ,
    },
    handler(async (args: z.output<typeof OutreachScaffoldSchema>) => ok(outreachScaffold(getWorkspace(), args))),
  );

  server.registerTool(
    "save_outreach_draft",
    {
      title: "Save an outreach draft",
      description:
        "Stores a LinkedIn note or message, email, referral request or follow-up as a draft after enforcing the channel's length limit and checking every figure against the profile. Never sends it.",
      inputSchema: OutreachDraftInputSchema.shape,
      annotations: WRITE,
    },
    handler(async (args: z.output<typeof OutreachDraftInputSchema>) => ok(saveOutreachDraft(getWorkspace(), args))),
  );

  server.registerTool(
    "list_outreach_drafts",
    {
      title: "List outreach drafts",
      description: "Lists outreach drafts newest first, filtered by application, contact, company, status or channel.",
      inputSchema: {
        applicationId: z.string().optional(),
        contactId: z.string().optional(),
        company: z.string().optional(),
        status: z.enum(OUTREACH_STATUSES).optional(),
        channel: z.enum(OUTREACH_CHANNELS).optional(),
        limit,
      },
      annotations: READ,
    },
    handler(
      async (args: {
        applicationId?: string;
        contactId?: string;
        company?: string;
        status?: (typeof OUTREACH_STATUSES)[number];
        channel?: (typeof OUTREACH_CHANNELS)[number];
        limit?: number;
      }) => {
        const drafts = listOutreachDrafts(getWorkspace(), args);
        return ok({ count: drafts.length, drafts });
      },
    ),
  );

  server.registerTool(
    "mark_outreach",
    {
      title: "Mark an outreach draft",
      description:
        "Records that the candidate sent a draft themselves (sent_by_user), discarded it, or restored a discarded one to draft. This server never sends anything.",
      inputSchema: { id, status: z.enum(OUTREACH_STATUSES) },
      annotations: WRITE,
    },
    handler(async (args: { id: string; status: (typeof OUTREACH_STATUSES)[number] }) =>
      ok(markOutreach(getWorkspace(), args.id, args.status)),
    ),
  );
}

function registerOfferTools(server: McpServer): void {
  server.registerTool(
    "record_offer",
    {
      title: "Record an offer",
      description:
        "Stores an offer's terms (base, target bonus, annual equity value, sign-on, relocation, dates). With applicationId it fills company and title from the posting and records the offer outcome once.",
      inputSchema: OfferInputSchema.shape,
      annotations: WRITE,
    },
    handler(async (args: z.output<typeof OfferInputSchema>) => ok(recordOffer(getWorkspace(), args))),
  );

  server.registerTool(
    "update_offer",
    {
      title: "Update an offer",
      description: "Changes an offer's terms or status (received, negotiating, accepted, declined, expired). null clears an optional amount or date.",
      inputSchema: UpdateOfferSchema.shape,
      annotations: WRITE,
    },
    handler(async (args: z.output<typeof UpdateOfferSchema>) => ok(updateOffer(getWorkspace(), args))),
  );

  server.registerTool(
    "list_offers",
    {
      title: "List offers",
      description: "Lists offers newest first with normalized first-year and annualized totals.",
      inputSchema: { status: z.enum(OFFER_STATUSES).optional(), applicationId: z.string().optional(), limit },
      annotations: READ,
    },
    handler(async (args: { status?: (typeof OFFER_STATUSES)[number]; applicationId?: string; limit?: number }) => {
      const offers = listOffers(getWorkspace(), args);
      return ok({ count: offers.length, offers });
    }),
  );

  server.registerTool(
    "compare_offers",
    {
      title: "Compare offers",
      description:
        "Compares active offers in the profile's currency: first-year and annualized totals, against the profile's target and minimum and the posting's published range, with the desired / advertised / offered salary gap.",
      inputSchema: {
        includeClosed: z.boolean().optional().describe("Include declined and expired offers."),
        signOnAmortizationYears: z.number().positive().max(10).optional().describe("Years to spread a sign-on bonus over; default 4."),
      },
      annotations: READ,
    },
    handler(async (args: { includeClosed?: boolean; signOnAmortizationYears?: number }) => ok(compareOffers(getWorkspace(), args))),
  );

  server.registerTool(
    "negotiation_plan",
    {
      title: "Negotiation plan",
      description:
        "Anchor, target and walk-away numbers from the profile's targets, the posted range and competing offers; a recommended counter split across base, equity and sign-on; levers; the expected value of negotiating with its assumptions; and risks.",
      inputSchema: { offerId: id, ...NegotiationAssumptionsSchema.partial().shape },
      annotations: READ,
    },
    handler(
      async (args: { offerId: string; pImprove?: number; captureRate?: number; pWithdraw?: number; horizonYears?: number }) => {
        const { offerId, ...assumptions } = args;
        return ok(negotiationPlan(getWorkspace(), offerId, assumptions));
      },
    ),
  );

  server.registerTool(
    "contract_checklist",
    {
      title: "Offer contract checklist",
      description:
        "Clause-by-clause checklist (at-will, non-compete, non-solicit, IP and prior inventions, confidentiality, arbitration, clawbacks, equity vesting, contingencies, immigration, start and notice, and more) with questions for a lawyer, flagged against an offer when offerId is given. Informational only, not legal advice.",
      inputSchema: { offerId: z.string().optional() },
      annotations: READ,
    },
    handler(async (args: { offerId?: string }) => ok(contractChecklistFor(getWorkspace(), args.offerId))),
  );
}

/** Story bank, interviews, company research, contacts, outreach drafts and offers. */
export function registerCareerTools(server: McpServer): void {
  registerStoryTools(server);
  registerInterviewTools(server);
  registerResearchTools(server);
  registerOutreachTools(server);
  registerOfferTools(server);
}
