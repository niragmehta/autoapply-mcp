import { describe, expect, it } from "vitest";
import { detectSeniority, evaluateGates, evaluateWorkAuthorizationGate } from "../src/ranking/gates.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

const campaign = makeCampaign();
const profile = makeProfile();
const context = { campaign, profile };

describe("detectSeniority", () => {
  it("identifies levels from titles", () => {
    expect(detectSeniority("Senior Software Engineer")).toBe("senior");
    expect(detectSeniority("Staff Security Engineer")).toBe("staff");
    expect(detectSeniority("Principal Engineer")).toBe("principal");
    expect(detectSeniority("Software Engineering Intern")).toBe("intern");
    expect(detectSeniority("Engineering Manager")).toBe("manager");
    expect(detectSeniority("Director of Security")).toBe("director");
    expect(detectSeniority("Security Engineer")).toBe("unspecified");
  });

  // "Member of Technical Staff" is the generic engineer title at many AI labs,
  // not a Staff level, so a campaign that rejects Staff roles must not drop it.
  it("does not read Member of Technical Staff as a Staff level", () => {
    expect(detectSeniority("Member of Technical Staff, Security")).toBe("unspecified");
    expect(detectSeniority("Senior Member of Technical Staff")).toBe("senior");
    expect(detectSeniority("Principal Member of Technical Staff")).toBe("principal");
    expect(detectSeniority("Senior Staff Software Engineer")).toBe("staff");
  });

  // A posting open at two levels hires at the lower one too, so a campaign
  // aiming for Senior keeps it; "Senior Staff" names a single level above Staff.
  it("reads a posting open at Senior or Staff as Senior", () => {
    expect(detectSeniority("Senior/Staff Security Researcher")).toBe("senior");
    expect(detectSeniority("Senior or Staff Software Engineer, Security")).toBe("senior");
    expect(detectSeniority("Staff / Senior Backend Engineer")).toBe("senior");
    expect(detectSeniority("Sr./Staff Product Security Engineer")).toBe("senior");
    expect(detectSeniority("Senior Staff Security Engineer")).toBe("staff");
    expect(detectSeniority("Staff/Senior Staff Software Engineer - Product Security")).toBe("staff");
    expect(detectSeniority("Staff or Sr. Staff Engineer")).toBe("staff");
    expect(detectSeniority("Principal/Senior Principal Security Engineer")).toBe("principal");
    expect(detectSeniority("Principal / Sr. Principal Engineer")).toBe("principal");
  });
});

describe("evaluateGates", () => {
  it("passes a well-matched senior Bay Area role", () => {
    expect(evaluateGates(makeJob(), context).passed).toBe(true);
  });

  it("rejects intern and manager roles", () => {
    expect(evaluateGates(makeJob({ title: "Security Engineering Intern" }), context).rule).toBe("seniority-rejected");
    expect(evaluateGates(makeJob({ title: "Engineering Manager, Security" }), context).rule).toBe("seniority-rejected");
  });

  it("rejects disallowed location classes", () => {
    const result = evaluateGates(makeJob({ locationClass: "remote-us", country: "US" }), context);
    expect(result.rule).toBe("location-not-allowed");
  });

  it("rejects roles requiring a security clearance", () => {
    const job = makeJob({ descriptionText: "Must hold an active TS/SCI security clearance to support this program." });
    expect(evaluateGates(job, context).rule).toBe("clearance-required");
  });

  it("rejects US roles that rule out sponsorship", () => {
    const job = makeJob({
      descriptionText: "We are unable to sponsor or take over sponsorship of an employment visa at this time.",
    });
    expect(evaluateGates(job, context).rule).toBe("sponsorship-unavailable");
  });

  it("rejects US roles requiring citizenship", () => {
    const job = makeJob({ descriptionText: "Applicants must be a U.S. citizen due to federal contract requirements." });
    expect(evaluateGates(job, context).rule).toBe("citizenship-required");
  });

  // Skydio's wording, which slipped past the ITAR-anchored patterns.
  it("rejects roles contingent on verified US-person status", () => {
    const job = makeJob({
      descriptionText:
        "Employment in this role is contingent upon verification of U.S. person status and the ability to access controlled or restricted information.",
    });
    expect(evaluateGates(job, context).rule).toBe("citizenship-required");
    const plural = makeJob({ descriptionText: "Due to customer requirements, applicants must be U.S. persons." });
    expect(evaluateGates(plural, context).rule).toBe("citizenship-required");
  });

  it("does not treat an export-licence notice as a US-person requirement", () => {
    const job = makeJob({
      descriptionText:
        "Export Control Notice: This position may require access to technology subject to the U.S. Export Administration Regulations. Any offer may be conditioned on the Company's ability to obtain an export license, which may require the Company to seek government authorization.",
    });
    expect(evaluateGates(job, context).passed).toBe(true);
  });

  it("does not treat equal-opportunity boilerplate as a citizenship requirement", () => {
    const job = makeJob({
      descriptionText:
        "We are an equal opportunity employer and consider all applicants without regard to race, religion, citizenship status, or veteran status.",
    });
    expect(evaluateGates(job, context).passed).toBe(true);
  });

  it("rejects compensation below the floor", () => {
    const job = makeJob({
      compensation: { min: 120000, max: 150000, currency: "USD", period: "year", source: "ats-structured", raw: "$120k-$150k" },
    });
    expect(evaluateGates(job, context).rule).toBe("compensation-below-floor");
  });

  it("allows unpublished compensation when the policy permits it", () => {
    expect(evaluateGates(makeJob({ compensation: null }), context).passed).toBe(true);
  });

  it("rejects stale postings", () => {
    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    expect(evaluateGates(makeJob({ postedAt: old }), context).rule).toBe("stale-posting");
  });

  it("honours campaign exclusions", () => {
    const strict = makeCampaign({ exclusions: { companies: ["Test Corp"], titlePatterns: [], descriptionPatterns: [] } });
    const result = evaluateGates(makeJob(), { campaign: strict, profile });
    expect(result.rule).toBe("company-excluded");
  });
});

describe("evaluateWorkAuthorizationGate", () => {
  it("passes Canadian roles for a Canadian citizen even with authorization language", () => {
    const job = makeJob({
      country: "CA",
      locationClass: "canada",
      descriptionText: "Candidates must be legally authorized to work in Canada. We do not provide visa sponsorship.",
    });
    expect(evaluateWorkAuthorizationGate(job, profile).passed).toBe(true);
  });

  it("blocks US roles that refuse sponsorship", () => {
    const job = makeJob({
      country: "US",
      descriptionText: "Candidates must be authorized to work in the United States without sponsorship now or in the future.",
    });
    expect(evaluateWorkAuthorizationGate(job, profile).passed).toBe(false);
  });

  it("passes US roles that say nothing about sponsorship", () => {
    const job = makeJob({ country: "US", descriptionText: "Join our security engineering team in San Francisco." });
    expect(evaluateWorkAuthorizationGate(job, profile).passed).toBe(true);
  });
});
