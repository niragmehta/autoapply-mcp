import { describe, expect, it } from "vitest";
import {
  chooseVerificationLink,
  extractVerificationLinks,
  isWorkdayHost,
  isWorkdaySender,
} from "../src/submission/verificationLinks.js";

/** The activation link the synthetic Acme email below carries, decoded. */
const ACTIVATION =
  "https://acme.wd5.myworkdayjobs.com/en-US/External/activate/q1w2e3r4t5y6?redirect=%2Fen-US%2FExternal&lang=en-US";

/**
 * Shaped like a Workday verification email after Gmail forwards it: a
 * multipart/alternative body, both parts quoted-printable, with soft line
 * breaks falling inside the link, `=3D` for every `=`, `&amp;` in the href,
 * and the usual footer, logo and unsubscribe links.
 */
const ACME_EMAIL = [
  "Delivered-To: forwarded-codes@example.com",
  "From: Acme Careers <acme@otp.workday.com>",
  "To: casey.moore@example.com",
  "Subject: Verify your candidate account",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="----=_Part_101_2024.1700000000000"',
  "",
  "------=_Part_101_2024.1700000000000",
  "Content-Type: text/plain; charset=UTF-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  "Hi Casey,",
  "",
  "Please verify your account by opening this link within 24 hours:",
  "https://acme.wd5.myworkdayjobs.com/en-US/External/activate/q1w2e3r4t5y6?redirec=",
  "t=3D%2Fen-US%2FExternal&lang=3Den-US",
  "",
  "------=_Part_101_2024.1700000000000",
  "Content-Type: text/html; charset=UTF-8",
  "Content-Transfer-Encoding: quoted-printable",
  "",
  '<html><body><p>Hi Casey,</p><p>Please verify your account.</p><a href=3D"https://acme.wd5.m=',
  'yworkdayjobs.com/en-US/External/activate/q1w2e3r4t5y6?redirect=3D%2Fen-US%2FExternal&amp;lang=3Den-=',
  'US">Verify Account</a>',
  '<a href=3D"https://www.workday.com/en-us/privacy.html">Privacy</a>',
  '<img src=3D"https://www.myworkday.com/wday/asset/logo.png" alt=3D"Acme">',
  '<a href=3D"https://acme.wd5.myworkdayjobs.com/en-US/External/unsubscribe?token=3Dzz9">Unsubscribe</a>',
  "</body></html>",
  "------=_Part_101_2024.1700000000000--",
  "",
].join("\r\n");

function base64Email(html: string): string {
  return [
    "From: acme@otp.workday.com",
    "Subject: Verify your account",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
    "",
  ].join("\r\n");
}

describe("reading the verification link out of an email", () => {
  it("rejoins soft line breaks and decodes =3D and &amp; in a quoted-printable email", () => {
    expect(extractVerificationLinks(ACME_EMAIL, "acme")).toEqual([ACTIVATION]);
  });

  it("reads a body that arrived base64-encoded", () => {
    const html = '<p>Verify your account</p><a href="https://acme.wd5.myworkdayjobs.com/External/activate/b64tok">Verify</a>';
    expect(extractVerificationLinks(base64Email(html))).toEqual([
      "https://acme.wd5.myworkdayjobs.com/External/activate/b64tok",
    ]);
  });

  it("leaves a part that was never quoted-printable alone, so =AB in a token survives", () => {
    // Decoding the whole message as quoted-printable - as the code reader does -
    // would turn "=AB" into a single byte and corrupt the token.
    const raw = [
      "From: acme@otp.workday.com",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=US-ASCII",
      "Content-Transfer-Encoding: 7bit",
      "",
      "Verify your account: https://acme.wd5.myworkdayjobs.com/External/activate?token=AB12CD34EF",
    ].join("\r\n");
    expect(extractVerificationLinks(raw)).toEqual(["https://acme.wd5.myworkdayjobs.com/External/activate?token=AB12CD34EF"]);
  });

  it("decodes a bare quoted-printable body handed over without its headers", () => {
    const body = '<a href=3D"https://acme.wd5.myworkdayjobs.com/External/acti=\r\nvate/k9j8h7?x=3D1&amp;y=3D2">Verify</a>';
    expect(extractVerificationLinks(body)).toEqual(["https://acme.wd5.myworkdayjobs.com/External/activate/k9j8h7?x=1&y=2"]);
  });

  it("trims the punctuation a sentence leaves on a plain-text link", () => {
    const body = "Open https://acme.wd5.myworkdayjobs.com/External/activate/k9j8h7. It expires in a day.";
    expect(extractVerificationLinks(body)).toEqual(["https://acme.wd5.myworkdayjobs.com/External/activate/k9j8h7"]);
  });

  it("drops the truncated copy a mailer leaves when it wraps a long plain-text link", () => {
    const body = [
      '<a href="https://acme.wd5.myworkdayjobs.com/External/activate/k9j8h7g6f5">Verify</a>',
      "https://acme.wd5.myworkdayjobs.com/External/activate/k9j8h7",
      "g6f5",
    ].join("\n");
    expect(extractVerificationLinks(body)).toEqual(["https://acme.wd5.myworkdayjobs.com/External/activate/k9j8h7g6f5"]);
  });
});

describe("which hosts a verification link may point at", () => {
  it.each([
    "https://acme.wd5.myworkdayjobs.com/External/activate/t1",
    "https://wd5.myworkdaysite.com/recruiting/acme/External/activate/t1",
    "https://www.myworkday.com/acme/verify?token=t1",
    "https://otp.workday.com/verify/t1",
  ])("follows %s", (link) => {
    expect(extractVerificationLinks(`<a href="${link}">Verify your account</a>`)).toEqual([link]);
  });

  it.each([
    "https://acme.wd5.myworkdayjobs.com.evil.example/activate/t1",
    "https://evilworkday.com/verify/t1",
    "https://myworkday.com.evil.example/verify/t1",
    "https://myworkdayjobs.com@evil.example/verify/t1",
    "http://acme.wd5.myworkdayjobs.com/activate/t1",
    "https://acme.wd5.myworkdayjobs.com:8443/activate/t1",
    "https://us.greenhouse-mail.io/ss/c/verify/t1",
  ])("refuses %s", (link) => {
    expect(extractVerificationLinks(`<a href="${link}">Verify your account</a>`)).toEqual([]);
  });

  it("matches hosts on a dot boundary only", () => {
    expect(isWorkdayHost("acme.wd5.myworkdayjobs.com")).toBe(true);
    expect(isWorkdayHost("workday.com")).toBe(true);
    expect(isWorkdayHost("evilworkday.com")).toBe(false);
    expect(isWorkdayHost("myworkdayjobs.com.evil.example")).toBe(false);
  });

  it("recognises Workday's senders and nobody else", () => {
    expect(isWorkdaySender("acme@otp.workday.com")).toBe(true);
    expect(isWorkdaySender("noreply@myworkday.com")).toBe(true);
    expect(isWorkdaySender("acme@otp.workday.com.evil.example")).toBe(false);
    expect(isWorkdaySender("no-reply@us.greenhouse-mail.io")).toBe(false);
    expect(isWorkdaySender("workday.com")).toBe(false);
  });
});

describe("ranking the links in a verification email", () => {
  it("puts an activation-shaped link ahead of the email's other links", () => {
    const body = [
      '<a href="https://acme.wd5.myworkdayjobs.com/External/userHome">Candidate home</a>',
      '<a href="https://wd5.myworkdaysite.com/en-US/verify?token=v1">Verify</a>',
    ].join("");
    expect(extractVerificationLinks(body, "acme")).toEqual([
      "https://wd5.myworkdaysite.com/en-US/verify?token=v1",
      "https://acme.wd5.myworkdayjobs.com/External/userHome",
    ]);
  });

  it("prefers the link that names the tenant being applied to", () => {
    const body = [
      '<a href="https://wd5.myworkdaysite.com/en-US/verify?token=g1">Verify</a>',
      '<a href="https://wd5.myworkdaysite.com/en-US/recruiting/acme/External/verify?token=a1">Verify</a>',
    ].join("");
    expect(extractVerificationLinks(body, "Acme")[0]).toBe(
      "https://wd5.myworkdaysite.com/en-US/recruiting/acme/External/verify?token=a1",
    );
    expect(extractVerificationLinks(body)[0]).toBe("https://wd5.myworkdaysite.com/en-US/verify?token=g1");
  });

  it("drops a link that names another tenant", () => {
    // Two runs can wait on one mailbox at once; following the other run's link
    // verifies an account this run cannot use.
    const body = [
      '<a href="https://globex.wd1.myworkdayjobs.com/External/activate/x3">Verify</a>',
      '<a href="https://wd5.myworkdaysite.com/recruiting/globex/External/activate/x4">Verify</a>',
    ].join("");
    expect(extractVerificationLinks(body, "acme")).toEqual([]);
    expect(extractVerificationLinks(body)).toHaveLength(2);
  });

  it("drops footer, help, unsubscribe and image links but keeps a job slug that merely contains such a word", () => {
    const body = [
      '<a href="https://www.myworkday.com/help">Help</a>',
      '<a href="https://www.workday.com/en-us/legal/privacy-policy.html">Privacy policy</a>',
      '<a href="https://acme.wd5.myworkdayjobs.com/External/support">Support</a>',
      '<a href="https://acme.wd5.myworkdayjobs.com/External/email/unsubscribe?token=u1">Unsubscribe</a>',
      '<img src="https://www.myworkday.com/static/img/banner.png">',
      '<a href="https://acme.wd5.myworkdayjobs.com/External/job/Remote/Privacy-Engineer_R123/activate?token=p1">Verify</a>',
    ].join("\n");
    expect(extractVerificationLinks(body, "acme")).toEqual([
      "https://acme.wd5.myworkdayjobs.com/External/job/Remote/Privacy-Engineer_R123/activate?token=p1",
    ]);
  });
});

describe("choosing which Workday email to follow", () => {
  const since = new Date("2026-10-01T12:00:00Z");
  const at = (offsetSeconds: number) => new Date(since.getTime() + offsetSeconds * 1000);
  const email = (link: string, words = "Please verify your account.") => `<p>${words}</p><a href="${link}">Open</a>`;
  const ACME = "https://acme.wd5.myworkdayjobs.com/External/activate/acme-1";

  it("ignores an email sent well before this run asked for one", () => {
    const stale = [{ receivedAt: at(-180), sender: "acme@otp.workday.com", body: email(ACME) }];
    expect(chooseVerificationLink(stale, { since, tenant: "acme" })).toBeNull();
  });

  it("allows a couple of minutes of clock skew before the request", () => {
    const skewed = [{ receivedAt: at(-90), sender: "acme@otp.workday.com", body: email(ACME) }];
    expect(chooseVerificationLink(skewed, { since, tenant: "acme" })).toBe(ACME);
  });

  it("only believes Workday's own senders", () => {
    const forged = [
      { receivedAt: at(10), sender: "alerts@us.greenhouse-mail.io", body: email(ACME) },
      { receivedAt: at(20), sender: "acme@otp.workday.com.evil.example", body: email(ACME) },
      { receivedAt: at(30), body: email(ACME) },
    ];
    expect(chooseVerificationLink(forged, { since })).toBeNull();
    const real = [...forged, { receivedAt: at(5), sender: "noreply@myworkday.com", body: email(ACME) }];
    expect(chooseVerificationLink(real, { since })).toBe(ACME);
  });

  it("takes the newest qualifying email", () => {
    const later = "https://acme.wd5.myworkdayjobs.com/External/activate/acme-2";
    const messages = [
      { receivedAt: at(30), sender: "acme@otp.workday.com", body: email(ACME) },
      { receivedAt: at(90), sender: "acme@otp.workday.com", body: email(later) },
    ];
    expect(chooseVerificationLink(messages, { since, tenant: "acme" })).toBe(later);
  });

  it("prefers this tenant's email over a newer one sent for another tenant", () => {
    const ours = "https://wd5.myworkdaysite.com/en-US/verify?token=ours";
    const theirs = "https://wd5.myworkdaysite.com/en-US/verify?token=theirs";
    const messages = [
      { receivedAt: at(30), sender: "acme@otp.workday.com", body: email(ours) },
      { receivedAt: at(60), sender: "globex@otp.workday.com", body: email(theirs) },
    ];
    expect(chooseVerificationLink(messages, { since, tenant: "acme" })).toBe(ours);
    expect(chooseVerificationLink(messages, { since })).toBe(theirs);
  });

  it("does not follow an email that is not about verification", () => {
    const thanks = [
      {
        receivedAt: at(30),
        sender: "acme@otp.workday.com",
        body: email("https://acme.wd5.myworkdayjobs.com/External/userHome", "Thank you for applying to Acme."),
      },
    ];
    expect(chooseVerificationLink(thanks, { since, tenant: "acme" })).toBeNull();
  });

  it("follows an activation-shaped link even when the wording is unfamiliar", () => {
    const terse = [{ receivedAt: at(30), sender: "acme@otp.workday.com", body: email(ACME, "Welcome to Acme careers.") }];
    expect(chooseVerificationLink(terse, { since, tenant: "acme" })).toBe(ACME);
  });

  it("reads a full raw message straight from the mailbox", () => {
    const raw = [{ receivedAt: at(15), sender: "acme@otp.workday.com", body: ACME_EMAIL }];
    expect(chooseVerificationLink(raw, { since, tenant: "acme" })).toBe(ACTIVATION);
  });
});
