import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { databaseNeedles, detokenizePath, HOME_TOKEN, rewriteTextValue, tokenizePath } from "../src/home/pathTokens.js";

/** Paths under AUTOAPPLY_HOME travel in a bundle as a placeholder, so a workspace can move between machines and platforms. */

const WINDOWS_HOME = "C:\\Users\\Alex\\.autoapply";

describe("tokenizing a path under the home folder", () => {
  it("replaces the home folder with the placeholder, in either slash style", () => {
    expect(tokenizePath("C:\\Users\\Alex\\.autoapply\\documents\\app_1\\resume.pdf", WINDOWS_HOME)).toBe(`${HOME_TOKEN}/documents/app_1/resume.pdf`);
    expect(tokenizePath("C:/Users/Alex/.autoapply/resumes/alex.pdf", WINDOWS_HOME)).toBe(`${HOME_TOKEN}/resumes/alex.pdf`);
    expect(tokenizePath("c:\\users\\alex\\.autoapply\\resume.json", WINDOWS_HOME)).toBe(`${HOME_TOKEN}/resume.json`);
    expect(tokenizePath("/home/alex/.autoapply/data/autoapply.sqlite", "/home/alex/.autoapply")).toBe(`${HOME_TOKEN}/data/autoapply.sqlite`);
    expect(tokenizePath(WINDOWS_HOME, WINDOWS_HOME)).toBe(HOME_TOKEN);
  });

  it("leaves paths elsewhere alone, including a sibling folder with the same prefix", () => {
    expect(tokenizePath("C:\\Users\\Alex\\.autoapply-old\\profile.json", WINDOWS_HOME)).toBeNull();
    expect(tokenizePath("D:\\resumes\\alex.pdf", WINDOWS_HOME)).toBeNull();
    expect(tokenizePath("/Home/alex/.autoapply/x", "/home/alex/.autoapply")).toBeNull();
    expect(tokenizePath("Senior Security Engineer", WINDOWS_HOME)).toBeNull();
  });
});

describe("restoring a placeholder path at the new home", () => {
  it("joins the rest of the path onto the new home with this platform's separator", () => {
    const home = join("srv", "alex", ".autoapply");
    expect(detokenizePath(`${HOME_TOKEN}/documents/app_1/resume.pdf`, home)).toBe(join(home, "documents", "app_1", "resume.pdf"));
    expect(detokenizePath(HOME_TOKEN, home)).toBe(home);
    expect(detokenizePath(`${HOME_TOKEN}x/escape`, home)).toBeNull();
    expect(detokenizePath("plain text", home)).toBeNull();
  });
});

describe("rewriting stored text", () => {
  const tokenize = (value: string) => tokenizePath(value, WINDOWS_HOME);

  it("rewrites a whole-value path and the path strings inside a JSON document", () => {
    expect(rewriteTextValue("C:\\Users\\Alex\\.autoapply\\artifacts\\shot.png", tokenize)).toBe(`${HOME_TOKEN}/artifacts/shot.png`);
    const payload = JSON.stringify({ path: "C:\\Users\\Alex\\.autoapply\\documents\\r.pdf", pages: 1, nested: ["C:/Users/Alex/.autoapply/x.pdf"] });
    expect(JSON.parse(rewriteTextValue(payload, tokenize))).toEqual({ path: `${HOME_TOKEN}/documents/r.pdf`, pages: 1, nested: [`${HOME_TOKEN}/x.pdf`] });
  });

  it("leaves free text that only mentions a path, and text with nothing to rewrite, exactly as it was", () => {
    const note = "[2026-10-01] saved to C:\\Users\\Alex\\.autoapply\\artifacts\\shot.png";
    expect(rewriteTextValue(note, tokenize)).toBe(note);
    const compact = '{"a":1,  "b":"unchanged"}';
    expect(rewriteTextValue(compact, tokenize)).toBe(compact);
    expect(rewriteTextValue("{not json", tokenize)).toBe("{not json");
  });

  it("searches stored text for every way the home folder can be written", () => {
    expect(databaseNeedles(WINDOWS_HOME)).toEqual(expect.arrayContaining(["\\Users\\Alex\\.autoapply", "/Users/Alex/.autoapply", "\\\\Users\\\\Alex\\\\.autoapply"]));
    expect(databaseNeedles("/home/alex/.autoapply")).toContain("/home/alex/.autoapply");
  });
});
