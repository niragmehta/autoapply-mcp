import { afterEach, describe, expect, it } from "vitest";
import { getAtsCredentials, hasAtsCredentials, lengthenedPassword, redactSecrets } from "../src/submission/credentials.js";
import { isWorkdayUrl } from "../src/submission/workdayFlow.js";

afterEach(() => {
  delete process.env.AUTOAPPLY_ATS_PASSWORD;
  delete process.env.AUTOAPPLY_ATS_EMAIL;
});

describe("ats credentials", () => {
  it("reports when no password is configured", () => {
    expect(hasAtsCredentials()).toBe(false);
  });

  it("refuses to invent a password", () => {
    expect(() => getAtsCredentials("casey@example.com")).toThrow(/AUTOAPPLY_ATS_PASSWORD/);
  });

  it("falls back to the profile email so only the password is needed", () => {
    process.env.AUTOAPPLY_ATS_PASSWORD = "correct-horse-battery";

    expect(getAtsCredentials("casey@example.com")).toEqual({
      email: "casey@example.com",
      password: "correct-horse-battery",
    });
  });

  it("prefers an explicitly configured email", () => {
    process.env.AUTOAPPLY_ATS_PASSWORD = "correct-horse-battery";
    process.env.AUTOAPPLY_ATS_EMAIL = "apply@example.com";

    expect(getAtsCredentials("casey@example.com").email).toBe("apply@example.com");
  });

  it("fails when there is no email at all rather than submitting a blank one", () => {
    process.env.AUTOAPPLY_ATS_PASSWORD = "correct-horse-battery";

    expect(() => getAtsCredentials("")).toThrow(/no account email/);
  });

  it("strips the password out of text on its way to a log", () => {
    process.env.AUTOAPPLY_ATS_PASSWORD = "correct-horse-battery";

    const message = redactSecrets('sign-in refused for password "correct-horse-battery"');

    expect(message).not.toContain("correct-horse-battery");
    expect(message).toContain("[redacted]");
  });

  it("leaves text alone when no password is set", () => {
    expect(redactSecrets("nothing to hide")).toBe("nothing to hide");
  });
});

describe("workday url detection", () => {
  it("recognises tenant subdomains", () => {
    expect(isWorkdayUrl("https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/x")).toBe(true);
    expect(isWorkdayUrl("https://netflix.wd108.myworkdayjobs.com/Netflix")).toBe(true);
  });

  it("does not match a lookalike host", () => {
    expect(isWorkdayUrl("https://myworkdayjobs.com.evil.example/x")).toBe(false);
    expect(isWorkdayUrl("https://job-boards.greenhouse.io/acme")).toBe(false);
    expect(isWorkdayUrl("not a url")).toBe(false);
  });
});

describe("lengthenedPassword", () => {
  it("repeats a short password until it meets the minimum", () => {
    expect(lengthenedPassword("Ab1!xyz", 14)).toBe("Ab1!xyzAb1!xyz");
    expect(lengthenedPassword("Ab1!xyz", 15)).toBe("Ab1!xyzAb1!xyzAb1!xyz");
  });

  it("leaves a password that already meets the minimum unchanged", () => {
    expect(lengthenedPassword("Ab1!xyz", 7)).toBe("Ab1!xyz");
    expect(lengthenedPassword("Ab1!xyz", 0)).toBe("Ab1!xyz");
  });

  it("is still fully redacted", () => {
    process.env.AUTOAPPLY_ATS_PASSWORD = "Ab1!xyz";
    expect(redactSecrets(`typed ${lengthenedPassword("Ab1!xyz", 14)}`)).not.toContain("xyz");
  });
});
