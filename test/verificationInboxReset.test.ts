import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A stand-in for imapflow that fails the way Gmail did mid-submission: the
 * socket is reset during a read, the client emits 'error' from the socket's
 * own stack, and the pending FETCH is rejected as the connection closes.
 *
 * Each connection consumes one step of the script: "reset", or the messages to
 * serve. An exhausted script serves an empty mailbox.
 */
const imap = vi.hoisted(() => ({
  script: [] as Array<"reset" | Array<{ from: string; date: Date; body: string }>>,
  clients: [] as Array<{ emitThrew: unknown; errorListeners: number; loggedOut: boolean }>,
}));

vi.mock("imapflow", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeImapFlow extends EventEmitter {
    readonly record = { emitThrew: undefined as unknown, errorListeners: 0, loggedOut: false };
    private readonly step = imap.script.shift() ?? [];

    constructor(_options: unknown) {
      super();
      imap.clients.push(this.record);
    }

    async connect(): Promise<void> {}

    async logout(): Promise<void> {
      this.record.loggedOut = true;
      if (this.step === "reset") throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
    }

    async getMailboxLock(): Promise<{ release: () => void }> {
      return { release: () => undefined };
    }

    async *fetch(
      range: unknown,
      query: { source?: boolean } = {},
    ): AsyncGenerator<{ uid: number; envelope: unknown; source?: Buffer }> {
      const step = this.step;
      if (step === "reset") {
        await new Promise<void>((_resolve, reject) => {
          setImmediate(() => {
            this.record.errorListeners = this.listenerCount("error");
            try {
              this.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
            } catch (error) {
              // Node throws an 'error' event that nobody listens for. Inside
              // imapflow that throw lands on the socket's stack and kills the
              // process; recording it here keeps the test run alive to say so.
              this.record.emitThrew = error;
            }
            reject(Object.assign(new Error("Connection not available"), { code: "NoConnection" }));
          });
        });
        return;
      }
      // Like IMAP, a source is served only when asked for, by UID list.
      const wanted = query.source && typeof range === "string" ? new Set(range.split(",").map(Number)) : null;
      for (const [index, message] of step.entries()) {
        const uid = index + 1;
        if (wanted && !wanted.has(uid)) continue;
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
};

const page = { waitForTimeout: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5))) };

describe("a mailbox connection reset mid-read", () => {
  beforeEach(() => {
    imap.script.length = 0;
    imap.clients.length = 0;
  });

  it("fails the read instead of crashing the server", async () => {
    // Observed live: Gmail reset the socket (read ECONNRESET), imapflow emitted
    // 'error' with no listener attached, and Node killed the MCP server
    // mid-submission.
    imap.script.push("reset");

    await expect(fetchVerificationCode(config, new Date())).rejects.toMatchObject({ code: "NoConnection" });

    const [client] = imap.clients;
    expect(client?.errorListeners).toBeGreaterThan(0);
    expect(client?.emitThrew).toBeUndefined();
    expect(client?.loggedOut).toBe(true);
  });

  it("keeps the gate open and reads the code on the next poll", async () => {
    const emailedAt = new Date();
    imap.script.push("reset", [
      {
        from: "no-reply@us.greenhouse-mail.io",
        date: new Date(emailedAt.getTime() + 1_000),
        body: "Copy and paste this code into the security code field on your application: pvlqH9IO",
      },
    ]);

    const code = await awaitVerificationCode(
      { codeWaitMs: 10_000, verificationInbox: config } as never,
      page as never,
      emailedAt,
    );

    expect(code).toBe("pvlqH9IO");
    expect(imap.clients).toHaveLength(2);
    expect(imap.clients[0]?.emitThrew).toBeUndefined();
  });

  it("waits out its deadline rather than aborting when every read fails", async () => {
    for (let index = 0; index < 50; index += 1) imap.script.push("reset");

    await expect(
      awaitVerificationCode({ codeWaitMs: 150, verificationInbox: config } as never, page as never, new Date()),
    ).resolves.toBeUndefined();

    expect(imap.clients.length).toBeGreaterThan(1);
    expect(imap.clients.every((client) => client.emitThrew === undefined)).toBe(true);
  });
});
