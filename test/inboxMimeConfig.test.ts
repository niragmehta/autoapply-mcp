import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { inboxEnvironment, readReplyInboxConfig } from "../src/inbox/config.js";
import { decodeEncodedWords, extractMessageText, makeSnippet, stripQuotedReply } from "../src/inbox/mime.js";
import { scratchDir } from "./afterApplyFixtures.js";

const scratch = scratchDir("inbox-config");
afterAll(() => scratch.cleanup());

describe("reading message text", () => {
  it("undoes quoted-printable soft breaks and escaped UTF-8 bytes", () => {
    const source = [
      "Subject: x",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "We will not be moving for=",
      "ward. Caf=C3=A9 =E2=80=94 thanks.",
    ].join("\r\n");
    expect(extractMessageText(Buffer.from(source))).toBe("We will not be moving forward. Café — thanks.");
  });

  it("prefers the plain alternative over HTML", () => {
    const source = [
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plain version",
      "--alt",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>HTML version</p>",
      "--alt--",
    ].join("\r\n");
    expect(extractMessageText(Buffer.from(source)).trim()).toBe("Plain version");
  });

  it("reduces base64 HTML in a legacy charset to text and skips attachments", () => {
    const html = Buffer.from("<html><body><p>Merci, Am\u00e9lie</p><style>p{}</style></body></html>", "latin1").toString("base64");
    const attachment = Buffer.from("not text").toString("base64");
    const source = [
      'Content-Type: multipart/mixed; boundary="mix"',
      "",
      "--mix",
      "Content-Type: text/html; charset=iso-8859-1",
      "Content-Transfer-Encoding: base64",
      "",
      html,
      "--mix",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="offer.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      attachment,
      "--mix--",
    ].join("\r\n");
    const text = extractMessageText(Buffer.from(source, "latin1"));
    expect(text).toContain("Merci, Am\u00e9lie");
    expect(text).not.toContain("not text");
  });

  it("reads a forwarded message attached whole, with its sender and subject", () => {
    const source = [
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      "Content-Type: text/plain",
      "",
      "See below.",
      "--outer",
      "Content-Type: message/rfc822",
      "",
      "From: Acme Recruiting <talent@acme.com>",
      "Subject: =?utf-8?B?VXBkYXRlIGZyb20gQWNtZQ==?=",
      "Content-Type: text/plain",
      "",
      "We are not able to move forward.",
      "--outer--",
    ].join("\r\n");
    const text = extractMessageText(Buffer.from(source));
    expect(text).toContain("From: Acme Recruiting <talent@acme.com>");
    expect(text).toContain("Subject: Update from Acme");
    expect(text).toContain("We are not able to move forward.");
  });

  it("survives a source cut short before its closing boundary", () => {
    const source = ['Content-Type: multipart/alternative; boundary="b"', "", "--b", "Content-Type: text/plain", "", "Thanks for applying"].join("\r\n");
    expect(extractMessageText(Buffer.from(source)).trim()).toBe("Thanks for applying");
  });

  it("decodes encoded words", () => {
    expect(decodeEncodedWords("=?iso-8859-1?Q?Caf=E9_update?=")).toBe("Café update");
  });

  it("drops quoted history but keeps a forwarded reply", () => {
    const text = [
      "Thanks, see the forwarded note.",
      "---------- Forwarded message ---------",
      "From: Acme <talent@acme.com>",
      "We will not be moving forward.",
      "> an older quoted line",
      "On Mon, Sep 1, 2026 at 9:00 AM Alex Candidate <alex@example.com> wrote:",
      "my own earlier message",
    ].join("\n");
    const stripped = stripQuotedReply(text);
    expect(stripped).toContain("We will not be moving forward.");
    expect(stripped).not.toContain("an older quoted line");
    expect(stripped).not.toContain("my own earlier message");
  });

  it("keeps a short, link-free snippet", () => {
    const snippet = makeSnippet(`Hello   Alex,\n\nSee https://acme.example/x?token=secret ${"word ".repeat(200)}`);
    expect(snippet.startsWith("Hello Alex, See [link] word")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(503);
    expect(snippet.endsWith("...")).toBe(true);
  });
});

describe("mailbox configuration", () => {
  it("reuses the verification mailbox by default", () => {
    const config = readReplyInboxConfig({
      AUTOAPPLY_OTP_IMAP_USER: "codes@example.com",
      AUTOAPPLY_OTP_IMAP_PASSWORD: "app-password",
      AUTOAPPLY_OTP_FROM: "greenhouse",
    });
    expect(config).toMatchObject({
      host: "imap.gmail.com",
      port: 993,
      user: "codes@example.com",
      mailboxes: ["INBOX", "[Gmail]/All Mail", "[Gmail]/Trash"],
      credentialSource: "AUTOAPPLY_OTP_IMAP",
    });
    expect(config).not.toHaveProperty("from");
  });

  it("takes a separate mailbox's credentials as a pair, and overrides individually", () => {
    const config = readReplyInboxConfig({
      AUTOAPPLY_OTP_IMAP_USER: "codes@example.com",
      AUTOAPPLY_OTP_IMAP_PASSWORD: "otp-password",
      AUTOAPPLY_INBOX_IMAP_USER: "replies@example.com",
      AUTOAPPLY_INBOX_IMAP_PASSWORD: "reply-password",
      AUTOAPPLY_INBOX_IMAP_HOST: "imap.example.com",
      AUTOAPPLY_INBOX_IMAP_PORT: "1993",
      AUTOAPPLY_INBOX_IMAP_MAILBOX: "Jobs, INBOX",
    });
    expect(config).toMatchObject({
      host: "imap.example.com",
      port: 1993,
      user: "replies@example.com",
      password: "reply-password",
      mailboxes: ["Jobs", "INBOX"],
      credentialSource: "AUTOAPPLY_INBOX_IMAP",
    });
  });

  it("never mixes a separate user with the verification password", () => {
    expect(
      readReplyInboxConfig({
        AUTOAPPLY_OTP_IMAP_USER: "codes@example.com",
        AUTOAPPLY_OTP_IMAP_PASSWORD: "otp-password",
        AUTOAPPLY_INBOX_IMAP_USER: "replies@example.com",
      }),
    ).toBeNull();
    expect(readReplyInboxConfig({})).toBeNull();
  });

  it("reads the workspace secrets file underneath the environment without changing it", () => {
    const path = join(scratch.path, ".env");
    writeFileSync(path, "AUTOAPPLY_INBOX_IMAP_USER=file-user@example.com\nAUTOAPPLY_INBOX_IMAP_PASSWORD=file-password\nAUTOAPPLY_INBOX_IMAP_HOST=file.example.com\n");
    const env = { AUTOAPPLY_INBOX_IMAP_HOST: "env.example.com" };
    const merged = inboxEnvironment(path, env);
    expect(merged).toMatchObject({
      AUTOAPPLY_INBOX_IMAP_USER: "file-user@example.com",
      AUTOAPPLY_INBOX_IMAP_HOST: "env.example.com",
    });
    expect(env).toEqual({ AUTOAPPLY_INBOX_IMAP_HOST: "env.example.com" });
    expect(inboxEnvironment(join(scratch.path, "missing.env"), env)).toBe(env);
  });
});
