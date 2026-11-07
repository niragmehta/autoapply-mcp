import { z } from "zod";
import { readCompanyFile, upsertCompany } from "../../config/companies.js";
import type { Db } from "../../db/database.js";
import { appendEvent } from "../../db/repositories/events.js";
import { AtsKindSchema, CompanySchema } from "../../domain/campaign.js";
import { invalidateWorkspace } from "../../runner/workspace.js";
import { verifyBoard } from "../../sources/registry.js";
import { AppError } from "../../util/errors.js";
import { JsonReply, parseBody, parseParams, type Router } from "../router.js";

/** Company boards: list with pipeline counts, add a verified board, toggle or retier one. */

const NameParams = z.object({ name: z.string().trim().min(1).max(200) });

const tags = z.array(z.string().trim().min(1).max(60)).max(30);

const AddBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    ats: AtsKindSchema,
    board: z.string().trim().min(1).max(300),
    tier: z.enum(["A", "B", "C"]).optional(),
    tags: tags.optional(),
    query: z.string().trim().max(200).optional(),
    region: z.enum(["global", "eu"]).optional(),
  })
  .strict();

const PatchBody = z
  .object({ active: z.boolean().optional(), tier: z.enum(["A", "B", "C"]).optional(), tags: tags.optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "nothing to change" });

type Row = Record<string, unknown>;

type CompanyStats = { jobs: number; accepted: number; lastSeenAt: string | null; applications: number; submitted: number };

function statsByCompany(db: Db): Map<string, CompanyStats> {
  const stats = new Map<string, CompanyStats>();
  const blank = (): CompanyStats => ({ jobs: 0, accepted: 0, lastSeenAt: null, applications: 0, submitted: 0 });
  const jobRows = db
    .prepare(
      `SELECT lower(j.company_name) AS name, COUNT(*) AS jobs, SUM(CASE WHEN e.decision = 'accept' THEN 1 ELSE 0 END) AS accepted,
              MAX(j.last_seen_at) AS last_seen
       FROM jobs j LEFT JOIN evaluations e ON e.job_id = j.id GROUP BY lower(j.company_name)`,
    )
    .all() as Row[];
  for (const row of jobRows) {
    stats.set(String(row.name), {
      ...blank(),
      jobs: Number(row.jobs ?? 0),
      accepted: Number(row.accepted ?? 0),
      lastSeenAt: row.last_seen ? String(row.last_seen) : null,
    });
  }
  const applicationRows = db
    .prepare(
      `SELECT lower(j.company_name) AS name, COUNT(*) AS total, SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END) AS submitted
       FROM applications a JOIN jobs j ON j.id = a.job_id GROUP BY lower(j.company_name)`,
    )
    .all() as Row[];
  for (const row of applicationRows) {
    const name = String(row.name);
    stats.set(name, { ...(stats.get(name) ?? blank()), applications: Number(row.total ?? 0), submitted: Number(row.submitted ?? 0) });
  }
  return stats;
}

export function registerRoutes(router: Router): void {
  router.get("/api/companies", ({ ctx }) => {
    const workspace = ctx.workspace();
    const stats = statsByCompany(workspace.db);
    const companies = workspace.companies.map((company) => ({
      ...company,
      stats: stats.get(company.name.toLowerCase()) ?? { jobs: 0, accepted: 0, lastSeenAt: null, applications: 0, submitted: 0 },
    }));
    return {
      total: companies.length,
      active: companies.filter((company) => company.active).length,
      companies: [...companies].sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  router.post("/api/companies", async (request) => {
    const body = parseBody(AddBody, request);
    const workspace = request.ctx.workspace();
    const candidate = CompanySchema.parse(body);
    const verification = await verifyBoard(candidate);
    if (!verification.ok) {
      const hint = "Copy the board slug from the employer's own careers page URL. A board that serves no postings is not saved.";
      return new JsonReply(422, {
        error: { code: "board_not_verified", message: `${verification.detail}. ${hint}` },
        saved: false,
        verified: false,
        company: candidate.name,
        reason: verification.detail,
        hint,
      });
    }
    const result = upsertCompany(workspace.paths.companies, candidate);
    appendEvent(workspace.db, "board.added", "campaign", {
      company: candidate.name,
      ats: candidate.ats,
      board: candidate.board,
      action: result.action,
      via: "dashboard",
    });
    invalidateWorkspace();
    return new JsonReply(201, {
      saved: true,
      verified: true,
      action: result.action,
      company: result.company,
      postings: verification.postings,
      sampleTitles: verification.sampleTitles,
      totalBoards: result.total,
    });
  });

  router.patch("/api/companies/:name", (request) => {
    const { name } = parseParams(NameParams, request);
    const body = parseBody(PatchBody, request);
    const workspace = request.ctx.workspace();
    const existing = readCompanyFile(workspace.paths.companies).find((company) => company.name.toLowerCase() === name.toLowerCase());
    if (!existing) throw new AppError("company_not_found", `no company named ${name} in companies.json`);
    const result = upsertCompany(workspace.paths.companies, { ...existing, ...body });
    appendEvent(workspace.db, "board.updated", "campaign", { company: existing.name, changes: body, via: "dashboard" });
    invalidateWorkspace();
    return { company: result.company };
  });
}
