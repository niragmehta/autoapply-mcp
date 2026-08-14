import { describe, expect, it } from "vitest";
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
  mailbox: "INBOX",
};

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
    expect(resolved).toMatchObject({ host: "imap.gmail.com", port: 993, mailbox: "INBOX" });
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
