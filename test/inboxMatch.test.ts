import { describe, expect, it } from "vitest";
import { buildApplicationIndex, labelMatchesKey, type ApplicationCandidate } from "../src/inbox/companies.js";
import { candidateReason } from "../src/inbox/filter.js";
import { matchReply, type MatchInput } from "../src/inbox/match.js";
import { addressDomain, knownSender, registrableDomain, registrableLabel } from "../src/inbox/senders.js";

function candidate(overrides: Partial<ApplicationCandidate> & Pick<ApplicationCandidate, "applicationId" | "companyName" | "title">): ApplicationCandidate {
  const board = overrides.board ?? overrides.companyName.toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    status: "submitted",
    submittedAt: "2026-09-01T12:00:00.000Z",
    createdAt: "2026-08-31T12:00:00.000Z",
    ats: "greenhouse",
    board,
    url: `https://job-boards.greenhouse.io/${board}/jobs/${overrides.applicationId}`,
    applyUrl: `https://job-boards.greenhouse.io/${board}/jobs/${overrides.applicationId}`,
    externalId: overrides.applicationId,
    ...overrides,
  };
}

const index = buildApplicationIndex([
  candidate({ applicationId: "app_platform", companyName: "Acme", title: "Senior Software Engineer, Platform" }),
  candidate({ applicationId: "app_security", companyName: "Acme", title: "Senior Security Engineer" }),
  candidate({ applicationId: "app_globex", companyName: "Globex Corporation", title: "Staff Engineer" }),
  candidate({
    applicationId: "app_initech",
    companyName: "Initech",
    title: "Principal Software Engineer",
    ats: "workday",
    board: "initech/wd5/Careers",
    externalId: "/job/Austin-TX/Principal-Software-Engineer_R104233",
    url: "https://initech.wd5.myworkdayjobs.com/Careers/job/Austin-TX/Principal-Software-Engineer_R104233",
  }),
  candidate({ applicationId: "app_anchor", companyName: "Anchor", title: "Backend Engineer" }),
  candidate({ applicationId: "app_nimbus", companyName: "Nimbus AI", title: "Machine Learning Engineer", ats: "lever", board: "nimbusai" }),
]);

function input(overrides: Partial<MatchInput>): MatchInput {
  return { fromAddress: "", fromName: "", subject: "", body: "", receivedAt: new Date("2026-09-10T12:00:00Z"), ...overrides };
}

describe("matching a reply to its application", () => {
  it("matches an ATS email that names the company and the role", () => {
    const result = matchReply(
      input({
        fromAddress: "no-reply@us.greenhouse-mail.io",
        fromName: "Acme Recruiting",
        subject: "Acme | Update on your application",
        body: "Thank you for applying to the Senior Security Engineer role at Acme.",
      }),
      index,
    );
    expect(result.applicationId).toBe("app_security");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.ambiguous).toBe(false);
  });

  it("refuses to choose between two applications at one company when the role is not named", () => {
    const result = matchReply(
      input({
        fromAddress: "no-reply@us.greenhouse-mail.io",
        fromName: "Acme Recruiting",
        subject: "An update from Acme",
        body: "Unfortunately we will not be moving forward with your application.",
      }),
      index,
    );
    expect(result.applicationId).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.map((entry) => entry.applicationId).sort()).toEqual(["app_platform", "app_security"]);
  });

  it("matches a Workday tenant's mail by its sender", () => {
    const result = matchReply(
      input({
        fromAddress: "initech@myworkday.com",
        fromName: "Initech",
        subject: "Thank you for applying!",
        body: "Thank you for applying for the position of Principal Software Engineer (R104233).",
      }),
      index,
    );
    expect(result.applicationId).toBe("app_initech");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.candidates[0]?.reasons.join(" ")).toContain("Workday tenant initech");
  });

  it("matches mail from the employer's own domain to its only application", () => {
    const result = matchReply(
      input({ fromAddress: "jane@globex.com", fromName: "Jane Recruiter", subject: "Next steps", body: "Can we find time to talk?" }),
      index,
    );
    expect(result.applicationId).toBe("app_globex");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("uses a quoted requisition number to tell a company's roles apart", () => {
    const twoRoles = buildApplicationIndex([
      candidate({ applicationId: "app_a", companyName: "Initech", title: "Software Engineer", ats: "workday", board: "initech/wd5/Careers", externalId: "_R100001" }),
      candidate({ applicationId: "app_b", companyName: "Initech", title: "Software Engineer", ats: "workday", board: "initech/wd5/Careers", externalId: "_R100002" }),
    ]);
    const result = matchReply(
      input({ fromAddress: "initech@myworkday.com", subject: "Your application", body: "Regarding requisition R100002 - Software Engineer" }),
      twoRoles,
    );
    expect(result.applicationId).toBe("app_b");
  });

  it("does not take a lower-case common word for a one-word company name", () => {
    const result = matchReply(
      input({ fromAddress: "news@example.org", subject: "Weekly digest", body: "We will anchor the backend engineer meetup around design reviews." }),
      index,
    );
    expect(result.applicationId).toBeNull();
    expect(result.candidates.some((entry) => entry.applicationId === "app_anchor")).toBe(false);
  });

  it("matches a company by the short name it uses for itself", () => {
    const result = matchReply(
      input({ fromAddress: "no-reply@hire.lever.co", fromName: "Nimbus", subject: "Your application to Nimbus", body: "Machine Learning Engineer" }),
      index,
    );
    expect(result.applicationId).toBe("app_nimbus");
  });

  it("reads a company named like a domain by the name it signs with", () => {
    const contoso = buildApplicationIndex([candidate({ applicationId: "app_contoso", companyName: "Contoso.com", title: "Senior Engineer" })]);
    const result = matchReply(input({ fromAddress: "no-reply@us.greenhouse-mail.io", subject: "Thank You from Contoso" }), contoso);
    expect(result.applicationId).toBe("app_contoso");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("ignores applications submitted after the reply was sent", () => {
    const later = buildApplicationIndex([
      candidate({ applicationId: "app_new", companyName: "Globex", title: "Staff Engineer", submittedAt: "2026-10-01T00:00:00.000Z" }),
    ]);
    const result = matchReply(input({ fromAddress: "jane@globex.com", subject: "Staff Engineer", receivedAt: new Date("2026-09-10T00:00:00Z") }), later);
    expect(result.applicationId).toBeNull();
    expect(result.candidates).toEqual([]);
  });

  it("prefers the submitted application over an unsubmitted one at the same company", () => {
    const mixed = buildApplicationIndex([
      candidate({ applicationId: "app_sent", companyName: "Globex", title: "Staff Engineer" }),
      candidate({ applicationId: "app_draft", companyName: "Globex", title: "Staff Engineer", status: "approved", submittedAt: null }),
    ]);
    const result = matchReply(input({ fromAddress: "jane@globex.com", subject: "Staff Engineer application" }), mixed);
    expect(result.applicationId).toBe("app_sent");
  });

  it("reports no match for mail with no employer signal", () => {
    const result = matchReply(input({ fromAddress: "friend@gmail.com", subject: "Lunch?", body: "Are you free for a Staff Engineer chat?" }), index);
    expect(result).toMatchObject({ applicationId: null, ambiguous: false });
  });
});

describe("deciding from the envelope what to download", () => {
  const view = (fromAddress: string, subject: string, fromName = "", replyTo: string[] = []) => ({ fromAddress, fromName, subject, replyTo });

  it("lets through ATS, scheduling and assessment senders", () => {
    expect(candidateReason(view("no-reply@us.greenhouse-mail.io", "Anything"), index)).toBe("recruiting-sender");
    expect(candidateReason(view("notifications@calendly.com", "Invitation"), index)).toBe("recruiting-sender");
    expect(candidateReason(view("support@hackerrank.com", "Test invite"), index)).toBe("recruiting-sender");
  });

  it("lets through an applied company's own domain, including a Reply-To", () => {
    expect(candidateReason(view("talent@mail.globex.com", "Hello"), index)).toBe("company-domain");
    expect(candidateReason(view("noreply@mailer.example.net", "Hello", "", ["recruiting@initech.com"]), index)).toBe("company-domain");
  });

  it("lets through a manual forward whose subject names an applied company", () => {
    expect(candidateReason(view("alex@example.com", "Fwd: Your application to Initech"), index)).toBe("company-named");
  });

  it("leaves everything else unread", () => {
    expect(candidateReason(view("deals@shop.example", "50% off this weekend"), index)).toBeNull();
    expect(candidateReason(view("friend@gmail.com", "Dinner on Friday?"), index)).toBeNull();
    expect(candidateReason(view("alex@example.com", "Initech quarterly results"), index)).toBeNull();
  });
});

describe("sender domains", () => {
  it("parses addresses and registrable domains", () => {
    expect(addressDomain("Acme Recruiting <talent@Mail.Acme.co.uk>")).toBe("mail.acme.co.uk");
    expect(registrableDomain("mail.acme.co.uk")).toBe("acme.co.uk");
    expect(registrableLabel("careers.acme.com")).toBe("acme");
    expect(knownSender("acme@otp.workday.com")?.ats).toBe("workday");
    expect(knownSender("someone@workday.com.evil.example")).toBeNull();
  });

  it("matches labels to company keys with small suffixes only", () => {
    expect(labelMatchesKey("datadoghq", "datadog")).toBe(true);
    expect(labelMatchesKey("scale", "scaleai")).toBe(true);
    expect(labelMatchesKey("acmeinsurancegroup", "acme")).toBe(false);
    expect(labelMatchesKey("hp", "hp")).toBe(true);
  });
});
