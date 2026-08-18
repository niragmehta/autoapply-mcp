import { describe, expect, it } from "vitest";
import { canAwaitVerificationCode } from "../src/submission/browser.js";
import {
  decodeMessageText,
  extractVerificationCode,
  fetchVerificationCode,
  readVerificationInboxConfig,
  type VerificationInboxConfig,
} from "../src/submission/verificationInbox.js";

const config: VerificationInboxConfig = {
  host: "imap.example.com",
  port: 993,
  user: "codes@example.com",
  password: "secret",
  mailboxes: ["INBOX"],
};

describe("waiting at a verification gate", () => {
  it("waits on a configured mailbox alone, with no code file", () => {
    // This demanded a code file, so a mailbox-only run returned instantly and
    // reported that no code arrived on a fully filled form.
    expect(canAwaitVerificationCode({ codeWaitMs: 300_000, verificationInbox: config })).toBe(true);
  });

  it("waits on a code file alone, with no mailbox", () => {
    expect(canAwaitVerificationCode({ codeWaitMs: 300_000, codeFilePath: "a.code", verificationInbox: null })).toBe(
      true,
    );
  });

  it("does not wait when nothing can supply a code, or when no time was granted", () => {
    expect(canAwaitVerificationCode({ codeWaitMs: 300_000, verificationInbox: null })).toBe(false);
    expect(canAwaitVerificationCode({ codeWaitMs: 0, codeFilePath: "a.code", verificationInbox: config })).toBe(false);
  });
});

describe("verification inbox configuration", () => {
  it("is absent until credentials are supplied", () => {
    expect(readVerificationInboxConfig({})).toBeNull();
    expect(readVerificationInboxConfig({ AUTOAPPLY_OTP_IMAP_USER: "a@b.c" })).toBeNull();
  });

  it("defaults to Gmail over IMAPS once credentials exist", () => {
    const resolved = readVerificationInboxConfig({
      AUTOAPPLY_OTP_IMAP_USER: "codes@example.com",
      AUTOAPPLY_OTP_IMAP_PASSWORD: "secret",
    });
    expect(resolved).toMatchObject({ host: "imap.gmail.com", port: 993 });
  });

  it("looks beyond the inbox, because a forwarding filter can delete on arrival", () => {
    // Observed: a Gmail filter with "delete it" ticked put every code straight
    // into Trash, where an inbox-only reader found nothing while the codes were
    // sitting there perfectly readable.
    const resolved = readVerificationInboxConfig({
      AUTOAPPLY_OTP_IMAP_USER: "codes@example.com",
      AUTOAPPLY_OTP_IMAP_PASSWORD: "secret",
    });
    expect(resolved?.mailboxes).toContain("INBOX");
    expect(resolved?.mailboxes).toContain("[Gmail]/Trash");
  });

  it("takes an explicit folder list over the defaults", () => {
    const resolved = readVerificationInboxConfig({
      AUTOAPPLY_OTP_IMAP_USER: "codes@example.com",
      AUTOAPPLY_OTP_IMAP_PASSWORD: "secret",
      AUTOAPPLY_OTP_MAILBOX: "Codes, Archive ",
    });
    expect(resolved?.mailboxes).toEqual(["Codes", "Archive"]);
  });
});

describe("extracting the code from an email", () => {
  it("reads a labelled Greenhouse code", () => {
    const body = "Hi Nirag,\r\n\r\nYour verification code is pvlqH9IO\r\n\r\nThanks,\r\nGreenhouse";
    expect(extractVerificationCode(body)).toBe("pvlqH9IO");
  });

  it("reads a code with no digit in it", () => {
    expect(extractVerificationCode("Enter this code: ZUvwsFBq to continue")).toBe("ZUvwsFBq");
  });

  it("finds the code with no label at all", () => {
    expect(extractVerificationCode("Nirag,\r\n\r\nKbZB13vY\r\n\r\nGreenhouse Software")).toBe("KbZB13vY");
  });

  /**
   * Brex's code on 2026-08-16 was `a7rbekvS` - one capital. It was matched by
   * the label and then discarded by a shape test written from a handful of
   * codes that happened to carry two, so the run waited out its whole timeout
   * on a code already sitting in the inbox.
   */
  it("reads a labelled code carrying only one capital", () => {
    const body = "Copy and paste this code into the security code field on your application:\r\n\r\na7rbekvS\r\n";
    expect(extractVerificationCode(body)).toBe("a7rbekvS");
  });

  it("reads a labelled code carrying no capital at all", () => {
    expect(extractVerificationCode("Your security code is: a7rbekv4")).toBe("a7rbekv4");
  });

  it("still refuses the ordinary word sitting beside the code", () => {
    // "After you enter the code, resubmit your application." is one sentence
    // away in Greenhouse's own email, and carries neither digit nor capital.
    expect(extractVerificationCode("Enter the code: resubmit your application")).toBeNull();
  });

  it("does not loosen the unlabelled scan, which reads signature blobs too", () => {
    // A DKIM blob offers well over a hundred fragments of this exact shape.
    // Unlabelled, one capital is not enough to call something a code.
    expect(extractVerificationCode("Nirag,\r\n\r\na7rbekvS\r\n\r\nGreenhouse")).toBeNull();
  });

  it("is not fooled by a mixed-case brand name of the same length", () => {
    expect(extractVerificationCode("Sent via LinkedIn to Nirag Mehta")).toBeNull();
  });

  it("refuses to guess when two different candidates appear", () => {
    // A wrong code is not a free retry: the board rejects it and emails a fresh
    // one, killing the code this run is waiting on.
    expect(extractVerificationCode("code N8NFAEQw and also code ZUvwsFBq")).toBeNull();
  });

  it("ignores ordinary prose", () => {
    expect(extractVerificationCode("Thank you for applying to Abnormal Security.")).toBeNull();
  });
});

describe("the email Greenhouse actually sends", () => {
  /**
   * Trimmed from the message Abnormal Security's board sent on 2026-08-14. The
   * code is long dead. Two details matter: the code follows a colon, and one
   * sentence later the word "resubmit" sits directly after "code," - which an
   * unanchored search returns as the code.
   */
  const GREENHOUSE = [
    "Content-Type: text/html; charset=utf-8",
    "Subject: Security code for your application to Abnormal",
    "",
    "<p>Hi Nirag,</p>",
    "<p>Copy and paste this code into the security code field on your application: dkgqL1KS</p>",
    "<p>After you enter the code, resubmit your application.</p>",
    '<a href="https://us.greenhouse-mail.io/ss/c/WH3q1f0elHUbkUWmL8z2WsazVD">unsubscribe</a>',
  ].join("\r\n");

  it("reads the code and not the word that follows the next mention", () => {
    expect(extractVerificationCode(decodeMessageText(Buffer.from(GREENHOUSE, "utf8")))).toBe("dkgqL1KS");
  });

  it("discards tracking hashes in link targets, which are shaped exactly like codes", () => {
    const text = decodeMessageText(Buffer.from(GREENHOUSE, "utf8"));
    expect(text).not.toContain("WH3q1f0elH");
  });

  it("discards the headers, so a subject line cannot supply a candidate", () => {
    const text = decodeMessageText(Buffer.from(GREENHOUSE, "utf8"));
    expect(text).not.toContain("Content-Type");
  });
});

describe("choosing which email to trust", () => {
  const since = new Date("2026-08-13T20:00:00Z");

  it("ignores a code that arrived before this attempt asked for one", async () => {
    const stale = [{ receivedAt: new Date("2026-08-13T19:58:00Z"), body: "code pvlqH9IO" }];
    await expect(fetchVerificationCode(config, since, async () => stale)).resolves.toBeNull();
  });

  it("takes the newest code once one arrives", async () => {
    const messages = [
      { receivedAt: new Date("2026-08-13T20:00:30Z"), body: "code N8NFAEQw" },
      { receivedAt: new Date("2026-08-13T20:01:30Z"), body: "code ZUvwsFBq" },
    ];
    await expect(fetchVerificationCode(config, since, async () => messages)).resolves.toBe("ZUvwsFBq");
  });

  it("accepts a code dated a second early, which is all IMAP's resolution promises", async () => {
    // The board emails the code as the submit click lands, and IMAP rounds
    // arrival down to the second, so the answer can be dated fractionally
    // before the question. Rejecting it discards every real code.
    const truncated = [{ receivedAt: new Date("2026-08-13T19:59:59Z"), body: "code gobU461O" }];
    await expect(fetchVerificationCode(config, since, async () => truncated)).resolves.toBe("gobU461O");
  });

  it("still refuses a code from the previous attempt minutes earlier", async () => {
    const previous = [{ receivedAt: new Date("2026-08-13T19:59:00Z"), body: "code dkgqL1KS" }];
    await expect(fetchVerificationCode(config, since, async () => previous)).resolves.toBeNull();
  });
});

describe("the window the mailbox is searched over", () => {
  /**
   * IMAP SINCE matches whole days against INTERNALDATE as the mail server
   * reckons it. A code emailed at 06:30 UTC is stamped 23:30 the previous day
   * in Pacific time, so searching from the moment of the click drops it - and
   * only in the evening, which is why this worked at 00:23 local and then
   * missed every code emailed later the same day.
   */
  const clickedAt = new Date("2026-08-15T06:30:00Z");

  it("searches from well before the click so a day boundary cannot hide the code", async () => {
    let asked: Date | undefined;
    await fetchVerificationCode(config, clickedAt, async (_config, since) => {
      asked = since;
      return [];
    });
    const hoursEarlier = (clickedAt.getTime() - (asked?.getTime() ?? 0)) / 3_600_000;
    expect(hoursEarlier).toBeGreaterThanOrEqual(24);
  });

  it("finds a code the server dated on the previous local day", async () => {
    const emailed = { receivedAt: new Date("2026-08-15T06:30:02Z"), body: "code 7elHZjj6" };
    const found = await fetchVerificationCode(config, clickedAt, async (_config, since) => {
      // Stands in for the mismatch that actually loses the code: the search
      // date goes out as a whole UTC day, while the server buckets the message
      // by its own local day. At UTC-7 this message is stamped 14-Aug, so a
      // search sent as 15-Aug never reaches it.
      const utcDay = Math.floor(since.getTime() / 86_400_000);
      const serverDay = Math.floor((emailed.receivedAt.getTime() - 7 * 3_600_000) / 86_400_000);
      return serverDay >= utcDay ? [emailed] : [];
    });
    expect(found).toBe("7elHZjj6");
  });

  it("widening the search still does not admit a code from an earlier attempt", async () => {
    const yesterday = [{ receivedAt: new Date("2026-08-14T22:00:00Z"), body: "code dkgqL1KS" }];
    await expect(fetchVerificationCode(config, clickedAt, async () => yesterday)).resolves.toBeNull();
  });
});

describe("decoding a raw message", () => {
  it("rejoins a code split by a quoted-printable soft break", () => {
    const source = Buffer.from("Your code is pvlq=\r\nH9IO now", "utf8");
    expect(decodeMessageText(source)).toContain("pvlqH9IO");
  });

  it("strips html tags so a code inside markup is still readable", () => {
    const source = Buffer.from("<p>Code: <b>KbZB13vY</b></p>", "utf8");
    expect(extractVerificationCode(decodeMessageText(source))).toBe("KbZB13vY");
  });
});
