import { describe, expect, it } from "vitest";
import { applyVariant, placedBullets } from "../src/documents/model.js";
import { parseResumeSource } from "../src/documents/resumeSource.js";
import { tailorResume } from "../src/documents/tailor.js";
import { DocumentsPolicySchema } from "../src/domain/policies/documents.js";
import { docJob, docProfile } from "./documents.fixtures.js";

/** Reserve bullets and skills: content held back from the fixed variants that tailoring may bring in. */

const profile = docProfile();

function resume(overrides: { cloud?: unknown[]; ai?: unknown[]; skills?: unknown; variants?: unknown } = {}) {
  return parseResumeSource({
    version: 1,
    header: { name: "Alex Candidate", headline: "Security Engineer", contact: [{ text: "alex@example.com", href: "mailto:alex@example.com" }] },
    experience: [
      {
        organization: "Northwind Logistics",
        location: "Toronto, Canada",
        roles: [
          {
            title: "Security Engineer",
            dates: "2021 - Present",
            groups: [
              {
                id: "cloud",
                label: "Cloud security",
                bullets: overrides.cloud ?? [
                  { id: "cloud-policy", text: "Built Azure Policy governance controls for production subscriptions." },
                  { id: "cloud-firewall", text: "Built host firewall enforcement for Windows servers." },
                  { id: "cloud-alerts", text: "Added alerting for extension failures." },
                  {
                    id: "cloud-policy-figures",
                    reserve: true,
                    upgrade: true,
                    replaces: ["cloud-policy"],
                    text: "Authored Azure Policies that disabled anonymous access on [[16,000]] storage accounts.",
                  },
                ],
              },
              {
                id: "ai",
                label: "AI security",
                bullets: overrides.ai ?? [
                  { id: "ai-guardrail", text: "Built guardrails for AI agents that gate tool calls." },
                  {
                    id: "ai-benchmark",
                    reserve: true,
                    text: "Built a prompt injection benchmark of adversarial and benign cases to evaluate agent defenses.",
                    tags: ["red teaming", "llm"],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    skills: overrides.skills ?? { categories: [{ id: "languages", terms: ["Python", "C#"], reserve: ["Rust", "Go"] }] },
    variants: overrides.variants ?? { main: { groupOrder: ["ai", "cloud"] } },
  });
}

const AI_POSTING = docJob({
  title: "AI Security Engineer",
  descriptionText: [
    "Requirements",
    "- Experience defending LLM agents against prompt injection",
    "- Red teaming of AI systems and adversarial evaluation",
    "- Rust or Go",
  ].join("\n"),
});
const UNRELATED = docJob({ title: "Pastry Chef", descriptionText: "Requirements\n- Laminated dough\n- Sourdough starters" });

const printedIds = (document: ReturnType<typeof tailorResume>["document"]) => placedBullets(document).map(({ bullet }) => bullet.id);
const groupBullets = (document: ReturnType<typeof tailorResume>["document"], groupId: string) =>
  document.experience[0]?.roles[0]?.groups.find((group) => group.id === groupId)?.bullets.map((bullet) => bullet.id);

describe("reserve bullets on fixed variants", () => {
  it("keeps reserves off the printed variant and hands them to tailoring", () => {
    const { document, reserves } = applyVariant(resume(), "main");
    expect(printedIds(document)).toEqual(["ai-guardrail", "cloud-policy", "cloud-firewall", "cloud-alerts"]);
    expect(reserves.map((reserve) => [reserve.bullet.id, reserve.groupId])).toEqual([
      ["cloud-policy-figures", "cloud"],
      ["ai-benchmark", "ai"],
    ]);
  });

  it("prints a reserve a variant lists, and never offers one a variant excludes", () => {
    const included = applyVariant(resume({ variants: { main: { includeBullets: ["ai-guardrail", "ai-benchmark", "cloud-policy"] } } }), "main");
    expect(printedIds(included.document)).toEqual(["cloud-policy", "ai-guardrail", "ai-benchmark"]);
    expect(included.reserves.map((reserve) => reserve.bullet.id)).toEqual(["cloud-policy-figures"]);

    const excluded = applyVariant(resume({ variants: { main: { excludeBullets: ["ai-benchmark"] } } }), "main");
    expect(excluded.reserves.map((reserve) => reserve.bullet.id)).toEqual(["cloud-policy-figures"]);
  });
});

const topicSwaps = (tailored: ReturnType<typeof tailorResume>) => tailored.swaps.filter((swap) => !swap.upgrade);
const BENCHMARK = "Built a prompt injection benchmark of adversarial and benign cases to evaluate agent defenses.";

describe("upgrades: a stronger statement of the same work", () => {
  it("applies an upgrade even when no swaps are allowed, exactly where the bullet it restates stood", () => {
    const tailored = tailorResume(resume(), "main", UNRELATED, profile);

    expect(tailored.swaps).toEqual([{ in: "cloud-policy-figures", out: "cloud-policy", upgrade: true, inScore: 0, outScore: 0 }]);
    expect(groupBullets(tailored.document, "cloud")).toEqual(["cloud-policy-figures", "cloud-firewall", "cloud-alerts"]);
    expect(tailored.changes.find((entry) => entry.kind === "bullet-swapped")?.message).toMatch(
      /^replaced "cloud-policy" with reserve "cloud-policy-figures", a stronger statement of the same work/,
    );
  });

  it("keeps the printed bullet when it suits the posting better than its upgrade", () => {
    const governance = docJob({
      title: "Cloud Governance Engineer",
      descriptionText: "Requirements\n- Azure Policy governance controls\n- Securing production subscriptions",
    });
    const tailored = tailorResume(resume(), "main", governance, profile, { maxSwaps: 3 });
    expect(tailored.swaps.map((swap) => swap.in)).not.toContain("cloud-policy-figures");
    expect(printedIds(tailored.document)).toContain("cloud-policy");
  });

  it("does not count against the swap limit", () => {
    const tailored = tailorResume(resume(), "main", AI_POSTING, profile, { maxSwaps: 1 });
    expect(tailored.swaps.map((swap) => [swap.in, swap.out, swap.upgrade])).toEqual([
      ["cloud-policy-figures", "cloud-policy", true],
      ["ai-benchmark", "cloud-alerts", false],
    ]);
  });
});

describe("swapping reserves into a tailored resume", () => {
  it("swaps in nothing but upgrades unless swaps are allowed", () => {
    const tailored = tailorResume(resume(), "main", AI_POSTING, profile);
    expect(topicSwaps(tailored)).toEqual([]);
    expect(printedIds(tailored.document).sort()).toEqual(["ai-guardrail", "cloud-alerts", "cloud-firewall", "cloud-policy-figures"]);
  });

  it("swaps in a reserve that clearly suits the posting for the least relevant printed bullet, and says why", () => {
    const tailored = tailorResume(resume(), "main", AI_POSTING, profile, { maxSwaps: 1 });

    expect(topicSwaps(tailored)).toEqual([expect.objectContaining({ in: "ai-benchmark", out: "cloud-alerts", upgrade: false })]);
    expect(topicSwaps(tailored)[0]?.inScore).toBeGreaterThanOrEqual(4);
    expect(groupBullets(tailored.document, "ai")).toEqual(["ai-benchmark", "ai-guardrail"]);
    expect(printedIds(tailored.document)).toHaveLength(4);
    const change = tailored.changes.find((entry) => entry.kind === "bullet-swapped" && entry.target === "ai-benchmark");
    expect(change?.message).toMatch(/^swapped reserve "ai-benchmark" in for "cloud-alerts" \(relevance [\d.]+ vs 0\) because of terms \[/);
    expect(change?.terms).toEqual(expect.arrayContaining(["prompt injection"]));
  });

  it("leaves a reserve out when it only brushes the posting", () => {
    const brushing = docJob({ title: "Platform Engineer", descriptionText: "About us\nWe like tools.\nRequirements\n- Some exposure to LLM tooling" });
    const tailored = tailorResume(resume(), "main", brushing, profile, { maxSwaps: 3 });
    expect(tailored.swaps.map((swap) => swap.in)).not.toContain("ai-benchmark");
  });

  it("makes the biggest gains first and stops at the limit", () => {
    const two = resume({
      ai: [
        { id: "ai-guardrail", text: "Built guardrails for AI agents that gate tool calls." },
        { id: "ai-benchmark", reserve: true, text: BENCHMARK, tags: ["red teaming", "llm"] },
        { id: "ai-rust-sdk", reserve: true, text: "Wrote a Rust library that lets LLM agents call tools through policy checks." },
      ],
    });
    const pairs = (maxSwaps: number) => topicSwaps(tailorResume(two, "main", AI_POSTING, profile, { maxSwaps })).map((swap) => [swap.in, swap.out]);
    expect(pairs(2)).toEqual([
      ["ai-benchmark", "cloud-alerts"],
      ["ai-rust-sdk", "cloud-firewall"],
    ]);
    expect(pairs(1)).toEqual([["ai-benchmark", "cloud-alerts"]]);
  });

  it("only replaces the bullets a reserve names", () => {
    const named = resume({
      ai: [
        { id: "ai-guardrail", text: "Built guardrails for AI agents that gate tool calls." },
        { id: "ai-benchmark", reserve: true, replaces: ["cloud-firewall"], text: BENCHMARK },
      ],
    });
    const tailored = tailorResume(named, "main", AI_POSTING, profile, { maxSwaps: 1 });
    expect(topicSwaps(tailored)).toEqual([expect.objectContaining({ in: "ai-benchmark", out: "cloud-firewall" })]);
  });

  it("never empties a group to make room", () => {
    const tight = resume({
      cloud: [{ id: "cloud-alerts", text: "Added alerting for extension failures." }],
      ai: [
        { id: "ai-tools", text: "Maintained build scripts for internal tools." },
        { id: "ai-benchmark", reserve: true, text: BENCHMARK },
      ],
    });
    const tailored = tailorResume(tight, "main", AI_POSTING, profile, { maxSwaps: 3 });
    // Both printed bullets are irrelevant and the later one would go first, but it is its group's only bullet.
    expect(tailored.swaps).toEqual([expect.objectContaining({ in: "ai-benchmark", out: "ai-tools" })]);
    expect(groupBullets(tailored.document, "cloud")).toEqual(["cloud-alerts"]);
  });

  it("brings back a group that prints only when one of its reserves is swapped in", () => {
    const reserveOnly = resume({ ai: [{ id: "ai-benchmark", reserve: true, text: BENCHMARK }] });
    expect(applyVariant(reserveOnly, "main").document.experience[0]?.roles[0]?.groups.map((group) => group.id)).toEqual(["cloud"]);
    const tailored = tailorResume(reserveOnly, "main", AI_POSTING, profile, { maxSwaps: 1 });
    expect(groupBullets(tailored.document, "ai")).toEqual(["ai-benchmark"]);
    expect(tailored.document.experience[0]?.roles[0]?.groups.find((group) => group.id === "ai")?.label).toBe("AI security");
  });
});

describe("bullets marked keep", () => {
  const cloud = (keepId: string) =>
    [
      { id: "cloud-policy", text: "Built Azure Policy governance controls for production subscriptions." },
      { id: "cloud-firewall", text: "Built host firewall enforcement for Windows servers." },
      { id: "cloud-alerts", text: "Added alerting for extension failures." },
      { id: "cloud-policy-figures", reserve: true, upgrade: true, replaces: ["cloud-policy"], text: "Authored Azure Policies for [[16,000]] storage accounts." },
    ].map((bullet) => (bullet.id === keepId ? { ...bullet, keep: true } : bullet));

  it("are never swapped out or dropped to fit the page", () => {
    const kept = resume({ cloud: cloud("cloud-alerts") });
    const tailored = tailorResume(kept, "main", AI_POSTING, profile, { maxSwaps: 1 });
    expect(topicSwaps(tailored)).toEqual([expect.objectContaining({ in: "ai-benchmark", out: "cloud-firewall" })]);
    expect(tailored.droppable).not.toContain("cloud-alerts");
    expect(tailorResume(kept, "main", AI_POSTING, profile, { maxSwaps: 1, dropBullets: 10 }).dropped).not.toContain("cloud-alerts");
  });

  it("stay kept when an upgrade restates them", () => {
    const kept = resume({ cloud: cloud("cloud-policy") });
    const tailored = tailorResume(kept, "main", AI_POSTING, profile, { maxSwaps: 3 });
    expect(printedIds(tailored.document)).toContain("cloud-policy-figures");
    expect(topicSwaps(tailored).map((swap) => swap.out)).not.toContain("cloud-policy");
    expect(tailored.droppable).not.toContain("cloud-policy-figures");
  });

  it("move ahead of bullets that share nothing with the posting, and say why", () => {
    const tailored = tailorResume(resume({ cloud: cloud("cloud-alerts") }), "main", UNRELATED, profile);
    expect(groupBullets(tailored.document, "cloud")).toEqual(["cloud-alerts", "cloud-policy-figures", "cloud-firewall"]);
    expect(tailored.changes.find((change) => change.target === "cloud-alerts")?.message).toMatch(/from 3 to 1 .* because it is marked keep$/);
  });

  it("stay ahead of a bullet that suits the posting only a little better", () => {
    const posting = docJob({ title: "Firewall Engineer", descriptionText: "Requirements\n- Alerting" });
    const tailored = tailorResume(resume({ cloud: cloud("cloud-alerts") }), "main", posting, profile);
    const score = (id: string) => tailored.scores.find((entry) => entry.id === id)?.score ?? 0;
    // cloud-firewall fits better, by less than one requirement term.
    expect(score("cloud-firewall")).toBeGreaterThan(score("cloud-alerts"));
    expect(score("cloud-firewall") - score("cloud-alerts")).toBeLessThan(2);
    expect(groupBullets(tailored.document, "cloud")).toEqual(["cloud-alerts", "cloud-firewall", "cloud-policy-figures"]);
  });

  it("give way to a bullet that clearly suits the posting better", () => {
    const firewall = docJob({ title: "Host Security Engineer", descriptionText: "Requirements\n- Host firewall enforcement for Windows servers" });
    const tailored = tailorResume(resume({ cloud: cloud("cloud-alerts") }), "main", firewall, profile);
    expect(groupBullets(tailored.document, "cloud")).toEqual(["cloud-firewall", "cloud-alerts", "cloud-policy-figures"]);
    expect(tailored.changes.find((change) => change.target === "cloud-firewall")?.message).toMatch(/from 2 to 1 .* because of terms \[/);
  });

  it("are ordered with everything else when a role prints as one list", () => {
    const oneList = parseResumeSource({
      version: 1,
      header: { name: "Alex Candidate" },
      experience: [
        {
          organization: "Northwind Logistics",
          roles: [
            {
              title: "Security Engineer",
              dates: "2021 - Present",
              groups: [
                {
                  id: "work",
                  bullets: [
                    { id: "cloud-policy", text: "Built Azure Policy governance controls for production subscriptions.", keep: true },
                    { id: "cloud-alerts", text: "Added alerting for extension failures." },
                    { id: "ai-guardrail", text: "Built guardrails for LLM agents that block prompt injection in tool calls." },
                    { id: "ai-benchmark", reserve: true, text: BENCHMARK, tags: ["red teaming", "llm"] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const tailored = tailorResume(oneList, "main", AI_POSTING, profile, { maxSwaps: 1 });
    expect(tailored.document.experience[0]?.roles[0]?.groups.map((group) => [group.id, group.label])).toEqual([["work", undefined]]);
    // The kept bullet is never the one swapped out, but it no longer outranks work that clearly suits the posting better.
    expect(tailored.swaps).toEqual([expect.objectContaining({ in: "ai-benchmark", out: "cloud-alerts" })]);
    const order = groupBullets(tailored.document, "work") ?? [];
    expect(order.slice(0, 2).sort()).toEqual(["ai-benchmark", "ai-guardrail"]);
    expect(order[2]).toBe("cloud-policy");
  });
});

describe("reserve skills", () => {
  it("adds the reserve skills the posting names, most relevant first, up to the limit", () => {
    const tailored = tailorResume(resume(), "main", AI_POSTING, profile, { maxAddedSkills: 1 });
    expect(tailored.addedSkills).toEqual(["Rust"]);
    expect(tailored.document.skills[0]?.terms).toContain("Rust");
    expect(tailored.document.skills[0]?.terms).not.toContain("Go");
    expect(tailored.changes.find((entry) => entry.kind === "skill-term-added")?.message).toMatch(/^added reserve skill "Rust" to "languages"/);
  });

  it("adds nothing the posting does not name, or when not allowed", () => {
    expect(tailorResume(resume(), "main", UNRELATED, profile, { maxAddedSkills: 4 }).addedSkills).toEqual([]);
    expect(tailorResume(resume(), "main", AI_POSTING, profile).addedSkills).toEqual([]);
  });

  it("needs the posting to name a skill, not just share a word with it", () => {
    const skills = { categories: [{ id: "platform", terms: ["Azure"], reserve: ["Azure Data Explorer", "Prompt Injection Defense"] }] };
    const posting = docJob({
      title: "Security Engineer",
      descriptionText: "Requirements\n- Data pipelines and data quality\n- Defending agents against prompt injection",
    });
    expect(tailorResume(resume({ skills }), "main", posting, profile, { maxAddedSkills: 4 }).addedSkills).toEqual(["Prompt Injection Defense"]);
  });

  it("matches a hyphenated skill however the posting spells it", () => {
    const skills = { categories: [{ id: "identity", terms: ["Entra ID"], reserve: ["Least-Privilege Access"] }] };
    const posting = docJob({ title: "Identity Engineer", descriptionText: "Requirements\n- Enforcing least privilege across cloud accounts" });
    expect(tailorResume(resume({ skills }), "main", posting, profile, { maxAddedSkills: 4 }).addedSkills).toEqual(["Least-Privilege Access"]);
  });
});

describe("validating reserves", () => {
  const issue = (build: () => unknown) => {
    try {
      build();
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };
  const withReserve = (extra: Record<string, unknown>, printed: Record<string, unknown> = {}) => [
    { id: "cloud-policy", text: "Built Azure Policy governance controls.", ...printed },
    { id: "cloud-firewall", text: "Built host firewall enforcement." },
    { id: "cloud-reserve", reserve: true, text: "Authored Azure Policies for [[100]] subscriptions.", ...extra },
  ];

  it("rejects replacements that point anywhere but a printed bullet in the same role", () => {
    expect(issue(() => resume({ cloud: withReserve({ replaces: ["nope"] }) }))).toMatch(/"nope" is not a printed bullet in this role/);
    expect(issue(() => resume({ cloud: withReserve({ replaces: ["ai-benchmark"] }) }))).toMatch(/"ai-benchmark" is not a printed bullet in this role/);
    expect(
      issue(() => resume({ cloud: [{ id: "cloud-policy", text: "Built Azure Policy governance controls.", replaces: ["cloud-policy"] }] })),
    ).toMatch(/replaces and upgrade only apply to a reserve bullet/);
  });

  it("rejects an upgrade that does not restate exactly one printed bullet in its own group", () => {
    const message = /an upgrade restates exactly one printed bullet in its own group/;
    expect(issue(() => resume({ cloud: withReserve({ upgrade: true }) }))).toMatch(message);
    expect(issue(() => resume({ cloud: withReserve({ upgrade: true, replaces: ["cloud-policy", "cloud-firewall"] }) }))).toMatch(message);
    expect(
      issue(() =>
        resume({
          ai: [
            { id: "ai-guardrail", text: "Built guardrails for AI agents." },
            { id: "ai-policy", reserve: true, upgrade: true, replaces: ["cloud-policy"], text: "Authored policies." },
          ],
        }),
      ),
    ).toMatch(message);
  });

  it("rejects keep on a reserve, and a reserve that could only replace a kept bullet", () => {
    expect(issue(() => resume({ cloud: withReserve({ keep: true }) }))).toMatch(/keep only applies to a printed bullet/);
    expect(issue(() => resume({ cloud: withReserve({ replaces: ["cloud-policy"] }, { keep: true }) }))).toMatch(
      /"cloud-policy" is kept, so only an upgrade may replace it/,
    );
    expect(issue(() => resume({ cloud: withReserve({ upgrade: true, replaces: ["cloud-policy"] }, { keep: true }) }))).toBe("");
  });

  it("rejects a reserve skill that is already printed", () => {
    expect(issue(() => resume({ skills: { categories: [{ id: "languages", terms: ["Python"], reserve: ["python"] }] } }))).toMatch(
      /"python" is already printed in this category/,
    );
  });

  it("allows a few swaps and added skills by default", () => {
    expect(DocumentsPolicySchema.parse({})).toMatchObject({ maxSwaps: 2, maxAddedSkills: 4 });
  });
});

