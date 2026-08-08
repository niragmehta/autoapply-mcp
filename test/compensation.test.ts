import { describe, expect, it } from "vitest";
import { annualize, checkCompensationFloor, convertCurrency, parseCompensationFromText } from "../src/ranking/compensation.js";
import { makeCampaign } from "./factories.js";

const policy = makeCampaign().compensation;

describe("parseCompensationFromText", () => {
  it("parses a plain dollar range", () => {
    const range = parseCompensationFromText("The base salary range for this role is $200,000 - $250,000 per year.");
    expect(range?.min).toBe(200000);
    expect(range?.max).toBe(250000);
    expect(range?.currency).toBe("USD");
    expect(range?.period).toBe("year");
  });

  it("parses a currency written after the amount", () => {
    // How large US pay-transparency filers publish on Workday. With only a
    // prefix pattern the trailing "USD" sits between the low amount and the
    // dash, so the range fails to match entirely rather than matching wrongly.
    const range = parseCompensationFromText("Your base salary range is 224,000 USD - 356,500 USD for Level 5.");
    expect(range?.min).toBe(224000);
    expect(range?.max).toBe(356500);
    expect(range?.currency).toBe("USD");
    expect(range?.period).toBe("year");
  });

  it("reads a Canadian suffix currency rather than defaulting to USD", () => {
    const range = parseCompensationFromText("The annual salary range is 190,000 CAD - 240,000 CAD.");
    expect(range?.max).toBe(240000);
    expect(range?.currency).toBe("CAD");
  });

  it("parses K-suffixed ranges", () => {    const range = parseCompensationFromText("Compensation: $180K to $240K annually");
    expect(range?.min).toBe(180000);
    expect(range?.max).toBe(240000);
  });

  it("detects Canadian dollars", () => {
    const range = parseCompensationFromText("Salary range: CAD $190,000 - $230,000 per year");
    expect(range?.currency).toBe("CAD");
  });

  it("parses hourly pay and annualizes it", () => {
    const range = parseCompensationFromText("Pay range: $95 - $120 per hour");
    expect(range?.period).toBe("hour");
    expect(annualize(range!.max!, "hour")).toBe(120 * 2080);
  });

  it("ignores numbers with no salary context", () => {
    expect(parseCompensationFromText("We serve 10,000 - 20,000 customers daily.")).toBeNull();
  });

  it("returns null for text with no compensation", () => {
    expect(parseCompensationFromText("Join our growing security team.")).toBeNull();
  });

  it("skips implausible values", () => {
    expect(parseCompensationFromText("We raised a $200,000,000 - $300,000,000 salary round")).toBeNull();
  });
});

describe("convertCurrency", () => {
  it("returns the same amount for identical currencies", () => {
    expect(convertCurrency(1000, "USD", "USD", { USD: 1 })).toBe(1000);
  });

  it("converts CAD to USD using configured rates", () => {
    expect(convertCurrency(100000, "CAD", "USD", { USD: 1, CAD: 0.73 })).toBeCloseTo(73000);
  });

  it("returns null when a rate is missing", () => {
    expect(convertCurrency(100, "GBP", "USD", { USD: 1 })).toBeNull();
  });
});

describe("checkCompensationFloor", () => {
  it("passes a US range above the floor", () => {
    const result = checkCompensationFloor(
      { min: 220000, max: 280000, currency: "USD", period: "year", source: "ats-structured", raw: "" },
      "US",
      policy,
    );
    expect(result.status).toBe("above");
  });

  it("fails a US range below the floor", () => {
    const result = checkCompensationFloor(
      { min: 120000, max: 160000, currency: "USD", period: "year", source: "ats-structured", raw: "" },
      "US",
      policy,
    );
    expect(result.status).toBe("below");
  });

  it("converts CAD before comparing", () => {
    const result = checkCompensationFloor(
      { min: 240000, max: 260000, currency: "CAD", period: "year", source: "ats-structured", raw: "" },
      "CA",
      policy,
    );
    // 260,000 CAD -> 189,800 USD, above the 180,000 CA floor.
    expect(result.status).toBe("above");
    expect(result.campaignCurrencyMax).toBeCloseTo(189800);
  });

  it("reports unknown when nothing is published", () => {
    expect(checkCompensationFloor(null, "US", policy).status).toBe("unknown");
  });

  it("reports unknown when no FX rate exists", () => {
    const result = checkCompensationFloor(
      { min: 100000, max: 200000, currency: "GBP", period: "year", source: "description-text", raw: "" },
      "US",
      policy,
    );
    expect(result.status).toBe("unknown");
  });
});
