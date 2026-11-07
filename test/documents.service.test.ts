import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getApplication, recordApproval } from "../src/db/repositories/applications.js";
import { listTailoredDocuments } from "../src/db/repositories/documents.js";
import { listEvents } from "../src/db/repositories/events.js";
import { sha256Bytes } from "../src/documents/render.js";
import { generateTailoredResume, renderResumeVariant, withChangedContent } from "../src/documents/resumeService.js";
import { documentStatus } from "../src/documents/status.js";
import type { Application } from "../src/domain/job.js";
import { buildPacket, prepareApplication } from "../src/services/applications.js";
import { computePacketHash } from "../src/submission/packet.js";
import { AppError } from "../src/util/errors.js";
import {
  acceptEvaluation,
  chromiumAvailable,
  docCampaign,
  docJob,
  docWorkspace,
  exampleResumeJson,
  removeAllScratch,
  seedApplication,
} from "./documents.fixtures.js";

const available = await chromiumAvailable();
afterAll(removeAllScratch);

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    return error as AppError;
  }
  throw new Error("expected a rejection");
}

/** The example with a dozen filler bullets added, enough to overflow a page. */
function overflowingSource(): unknown {
  const source = structuredClone(exampleResumeJson()) as {
    experience: Array<{ roles: Array<{ groups: Array<{ id: string; bullets: Array<{ id: string; text: string }> }> }> }>;
  };
  const filler = Array.from({ length: 14 }, (_, index) => ({
    id: `filler-${index}`,
    text: `Kept the quarterly operations dashboards and their spreadsheet exports current for the finance and facilities teams, round ${index}.`,
  }));
  const groups = source.experience[0]?.roles[0]?.groups ?? [];
  return {
    ...source,
    experience: [
      { ...source.experience[0], roles: [{ ...source.experience[0]?.roles[0], groups: [...groups, { id: "operations", label: "Operations", bullets: filler }] }] },
      ...source.experience.slice(1),
    ],
  };
}

describe("tailored resume preconditions", () => {
  it("needs a resume source", async () => {
    const workspace = docWorkspace();
    const application = seedApplication(workspace);
    expect((await rejection(generateTailoredResume(workspace, application.id))).code).toBe("resume_source_missing");
  });

  it("refuses submitted and unknown applications", async () => {
    const workspace = docWorkspace({ source: exampleResumeJson() });
    const application = seedApplication(workspace, docJob(), { status: "submitted", submittedAt: new Date().toISOString() });
    expect((await rejection(generateTailoredResume(workspace, application.id))).code).toBe("already_submitted");
    expect((await rejection(generateTailoredResume(workspace, "app_missing"))).code).toBe("application_not_found");
  });

  it("refuses an unsupported headline before starting a browser", async () => {
    const workspace = docWorkspace({ source: exampleResumeJson() });
    const application = seedApplication(workspace);
    const error = await rejection(generateTailoredResume(workspace, application.id, { headline: "Distinguished Rust Architect" }));
    expect(error.code).toBe("fact_check_failed");
    expect(getApplication(workspace.db, application.id)?.resumePath).toBe(application.resumePath);
  });
});

describe("withChangedContent", () => {
  it("voids approval and recomputes status and packet hash", () => {
    const workspace = docWorkspace();
    const job = docJob();
    const approved = seedApplication(workspace, job, { status: "approved", approvedAt: "2026-11-01T00:00:00.000Z" });
    const changed = withChangedContent(approved, job, { resumePath: "/new/resume.pdf" });
    expect(changed).toMatchObject({ status: "awaiting_approval", approvedAt: null, resumePath: "/new/resume.pdf" });
    expect(changed.packetHash).toBe(computePacketHash(buildPacket(changed, job)));
    expect(changed.packetHash).not.toBe(approved.packetHash);

    const waiting: Application = {
      ...approved,
      answers: [{ questionKey: "q", label: "Q", answer: "", source: "blocked", citation: "", requiresHuman: true, required: true, category: "essay", guidance: "" }],
    };
    expect(withChangedContent(waiting, job, {}).status).toBe("needs_human");
    expect(withChangedContent({ ...approved, status: "skipped" }, job, {}).status).toBe("skipped");
  });

  it("leaves an application a person must handle with them, unless it is a fresh draft", () => {
    const workspace = docWorkspace();
    const job = docJob();
    const aborted = seedApplication(workspace, job, {
      status: "needs_human",
      notes: "[2026-10-01T00:00:00.000Z] aborted: submit control clicked but no submission confirmation was detected; verify this application manually.",
    });
    // A new document answers no question and settles no failed submission.
    expect(withChangedContent(aborted, job, { resumePath: "/new/resume.pdf" }).status).toBe("needs_human");
    // A fresh draft's only other blocker can be the resume the change replaces.
    expect(withChangedContent(aborted, job, { resumePath: "/new/resume.pdf" }, { freshDraft: true }).status).toBe("awaiting_approval");
  });
});

describe("prepare_application hook", () => {
  async function prepared(workspace: ReturnType<typeof docWorkspace>) {
    const job = docJob();
    seedApplication(workspace, job, { id: "app_hook" });
    acceptEvaluation(workspace, job);
    return prepareApplication(workspace, { jobId: job.id });
  }

  it("adds nothing when tailoring is off", async () => {
    const result = await prepared(docWorkspace({ source: exampleResumeJson() }));
    expect("documents" in result).toBe(false);
  });

  it("keeps the variant and says why when there is no resume source", async () => {
    const workspace = docWorkspace({ campaign: docCampaign({ tailorResume: true }) });
    const result = await prepared(workspace);
    expect(result.documents).toEqual({ tailored: false, warning: expect.stringContaining("no resume source") });
    expect(getApplication(workspace.db, result.applicationId)?.resumePath).toBe("variants/platform.pdf");
  });

  it("reports a tailoring failure instead of failing the preparation", async () => {
    const workspace = docWorkspace({ source: { version: 1 }, campaign: docCampaign({ tailorResume: true }) });
    const result = await prepared(workspace);
    expect(result.documents?.tailored).toBe(false);
    expect(result.documents?.warning).toContain("resume_source_invalid");
    expect(result.resumeBlocker).toBeDefined();
    expect(getApplication(workspace.db, result.applicationId)?.packetHash).toBe(result.packetHash);
  });

  it.skipIf(!available)("attaches a tailored resume and returns the hash to approve", async () => {
    const workspace = docWorkspace({ source: exampleResumeJson(), campaign: docCampaign({ tailorResume: true }) });
    const result = await prepared(workspace);
    const stored = getApplication(workspace.db, result.applicationId);
    expect(result.documents).toMatchObject({ tailored: true, pages: 1 });
    expect(stored?.resumePath).toBe(result.documents?.resumePath);
    expect(result.packetHash).toBe(stored?.packetHash);
    expect(result.status).toBe(stored?.status);
    // The missing variant file no longer blocks once a verified tailored file replaces it.
    expect(result.resumeBlocker).toBeUndefined();
    expect(result.status).toBe("awaiting_approval");
  }, 60_000);
});

describe.skipIf(!available)("tailored resume rendering", () => {
  it("renders, verifies, stores and attaches the resume, voiding an approval", async () => {
    const workspace = docWorkspace({ source: exampleResumeJson() });
    const job = docJob();
    const application = seedApplication(workspace, job, { status: "approved", approvedAt: new Date().toISOString() });
    recordApproval(workspace.db, { id: "apr_1", applicationId: application.id, packetHash: application.packetHash, decision: "approved", note: "" });

    const result = await generateTailoredResume(workspace, application.id);
    expect(result.path).toBe(join(workspace.paths.documents, application.id, `resume-${result.sha256.slice(0, 8)}.pdf`));
    expect(sha256Bytes(readFileSync(result.path))).toBe(result.sha256);
    expect(result).toMatchObject({ pages: 1, status: "awaiting_approval", approvalVoided: true, variantId: "platform", dropped: [] });
    expect(result.checks).toMatchObject({ ok: true, textChecked: true });
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.includes("fonts not found"))).toBe(true);

    const stored = getApplication(workspace.db, application.id);
    expect(stored).toMatchObject({ resumePath: result.path, approvedAt: null, packetHash: result.packetHash, status: "awaiting_approval" });
    expect(result.packetHash).toBe(computePacketHash(buildPacket(stored as Application, job)));
    expect(result.packetHash).not.toBe(application.packetHash);

    const rows = listTailoredDocuments(workspace.db, application.id, "resume");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: result.path, sha256: result.sha256, variantId: "platform" });
    expect(rows[0]?.changes).toHaveLength(result.changes.length);
    expect(listEvents(workspace.db, "document.resume_tailored")).toHaveLength(1);

    const status = documentStatus(workspace, application.id);
    expect(status.resume).toMatchObject({ tailored: true, exists: true, path: result.path });
    expect(status.history).toHaveLength(1);
    expect(status.nextStep).toContain("cover_letter_scaffold");
  }, 60_000);

  it("keeps an application flagged after an aborted submission waiting on a person", async () => {
    const workspace = docWorkspace({ source: exampleResumeJson() });
    const application = seedApplication(workspace, docJob(), {
      status: "needs_human",
      notes: "[2026-10-01T00:00:00.000Z] aborted: the employer refused the submission. Submit this one by hand.",
    });
    const result = await generateTailoredResume(workspace, application.id);
    expect(result.status).toBe("needs_human");
    expect(getApplication(workspace.db, application.id)).toMatchObject({ status: "needs_human", resumePath: result.path });
  }, 60_000);

  it("drops the least relevant bullets until an overflowing resume fits one page", async () => {
    const workspace = docWorkspace({ source: overflowingSource() });
    const application = seedApplication(workspace);
    const result = await generateTailoredResume(workspace, application.id);
    expect(result.pages).toBe(1);
    expect(result.dropped.length).toBeGreaterThan(0);
    expect(result.dropped.every((id) => id.startsWith("filler-"))).toBe(true);
    expect(result.changes.filter((change) => change.kind === "bullet-dropped")).toHaveLength(result.dropped.length);
  }, 60_000);

  it("refuses to attach a resume that cannot fit and leaves the application alone", async () => {
    const workspace = docWorkspace({ source: overflowingSource(), campaign: docCampaign({ minBulletsPerRole: 20 }) });
    const application = seedApplication(workspace);
    const error = await rejection(generateTailoredResume(workspace, application.id));
    expect(error.code).toBe("document_verification_failed");
    expect(error.message).toContain("pages");
    expect(getApplication(workspace.db, application.id)?.resumePath).toBe(application.resumePath);
    expect(listTailoredDocuments(workspace.db, application.id)).toEqual([]);
  }, 60_000);

  it("rebuilds a fixed variant into documents/variants", async () => {
    const workspace = docWorkspace({ source: exampleResumeJson() });
    const result = await renderResumeVariant(workspace, "backend");
    expect(result.path).toBe(join(workspace.paths.documents, "variants", "backend.pdf"));
    expect(result).toMatchObject({ pages: 1, variantFound: true, usedByProfile: false, profilePath: "variants/backend.pdf" });
    expect(result.nextStep).toContain("set its profile.resumes path");
    expect(sha256Bytes(readFileSync(result.path))).toBe(result.sha256);
    expect((await rejection(renderResumeVariant(workspace, "nope"))).code).toBe("unknown_resume");
  }, 60_000);

  it("renders a profile variant resume.json does not define, and recognises the file profile.resumes uses", async () => {
    const base = docWorkspace({ source: exampleResumeJson() });
    const output = join(base.paths.documents, "variants", "security.pdf");
    const profile = { ...base.profile, resumes: [...base.profile.resumes, { id: "security", label: "Security", path: output, tracks: [], isDefault: false }] };
    const result = await renderResumeVariant({ ...base, profile }, "security");
    expect(result).toMatchObject({ variantFound: false, usedByProfile: true, path: output });
    expect(result.warnings).toContain('resume.json has no variant "security"; rendered the source order');
    expect(result.nextStep).toContain("already points at this file");
  }, 60_000);
});
