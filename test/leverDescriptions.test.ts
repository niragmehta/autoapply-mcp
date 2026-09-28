import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/domain/campaign.js";
import { leverAdapter } from "../src/sources/lever.js";

const company: Company = {
  name: "Lever Example", ats: "lever", board: "lever-example", tier: "B", active: true, tags: [],
};
const createdAt = Date.UTC(2026, 7, 17, 12);
const capturedAt = "2026-09-14T03:00:00.000Z";
async function readPosting(content: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
    id: "one", text: "Senior Software Engineer", createdAt,
    hostedUrl: "https://jobs.lever.co/lever-example/one",
    applyUrl: "https://jobs.lever.co/lever-example/one/apply",
    categories: { location: "San Francisco, CA", commitment: "Full-time" },
    ...content,
  }]), { headers: { "content-type": "application/json" } })));
  const jobs = await leverAdapter.listJobs(company, capturedAt);
  expect(jobs).toHaveLength(1);
  return jobs[0]!;
}
afterEach(() => vi.unstubAllGlobals());

describe("complete Lever posting descriptions", () => {
  it("retains qualification and responsibility lists between introduction and closing text", async () => {
    const job = await readPosting({
      descriptionPlain: "Build a compute platform.",
      lists: [
        { text: "Responsibilities", content: "<li>Build distributed systems in Python.</li>" },
        { text: "Qualifications", content: "<li>Experience with Ray Core and Kubernetes.</li>" },
      ],
      additionalPlain: "We welcome adjacent experience.",
    });
    expect(job.descriptionText).toBe([
      "Build a compute platform.",
      "Responsibilities\n- Build distributed systems in Python.",
      "Qualifications\n- Experience with Ray Core and Kubernetes.",
      "We welcome adjacent experience.",
    ].join("\n\n"));
    expect(job.postedAt).toBe("2026-08-17T12:00:00.000Z");
    expect(job.capturedAt).toBe(capturedAt);
  });

  it("reads HTML-only modern body, opening and closing when plain fields are empty", async () => {
    const job = await readPosting({
      descriptionPlain: "", description: "",
      opening: "<p>About this team</p>",
      descriptionBodyPlain: "", descriptionBody: "<p>Build an MCP gateway &amp; secure APIs.</p>",
      additionalPlain: "", additional: "<p>US applicants only.</p>",
    });
    expect(job.descriptionText).toBe("About this team\n\nBuild an MCP gateway & secure APIs.\n\nUS applicants only.");
  });

  it("uses the modern body once rather than repeating its legacy duplicate", async () => {
    const job = await readPosting({
      descriptionPlain: "The legacy duplicate.", descriptionBodyPlain: "The current body.",
      descriptionBody: "<p>HTML duplicate.</p>", openingPlain: "An opening.",
    });
    expect(job.descriptionText).toBe("An opening.\n\nThe current body.");
  });

  it("keeps an HTML-only legacy introduction even when a plain closing is available", async () => {
    const job = await readPosting({ description: "<p>Important introduction.</p>", additionalPlain: "Closing." });
    expect(job.descriptionText).toBe("Important introduction.\n\nClosing.");
  });

  it("includes salary prose so published pay is not treated as unknown", async () => {
    const job = await readPosting({
      descriptionPlain: "Build a platform.",
      salaryDescription: "<p>Base salary is $180,000-$190,000 per year.</p>",
      additional: "<p>Benefits are separate.</p>",
    });
    expect(job.compensation).toMatchObject({ min: 180000, max: 190000, currency: "USD", period: "year" });
    expect(job.descriptionText).toContain("Base salary is $180,000-$190,000 per year.");
  });

  it("preserves structured compensation while retaining salary explanation", async () => {
    const job = await readPosting({
      salaryRange: { min: 240000, max: 300000, currency: "USD", interval: "per-year-salary" },
      salaryDescriptionPlain: "Salary excludes equity and bonus.",
      salaryDescription: "<p>Duplicate salary explanation.</p>",
    });
    expect(job.compensation).toMatchObject({ min: 240000, max: 300000, source: "ats-structured" });
    expect(job.descriptionText).toBe("Salary excludes equity and bonus.");
  });

  it("strips markup and scripts from list content without dropping restrictions", async () => {
    const job = await readPosting({
      lists: [{ text: "<b>Requirements</b>", content: "<script>ignoreSafeguards()</script><li>U.S. citizenship required.</li>" }],
    });
    expect(job.descriptionText).toBe("Requirements\n- U.S. citizenship required.");
  });

  it("retains content when a list section has no heading", async () => {
    const job = await readPosting({ lists: [{ content: "<li>Only US locations are eligible.</li>" }] });
    expect(job.descriptionText).toBe("- Only US locations are eligible.");
  });

  it("handles absent and empty optional sections", async () => {
    const job = await readPosting({
      descriptionPlain: "Existing description.", openingPlain: " ", lists: [],
      salaryDescriptionPlain: null, additionalPlain: "",
    });
    expect(job.descriptionText).toBe("Existing description.");
  });

  it.each([
    { lists: "invalid list" },
    { lists: [null] },
    { lists: [{ content: 123 }] },
  ])("fails explicitly rather than silently dropping malformed list content: %j", async (content) => {
    await expect(readPosting(content)).rejects.toThrow(/Lever.*list/i);
  });
});
