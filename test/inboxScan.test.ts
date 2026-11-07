import { EventEmitter } from "node:events";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../src/config/load.js";
import { listOutcomes } from "../src/db/repositories/applications.js";
import { getInboxState, listInboxMessages } from "../src/db/repositories/inbox.js";
import type { ReplyInboxConfig } from "../src/inbox/config.js";
import type { ImapMessage, ReplyImapClient } from "../src/inbox/imap.js";
import { scanInbox } from "../src/inbox/scan.js";
import { inboxStatus } from "../src/inbox/status.js";
import { makeWorkspace, seedApplication } from "./afterApplyFixtures.js";

/**
 * A stand-in IMAP server. It serves envelopes and sources separately the way
 * IMAP does, applies "n:*" the way servers do (the newest message is always
 * returned), records every call, and exposes the write commands a read-only
 * scanner must never use so a stray call would be caught.
 */

type FakeMessage = {
  uid: number;
  from: string;
  fromName?: string;
  replyTo?: string;
  subject: string;
  date: Date;
  body?: string;
  source?: string;
  messageId?: string;
};

type FakeFolder = { uidValidity: number; messages: FakeMessage[] };

type Behaviour = { stallConnect?: boolean; resetOnSource?: boolean; stallOnSource?: boolean };

function rawMessage(message: FakeMessage): string {
  if (message.source) return message.source;
  return [
    `From: ${message.fromName ?? ""} <${message.from}>`,
    `Subject: ${message.subject}`,
    `Date: ${message.date.toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    message.body ?? "",
  ].join("\r\n");
}

class FakeImap extends EventEmitter implements ReplyImapClient {
  readonly locks: Array<{ path: string; options: unknown }> = [];
  readonly fetches: Array<{ range: unknown; query: Record<string, unknown>; options?: unknown }> = [];
  readonly sourcesServed: number[] = [];
  readonly writes: string[] = [];
  closed = false;
  loggedOut = false;
  emitThrew: unknown = undefined;
  mailbox: { uidValidity?: bigint } | false = false;
  private current: FakeFolder | null = null;
  private readonly folders: Record<string, FakeFolder>;
  private readonly behaviour: Behaviour;

  constructor(folders: Record<string, FakeFolder>, behaviour: Behaviour = {}) {
    super();
    this.folders = folders;
    this.behaviour = behaviour;
  }

  async connect(): Promise<void> {
    if (this.behaviour.stallConnect) await new Promise<void>(() => undefined);
  }

  async logout(): Promise<void> {
    this.loggedOut = true;
  }

  close(): void {
    this.closed = true;
  }

  async getMailboxLock(path: string, options: { readOnly: true }): Promise<{ release(): void }> {
    this.locks.push({ path, options });
    const folder = this.folders[path];
    if (!folder) throw Object.assign(new Error("Mailbox doesn't exist"), { mailboxMissing: true });
    this.current = folder;
    this.mailbox = { uidValidity: BigInt(folder.uidValidity) };
    return { release: () => undefined };
  }

  messageFlagsAdd(): void {
    this.writes.push("messageFlagsAdd");
  }
  messageMove(): void {
    this.writes.push("messageMove");
  }
  messageDelete(): void {
    this.writes.push("messageDelete");
  }

  private select(range: unknown): FakeMessage[] {
    const messages = [...(this.current?.messages ?? [])].sort((a, b) => a.uid - b.uid);
    if (typeof range === "object" && range !== null && "since" in range) {
      const since = (range as { since: Date }).since;
      const day = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate());
      return messages.filter((message) => message.date.getTime() >= day);
    }
    const text = String(range);
    const open = /^(\d+):\*$/.exec(text);
    if (open) {
      const from = Number(open[1]);
      const newer = messages.filter((message) => message.uid >= from);
      return newer.length > 0 ? newer : messages.slice(-1);
    }
    const wanted = new Set(text.split(",").map(Number));
    return messages.filter((message) => wanted.has(message.uid));
  }

  async *fetch(range: unknown, query: Record<string, unknown>, options?: { uid?: boolean }): AsyncGenerator<ImapMessage> {
    this.fetches.push({ range, query, options });
    if (query.source && this.behaviour.stallOnSource) await new Promise<void>(() => undefined);
    if (query.source && this.behaviour.resetOnSource) {
      try {
        this.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      } catch (error) {
        this.emitThrew = error;
      }
      throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
    }
    for (const message of this.select(range)) {
      if (query.source) this.sourcesServed.push(message.uid);
      yield {
        uid: message.uid,
        internalDate: message.date,
        envelope: {
          date: message.date,
          subject: message.subject,
          messageId: message.messageId ?? `<uid-${message.uid}-${message.subject.length}@mail.example>`,
          from: [{ address: message.from, name: message.fromName ?? "" }],
          replyTo: message.replyTo ? [{ address: message.replyTo }] : [],
        },
        ...(query.source ? { source: Buffer.from(rawMessage(message), "utf8") } : {}),
      };
    }
  }
}

const NOW = new Date("2026-09-20T12:00:00Z");
const config: ReplyInboxConfig = {
  host: "imap.example.com",
  port: 993,
  user: "replies@example.com",
  password: "not-a-real-password",
  mailboxes: ["INBOX"],
  credentialSource: "AUTOAPPLY_INBOX_IMAP",
};

const REJECTION =
  "Thank you for applying for the Senior Security Engineer role at Acme. Unfortunately, we have decided to move forward with other candidates.";

function inboxMessages(): FakeMessage[] {
  return [
    { uid: 1, from: "deals@shop.example", subject: "50% off this weekend", date: new Date("2026-09-12T08:00:00Z"), body: "Sale!" },
    {
      uid: 2,
      from: "no-reply@us.greenhouse-mail.io",
      fromName: "Acme Recruiting",
      subject: "Acme | Update on your application",
      date: new Date("2026-09-12T09:00:00Z"),
      body: REJECTION,
    },
    { uid: 3, from: "friend@gmail.com", subject: "Dinner on Friday?", date: new Date("2026-09-13T08:00:00Z"), body: "Pizza?" },
    {
      uid: 4,
      from: "jane@globex.com",
      fromName: "Jane at Globex",
      subject: "Interview for Staff Engineer",
      date: new Date("2026-09-14T08:00:00Z"),
      body: "We would like to invite you to an onsite interview for the Staff Engineer role.",
    },
  ];
}

let workspace: Workspace;

function scan(fake: FakeImap, options: Parameters<typeof scanInbox>[1] = {}, configOverride: ReplyInboxConfig = config) {
  return scanInbox(workspace, { now: NOW, ...options }, { config: configOverride, createClient: async () => fake });
}

beforeAll(() => {
  process.env.AUTOAPPLY_LOG_LEVEL = "error";
});

beforeEach(() => {
  workspace = makeWorkspace({ campaign: { inbox: { enabled: true, lookbackDays: 30 } } });
  seedApplication(workspace.db, { id: "app_sec", company: "Acme", title: "Senior Security Engineer" });
  seedApplication(workspace.db, { id: "app_globex", company: "Globex", title: "Staff Engineer" });
});

describe("scanning the mailbox", () => {
  it("opens folders read-only and downloads only hiring mail", async () => {
    const fake = new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } });
    const result = await scan(fake);

    expect(fake.locks.every((lock) => (lock.options as { readOnly?: boolean }).readOnly === true)).toBe(true);
    expect(fake.sourcesServed).toEqual([2, 4]);
    expect(fake.writes).toEqual([]);
    expect(fake.loggedOut).toBe(true);
    expect(result.counts).toMatchObject({ candidates: 2, stored: 2, recorded: 1, proposed: 1, dismissed: 0 });
    expect(listOutcomes(workspace.db, "app_sec").map((entry) => entry.status)).toEqual(["rejected"]);
    expect(listInboxMessages(workspace.db)).toHaveLength(2);
    expect(getInboxState(workspace.db, "INBOX")).toMatchObject({ lastUid: 4, uidValidity: "7", lastDate: "2026-09-14T08:00:00.000Z" });
    // The first read of a folder is by date, from the campaign's lookback.
    expect(fake.fetches[0]?.range).toEqual({ since: new Date("2026-08-21T12:00:00.000Z") });
  });

  it("resumes from the last UID and skips the newest message a server always returns for n:*", async () => {
    const messages = inboxMessages();
    await scan(new FakeImap({ INBOX: { uidValidity: 7, messages } }));

    const quiet = new FakeImap({ INBOX: { uidValidity: 7, messages } });
    const nothingNew = await scan(quiet);
    expect(quiet.fetches[0]).toMatchObject({ range: "5:*", options: { uid: true } });
    expect(quiet.sourcesServed).toEqual([]);
    expect(nothingNew.counts.candidates).toBe(0);

    const ack = {
      uid: 5,
      from: "no-reply@us.greenhouse-mail.io",
      fromName: "Globex",
      subject: "Thank you for applying to Globex",
      date: new Date("2026-09-15T08:00:00Z"),
      body: "We have received your application for the Staff Engineer role. Our team will review your application and we'll be in touch.",
    };
    const busy = new FakeImap({ INBOX: { uidValidity: 7, messages: [...messages, ack] } });
    const next = await scan(busy);
    expect(busy.sourcesServed).toEqual([5]);
    expect(next.counts).toMatchObject({ candidates: 1, recorded: 1 });
    expect(getInboxState(workspace.db, "INBOX")?.lastUid).toBe(5);
  });

  it("falls back to a date search when the server renumbers the folder", async () => {
    await scan(new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } }));
    const renumbered = new FakeImap({ INBOX: { uidValidity: 8, messages: inboxMessages() } });
    const result = await scan(renumbered);
    const range = renumbered.fetches[0]?.range as { since: Date };
    // Resumes from the newest message seen, widened by 36 hours for IMAP's whole-day SINCE.
    expect(range.since.toISOString()).toBe("2026-09-12T20:00:00.000Z");
    expect(result.counts).toMatchObject({ stored: 0, duplicates: 2 });
    expect(getInboxState(workspace.db, "INBOX")).toMatchObject({ uidValidity: "8", lastUid: 4 });
  });

  it("re-reads by date when a lookback is asked for", async () => {
    await scan(new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } }));
    const again = new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } });
    const result = await scan(again, { lookbackDays: 10 });
    expect(again.fetches[0]?.range).toEqual({ since: new Date("2026-09-10T12:00:00.000Z") });
    expect(result.counts).toMatchObject({ stored: 0, duplicates: 2 });
    expect(listOutcomes(workspace.db, "app_sec")).toHaveLength(1);
  });

  it("skips a folder the provider does not have", async () => {
    const fake = new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } });
    const result = await scan(fake, {}, { ...config, mailboxes: ["[Gmail]/Trash", "INBOX"] });
    expect(result.mailboxes[0]).toMatchObject({ mailbox: "[Gmail]/Trash", mode: "skipped", error: "folder not found" });
    expect(result.mailboxes[1]).toMatchObject({ mailbox: "INBOX", complete: true });
    expect(result.counts.stored).toBe(2);
  });

  it("drops a stalled connection and reports the mailbox unreachable", async () => {
    const fake = new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } }, { stallConnect: true });
    await expect(scan(fake, { readTimeoutMs: 50 })).rejects.toMatchObject({ code: "inbox_unreachable" });
    expect(fake.closed).toBe(true);
  });

  it("gives up on a read that stalls part-way, keeping the checkpoint where it was", async () => {
    const fake = new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } }, { stallOnSource: true });
    const result = await scan(fake, { readTimeoutMs: 50 });
    expect(result.timedOut).toBe(true);
    expect(fake.closed).toBe(true);
    expect(result.mailboxes[0]).toMatchObject({ mailbox: "INBOX", candidates: 2, complete: false });
    expect(getInboxState(workspace.db, "INBOX")).toBeNull();
  });

  it("survives a socket reset mid-read without moving the checkpoint", async () => {
    const fake = new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } }, { resetOnSource: true });
    const result = await scan(fake);
    expect(fake.listenerCount("error")).toBeGreaterThan(0);
    expect(fake.emitThrew).toBeUndefined();
    expect(result.mailboxes[0]).toMatchObject({ complete: false });
    expect(result.mailboxes[0]?.error).toContain("NoConnection");
    expect(getInboxState(workspace.db, "INBOX")).toBeNull();
    expect(fake.loggedOut).toBe(true);
  });

  it("stores nothing and keeps the checkpoint on a dry run", async () => {
    const result = await scan(new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } }), { dryRun: true });
    expect(result).toMatchObject({ dryRun: true });
    expect(result.counts).toMatchObject({ stored: 0, recorded: 1, proposed: 1 });
    expect(listInboxMessages(workspace.db)).toHaveLength(0);
    expect(listOutcomes(workspace.db, "app_sec")).toHaveLength(0);
    expect(getInboxState(workspace.db, "INBOX")).toBeNull();
  });

  it("holds the checkpoint at the first message left for the next scan", async () => {
    const fake = new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } });
    const result = await scan(fake, { maxCandidatesPerMailbox: 1 });
    expect(fake.sourcesServed).toEqual([2]);
    expect(result.mailboxes[0]).toMatchObject({ candidates: 2, downloaded: 1, deferred: 1 });
    expect(getInboxState(workspace.db, "INBOX")?.lastUid).toBe(3);
  });

  it("reads a multipart message with encoded parts", async () => {
    const html = Buffer.from(`<html><body><p>${REJECTION}</p></body></html>`, "utf8").toString("base64");
    const source = [
      "From: Acme Recruiting <no-reply@us.greenhouse-mail.io>",
      "Subject: Update",
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      html,
      "--b1--",
    ].join("\r\n");
    const fake = new FakeImap({
      INBOX: {
        uidValidity: 7,
        messages: [{ uid: 1, from: "no-reply@us.greenhouse-mail.io", fromName: "Acme Recruiting", subject: "Update from Acme", date: new Date("2026-09-12T09:00:00Z"), source }],
      },
    });
    const result = await scan(fake);
    expect(result.replies[0]).toMatchObject({ kind: "rejected", action: "record", applicationId: "app_sec" });
  });

  it("refuses to read when the campaign has not turned it on, or no mailbox is configured", async () => {
    workspace = makeWorkspace({ campaign: { inbox: { enabled: false } } });
    await expect(scan(new FakeImap({}))).rejects.toMatchObject({ code: "inbox_disabled" });
    workspace = makeWorkspace({ campaign: { inbox: { enabled: true } } });
    await expect(scanInbox(workspace, {}, { config: null, createClient: async () => new FakeImap({}) })).rejects.toMatchObject({
      code: "inbox_not_configured",
    });
  });

  it("reports where reply reading stands without revealing credentials", async () => {
    const before = inboxStatus(workspace, {});
    expect(before).toMatchObject({ enabled: true, configured: false, credentialSource: null, lastScanAt: null, checkpoints: [] });
    await scan(new FakeImap({ INBOX: { uidValidity: 7, messages: inboxMessages() } }));
    const after = inboxStatus(workspace, { AUTOAPPLY_OTP_IMAP_USER: "codes@example.com", AUTOAPPLY_OTP_IMAP_PASSWORD: "secret-value" });
    expect(after).toMatchObject({
      configured: true,
      credentialSource: "AUTOAPPLY_OTP_IMAP",
      host: "imap.gmail.com",
      replies: { new: 0, proposed: 1, recorded: 1, dismissed: 0 },
    });
    expect(after.checkpoints).toEqual([expect.objectContaining({ mailbox: "INBOX", lastUid: 4 })]);
    expect(after.lastScanAt).not.toBeNull();
    expect(JSON.stringify(after)).not.toContain("secret-value");
  });
});
