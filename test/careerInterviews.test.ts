import { beforeEach, describe, expect, it } from "vitest";
import { listOutcomes } from "../src/db/repositories/applications.js";
import { listSessionRecords } from "../src/db/repositories/career/interviews.js";
import { listEvents } from "../src/db/repositories/events.js";
import { saveContact } from "../src/career/contacts.js";
import { prepBlocks, STAGE_GUIDES } from "../src/career/interviewGuides.js";
import {
  interviewContext,
  listInterviews,
  saveInterviewSession,
  scheduleInterview,
  updateInterview,
} from "../src/career/interviews.js";
import { classifyPanelist, panelHints } from "../src/career/panelists.js";
import { saveCompanyNote } from "../src/career/research.js";
import { saveStory } from "../src/career/stories.js";
import { INTERVIEW_STAGES } from "../src/career/types.js";
import { careerWorkspace, errorCode, inDays, seedApplication, type TestWorkspace } from "./careerFixtures.js";

let workspace: TestWorkspace;
let applicationId: string;

beforeEach(() => {
  workspace = careerWorkspace();
  applicationId = seedApplication(workspace.db).application.id;
});

function outcomeStatuses(): string[] {
  return listOutcomes(workspace.db, applicationId).map((outcome) => outcome.status);
}

describe("scheduleInterview", () => {
  it("records the recruiter_screen outcome once", () => {
    const first = scheduleInterview(workspace, { applicationId, stage: "recruiter_screen", scheduledAt: inDays(2) });
    expect(first.outcomeRecorded).toBe("recruiter_screen");
    const second = scheduleInterview(workspace, { applicationId, stage: "recruiter_screen", scheduledAt: inDays(3) });
    expect(second.outcomeRecorded).toBeNull();
    expect(outcomeStatuses()).toEqual(["recruiter_screen"]);
    expect(listEvents(workspace.db, "outcome.recorded")).toHaveLength(1);
    expect(listEvents(workspace.db, "interview.scheduled")).toHaveLength(2);
  });

  it("records the interview outcome once for any later stage", () => {
    expect(scheduleInterview(workspace, { applicationId, stage: "technical" }).outcomeRecorded).toBe("interview");
    expect(scheduleInterview(workspace, { applicationId, stage: "onsite" }).outcomeRecorded).toBeNull();
    expect(outcomeStatuses()).toEqual(["interview"]);
  });

  it("normalizes the time to UTC and stores the panel", () => {
    const { interview, panel, company } = scheduleInterview(workspace, {
      applicationId,
      stage: "hiring_manager",
      scheduledAt: "2030-03-04T10:00:00-08:00",
      durationMinutes: 45,
      format: "video",
      interviewers: [{ name: "Jordan Example", role: "Engineering Manager" }],
    });
    expect(interview.scheduledAt).toBe("2030-03-04T18:00:00.000Z");
    expect(interview.status).toBe("scheduled");
    expect(company).toBe("Acme Robotics");
    expect(panel[0]?.kind).toBe("hiring_manager");
  });

  it("rejects bad input and unknown applications", () => {
    expect(errorCode(() => scheduleInterview(workspace, { applicationId, stage: "technical", scheduledAt: "next tuesday-ish" }))).toBe(
      "invalid_input",
    );
    expect(errorCode(() => scheduleInterview(workspace, { applicationId: "app_missing", stage: "technical" }))).toBe(
      "application_not_found",
    );
    expect(errorCode(() => scheduleInterview(workspace, { applicationId, stage: "lunch" as never }))).toBe("invalid_input");
  });

  it("warns when the application was never recorded as submitted", () => {
    const drafted = seedApplication(workspace.db, { id: "2", application: { status: "drafted", submittedAt: null } });
    const result = scheduleInterview(workspace, { applicationId: drafted.application.id, stage: "technical" });
    expect(result.warnings.join(" ")).toContain("record_submission");
  });
});

describe("updateInterview", () => {
  it("applies a patch, reports the changed fields and records a new stage's outcome", () => {
    const { interview } = scheduleInterview(workspace, { applicationId, stage: "recruiter_screen", scheduledAt: inDays(1) });
    const updated = updateInterview(workspace, { id: interview.id, stage: "technical", notes: "Panel of two", durationMinutes: 60 });
    expect(updated.changed.sort()).toEqual(["durationMinutes", "notes", "stage"]);
    expect(updated.outcomeRecorded).toBe("interview");
    expect(outcomeStatuses()).toEqual(["recruiter_screen", "interview"]);

    const cleared = updateInterview(workspace, { id: interview.id, scheduledAt: null, status: "done" });
    expect(cleared.interview.scheduledAt).toBeNull();
    expect(cleared.interview.status).toBe("done");
    expect(cleared.interview.notes).toBe("Panel of two");
  });

  it("fails for an unknown interview", () => {
    expect(errorCode(() => updateInterview(workspace, { id: "int_missing", status: "done" }))).toBe("interview_not_found");
  });
});

describe("saveInterviewSession", () => {
  it("stores sessions and checks the interview belongs to the application", () => {
    const { interview } = scheduleInterview(workspace, { applicationId, stage: "technical" });
    const saved = saveInterviewSession(workspace, { applicationId, interviewId: interview.id, kind: "plan", content: "# Plan" });
    expect(saved.kind).toBe("plan");
    expect(listSessionRecords(workspace.db, { applicationId })[0]?.content).toBe("# Plan");

    const other = seedApplication(workspace.db, { id: "3" }).application.id;
    expect(errorCode(() => saveInterviewSession(workspace, { applicationId: other, interviewId: interview.id, kind: "debrief", content: "x" }))).toBe(
      "interview_mismatch",
    );
    expect(errorCode(() => saveInterviewSession(workspace, { applicationId, kind: "notes" as never, content: "x" }))).toBe("invalid_input");
  });
});

describe("listInterviews", () => {
  it("lists upcoming interviews in time order, unscheduled last, with the role", () => {
    const past = scheduleInterview(workspace, { applicationId, stage: "recruiter_screen", scheduledAt: inDays(-2) }).interview;
    const later = scheduleInterview(workspace, { applicationId, stage: "onsite", scheduledAt: inDays(9) }).interview;
    const soon = scheduleInterview(workspace, { applicationId, stage: "technical", scheduledAt: inDays(3) }).interview;
    const unscheduled = scheduleInterview(workspace, { applicationId, stage: "behavioral" }).interview;
    const cancelled = scheduleInterview(workspace, { applicationId, stage: "other", scheduledAt: inDays(4) }).interview;
    updateInterview(workspace, { id: cancelled.id, status: "cancelled" });

    const upcoming = listInterviews(workspace, { upcoming: true });
    expect(upcoming.map((entry) => entry.id)).toEqual([soon.id, later.id, unscheduled.id]);
    expect(upcoming[0]?.company).toBe("Acme Robotics");
    expect(upcoming[0]?.daysUntil).toBeCloseTo(3, 0);
    expect(listInterviews(workspace).map((entry) => entry.id)).toContain(past.id);
  });
});

describe("panelists", () => {
  it("classifies interviewer titles into the roles they probe as", () => {
    expect(classifyPanelist("VP of Engineering").kind).toBe("executive");
    expect(classifyPanelist("Senior Technical Recruiter").kind).toBe("recruiter");
    expect(classifyPanelist("Engineering Manager, Platform").kind).toBe("hiring_manager");
    expect(classifyPanelist("Staff Software Engineer").kind).toBe("peer");
    expect(classifyPanelist("Co-founder & CEO").kind).toBe("executive");
    expect(classifyPanelist("").kind).toBe("other");
    expect(panelHints([{ name: "Riley Example", role: "Talent Partner" }])[0]?.probes.join(" ")).toContain("Compensation");
  });
});

describe("prep blocks and stage guides", () => {
  it("allocates every stage's time in full", () => {
    for (const stage of INTERVIEW_STAGES) {
      const total = prepBlocks(stage).reduce((sum, block) => sum + block.share, 0);
      expect(total).toBeCloseTo(1, 5);
      expect(STAGE_GUIDES[stage].defaultQuestions.length).toBeGreaterThan(0);
    }
  });

  it("sizes blocks in minutes when hours are known and shifts a screen toward stories and research", () => {
    const blocks = prepBlocks("technical", 10);
    expect(blocks.find((block) => block.block === "Priority domain")?.minutes).toBe(150);
    const screen = prepBlocks("recruiter_screen");
    expect(screen.find((block) => block.block === "Company research")?.share).toBeGreaterThan(
      prepBlocks("technical").find((block) => block.block === "Company research")?.share ?? 1,
    );
  });
});

describe("interviewContext", () => {
  it("assembles requirements, evidence, stories, notes, contacts, panel and sessions", () => {
    saveStory(workspace, {
      title: "Containing a credential leak",
      action: "I led incident response across three teams.",
      result: "We cut time to remediate from 6 hours to 45 minutes.",
      reflection: "Rehearse the runbook early.",
      factIds: ["incident"],
      tags: ["incident response"],
    });
    saveCompanyNote(workspace, { company: "acme robotics", kind: "news", content: "Launched an agent platform.", sources: ["https://example.com/news"] });
    saveContact(workspace, { company: "Acme Robotics", name: "Riley Example", role: "Technical Recruiter", kind: "recruiter", source: "https://example.com/team" });
    const { interview } = scheduleInterview(workspace, {
      applicationId,
      stage: "technical",
      scheduledAt: inDays(4),
      interviewers: [{ name: "Jordan Example", role: "Staff Engineer" }],
    });
    saveInterviewSession(workspace, { applicationId, interviewId: interview.id, kind: "practice", content: "x".repeat(5000) });

    const context = interviewContext(workspace, applicationId, { hoursAvailable: 8 });
    expect(context.job.company).toBe("Acme Robotics");
    expect(context.requirements.lines).toContain("Lead incident response for production security events");
    expect(context.evidence[0]?.id).toBeDefined();
    expect(context.evidence.find((fact) => fact.id === "incident")?.metrics).toEqual(["6 hours to 45 minutes"]);
    expect(context.stories.featured[0]?.title).toBe("Containing a credential leak");
    expect(context.companyNotes.items).toHaveLength(1);
    expect(context.contacts[0]?.name).toBe("Riley Example");
    expect(context.nextInterview?.id).toBe(interview.id);
    expect(context.stageGuide?.stage).toBe("technical");
    expect(context.interviews[0]?.panel[0]?.kind).toBe("peer");
    expect(context.prepBlocks.every((block) => block.minutes !== null)).toBe(true);
    expect(context.sessions[0]?.truncated).toBe(true);
    expect(context.outcomes.map((outcome) => outcome.status)).toEqual(["interview"]);
    expect(context.panelistRoles.map((role) => role.kind)).toEqual(["recruiter", "hiring_manager", "peer", "executive", "other"]);
    expect(context.redFlagRubric.signals).toHaveLength(5);
  });

  it("lets the caller pick the stage and reports structural signals", () => {
    seedApplication(workspace.db, { id: "4", job: { compensation: null } });
    for (let round = 0; round < 5; round += 1) scheduleInterview(workspace, { applicationId: "app_career4", stage: "onsite" });
    const context = interviewContext(workspace, "app_career4", { stage: "behavioral" });
    expect(context.stageGuide?.stage).toBe("behavioral");
    expect(context.structuralSignals.join(" ")).toContain("5 interview rounds");
    expect(context.structuralSignals.join(" ")).toContain("no pay range");
  });
});
