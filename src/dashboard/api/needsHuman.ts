import { z } from "zod";
import { setApplicationContent } from "../../services/applications.js";
import { sha256 } from "../../util/hash.js";
import { toErrorMessage } from "../../util/errors.js";
import { isUnresolved, listHeldApplications, previousHumanAnswers } from "../queries/applications.js";
import { artifactNameOf, listArtifacts } from "../queries/artifacts.js";
import { parseBody, type Router } from "../router.js";

/**
 * The needs-human queue, grouped by question: the same question recurs across
 * employers, so one decision can release many applications at once.
 */

type GroupMember = { applicationId: string; company: string; title: string; questionKey: string; screenshot: string | null };

type QuestionGroup = {
  key: string;
  label: string;
  category: string;
  guidance: string;
  previousAnswers: string[];
  applications: GroupMember[];
};

const BulkAnswerBody = z
  .object({
    items: z
      .array(
        z
          .object({
            applicationId: z.string().trim().min(1).max(200),
            questionKey: z.string().min(1).max(300),
            answer: z.string().trim().min(1).max(20_000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

/** The last "[timestamp] aborted: reason" line the submission engine left in the notes. */
function lastNote(notes: string): string {
  const lines = notes.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  return (lines.at(-1) ?? "").replace(/^\[[^\]]+\]\s*/, "").slice(0, 300);
}

export function registerRoutes(router: Router): void {
  router.get("/api/needs-human", ({ ctx }) => {
    const workspace = ctx.workspace();
    const held = listHeldApplications(workspace.db);
    const screenshots = listArtifacts(workspace.paths.artifacts);
    const groups = new Map<string, QuestionGroup>();
    const other: Array<Omit<GroupMember, "questionKey"> & { reason: string }> = [];

    for (const application of held) {
      const screenshot = artifactNameOf(application.artifactPath) ?? screenshots.get(application.id)?.[0]?.name ?? null;
      const member = { applicationId: application.id, company: application.company, title: application.title, screenshot };
      const blocked = application.answers.filter(isUnresolved);
      if (blocked.length === 0) {
        other.push({ ...member, reason: lastNote(application.notes) || "held for review; open the application for details" });
        continue;
      }
      for (const answer of blocked) {
        const normalized = answer.label.trim().toLowerCase();
        const group = groups.get(normalized) ?? {
          key: sha256(normalized).slice(0, 16),
          label: answer.label.trim(),
          category: answer.category,
          guidance: "",
          previousAnswers: [],
          applications: [],
        };
        groups.set(normalized, {
          ...group,
          guidance: group.guidance || answer.guidance,
          applications: [...group.applications, { ...member, questionKey: answer.questionKey }],
        });
      }
    }

    const previous = previousHumanAnswers(workspace.db, new Set(groups.keys()));
    const ordered = [...groups.entries()]
      .map(([normalized, group]) => ({ ...group, previousAnswers: previous.get(normalized) ?? [] }))
      .sort((a, b) => b.applications.length - a.applications.length || a.label.localeCompare(b.label));
    return { applications: held.length, questions: ordered, otherBlockers: other };
  });

  router.post("/api/needs-human/answers", (request) => {
    const body = parseBody(BulkAnswerBody, request);
    const workspace = request.ctx.workspace();
    const byApplication = new Map<string, Array<{ questionKey: string; answer: string }>>();
    for (const item of body.items) {
      byApplication.set(item.applicationId, [
        ...(byApplication.get(item.applicationId) ?? []),
        { questionKey: item.questionKey, answer: item.answer },
      ]);
    }
    // Each application is updated on its own, so one bad key does not hold back the rest.
    const results = [...byApplication.entries()].map(([applicationId, answers]) => {
      try {
        const updated = setApplicationContent(workspace, { applicationId, answers });
        return { applicationId, ok: true, status: updated.status, outstanding: updated.outstandingQuestions };
      } catch (error) {
        return { applicationId, ok: false, error: toErrorMessage(error) };
      }
    });
    return {
      updated: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      results,
    };
  });
}
