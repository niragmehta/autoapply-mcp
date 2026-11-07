import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHarvestArgs } from "../src/cli/harvest.js";
import { readLinkedInAlertMail } from "../src/sourcing/linkedinAlerts.js";
import type { VerificationInboxConfig } from "../src/submission/verificationInbox.js";

/**
 * The IMAP reader against a fake imapflow client: it must open every folder
 * read-only, never touch flags, and read only LinkedIn alert senders.
 */

type FakeMessage = { uid: number; envelope: { date: Date; messageId: string; from: Array<{ address: string }> }; source: Buffer };

const calls: Array<{ method: string; args: unknown[] }> = [];
const folders: Record<string, FakeMessage[]> = {};

vi.mock("imapflow", () => {
  class ImapFlow {
    constructor(options: unknown) {
      calls.push({ method: "constructor", args: [options] });
    }
    on(event: string) {
      calls.push({ method: "on", args: [event] });
    }
    async connect() {
      calls.push({ method: "connect", args: [] });
    }
    async logout() {
      calls.push({ method: "logout", args: [] });
    }
    current = "";
    async getMailboxLock(mailbox: string, options?: unknown) {
      calls.push({ method: "getMailboxLock", args: [mailbox, options] });
      if (!folders[mailbox]) throw new Error("Mailbox doesn't exist");
      this.current = mailbox;
      return { release: () => calls.push({ method: "release", args: [mailbox] }) };
    }
    async *fetch(range: unknown, query: unknown, options?: unknown) {
      calls.push({ method: "fetch", args: [range, query, options] });
      const messages = folders[this.current] ?? [];
      if (typeof range === "string") {
        const wanted = new Set(range.split(",").map(Number));
        for (const message of messages.filter((entry) => wanted.has(entry.uid))) yield message;
        return;
      }
      for (const message of messages) yield { uid: message.uid, envelope: message.envelope };
    }
    // Present so a call to it would be recorded; the reader must never use it.
    async messageFlagsAdd(...args: unknown[]) {
      calls.push({ method: "messageFlagsAdd", args });
    }
  }
  return { ImapFlow };
});

const config: VerificationInboxConfig = {
  host: "imap.inbox.test",
  port: 993,
  user: "relay@inbox.test",
  password: "app-password",
  mailboxes: ["INBOX", "[Gmail]/All Mail", "Missing"],
};

function message(uid: number, from: string, messageId: string): FakeMessage {
  return { uid, envelope: { date: new Date("2026-11-05T10:00:00Z"), messageId, from: [{ address: from }] }, source: Buffer.from(`From: ${from}\r\n\r\nbody ${uid}`) };
}

afterEach(() => {
  calls.length = 0;
  for (const key of Object.keys(folders)) delete folders[key];
});

describe("readLinkedInAlertMail", () => {
  it("opens folders read-only, filters senders and reads each message once", async () => {
    folders.INBOX = [message(1, "jobalerts-noreply@linkedin.com", "<a@linkedin.com>"), message(2, "friend@mail.test", "<b@mail.test>")];
    // All Mail repeats the inbox message under another uid.
    folders["[Gmail]/All Mail"] = [message(7, "jobalerts-noreply@linkedin.com", "<a@linkedin.com>"), message(8, "jobs-listings@linkedin.com", "<c@linkedin.com>")];

    const messages = await readLinkedInAlertMail(config, new Date("2026-10-30T00:00:00Z"));

    expect(messages.map((entry) => entry.sender)).toEqual(["jobalerts-noreply@linkedin.com", "jobs-listings@linkedin.com"]);
    const locks = calls.filter((call) => call.method === "getMailboxLock");
    expect(locks.map((call) => call.args)).toEqual([
      ["INBOX", { readOnly: true }],
      ["[Gmail]/All Mail", { readOnly: true }],
      ["Missing", { readOnly: true }],
    ]);
    const searches = calls.filter((call) => call.method === "fetch" && typeof call.args[0] === "object");
    expect(searches[0]!.args[0]).toEqual({ since: new Date("2026-10-30T00:00:00Z"), from: "linkedin.com" });
    const downloads = calls.filter((call) => call.method === "fetch" && typeof call.args[0] === "string");
    expect(downloads.map((call) => call.args[0])).toEqual(["1", "8"]);
    expect(downloads[0]!.args[1]).toEqual({ envelope: true, source: true });
    expect(calls.some((call) => call.method === "messageFlagsAdd")).toBe(false);
    expect(calls.filter((call) => call.method === "release")).toHaveLength(2);
    expect(calls.at(-1)?.method).toBe("logout");
  });
});

describe("harvest CLI arguments", () => {
  it("parses and validates options", () => {
    expect(parseHarvestArgs(["--ats", "greenhouse,lever", "--indexes", "2", "--scan"])).toMatchObject({
      ats: ["greenhouse", "lever"],
      indexes: 2,
      scan: true,
      scanOnly: false,
      limit: 50,
    });
    expect(parseHarvestArgs([])).toMatchObject({ ats: ["greenhouse", "ashby", "lever", "workday"], indexes: 1, scan: false });
    expect(parseHarvestArgs(["--scan-only", "--limit", "10", "--rescan-days", "7", "--index", "CC-MAIN-2026-43"])).toMatchObject({
      scan: true,
      scanOnly: true,
      limit: 10,
      rescanDays: 7,
      indexIds: ["CC-MAIN-2026-43"],
    });
    expect(() => parseHarvestArgs(["--ats", "taleo"])).toThrow("unknown ATS: taleo");
    expect(() => parseHarvestArgs(["--indexes", "two"])).toThrow("--indexes must be a whole number");
    expect(() => parseHarvestArgs(["--bogus"])).toThrow();
  });
});
