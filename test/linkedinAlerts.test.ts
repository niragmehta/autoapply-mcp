import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { listLeads } from "../src/db/repositories/leads.js";
import { importJobAlert, isLinkedInAlertSender, scanAlertInbox, type AlertMessage } from "../src/sourcing/linkedinAlerts.js";
import { linkedInJobId, parseLinkedInAlert } from "../src/sourcing/linkedinParse.js";
import { messageBodies, parseMime } from "../src/sourcing/mime.js";
import { AppError } from "../src/util/errors.js";

/** Fictional alert fixtures: companies, ids and addresses are invented. */

const FIXTURES = join(import.meta.dirname, "fixtures", "sourcing");
const HTML = readFileSync(join(FIXTURES, "linkedin-alert.html"), "utf8");
const TEXT = readFileSync(join(FIXTURES, "linkedin-alert.txt"), "utf8");

function quotedPrintable(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  let out = "";
  let line = 0;
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    const piece = byte === 0x0a ? "\n" : byte > 126 || byte === 61 || (byte < 32 && byte !== 9) ? `=${byte.toString(16).toUpperCase().padStart(2, "0")}` : char;
    if (piece === "\n") {
      out += "\r\n";
      line = 0;
      continue;
    }
    if (line + piece.length > 75) {
      out += "=\r\n";
      line = 0;
    }
    out += piece;
    line += piece.length;
  }
  return out;
}

/** A multipart/alternative alert: base64 text part and quoted-printable HTML part. */
function alertEmail(from = "LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>"): string {
  const base64 = Buffer.from(TEXT, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  return [
    `From: ${from}`,
    "To: alex@example.com",
    "Subject: =?UTF-8?Q?Senior_Platform_Engineer_at_Acme_Robotics?=",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="ALT-BOUNDARY"',
    "",
    "--ALT-BOUNDARY",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64,
    "--ALT-BOUNDARY",
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    quotedPrintable(HTML),
    "--ALT-BOUNDARY--",
    "",
  ].join("\r\n");
}

let db: Db;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
});

describe("linkedInJobId", () => {
  it("reads ids from canonical, tracking and wrapped links", () => {
    expect(linkedInJobId("https://www.linkedin.com/jobs/view/4012345678")).toBe("4012345678");
    expect(linkedInJobId("https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc")).toBe("4012345678");
    expect(linkedInJobId("https://ca.linkedin.com/jobs/view/senior-platform-engineer-at-acme-4012345678?refId=x")).toBe("4012345678");
    expect(linkedInJobId("https://www.linkedin.com/jobs/search/?currentJobId=4034567890")).toBe("4034567890");
    expect(
      linkedInJobId("https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.linkedin.com%2Fcomm%2Fjobs%2Fview%2F4023456789%2F&data=1"),
    ).toBe("4023456789");
    expect(linkedInJobId("https://www.google.com/url?q=https://www.linkedin.com/jobs/view/4023456789&sa=D")).toBe("4023456789");
  });

  it("ignores look-alike hosts and links that are not postings", () => {
    expect(linkedInJobId("https://linkedin.com.evil.test/jobs/view/4012345678")).toBeNull();
    expect(linkedInJobId("https://www.linkedin.com/comm/jobs/alerts?midToken=x")).toBeNull();
    expect(linkedInJobId("https://www.linkedin.com/jobs/view/123")).toBeNull();
    expect(linkedInJobId("not a url")).toBeNull();
  });
});

describe("parseLinkedInAlert", () => {
  it("reads title, company and place from an HTML alert", () => {
    expect(parseLinkedInAlert({ html: HTML })).toEqual([
      {
        jobId: "4012345678",
        url: "https://www.linkedin.com/jobs/view/4012345678",
        title: "Senior Platform Engineer",
        company: "Acme Robotics",
        location: "San Francisco, CA (Hybrid)",
      },
      { jobId: "4023456789", url: "https://www.linkedin.com/jobs/view/4023456789", title: "Staff Security Engineer", company: "Globex Analytics", location: "Remote" },
      { jobId: "4034567890", url: "https://www.linkedin.com/jobs/view/4034567890", title: "Backend Developer", company: "Initech", location: "Toronto, ON" },
    ]);
  });

  it("reads the lines above each link in a plain-text alert", () => {
    expect(parseLinkedInAlert({ text: TEXT })).toEqual([
      expect.objectContaining({ jobId: "4012345678", title: "Senior Platform Engineer", company: "Acme Robotics", location: "San Francisco, CA (Hybrid)" }),
      expect.objectContaining({ jobId: "4023456789", title: "Staff Security Engineer", company: "Globex Analytics", location: "Remote" }),
      // No text above the link: the title comes from the words in the URL.
      expect.objectContaining({ jobId: "4034567890", title: "Backend Developer At Initech", company: "" }),
    ]);
  });

  it("treats HTML pasted into the text field as HTML", () => {
    expect(parseLinkedInAlert({ text: HTML }).map((job) => job.company)).toEqual(["Acme Robotics", "Globex Analytics", "Initech"]);
  });

  it("stays linear on hostile markup with thousands of unclosed tags", () => {
    const hostile = `${"<a href='https://example.test/x'>".repeat(50_000)}${"<style>".repeat(10)}`;
    const started = Date.now();
    const jobs = parseLinkedInAlert({ html: `${HTML}${hostile}` });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(jobs.map((job) => job.jobId)).toEqual(["4012345678", "4023456789", "4034567890"]);
  });
});

describe("mime", () => {
  it("decodes base64 and quoted-printable parts with their charsets", () => {
    const parts = parseMime(alertEmail());
    expect(parts.map((part) => part.contentType)).toEqual(["text/plain", "text/html"]);
    expect(parts[0]!.body).toBe(TEXT);
    expect(parts[1]!.body).toBe(HTML.replace(/\n/g, "\r\n"));
    const latin1 = parseMime(Buffer.from("Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf\xe9", "latin1"));
    expect(latin1[0]!.body).toBe("Café");
    expect(messageBodies(alertEmail()).html).toContain("Senior Platform Engineer");
  });
});

describe("importJobAlert", () => {
  it("stores postings as leads and ignores repeats", () => {
    const first = importJobAlert({ db }, { html: HTML });
    expect(first).toMatchObject({ found: 3, added: 3, already: 0 });
    const second = importJobAlert({ db }, { text: TEXT });
    expect(second).toMatchObject({ found: 3, added: 0, already: 3 });
    const leads = listLeads(db, { source: "linkedin-alert" });
    expect(leads).toHaveLength(3);
    expect(leads.every((lead) => lead.status === "new")).toBe(true);
    // A repeat fills a blank field but never overwrites what is there.
    expect(leads.find((lead) => lead.sourceId === "4034567890")).toMatchObject({ title: "Backend Developer", company: "Initech" });
  });

  it("explains an alert with no job links and rejects an empty paste", () => {
    expect(importJobAlert({ db }, { text: "Your alert had no matches this week." })).toMatchObject({ found: 0, added: 0 });
    expect(() => importJobAlert({ db }, { text: "   " })).toThrow(AppError);
  });
});

describe("scanAlertInbox", () => {
  const env = { AUTOAPPLY_OTP_IMAP_USER: "relay@inbox.test", AUTOAPPLY_OTP_IMAP_PASSWORD: "app-password" };

  it("imports alerts from LinkedIn senders only", async () => {
    const messages: AlertMessage[] = [
      { receivedAt: new Date("2026-11-05T12:00:00Z"), sender: "jobalerts-noreply@linkedin.com", source: alertEmail() },
      { receivedAt: new Date("2026-11-05T13:00:00Z"), sender: "newsletter@vandelay.test", source: alertEmail("Vandelay <newsletter@vandelay.test>") },
    ];
    let since: Date | null = null;
    const result = await scanAlertInbox({ db }, {
      env,
      lookbackDays: 7,
      now: new Date("2026-11-06T00:00:00Z"),
      reader: async (config, from) => {
        expect(config.user).toBe("relay@inbox.test");
        since = from;
        return messages;
      },
    });
    expect(since).toEqual(new Date("2026-10-30T00:00:00Z"));
    expect(result).toMatchObject({ messagesRead: 1, found: 3, added: 3, lookbackDays: 7 });
    expect(JSON.stringify(result)).not.toContain("app-password");
  });

  it("requires a configured mailbox and bounds the lookback", async () => {
    await expect(scanAlertInbox({ db }, { env: {}, reader: async () => [] })).rejects.toMatchObject({ code: "inbox_not_configured" });
    const result = await scanAlertInbox({ db }, { env, lookbackDays: 400, reader: async () => [] });
    expect(result).toMatchObject({ lookbackDays: 90, messagesRead: 0, found: 0 });
    expect(result.message).toContain("No LinkedIn job alerts");
  });

  it("recognizes LinkedIn alert senders", () => {
    expect(isLinkedInAlertSender("jobalerts-noreply@linkedin.com")).toBe(true);
    expect(isLinkedInAlertSender("jobs-listings@linkedin.com")).toBe(true);
    expect(isLinkedInAlertSender("messages-noreply@linkedin.com")).toBe(false);
    expect(isLinkedInAlertSender("jobalerts@linkedin.com.evil.test")).toBe(false);
  });
});
