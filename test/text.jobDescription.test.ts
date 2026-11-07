import { describe, expect, it } from "vitest";
import { BOILERPLATE_SECTIONS, classifyHeading, readJdLines, requirementLines, skillBearingText, splitSentences } from "../src/text/jobDescription.js";

const POSTING = [
  "Acme Freight is hiring a Senior Platform Engineer to own our Kubernetes platform.",
  "",
  "What you\u2019ll do",
  "- Run and scale our Kubernetes clusters and the CI/CD pipeline every team ships through",
  "- Improve build times and developer experience on GitHub Actions",
  "",
  "Requirements",
  "- 5+ years building distributed systems in Go or Python",
  "- Experience operating Kafka or another event streaming system",
  "",
  "Nice to have",
  "- Rust or Elixir",
  "",
  "Benefits",
  "- Kubernetes-themed swag, generous parental leave and a learning budget",
  "",
  "About Acme Freight",
  "We move freight for 2,000 shippers.",
].join("\n");

describe("classifyHeading", () => {
  it("recognises headings by pattern, preferred before required", () => {
    expect(classifyHeading("Preferred Qualifications:")).toBe("preferred");
    expect(classifyHeading("Minimum Qualifications")).toBe("requirements");
    expect(classifyHeading("What you'll bring")).toBe("requirements");
    expect(classifyHeading("What you\u2019ll need")).toBe("requirements");
    expect(classifyHeading("**Nice to have**")).toBe("preferred");
    expect(classifyHeading("## Responsibilities")).toBe("responsibilities");
    expect(classifyHeading("Key Responsibilities")).toBe("responsibilities");
    expect(classifyHeading("Skills")).toBe("requirements");
    expect(classifyHeading("Technical Skills")).toBe("requirements");
    expect(classifyHeading("Equal Opportunity Employer")).toBe("legal");
    expect(classifyHeading("Compensation")).toBe("compensation");
    expect(classifyHeading("Perks")).toBe("benefits");
    expect(classifyHeading("About Acme Robotics")).toBe("about");
    expect(classifyHeading("About the role")).toBe("responsibilities");
    expect(classifyHeading("About you")).toBe("requirements");
  });

  it("does not mistake content for a heading", () => {
    expect(classifyHeading("We are looking for someone who loves building great products every day.")).toBeNull();
    expect(classifyHeading("Experience with distributed systems")).toBeNull();
    expect(classifyHeading("Basic understanding of networking protocols")).toBeNull();
    expect(classifyHeading("You will own the platform roadmap")).toBeNull();
    expect(classifyHeading("Minimum 5 years of experience")).toBeNull();
    expect(classifyHeading("Go and Python")).toBeNull();
    expect(classifyHeading("Tools we use:")).toBeNull();
    expect(classifyHeading("")).toBeNull();
    expect(classifyHeading("x ".repeat(50))).toBeNull();
  });
});

describe("readJdLines", () => {
  it("files each line under the heading above it", () => {
    const lines = readJdLines(POSTING);
    expect(lines.filter((line) => !line.heading).map((line) => [line.section, line.bullet, line.text.slice(0, 18)])).toEqual([
      ["other", false, "Acme Freight is hi"],
      ["responsibilities", true, "Run and scale our "],
      ["responsibilities", true, "Improve build time"],
      ["requirements", true, "5+ years building "],
      ["requirements", true, "Experience operati"],
      ["preferred", true, "Rust or Elixir"],
      ["benefits", true, "Kubernetes-themed "],
      ["about", false, "We move freight fo"],
    ]);
    expect(lines.filter((line) => line.heading).map((line) => line.headingText)).toEqual([
      "What you\u2019ll do",
      "Requirements",
      "Nice to have",
      "Benefits",
      "About Acme Freight",
    ]);
  });

  it("keeps an unrecognised sub-heading inside its section", () => {
    const lines = readJdLines("Requirements\nTechnical:\n- Go\nTools we use:\n- Bazel\nPerks\n- Snacks");
    expect(lines.map((line) => [line.text, line.section, line.heading, line.subheading, line.headingText])).toEqual([
      ["Requirements", "requirements", true, false, "Requirements"],
      ["Technical:", "requirements", true, true, "Requirements"],
      ["Go", "requirements", false, false, "Requirements"],
      ["Tools we use:", "requirements", true, true, "Requirements"],
      ["Bazel", "requirements", false, false, "Requirements"],
      ["Perks", "benefits", true, false, "Perks"],
      ["Snacks", "benefits", false, false, "Perks"],
    ]);
  });

  it("splits an inline heading from its content and reads a heading written as a list item", () => {
    expect(readJdLines("Requirements: 5+ years with Go and e.g. Python.").map((line) => [line.heading, line.section, line.text])).toEqual([
      [true, "requirements", "Requirements"],
      [false, "requirements", "5+ years with Go and e.g. Python."],
    ]);
    expect(readJdLines("- Nice to have:\n- Rust\n- Experience with one of:").map((line) => [line.heading, line.section])).toEqual([
      [true, "preferred"],
      [false, "preferred"],
      [false, "preferred"],
    ]);
  });

  it("reads Windows line endings and skips empty bullets", () => {
    expect(readJdLines("Responsibilities\r\n- \r\n- Ship it").map((line) => line.text)).toEqual(["Responsibilities", "Ship it"]);
  });

  it("treats the employer, pay and legal sections as boilerplate", () => {
    expect([...BOILERPLATE_SECTIONS].sort()).toEqual(["about", "benefits", "compensation", "legal"]);
    expect(skillBearingText(POSTING).split("\n")).toEqual([
      "Acme Freight is hiring a Senior Platform Engineer to own our Kubernetes platform.",
      "Run and scale our Kubernetes clusters and the CI/CD pipeline every team ships through",
      "Improve build times and developer experience on GitHub Actions",
      "5+ years building distributed systems in Go or Python",
      "Experience operating Kafka or another event streaming system",
      "Rust or Elixir",
    ]);
  });
});

describe("splitSentences", () => {
  it("keeps sentences whole around abbreviations", () => {
    expect(splitSentences("Use e.g. Python daily. Work with U.S. teams. Ship it.")).toEqual([
      "Use e.g. Python daily.",
      "Work with U.S. teams.",
      "Ship it.",
    ]);
  });
});

describe("requirementLines", () => {
  it("quotes list items under requirement, responsibility and preferred headings", () => {
    const lines = requirementLines(POSTING);
    expect(lines.map((line) => line.section)).toEqual(["responsibilities", "responsibilities", "requirements", "requirements", "preferred"]);
    expect(lines.every((line) => line.bullet)).toBe(true);
    expect(lines.some((line) => line.text.includes("parental leave"))).toBe(false);
    expect(lines[4]).toEqual({ text: "Rust or Elixir", quote: "Rust or Elixir", section: "preferred", bullet: true });
  });

  it("falls back to any list item outside the boilerplate", () => {
    const lines = requirementLines("Acme builds tools.\n- Own the build system\n- Mentor two engineers\nBenefits\n- Dental");
    expect(lines.map((line) => line.text)).toEqual(["Own the build system", "Mentor two engineers"]);
  });

  it("falls back to sentences that read as asks when a posting has no lists", () => {
    const lines = requirementLines("We need someone to run Kafka at scale. Acme was founded in Ohio by two friends. You will own the platform roadmap. Hi.");
    expect(lines.map((line) => line.quote)).toEqual(["We need someone to run Kafka at scale.", "You will own the platform roadmap."]);
  });

  it("drops benefits and legal wording, repeats and anything past the limit", () => {
    const description = [
      "Requirements",
      "- Experience with Rust",
      "- experience with rust",
      "- Visa sponsorship is not available for this role",
      "- Strong Go skills",
      "- Familiarity with Terraform",
    ].join("\n");
    expect(requirementLines(description).map((line) => line.text)).toEqual(["Experience with Rust", "Strong Go skills", "Familiarity with Terraform"]);
    expect(requirementLines(description, { limit: 2 }).map((line) => line.text)).toEqual(["Experience with Rust", "Strong Go skills"]);
  });

  it("reads a paragraph-length list item sentence by sentence and shortens long quotes", () => {
    const long = `You will design the ingestion platform for ${"many ".repeat(60)}teams. You will also mentor engineers across the company.`;
    const lines = requirementLines(`Responsibilities\n- ${long}`);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.quote.endsWith("\u2026")).toBe(true);
    expect(lines[1]?.text).toBe("You will also mentor engineers across the company.");
  });
});
