import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePaths, type WorkspacePaths } from "../src/config/paths.js";
import { openDatabase } from "../src/db/database.js";
import { getApplication, recordApproval, saveApplication } from "../src/db/repositories/applications.js";
import { insertTailoredDocument } from "../src/db/repositories/documents.js";
import { appendEvent, listEvents } from "../src/db/repositories/events.js";
import { getJob, saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import type { Application } from "../src/domain/job.js";
import { decryptBundle, unpackFiles } from "../src/home/archive.js";
import { exportHome, importHome } from "../src/home/bundle.js";
import { buildPacket } from "../src/services/applications.js";
import { computePacketHash } from "../src/submission/packet.js";
import { makeJob } from "./factories.js";

/** Moving a whole AUTOAPPLY_HOME to another machine as one encrypted bundle. */

const PASSPHRASE = "correct horse battery staple 2026";
const SECRET = "hunter2-ats-password-never-travels";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
const OVERRIDES = ["AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB", "AUTOAPPLY_ARTIFACTS", "AUTOAPPLY_RESUME_SOURCE", "AUTOAPPLY_FONTS", "AUTOAPPLY_DOCUMENTS", "AUTOAPPLY_REPORTS", "AUTOAPPLY_EXPORTS", "AUTOAPPLY_SECRETS"];

const created: string[] = [];

function pathsFor(home: string): WorkspacePaths {
  const saved = process.env.AUTOAPPLY_HOME;
  for (const key of OVERRIDES) delete process.env[key];
  process.env.AUTOAPPLY_HOME = home;
  try {
    return resolvePaths();
  } finally {
    if (saved === undefined) delete process.env.AUTOAPPLY_HOME;
    else process.env.AUTOAPPLY_HOME = saved;
  }
}

function tempHome(label: string): WorkspacePaths {
  const home = mkdtempSync(join(tmpdir(), `autoapply-bundle-${label}-`));
  created.push(home);
  return pathsFor(home);
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function application(overrides: Partial<Application> & Pick<Application, "id" | "jobId" | "status" | "resumePath">): Application {
  return {
    resumeId: "ai-security",
    packetHash: "",
    coverLetter: "",
    answers: [],
    blockedQuestions: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    approvedAt: null,
    submittedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
    ...overrides,
  };
}

/** A workspace with everything a bundle carries, and the things it must never carry. */
function sourceHome(): WorkspacePaths {
  const paths = tempHome("source");
  const { home } = paths;
  const resume = join(home, "resumes", "alex-security.pdf");
  const tailored = join(paths.documents, "app_approved", "resume-1234abcd.pdf");
  mkdirSync(paths.fonts, { recursive: true });
  mkdirSync(join(paths.documents, "app_approved"), { recursive: true });
  writeFileSync(resume, PDF);
  writeFileSync(join(paths.fonts, "body.ttf"), Buffer.from("font-bytes"));
  writeFileSync(tailored, PDF);
  writeFileSync(paths.secrets, `AUTOAPPLY_ATS_PASSWORD=${SECRET}\n`);
  mkdirSync(paths.artifacts, { recursive: true });
  writeFileSync(join(paths.artifacts, "shot.png"), Buffer.from(SECRET));
  mkdirSync(join(home, "browser-profiles", "careers"), { recursive: true });
  writeFileSync(join(home, "browser-profiles", "careers", "Cookies"), SECRET);
  writeFileSync(join(home, "profile.json.bak-old"), SECRET);

  writeFileSync(
    paths.profile,
    JSON.stringify({ version: 1, identity: { fullName: "Alex Candidate" }, resumes: [{ id: "ai-security", label: "AI", path: resume, tracks: ["ai-security"], isDefault: true }] }),
  );
  writeFileSync(paths.campaign, JSON.stringify({ version: 1, name: "test", submission: { mode: "manual" } }));
  writeFileSync(paths.companies, JSON.stringify({ version: 1, companies: [{ name: "Acme", ats: "greenhouse", board: "acme" }] }));
  writeFileSync(paths.resumeSource, JSON.stringify({ version: 1, header: { name: "Alex Candidate" } }));

  const db = openDatabase(paths.database);
  try {
    const jobs = ["sent", "approved", "waiting", "unrelated"].map((name, index) =>
      makeJob({ id: `job_${name}`, fingerprint: `fp_${name}`, externalId: String(index), companyName: `Company ${name}` }),
    );
    upsertJobs(db, jobs);
    for (const job of jobs) {
      saveEvaluation(db, {
        jobId: job.id,
        decision: "accept",
        gate: { passed: true, rule: null, reason: "", evidence: "" },
        trackId: "ai-security",
        score: 80,
        tier: "B",
        components: [],
        flags: [],
        evaluatedAt: "2026-10-01T00:00:00.000Z",
      });
    }
    saveApplication(db, application({ id: "app_sent", jobId: "job_sent", status: "submitted", resumePath: resume, submittedAt: "2026-10-02T00:00:00.000Z", artifactPath: join(paths.artifacts, "shot.png") }));
    const approved = application({ id: "app_approved", jobId: "job_approved", status: "approved", resumePath: tailored, approvedAt: "2026-10-03T00:00:00.000Z" });
    const approvedHash = computePacketHash(buildPacket(approved, jobs[1]!));
    saveApplication(db, { ...approved, packetHash: approvedHash });
    recordApproval(db, { id: "apr_1", applicationId: "app_approved", packetHash: approvedHash, decision: "approved", note: "" });
    saveApplication(db, application({ id: "app_waiting", jobId: "job_waiting", status: "awaiting_approval", resumePath: resume }));
    insertTailoredDocument(db, { applicationId: "app_approved", kind: "resume", path: tailored, sha256: "abc", variantId: "ai-security", changes: [], checks: {} });
    appendEvent(db, "document.resume_tailored", "app_approved", { path: tailored });
  } finally {
    db.close();
  }
  return paths;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: string }).code ?? (error as Error).message);
  }
  return "no error";
}

describe("moving a workspace to a new home", () => {
  it("carries configuration, résumés, fonts, documents and history, with every path pointing at the new home", () => {
    const source = sourceHome();
    const target = tempHome("target");

    const exported = exportHome(source, { passphrase: PASSPHRASE });
    const imported = importHome(exported.bytes, target, { passphrase: PASSPHRASE });

    for (const file of [target.profile, target.campaign, target.companies, target.resumeSource, target.database]) expect(existsSync(file), file).toBe(true);
    expect(readFileSync(join(target.home, "resumes", "alex-security.pdf"))).toEqual(PDF);
    expect(readFileSync(join(target.fonts, "body.ttf")).toString()).toBe("font-bytes");
    const tailored = join(target.documents, "app_approved", "resume-1234abcd.pdf");
    expect(readFileSync(tailored)).toEqual(PDF);
    expect(JSON.parse(readFileSync(target.profile, "utf8")).resumes[0].path).toBe(join(target.home, "resumes", "alex-security.pdf"));

    const db = openDatabase(target.database);
    try {
      const ids = (table: string, column = "id") => (db.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY 1`).all() as Array<{ id: string }>).map((row) => row.id);
      expect(ids("applications")).toEqual(["app_approved", "app_sent", "app_waiting"]);
      expect(ids("jobs")).toEqual(["job_approved", "job_sent", "job_waiting"]);
      expect(ids("evaluations", "job_id")).toEqual(["job_approved", "job_sent", "job_waiting"]);
      expect(getApplication(db, "app_waiting")?.resumePath).toBe(join(target.home, "resumes", "alex-security.pdf"));
      expect(getApplication(db, "app_sent")?.artifactPath).toBe(join(target.artifacts, "shot.png"));
      expect((db.prepare("SELECT path FROM tailored_documents").get() as { path: string }).path).toBe(tailored);
      expect(JSON.parse(listEvents(db, "document.resume_tailored")[0]?.payload ?? "{}").path).toBe(tailored);
      expect(JSON.stringify(db.prepare("SELECT * FROM applications").all())).not.toContain(source.home);
    } finally {
      db.close();
    }
    expect(exported.summary).toMatchObject({ jobsKept: 3, jobsLeftOut: 1, applications: { submitted: 1, approved: 1, awaiting_approval: 1 } });
    expect(imported).toMatchObject({ files: exported.summary.files, approvalsVoided: 1 });
  });

  it("voids approvals, because the packet now names files at the new home", () => {
    const source = sourceHome();
    const target = tempHome("target");
    importHome(exportHome(source, { passphrase: PASSPHRASE }).bytes, target, { passphrase: PASSPHRASE });

    const db = openDatabase(target.database);
    try {
      const approved = getApplication(db, "app_approved");
      const job = getJob(db, "job_approved");
      expect(approved).toMatchObject({ status: "awaiting_approval", approvedAt: null });
      expect(approved?.packetHash).toBe(computePacketHash(buildPacket(approved as Application, job!)));
      expect(getApplication(db, "app_sent")).toMatchObject({ status: "submitted", submittedAt: "2026-10-02T00:00:00.000Z" });
      expect(listEvents(db, "application.approval_voided").map((event) => event.subject)).toEqual(["app_approved"]);
      expect(listEvents(db, "home.imported")).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("never carries secrets, screenshots, browser sessions or backups", () => {
    const source = sourceHome();
    const { header, files } = unpackFiles(decryptBundle(exportHome(source, { passphrase: PASSPHRASE }).bytes, PASSPHRASE));
    expect(files.map((file) => file.path).sort()).toEqual([
      "campaign.json",
      "companies.json",
      "data/autoapply.sqlite",
      "documents/app_approved/resume-1234abcd.pdf",
      "profile.json",
      "resume.json",
      "resumes/alex-security.pdf",
      "resumes/fonts/body.ttf",
    ]);
    for (const file of files) expect(file.bytes.includes(Buffer.from(SECRET)), file.path).toBe(false);
    expect(JSON.stringify(header)).not.toContain(source.home);

    const target = tempHome("target");
    importHome(exportHome(source, { passphrase: PASSPHRASE }).bytes, target, { passphrase: PASSPHRASE });
    for (const file of allFiles(target.home)) expect(readFileSync(file).includes(Buffer.from(SECRET)), file).toBe(false);
  });
});

describe("protecting a bundle", () => {
  it("refuses a wrong passphrase, a changed bundle and a file that is not a bundle", () => {
    const bytes = exportHome(sourceHome(), { passphrase: PASSPHRASE }).bytes;
    const target = tempHome("target");
    expect(errorCode(() => importHome(bytes, target, { passphrase: "a different passphrase 2026" }))).toBe("bundle_decrypt_failed");
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 0xff;
    expect(errorCode(() => importHome(changed, target, { passphrase: PASSPHRASE }))).toBe("bundle_decrypt_failed");
    expect(errorCode(() => importHome(Buffer.from("not a bundle at all"), target, { passphrase: PASSPHRASE }))).toBe("bundle_invalid");
    expect(existsSync(target.profile)).toBe(false);
  });

  it("refuses a short passphrase", () => {
    expect(errorCode(() => exportHome(sourceHome(), { passphrase: "short" }))).toBe("bundle_passphrase_weak");
  });

  it("refuses an entry that would land outside the new home", () => {
    const header = Buffer.from(JSON.stringify({ format: "autoapply-home", version: 1, createdAt: "2026-11-01T00:00:00.000Z", summary: {}, files: [{ path: "../escape.txt", size: 1, sha256: "a".repeat(64) }] }));
    const length = Buffer.alloc(4);
    length.writeUInt32BE(header.length);
    expect(errorCode(() => unpackFiles(gzipSync(Buffer.concat([length, header, Buffer.from("x")]))))).toBe("bundle_invalid");
  });
});

describe("importing over an existing workspace", () => {
  it("refuses unless forced, and keeps a backup of what it replaces", () => {
    const bytes = exportHome(sourceHome(), { passphrase: PASSPHRASE }).bytes;
    const target = tempHome("target");
    writeFileSync(target.profile, '{"old":true}');

    expect(errorCode(() => importHome(bytes, target, { passphrase: PASSPHRASE }))).toBe("home_not_empty");
    expect(readFileSync(target.profile, "utf8")).toBe('{"old":true}');

    const result = importHome(bytes, target, { passphrase: PASSPHRASE, force: true });
    expect(result.backup).toBeTruthy();
    expect(readFileSync(join(result.backup as string, "profile.json"), "utf8")).toBe('{"old":true}');
    expect(JSON.parse(readFileSync(target.profile, "utf8")).identity.fullName).toBe("Alex Candidate");
  });
});
