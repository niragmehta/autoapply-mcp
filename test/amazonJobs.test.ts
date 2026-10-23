import { describe, expect, it } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import {
  amazonApplyUrl,
  amazonLocations,
  amazonPostedAt,
  amazonSearchUrl,
  normalizeAmazonJob,
} from "../src/sources/amazonJobs.js";

type AmazonJob = Parameters<typeof normalizeAmazonJob>[0];

const company = CompanySchema.parse({ name: "Amazon", ats: "amazon", board: "USA", query: "security engineer" });
const capturedAt = "2026-10-20T12:00:00.000Z";

/** One entry of a posting's `locations`, which Amazon sends as a JSON string. */
function place(city: string, state: string, country: string, building = "SEA54"): string {
  return JSON.stringify({
    normalizedLocation: `${city}, ${state}, ${country}`,
    city,
    normalizedStateName: state,
    normalizedCountryCode: country,
    buildingCodes: [building],
    type: "PRIMARY",
  });
}

/** Amazon's standard pay-transparency sentence. */
const PAY_SENTENCE =
  "Our compensation reflects the cost of labor across several US geographic markets. The base pay for this position ranges from $129,300/year in our lowest geographic market up to $223,600/year in our highest geographic market.";

function amazonJob(overrides: AmazonJob = {}): AmazonJob {
  return {
    id_icims: "2800001",
    title: " Security Engineer, AWS Identity ",
    description: "Build security tooling for AWS services.",
    basic_qualifications: "- 5+ years of software development experience",
    preferred_qualifications: PAY_SENTENCE,
    locations: [place("Seattle", "Washington", "USA"), place("Sunnyvale", "California", "USA", "SVL10")],
    normalized_location: "Seattle, Washington, USA",
    location: "US, WA, Seattle",
    // Amazon pads single-digit days with a second space.
    posted_date: "October  3, 2026",
    job_path: "/en/jobs/2800001/security-engineer-aws-identity",
    is_intern: false,
    ...overrides,
  };
}

describe("amazonSearchUrl", () => {
  it("searches one country, a full page at a time, newest first", () => {
    expect(amazonSearchUrl(" usa ", " security engineer ", 200)).toBe(
      "https://www.amazon.jobs/en/search.json?base_query=security+engineer&normalized_country_code%5B%5D=USA&result_limit=100&offset=200&sort=recent",
    );
  });

  it("leaves out a blank query", () => {
    const url = new URL(amazonSearchUrl("CAN", "   ", 0));

    expect(url.searchParams.has("base_query")).toBe(false);
    expect(url.searchParams.get("normalized_country_code[]")).toBe("CAN");
    expect(url.searchParams.get("offset")).toBe("0");
  });
});

describe("amazonApplyUrl", () => {
  it("points at the applicant form for the posting", () => {
    expect(amazonApplyUrl("2800001")).toBe("https://www.amazon.jobs/applicant/jobs/2800001/apply");
  });

  it("keeps an id with reserved characters inside one path segment", () => {
    expect(amazonApplyUrl("28/01")).toBe("https://www.amazon.jobs/applicant/jobs/28%2F01/apply");
  });
});

describe("amazonLocations", () => {
  it("formats each JSON-encoded location as city, state and country", () => {
    const job = amazonJob();

    expect(amazonLocations(job)).toEqual(["Seattle, Washington, USA", "Sunnyvale, California, USA"]);
  });

  it("lists a place once when several buildings repeat it", () => {
    const job = amazonJob({ locations: [place("Seattle", "Washington", "USA", "SEA54"), place("Seattle", "Washington", "USA", "SEA83")] });

    expect(amazonLocations(job)).toEqual(["Seattle, Washington, USA"]);
  });

  it("keeps whichever parts a location carries", () => {
    const job = amazonJob({ locations: [JSON.stringify({ normalizedStateName: "Virginia", normalizedCountryCode: "USA" })] });

    expect(amazonLocations(job)).toEqual(["Virginia, USA"]);
  });

  it("falls back to normalized_location when no entry can be read", () => {
    const job = amazonJob({ locations: ["not json", JSON.stringify({}), "null"] });

    expect(amazonLocations(job)).toEqual(["Seattle, Washington, USA"]);
  });

  it("falls back to the raw location string, then to nothing", () => {
    expect(amazonLocations({ location: "US, WA, Seattle" })).toEqual(["US, WA, Seattle"]);
    expect(amazonLocations({})).toEqual([]);
  });
});

describe("amazonPostedAt", () => {
  it.each([
    ["October  3, 2026", "2026-10-03T00:00:00.000Z"],
    ["September 30, 2026", "2026-09-30T00:00:00.000Z"],
  ])("reads %j as midnight UTC", (text, iso) => {
    expect(amazonPostedAt(text)).toBe(iso);
  });

  it.each([undefined, null, "", "   ", "recently", 20261003])("returns null for a missing or unreadable date: %j", (value) => {
    expect(amazonPostedAt(value)).toBeNull();
  });
});

describe("normalizeAmazonJob", () => {
  it("normalizes a posting with its links, places and posting date", () => {
    const job = normalizeAmazonJob(amazonJob(), company, capturedAt);

    expect(job).toMatchObject({
      ats: "amazon",
      companyName: "Amazon",
      board: "USA",
      externalId: "2800001",
      title: "Security Engineer, AWS Identity",
      url: "https://www.amazon.jobs/en/jobs/2800001/security-engineer-aws-identity",
      applyUrl: "https://www.amazon.jobs/applicant/jobs/2800001/apply",
      locationsRaw: ["Seattle, Washington, USA", "Sunnyvale, California, USA"],
      postedAt: "2026-10-03T00:00:00.000Z",
      capturedAt,
    });
    expect(job?.id).toMatch(/^job_/);
  });

  it("classifies the posting by its strongest location", () => {
    // Seattle alone is us-other; the Sunnyvale office makes it a Bay Area role.
    const job = normalizeAmazonJob(amazonJob(), company, capturedAt);

    expect(job?.locationClass).toBe("bay-area");
    expect(job?.country).toBe("US");
  });

  it("lays out the description and both qualification lists under their own headings", () => {
    const text = normalizeAmazonJob(amazonJob(), company, capturedAt)?.descriptionText ?? "";

    expect(text).toContain("Description\nBuild security tooling for AWS services.");
    expect(text).toContain("Basic qualifications\n- 5+ years of software development experience");
    expect(text).toContain("Preferred qualifications\nOur compensation reflects");
  });

  it("reads pay from Amazon's geographic-market sentence", () => {
    const job = normalizeAmazonJob(amazonJob(), company, capturedAt);

    expect(job?.compensation).toMatchObject({ min: 129300, max: 223600, currency: "USD", period: "year", source: "description-text" });
  });

  it("leaves pay unknown when the posting states none", () => {
    const job = normalizeAmazonJob(amazonJob({ preferred_qualifications: "Experience with AWS IAM." }), company, capturedAt);

    expect(job?.compensation).toBeNull();
  });

  it("falls back to the standard job path and an unknown date when the posting omits them", () => {
    const job = normalizeAmazonJob(amazonJob({ job_path: undefined, posted_date: undefined }), company, capturedAt);

    expect(job?.url).toBe("https://www.amazon.jobs/en/jobs/2800001");
    expect(job?.postedAt).toBeNull();
  });

  it("classifies a Canadian posting from its normalized_location", () => {
    const canada = CompanySchema.parse({ name: "Amazon", ats: "amazon", board: "CAN", query: "security engineer" });
    const posting = amazonJob({ locations: undefined, normalized_location: "Toronto, Ontario, CAN", location: "CA, ON, Toronto" });

    const job = normalizeAmazonJob(posting, canada, capturedAt);

    expect(job).toMatchObject({ locationsRaw: ["Toronto, Ontario, CAN"], locationClass: "canada", country: "CA", board: "CAN" });
  });

  it.each<{ reason: string; overrides: AmazonJob }>([
    { reason: "no id", overrides: { id_icims: undefined } },
    { reason: "a blank id", overrides: { id_icims: "" } },
    { reason: "a blank title", overrides: { title: "   " } },
    { reason: "an internship flag", overrides: { is_intern: true } },
  ])("skips a posting with $reason", ({ overrides }) => {
    expect(normalizeAmazonJob(amazonJob(overrides), company, capturedAt)).toBeNull();
  });
});
