import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for imapflow that serves envelopes and sources separately, the way
 * IMAP does, and can hang a connection the way Gmail did while throttling.
 *
 * Each connection consumes one step of the script: "stall" never finishes
 * connecting; a message list is the mailbox to serve. An exhausted script
 * serves an empty mailbox.
 */
const imap = vi.hoisted(() => ({
  script: [] as Array<"stall" | Array<{ from: string; date: Date; body: string }>>,
  clients: [] as Array<{ closed: boolean; sourcesServed: number }>,
}));

vi.mock("imapflow", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeImapFlow extends EventEmitter {
    readonly record = { closed: false, sourcesServed: 0 };
    private readonly step = imap.script.shift() ?? [];

    constructor(_options: unknown) {
      super();
      imap.clients.push(this.record);
    }

    async connect(): Promise<void> {
      if (this.step === "stall") await new Promise<void>(() => undefined);
    }

    close(): void {
      this.record.closed = true;
    }

    async logout(): Promise<void> {}

    async getMailboxLock(): Promise<{ release: () => void }> {
      return { release: () => undefined };
    }

    async *fetch(
      range: unknown,
      query: { source?: boolean } = {},
    ): AsyncGenerator<{ uid: number; envelope: unknown; source?: Buffer }> {
      const step = this.step === "stall" ? [] : this.step;
      const wanted = query.source && typeof range === "string" ? new Set(range.split(",").map(Number)) : null;
      for (const [index, message] of step.entries()) {
        const uid = index + 1;
        if (wanted && !wanted.has(uid)) continue;
        if (query.source) this.record.sourcesServed += 1;
        yield {
          uid,
          envelope: { date: message.date, from: [{ address: message.from }] },
          ...(query.source ? { source: Buffer.from(message.body, "utf8") } : {}),
        };
      }
    }
  }
  return { ImapFlow: FakeImapFlow };
});

import { awaitVerificationCode } from "../src/submission/browser.js";
import { fetchVerificationCode, type VerificationInboxConfig } from "../src/submission/verificationInbox.js";

const config: VerificationInboxConfig = {
  host: "imap.example.com",
  port: 993,
  user: "codes@example.com",
  password: "secret",
  mailboxes: ["INBOX"],
  from: "greenhouse-mail.io",
};

const page = { waitForTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))) };

describe("reading the verification mailbox", () => {
  beforeEach(() => {
    imap.script.length = 0;
    imap.clients.length = 0;
  });

  // The relay held 190 messages from the last day and a half. Every poll
  // downloaded each one in full only to discard most of them by sender, and a
  // single read took long enough that Gremlin's code expired before it was typed.
  it("downloads a message's source only when its sender is accepted", async () => {
    const emailedAt = new Date();
    const later = new Date(emailedAt.getTime() + 1_000);
    imap.script.push([
      { from: "news@example.com", date: later, body: "Weekly digest" },
      { from: "alerts@example.org", date: later, body: "Your order shipped" },
      {
        from: "no-reply@us.greenhouse-mail.io",
        date: later,
        body: "Copy and paste this code into the security code field on your application: pvlqH9IO",
      },
    ]);

    await expect(fetchVerificationCode(config, emailedAt)).resolves.toBe("pvlqH9IO");
    expect(imap.clients[0]?.sourcesServed).toBe(1);
  });

  it("downloads only messages dated after the submit click", async () => {
    // Every code from earlier applications sits in the same folder. Re-reading
    // them in full on every two-second poll is what pushed the relay into
    // Gmail's bandwidth limits.
    const emailedAt = new Date();
    imap.script.push([
      {
        from: "no-reply@us.greenhouse-mail.io",
        date: new Date(emailedAt.getTime() - 10 * 60_000),
        body: "Copy and paste this code into the security code field on your application: oldCode1",
      },
      {
        from: "no-reply@us.greenhouse-mail.io",
        date: new Date(emailedAt.getTime() + 1_000),
        body: "Copy and paste this code into the security code field on your application: pvlqH9IO",
      },
    ]);

    await expect(fetchVerificationCode(config, emailedAt)).resolves.toBe("pvlqH9IO");
    expect(imap.clients[0]?.sourcesServed).toBe(1);
  });

  it("abandons a read that stalls so the next poll can try again", async () => {
    const emailedAt = new Date();
    imap.script.push("stall", [
      {
        from: "no-reply@us.greenhouse-mail.io",
        date: new Date(emailedAt.getTime() + 1_000),
        body: "Copy and paste this code into the security code field on your application: pvlqH9IO",
      },
    ]);

    const code = await awaitVerificationCode(
      { codeWaitMs: 5_000, verificationInbox: { ...config, readTimeoutMs: 50 } } as never,
      page as never,
      emailedAt,
    );

    expect(code).toBe("pvlqH9IO");
    expect(imap.clients).toHaveLength(2);
    expect(imap.clients[0]?.closed).toBe(true);
  });
});
