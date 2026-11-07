import { describe, expect, it } from "vitest";
import { extractEmployers, extractTermCandidates, extractTitles, isTitleCase, numberSupported } from "../src/documents/claims.js";
import { assertFacts, buildFactCorpus, checkFacts, withContext, type FactIssueKind } from "../src/documents/factCheck.js";
import { extractDates, extractFigures } from "../src/text/figures.js";
import { LOWERCASE_TECH_WORDS } from "../src/text/techTerms.js";
import { AppError } from "../src/util/errors.js";
import { docProfile, exampleResume } from "./documents.fixtures.js";

const corpus = buildFactCorpus({ source: exampleResume(), profile: docProfile() });
const letterCorpus = withContext(corpus, { company: "Acme Freight", role: "Senior Platform Engineer", locations: ["Toronto, ON"] });

function flagged(text: string, kind: FactIssueKind, against = corpus): string[] {
  return checkFacts(text, against).issues.filter((issue) => issue.kind === kind).map((issue) => issue.token);
}

describe("figures", () => {
  it("matches a magnitude however it is written, and a percentage or sum only to its own kind", () => {
    const evidence = extractFigures("Scaled to 40k requests and cut latency by 60%");
    expect(numberSupported({ raw: "40,000", value: 40000, kind: "plain" }, evidence)).toBe(true);
    expect(numberSupported({ raw: "40 thousand", value: 40000, kind: "plain" }, evidence)).toBe(true);
    expect(numberSupported({ raw: "400k", value: 400000, kind: "plain" }, evidence)).toBe(false);
    expect(numberSupported({ raw: "60", value: 60, kind: "plain" }, evidence)).toBe(true);
    expect(numberSupported({ raw: "$60", value: 60, kind: "money" }, evidence)).toBe(false);
    expect(numberSupported({ raw: "40k%", value: 40000, kind: "percent" }, evidence)).toBe(false);
  });

  it("accepts the source's figures and flags invented or inflated ones", () => {
    expect(flagged("Scaled the API from 2k to 40k requests per second and cut p99 latency by 60%.", "number")).toEqual([]);
    expect(flagged("Moved 120 services, then 120+ more, across 30+ teams in 15 migrations.", "number")).toEqual([]);
    expect(flagged("Scaled the API to 400k requests per second.", "number")).toEqual(["400k"]);
    expect(flagged("Cut latency by 75% and saved $2M.", "number")).toEqual(["75%", "$2M"]);
    expect(flagged("Led a team of 12 engineers.", "number")).toEqual(["12"]);
  });

  it("takes no figure from contact details or the month of an ISO date", () => {
    const profileOnly = buildFactCorpus({ source: null, profile: docProfile() });
    const phoneDigits = extractFigures(docProfile().identity.phone).map((figure) => figure.raw);
    expect(phoneDigits.length).toBeGreaterThan(0);
    for (const digits of phoneDigits) expect(flagged(`I led ${digits} launches.`, "number", profileOnly)).toEqual([digits]);
    const month = docProfile().experience.map((role) => role.start).find((start) => /^\d{4}-\d{2}/.test(start));
    expect(month).toBeDefined();
    const monthNumber = String(Number(month?.slice(5, 7)));
    expect(flagged(`I cut costs ${monthNumber}x.`, "number", profileOnly)).toEqual([`${monthNumber}x`]);
  });
});

describe("named terms", () => {
  it("finds stylized and listed technology names but not sentence-initial words", () => {
    const names = extractTermCandidates(
      "Built it with TypeScript and terraform. Kubernetes-based tooling on AWS and CI/CD. Shipped fast.",
      LOWERCASE_TECH_WORDS,
    ).map((candidate) => candidate.surface);
    expect(names).toEqual(["TypeScript", "terraform", "Kubernetes", "AWS", "CI/CD"]);
  });

  it("joins adjacent capitalized words into one name", () => {
    expect(extractTermCandidates("I used Open Policy Agent with GitHub Actions daily.", LOWERCASE_TECH_WORDS).map((candidate) => candidate.surface)).toEqual([
      "Open Policy Agent",
      "GitHub Actions",
    ]);
  });

  it("passes names the evidence holds, including aliases and parts of compounds", () => {
    expect(flagged("I run Kubernetes (k8s) clusters, Terraform, Kafka, PostgreSQL and Postgres replicas with GitHub Actions.", "term")).toEqual([]);
    expect(flagged("Shipped React/Node.js features and moved jobs to Airflow.", "term")).toEqual([]);
    // Pronouns with typographic apostrophes are not names.
    expect(flagged("Today I\u2019m writing because I\u2019ve run Kubernetes and I\u2019d like to again.", "term")).toEqual([]);
  });

  it("flags technologies and proper nouns the evidence never mentions", () => {
    expect(flagged("I also bring years of Rust and Elixir.", "term")).toEqual(["Rust", "Elixir"]);
    expect(flagged("Deep experience with elixir and snowflake.", "term")).toEqual(["elixir", "snowflake"]);
    expect(flagged("I built AI-powered tooling.", "term")).toEqual(["AI"]);
  });

  it("allows the employer, role and location being written to only when given as context", () => {
    const text = "I would like to bring this to Acme Freight in Toronto.";
    expect(flagged(text, "term")).toEqual(["Acme Freight"]);
    expect(flagged(text, "term", letterCorpus)).toEqual([]);
  });

  it("lets a letter name what the posting describes, but not claim the skills it requires", () => {
    const posting = [
      "Acme Freight builds Freightline, our routing engine, from Toronto and Montreal.",
      "",
      "What you'll do",
      "- Run the Flink jobs behind Freightline",
      "",
      "Requirements",
      "- Production experience with Rust and Zscaler",
    ].join("\n");
    const context = withContext(corpus, { company: "Hudson River Freight", posting });
    expect(flagged("Freightline's routing work in Montreal is why I am writing.", "term", context)).toEqual([]);
    expect(flagged("Your team runs Flink behind Freightline.", "term", context)).toEqual([]);
    expect(flagged("I have run Flink in production.", "term", context)).toEqual(["Flink"]);
    expect(flagged("I bring Rust and Zscaler experience.", "term", context)).toEqual(["Rust", "Zscaler"]);
    expect(flagged("Your Zscaler rollout is ambitious.", "term", context)).toEqual(["Zscaler"]);
    // The employer's initials are its name too.
    expect(checkFacts("At HRF, I would start with the routing engine.", context).ok).toBe(true);
  });

  it("treats a Title Case headline word by word", () => {
    expect(isTitleCase("Backend Software Engineer | Distributed Systems")).toBe(true);
    expect(isTitleCase("I build reliable systems for teams.")).toBe(false);
    expect(flagged("Backend Software Engineer | Distributed Systems and Observability", "term")).toEqual([]);
    expect(flagged("Backend Software Engineer | Quantum Networking", "term")).toEqual(["Quantum Networking"]);
  });
});

describe("employers, titles and dates", () => {
  it("extracts employment claims, not every capitalized word after 'at'", () => {
    expect(extractEmployers("I worked at Globex Corp for two years. At Northwind, I led migrations. Joined Initech in 2019.")).toEqual([
      "Globex Corp",
      "Northwind",
    ]);
    expect(extractEmployers("I joined Initech and stayed at scale with Kafka.")).toEqual(["Initech"]);
  });

  it("flags employers outside the source but accepts short forms of real ones", () => {
    expect(flagged("At Northwind, I led migrations; my internship at Bluefin taught me on-call.", "employer")).toEqual([]);
    expect(flagged("I worked at Globex Corp before that.", "employer")).toEqual(["Globex Corp"]);
    expect(flagged("I would join Acme Freight after my time at Acme Freight.", "employer", letterCorpus)).toEqual([]);
  });

  it("extracts capitalized titles and skips letter conventions", () => {
    expect(extractTitles("As Senior Software Engineer II, I reported to the Hiring Manager and the Staff Engineer.")).toEqual([
      "Senior Software Engineer II",
      "Staff Engineer",
    ]);
  });

  it("accepts titles held or used as a headline, and the job being applied for, but flags others", () => {
    expect(flagged("As a Senior Software Engineer and Platform Engineer, I lead migrations.", "title")).toEqual([]);
    expect(flagged("As a Principal Engineer I set the direction.", "title")).toEqual(["Principal Engineer"]);
    expect(flagged("I am applying for the Senior Platform Engineer role.", "title")).toEqual([]);
    expect(flagged("I am applying for the Staff Engineer (Infrastructure) position.", "title")).toEqual([]);
    // Writing for a role does not make it a title the candidate has held.
    expect(flagged("I was a Senior Platform Engineer at Northwind.", "title", letterCorpus)).toEqual(["Senior Platform Engineer"]);
    // "the <title>" naming the job, with the posting's own qualifiers, is a reference.
    expect(flagged("The Senior Platform Engineer, Kubernetes Platform opening fits my work.", "title", letterCorpus)).toEqual([]);
    expect(flagged("The Senior Platform Engineer, Kubernetes Platform opening fits my work.", "title")).toEqual(["Senior Platform Engineer"]);
  });

  it("checks month-year dates against the source and profile", () => {
    expect(extractDates("since March 2021, in Summer 2019 and Sept. 5, 2020").map((date) => date.key)).toEqual(["mar 2021", "summer 2019", "sep 2020"]);
    expect(flagged("I have been at Northwind since March 2021, after an internship in May 2020.", "date")).toEqual([]);
    expect(flagged("I started in January 2019.", "date")).toEqual(["January 2019"]);
  });
});

describe("assertFacts", () => {
  it("passes a letter written only from the evidence", () => {
    const letter = [
      "Dear Hiring Team,",
      "",
      "Acme Freight wants someone to own its Kubernetes platform and the CI/CD pipeline every team ships through, which is the work I have done at Northwind Logistics since Mar 2021.",
      "",
      "As Senior Software Engineer on the platform team, I led the migration of 120+ services from virtual machines to Kubernetes with zero-downtime cut-overs, and rebuilt our CI/CD pipeline on GitHub Actions, cutting median build time from 18 to 7 minutes. A service template with tracing and on-call wiring that I created is used by 30+ teams.",
      "",
      "I also cut p99 latency of our payments API by 60% by moving synchronous fan-out onto a Kafka-backed pipeline, and scaled the same API from 2k to 40k requests per second.",
      "",
      "I would start by learning how your teams ship today and where builds and incidents cost them the most time.",
      "",
      "Sincerely,",
      "Alex Candidate",
    ].join("\n");
    expect(assertFacts(letter, letterCorpus, "the cover letter").ok).toBe(true);
  });

  it("throws fact_check_failed naming every unsupported claim", () => {
    let thrown: unknown;
    try {
      assertFacts("At Globex, I ran Rust services for 8 years as Principal Engineer since Jan 2014.", letterCorpus, "the cover letter");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const error = thrown as AppError;
    expect(error.code).toBe("fact_check_failed");
    expect(error.message).toContain("the cover letter makes claims");
    const issues = error.details.issues as Array<{ kind: string; token: string }>;
    // Each claim is reported once, under its most specific kind.
    expect(issues.map((issue) => `${issue.kind}:${issue.token}`).sort()).toEqual(
      ["date:Jan 2014", "employer:Globex", "number:2014", "number:8", "term:Rust", "title:Principal Engineer"].sort(),
    );
  });

  it("works from the profile alone when there is no resume source", () => {
    const profileOnly = buildFactCorpus({ source: null, profile: docProfile() });
    expect(checkFacts("I scaled a payments API from 2k to 40k requests per second with Python.", profileOnly).ok).toBe(true);
    expect(checkFacts("I rebuilt CI on GitHub Actions.", profileOnly).ok).toBe(false);
  });
});
