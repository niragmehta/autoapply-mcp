import { describe, expect, it } from "vitest";
import { applyVariant, placedBullets } from "../src/documents/model.js";
import { parseResumeSource, stripMetricMarkers } from "../src/documents/resumeSource.js";
import { dropOrder, tailorResume } from "../src/documents/tailor.js";
import { AppError } from "../src/util/errors.js";
import { docJob, docProfile, exampleResume, exampleResumeJson } from "./documents.fixtures.js";

const source = exampleResume();
const profile = docProfile();
const groupsOf = (document: ReturnType<typeof tailorResume>["document"]) =>
  document.experience[0]?.roles[0]?.groups.map((group) => [group.id, group.bullets.map((bullet) => bullet.id)]);

describe("tailorResume", () => {
  it("moves the groups, bullets and skills a platform posting asks for to the top", () => {
    const tailored = tailorResume(source, "backend", docJob(), profile);
    expect(groupsOf(tailored.document)).toEqual([
      ["platform", ["ci-rebuild", "k8s-migration", "service-template"]],
      ["reliability", ["payments-latency", "incident-paging", "payments-cache", "canary-releases"]],
      ["data", ["reporting-airflow", "shipments-sharding", "backfill-framework"]],
    ]);
    expect(tailored.document.skills.map((category) => category.id)).toEqual(["practices", "infrastructure", "languages", "tools", "data"]);
    expect(tailored.document.skills[1]?.terms).toEqual(["Kubernetes", "Terraform", "AWS", "Docker", "GCP"]);
    expect(tailored.headline).toEqual({ text: "Backend Software Engineer", source: "variant" });
  });

  it("explains every move with the posting terms behind it", () => {
    const { changes } = tailorResume(source, "backend", docJob(), profile);
    const group = changes.find((change) => change.kind === "group-moved");
    expect(group).toMatchObject({ target: "platform", from: 3, to: 1 });
    expect(group?.terms).toEqual(expect.arrayContaining(["platform", "ci/cd pipeline", "github actions"]));
    expect(group?.message).toMatch(/^moved group "platform" from 3 to 1 in Northwind Logistics \/ Senior Software Engineer .+ because of terms \[/);
    expect(changes.find((change) => change.target === "ci-rebuild")).toMatchObject({ kind: "bullet-moved", from: 2, to: 1 });
    expect(changes.find((change) => change.target === "Kafka")).toMatchObject({ kind: "skill-term-moved", terms: ["kafka"] });
    // Only upward moves are logged; an item pushed down by another has nothing to explain.
    expect(changes.every((change) => change.from === undefined || (change.to ?? 0) < change.from)).toBe(true);
  });

  it("never adds, rewords or removes content when nothing needs dropping", () => {
    const tailored = tailorResume(source, "backend", docJob(), profile);
    const variant = applyVariant(source, "backend").document;
    const texts = (document: typeof variant) => placedBullets(document).map(({ bullet }) => bullet.text).sort();
    expect(texts(tailored.document)).toEqual(texts(variant));
    const terms = (document: typeof variant) => document.skills.flatMap((category) => category.terms).sort();
    expect(terms(tailored.document)).toEqual(terms(variant));
    expect(tailored.document.additional).toEqual(variant.additional);
    expect(tailored.document.education).toEqual(variant.education);
    expect(tailored.dropped).toEqual([]);
  });

  it("is deterministic", () => {
    expect(tailorResume(source, "backend", docJob(), profile)).toEqual(tailorResume(source, "backend", docJob(), profile));
  });

  it("keeps the variant's order when the posting shares nothing with the resume", () => {
    const unrelated = docJob({ title: "Pastry Chef", descriptionText: "Requirements\n- Laminated dough\n- Sourdough starters" });
    const tailored = tailorResume(source, "backend", unrelated, profile);
    expect(tailored.document).toEqual(applyVariant(source, "backend").document);
    expect(tailored.changes).toEqual([]);
  });

  it("keeps a variant's bullet order when the posting shares nothing with the resume", () => {
    const ordered = parseResumeSource({ ...(exampleResumeJson() as object), variants: { ops: { bulletOrder: ["canary-releases", "incident-paging"] } } });
    const unrelated = docJob({ title: "Pastry Chef", descriptionText: "Requirements\n- Laminated dough\n- Sourdough starters" });
    const tailored = tailorResume(ordered, "ops", unrelated, profile);
    expect(tailored.document).toEqual(applyVariant(ordered, "ops").document);
    expect(groupsOf(tailored.document)?.[0]).toEqual(["reliability", ["canary-releases", "incident-paging", "payments-cache", "payments-latency"]]);
  });

  it("drops the least relevant bullets first, never below the per-role minimum or a group's last bullet", () => {
    const tailored = tailorResume(source, "backend", docJob(), profile, { dropBullets: 3 });
    expect(tailored.droppable.slice(0, 3)).toEqual(["backfill-framework", "shipments-sharding", "canary-releases"]);
    expect(tailored.dropped).toEqual(["backfill-framework", "shipments-sharding", "canary-releases"]);
    const remaining = placedBullets(tailored.document).map((spot) => spot.bullet.id);
    expect(remaining).not.toContain("canary-releases");
    expect(remaining).toContain("reporting-airflow");
    // The internship role has a single bullet and is never touched.
    expect(remaining).toContain("load-testing");
    expect(tailored.changes.filter((change) => change.kind === "bullet-dropped").map((change) => change.target)).toEqual(tailored.dropped);

    // Every group keeps one bullet and the role keeps its minimum.
    const all = tailorResume(source, "backend", docJob(), profile, { dropBullets: 99, minBulletsPerRole: 4 });
    const role = all.document.experience[0]?.roles[0];
    expect(role?.groups).toHaveLength(3);
    expect(role?.groups.reduce((sum, group) => sum + group.bullets.length, 0)).toBe(4);
    expect(all.document.experience[1]?.roles[0]?.groups[0]?.bullets).toHaveLength(1);
  });

  it("orders drops by relevance, later bullets first among equals", () => {
    const experience = [
      {
        organization: "Northwind",
        location: "",
        roles: [
          {
            title: "Engineer",
            dates: "2020",
            groups: [
              { id: "a", bullets: ["a1", "a2"].map((id) => ({ id, text: id, factIds: [], tags: [], keep: false, reserve: false, replaces: [], upgrade: false })) },
              { id: "b", bullets: ["b1", "b2", "b3"].map((id) => ({ id, text: id, factIds: [], tags: [], keep: false, reserve: false, replaces: [], upgrade: false })) },
            ],
          },
        ],
      },
    ];
    const scores: Record<string, number> = { a1: 5, a2: 0, b1: 3, b2: 0, b3: 1 };
    expect(dropOrder(experience, (id) => scores[id] ?? 0, 2)).toEqual(["b2", "a2", "b3"]);
    expect(dropOrder(experience, (id) => scores[id] ?? 0, 5)).toEqual([]);
  });

  it("uses an agent's headline only when it passes the fact check", () => {
    const accepted = tailorResume(source, "backend", docJob(), profile, { headline: "Backend Software Engineer | Kubernetes and Distributed Systems" });
    expect(accepted.headline).toEqual({ text: "Backend Software Engineer | Kubernetes and Distributed Systems", source: "override" });
    expect(accepted.document.header.headline).toBe("Backend Software Engineer | Kubernetes and Distributed Systems");
    expect(accepted.changes[0]).toMatchObject({ kind: "headline" });

    expect(() => tailorResume(source, "backend", docJob(), profile, { headline: "Staff Platform Engineer | Rust" })).toThrow(AppError);
    try {
      tailorResume(source, "backend", docJob(), profile, { headline: "Senior Platform Engineer" });
      expect.unreachable("the target job's title is not the candidate's");
    } catch (error) {
      expect((error as AppError).code).toBe("fact_check_failed");
    }
  });

  it("starts from the source order for a variant resume.json does not define, and says so", () => {
    const tailored = tailorResume(source, "security", docJob(), profile);
    expect(tailored.variantFound).toBe(false);
    expect(tailored.changes[0]).toMatchObject({ kind: "variant", target: "security" });
    expect(tailored.headline.source).toBe("source");
  });

  it("counts tags and the tags of linked facts as a bullet's terms without printing them", () => {
    const tagged = parseResumeSource({
      ...(exampleResumeJson() as object),
      experience: [
        {
          organization: "Northwind Logistics",
          roles: [
            {
              title: "Engineer",
              dates: "2021",
              groups: [
                {
                  id: "g",
                  bullets: [
                    { id: "plain", text: "Kept the lights on." },
                    { id: "linked", text: "Made the payments API faster.", factIds: ["scaling"] },
                  ],
                },
              ],
            },
          ],
        },
      ],
      variants: {},
    });
    const job = docJob({ title: "Engineer", descriptionText: "Requirements\n- Distributed systems and caching" });
    const tailored = tailorResume(tagged, "none", job, profile);
    expect(groupsOf(tailored.document)).toEqual([["g", ["linked", "plain"]]]);
    expect(placedBullets(tailored.document).map((spot) => stripMetricMarkers(spot.bullet.text))).toEqual([
      "Made the payments API faster.",
      "Kept the lights on.",
    ]);
  });
});
