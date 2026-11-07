import { homedir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAREER_PROFILE } from "./dashboardCareerFixture.js";
import { bearer, http, jsonBody, startFixture, type Fixture } from "./dashboardFixture.js";

/**
 * The career suite's write API: the story bank, contacts, outreach drafts and
 * company research. Every write goes through a src/career service, needs the
 * session and the same origin, and validates its input.
 */

let fixture: Fixture;
let port: number;

const get = async <T = Record<string, unknown>>(path: string) => {
  const response = await http(port, path, { headers: bearer() });
  expect(response.status, `${path}: ${response.text.slice(0, 300)}`).toBe(200);
  return response.json<T>();
};

const send = (method: string, path: string, body: unknown) => http(port, path, { method, ...jsonBody(port, body) });
const errorOf = (response: { json: <T>() => T }) => response.json<{ error: Record<string, unknown> }>().error;

beforeAll(async () => {
  fixture = await startFixture("dashboard-career", { profile: CAREER_PROFILE });
  port = fixture.port;
});

afterAll(async () => {
  await fixture.close();
});

const story = {
  title: "Containing a credential leak",
  situation: "A production credential leaked during a deploy.",
  task: "I owned the response as on-call lead.",
  action: "I rotated the credentials and led incident response across three teams.",
  result: "We cut time to remediate from 6 hours to 45 minutes.",
  reflection: "I would rehearse the runbook before we needed it.",
  skills: ["Python"],
  factIds: ["incident"],
  tags: ["failure", "leadership"],
};

describe("writes need a session and the same origin", () => {
  const writes: Array<[string, string, unknown]> = [
    ["POST", "/api/stories", story],
    ["PATCH", "/api/stories/story_any", story],
    ["DELETE", "/api/stories/story_any", {}],
    ["POST", "/api/contacts", { company: "Acme", name: "Riley Example", kind: "recruiter", source: "x" }],
    ["PATCH", "/api/contacts/contact_any", { role: "Recruiter" }],
    ["DELETE", "/api/contacts/contact_any", {}],
    ["POST", "/api/outreach", { applicationId: "app_sent", channel: "linkedin_connect", body: "Hello." }],
    ["PATCH", "/api/outreach/outreach_any", { body: "Hello again." }],
    ["DELETE", "/api/outreach/outreach_any", {}],
    ["POST", "/api/company-notes", { company: "Acme", kind: "redflag", content: "Slow replies." }],
    ["PATCH", "/api/company-notes/note_any", { content: "Slower replies." }],
    ["DELETE", "/api/company-notes/note_any", {}],
  ];

  it.each(writes)("%s %s", async (method, path, body) => {
    const anonymous = await http(port, path, {
      method,
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify(body),
    });
    expect(anonymous.status).toBe(401);
    const crossSite = await http(port, path, { method, ...jsonBody(port, body, { origin: "https://evil.example" }) });
    expect(crossSite.status).toBe(403);
  });
});

describe("story bank", () => {
  it("creates, finds, edits and deletes a story through saveStory and deleteStory", async () => {
    const created = await send("POST", "/api/stories", story);
    expect(created.status).toBe(201);
    const saved = created.json<{ story: { id: string; tags: string[] }; created: boolean; fieldWarnings: unknown[] }>();
    expect(saved.created).toBe(true);
    expect(saved.fieldWarnings).toEqual([]);
    const id = saved.story.id;

    expect((await get<{ stories: Array<{ id: string }> }>("/api/stories?q=credential")).stories.map((entry) => entry.id)).toEqual([id]);
    expect((await get<{ stories: unknown[] }>("/api/stories?q=kubernetes")).stories).toEqual([]);
    expect((await get<{ stories: unknown[] }>("/api/stories?tag=failure")).stories).toHaveLength(1);
    expect((await get<{ stories: unknown[] }>("/api/stories?competency=failure")).stories).toHaveLength(1);
    expect((await get<{ story: { title: string } }>(`/api/stories/${id}`)).story.title).toBe(story.title);

    const edited = await send("PATCH", `/api/stories/${id}`, { ...story, reflection: "", title: "Containing a leak, fast" });
    expect(edited.status).toBe(200);
    expect(edited.json()).toMatchObject({
      created: false,
      story: { id, title: "Containing a leak, fast" },
      fieldWarnings: [expect.objectContaining({ field: "reflection" })],
    });

    const deleted = await send("DELETE", `/api/stories/${id}`, {});
    expect(deleted.json()).toEqual({ deleted: id });
    expect((await http(port, `/api/stories/${id}`, { headers: bearer() })).status).toBe(404);
    expect((await send("DELETE", `/api/stories/${id}`, {})).status).toBe(404);
  });

  it("names the field an unverified figure is in, and validates the shape", async () => {
    const refused = await send("POST", "/api/stories", { ...story, result: "We cut remediation time by 90%." });
    expect(refused.status).toBe(422);
    expect(errorOf(refused)).toMatchObject({ code: "unverified_figures", byField: { result: ["90%"], action: [] } });

    const noAction = await send("POST", "/api/stories", { ...story, action: "" });
    expect(noAction.status).toBe(400);
    expect(errorOf(noAction).issues).toEqual([expect.objectContaining({ path: "action" })]);
    expect((await send("POST", "/api/stories", { ...story, factIds: ["made-up"] })).status).toBe(400);
    expect((await send("POST", "/api/stories", { ...story, extra: true })).status).toBe(400);
  });

  it("starts from the profile's facts and matches stories to a job's requirements", async () => {
    const scaffold = await get<{ themes: Array<{ facts: Array<{ id: string }> }>; uncitedFacts: string[] }>("/api/stories/scaffold");
    expect(scaffold.themes.flatMap((theme) => theme.facts.map((fact) => fact.id)).sort()).toEqual(["guardrails", "incident"]);

    await send("POST", "/api/stories", { ...story, title: "Guardrails for AI agents", factIds: ["guardrails"], action: "I built guardrails that enforce policy.", result: "12 product teams adopted them." });
    const match = await get<{ jobId: string; requirements: Array<{ requirement: string; stories: unknown[] }>; uncovered: string[]; topStories: unknown[] }>(
      "/api/jobs/job_acme/story-match",
    );
    expect(match.jobId).toBe("job_acme");
    expect(match.requirements.length).toBeGreaterThan(0);
    expect(Array.isArray(match.uncovered)).toBe(true);
    expect((await http(port, "/api/jobs/job_missing/story-match", { headers: bearer() })).status).toBe(404);
  });
});

describe("contacts", () => {
  it("saves, edits, filters and deletes a contact", async () => {
    const created = await send("POST", "/api/contacts", {
      company: "Acme",
      name: "Riley Example",
      role: "Recruiter",
      kind: "recruiter",
      email: "riley@example.com",
      source: "https://example.com/team",
    });
    expect(created.status).toBe(201);
    const contact = created.json<{ contact: { id: string } }>().contact;

    const edited = await send("PATCH", `/api/contacts/${contact.id}`, { role: "Senior Recruiter", email: "" });
    expect(edited.json()).toMatchObject({ contact: { role: "Senior Recruiter", email: "" }, changed: ["role", "email"] });
    expect((await get<{ contact: { name: string }; drafts: unknown[] }>(`/api/contacts/${contact.id}`))).toMatchObject({ contact: { name: "Riley Example" }, drafts: [] });
    expect((await get<{ contacts: unknown[] }>("/api/contacts?company=acme")).contacts).toHaveLength(1);
    expect((await get<{ contacts: unknown[] }>("/api/contacts?applicationId=app_sent")).contacts).toHaveLength(1);

    await send("POST", "/api/contacts", { company: "Acme", name: "Pat Example", kind: "peer", source: "x" });
    const clash = await send("PATCH", `/api/contacts/${contact.id}`, { name: "pat example" });
    expect(clash.status).toBe(409);
    expect(errorOf(clash).code).toBe("contact_exists");

    expect((await send("DELETE", `/api/contacts/${contact.id}`, {})).json()).toEqual({ deleted: contact.id, draftsKept: 0 });
    expect((await send("PATCH", `/api/contacts/${contact.id}`, { role: "x" })).status).toBe(404);
    expect((await http(port, `/api/contacts/${contact.id}`, { headers: bearer() })).status).toBe(404);
  });

  it("validates contact input", async () => {
    expect((await send("POST", "/api/contacts", { company: "Acme", name: "No Source", kind: "peer" })).status).toBe(400);
    expect((await send("POST", "/api/contacts", { company: "Acme", name: "Bad Mail", kind: "peer", email: "nope", source: "x" })).status).toBe(400);
    expect((await send("PATCH", "/api/contacts/contact_x", { kind: "boss" })).status).toBe(400);
  });
});

describe("outreach drafts", () => {
  it("builds a scaffold without exposing the home folder", async () => {
    const scaffold = await get<{ limits: { maxChars: number }; structure: string[]; attachments: Array<{ item: string; detail: string }> }>(
      "/api/outreach/scaffold?channel=email&applicationId=app_sent",
    );
    expect(scaffold.limits.maxChars).toBe(3000);
    expect(scaffold.structure.length).toBeGreaterThan(0);
    expect(JSON.stringify(scaffold.attachments)).not.toContain(homedir());
    expect((await http(port, "/api/outreach/scaffold?channel=fax", { headers: bearer() })).status).toBe(400);
  });

  it("saves, edits, copies out and records a draft; never sends", async () => {
    const created = await send("POST", "/api/outreach", {
      applicationId: "app_sent",
      channel: "email",
      subject: "Senior Security Engineer",
      body: "Hello, I applied for the Senior Security Engineer role.",
    });
    expect(created.status).toBe(201);
    const draft = created.json<{ draft: { id: string; status: string }; limits: unknown }>().draft;
    expect(draft.status).toBe("draft");

    const edited = await send("PATCH", `/api/outreach/${draft.id}`, { body: "Hello, my guardrails were adopted by 12 product teams." });
    expect(edited.json()).toMatchObject({ changed: ["body"], draft: { id: draft.id } });
    expect((await get<{ draft: { body: string } }>(`/api/outreach/${draft.id}`)).draft.body).toContain("12 product teams");
    expect((await http(port, "/api/outreach/outreach_missing", { headers: bearer() })).status).toBe(404);

    expect((await send("POST", `/api/outreach/${draft.id}/mark`, { status: "sent_by_user" })).status).toBe(200);
    const locked = await send("PATCH", `/api/outreach/${draft.id}`, { body: "Changed after sending." });
    expect(locked.status).toBe(409);
    expect(errorOf(locked).code).toBe("outreach_not_editable");
    expect(errorOf(await send("DELETE", `/api/outreach/${draft.id}`, {})).code).toBe("outreach_sent");

    const spare = (await send("POST", "/api/outreach", { applicationId: "app_sent", channel: "linkedin_connect", body: "Hi, I applied." })).json<{ draft: { id: string } }>().draft;
    expect((await send("DELETE", `/api/outreach/${spare.id}`, {})).json()).toEqual({ deleted: spare.id });
  });

  it("explains limit and figure refusals with their numbers", async () => {
    const long = await send("POST", "/api/outreach", { applicationId: "app_sent", channel: "linkedin_connect", body: "x".repeat(301) });
    expect(long.status).toBe(400);
    expect(errorOf(long)).toMatchObject({ code: "too_long", characters: 301, maxChars: 300 });
    const figures = await send("POST", "/api/outreach", { applicationId: "app_sent", channel: "linkedin_connect", body: "I led 99 teams." });
    expect(figures.status).toBe(422);
    expect(errorOf(figures)).toMatchObject({ code: "unverified_figures", offending: ["99"] });
    expect((await send("POST", "/api/outreach", { applicationId: "app_sent", channel: "email", body: "" })).status).toBe(400);
  });
});

describe("company research notes", () => {
  it("saves, edits and deletes a note under the source rules", async () => {
    const created = await send("POST", "/api/company-notes", { company: "Acme", kind: "research", content: "Ships an agent platform.", sources: ["https://example.com/acme"] });
    expect(created.status).toBe(201);
    const note = created.json<{ note: { id: string } }>().note;

    const edited = await send("PATCH", `/api/company-notes/${note.id}`, { content: "Ships an agent platform to banks." });
    expect(edited.json()).toMatchObject({ changed: ["content"], note: { content: "Ships an agent platform to banks." } });
    expect((await get<{ notes: unknown[] }>("/api/company-notes?company=acme")).notes).toHaveLength(1);

    const unsourced = await send("PATCH", `/api/company-notes/${note.id}`, { sources: [] });
    expect(unsourced.status).toBe(400);
    expect(errorOf(unsourced).code).toBe("sources_required");

    expect((await send("DELETE", `/api/company-notes/${note.id}`, {})).json()).toEqual({ deleted: note.id });
    expect((await send("DELETE", `/api/company-notes/${note.id}`, {})).status).toBe(404);
  });

  it("validates note input", async () => {
    expect((await send("POST", "/api/company-notes", { company: "Acme", kind: "gossip", content: "x" })).status).toBe(400);
    expect((await send("POST", "/api/company-notes", { company: "Acme", kind: "research", content: "Unsourced." })).status).toBe(400);
  });
});
