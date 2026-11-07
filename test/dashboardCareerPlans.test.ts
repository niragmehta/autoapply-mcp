import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAREER_PROFILE } from "./dashboardCareerFixture.js";
import { bearer, http, jsonBody, startFixture, type Fixture } from "./dashboardFixture.js";

/**
 * Interviews, prep and debriefs, and offers with their comparison,
 * negotiation plan and contract checklist, written from the dashboard. Every
 * write goes through a src/career service; nothing is ever sent.
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
  fixture = await startFixture("dashboard-career-plans", {
    profile: CAREER_PROFILE,
    campaign: { compensation: { currency: "USD", floors: { US: 200000 }, fx: { USD: 1, CAD: 0.73 } } },
  });
  port = fixture.port;
});

afterAll(async () => {
  await fixture.close();
});

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

describe("writes need a session and the same origin", () => {
  const writes: Array<[string, string, unknown]> = [
    ["POST", "/api/interviews", { applicationId: "app_sent", stage: "technical" }],
    ["PATCH", "/api/interviews/int_any", { status: "cancelled" }],
    ["POST", "/api/interview-sessions", { applicationId: "app_sent", kind: "debrief", content: "Went well." }],
    ["POST", "/api/offers", { applicationId: "app_sent", currency: "USD", base: 250000 }],
    ["PATCH", "/api/offers/offer_any", { base: 260000 }],
    ["POST", "/api/offers/offer_any/checklist", { clauseId: "equity", checked: true }],
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

describe("interviews", () => {
  let interviewId = "";

  it("schedules an interview from an application, recording the outcome once", async () => {
    const scheduled = await send("POST", "/api/interviews", {
      applicationId: "app_sent",
      stage: "technical",
      scheduledAt: inDays(2),
      durationMinutes: 60,
      format: "video",
      locationOrLink: "https://meet.example.com/abc",
      interviewers: [{ name: "Jordan Example", role: "Staff Engineer" }],
    });
    expect(scheduled.status).toBe(201);
    const body = scheduled.json<{ interview: { id: string; status: string }; outcomeRecorded: string | null; panel: Array<{ kind: string }> }>();
    expect(body).toMatchObject({ interview: { status: "scheduled" }, outcomeRecorded: "interview", panel: [{ kind: "peer" }] });
    interviewId = body.interview.id;
    expect((await get<{ interviews: Array<{ id: string }> }>("/api/interviews")).interviews.map((entry) => entry.id)).toContain(interviewId);
  });

  it("reschedules, edits and cancels through updateInterview", async () => {
    const moved = await send("PATCH", `/api/interviews/${interviewId}`, { scheduledAt: inDays(3), notes: "Bring the guardrail story." });
    expect(moved.json()).toMatchObject({ changed: expect.arrayContaining(["scheduledAt", "notes"]) });
    const cancelled = await send("PATCH", `/api/interviews/${interviewId}`, { status: "cancelled" });
    expect(cancelled.json()).toMatchObject({ interview: { status: "cancelled" }, changed: ["status"] });
    expect((await send("PATCH", `/api/interviews/${interviewId}`, { status: "scheduled" })).status).toBe(200);
  });

  it("validates interview input", async () => {
    expect((await send("POST", "/api/interviews", { applicationId: "app_sent", stage: "chat" })).status).toBe(400);
    expect((await send("POST", "/api/interviews", { applicationId: "app_sent", stage: "technical", scheduledAt: "next tuesday" })).status).toBe(400);
    expect((await send("POST", "/api/interviews", { applicationId: "app_missing", stage: "technical" })).status).toBe(404);
    expect((await send("PATCH", "/api/interviews/int_missing", { status: "done" })).status).toBe(404);
  });

  it("saves a debrief and lists it per interview and per application", async () => {
    const saved = await send("POST", "/api/interview-sessions", {
      applicationId: "app_sent",
      interviewId,
      kind: "debrief",
      content: "## Questions asked\n- Design a policy engine\n\n## How it went\nWell.",
    });
    expect(saved.status).toBe(201);
    expect(saved.json()).toMatchObject({ kind: "debrief", interviewId });
    const detail = await get<{ sessions: Array<{ kind: string; content: string }> }>(`/api/interviews/${interviewId}`);
    expect(detail.sessions).toEqual([expect.objectContaining({ kind: "debrief" })]);
    expect((await get<{ sessions: unknown[] }>("/api/interview-sessions?applicationId=app_sent")).sessions).toHaveLength(1);

    expect((await send("POST", "/api/interview-sessions", { applicationId: "app_sent", kind: "debrief", content: "" })).status).toBe(400);
    const mismatch = await send("POST", "/api/interview-sessions", { applicationId: "app_held", interviewId, kind: "plan", content: "x" });
    expect(errorOf(mismatch).code).toBe("interview_mismatch");
  });

  it("builds a prep sheet from interviewContext, for an interview or an application", async () => {
    const prep = await get<{
      job: { company: string };
      stageGuide: { label: string } | null;
      prepBlocks: Array<{ minutes: number | null }>;
      stories: { byRequirement: unknown[] };
      interview: { id: string } | null;
    }>(`/api/interviews/${interviewId}/prep?hours=4`);
    expect(prep.job.company).toBe("Acme");
    expect(prep.stageGuide?.label).toBe("Technical round");
    expect(prep.prepBlocks.every((block) => typeof block.minutes === "number")).toBe(true);
    expect(prep.interview?.id).toBe(interviewId);

    const forApplication = await get<{ stageGuide: { label: string } | null }>("/api/applications/app_sent/prep?stage=behavioral");
    expect(forApplication.stageGuide?.label).toBe("Behavioral round");
    expect((await http(port, `/api/interviews/${interviewId}/prep?hours=99`, { headers: bearer() })).status).toBe(400);
  });
});

describe("offers", () => {
  let offerId = "";

  it("records and edits an offer", async () => {
    const recorded = await send("POST", "/api/offers", { applicationId: "app_sent", currency: "USD", base: 250000, bonusTargetPct: 10, signOn: 20000, deadline: "2030-01-15" });
    expect(recorded.status).toBe(201);
    const body = recorded.json<{ offer: { id: string; company: string }; comp: { annualizedTotal: number }; outcomeRecorded: string | null }>();
    expect(body).toMatchObject({ offer: { company: "Acme" }, comp: { annualizedTotal: 280000 }, outcomeRecorded: "offer" });
    offerId = body.offer.id;

    const edited = await send("PATCH", `/api/offers/${offerId}`, { base: 260000, signOn: null, status: "negotiating" });
    expect(edited.json()).toMatchObject({ offer: { base: 260000, signOn: null, status: "negotiating" } });
    expect(await get(`/api/offers/${offerId}`)).toMatchObject({ offer: { id: offerId, base: 260000 }, comp: { signOn: 0 } });
    expect((await http(port, "/api/offers/offer_missing", { headers: bearer() })).status).toBe(404);
    expect((await send("PATCH", `/api/offers/${offerId}`, { base: -1 })).status).toBe(400);
    expect((await send("PATCH", "/api/offers/offer_missing", { base: 1 })).status).toBe(404);
    expect((await send("POST", "/api/offers", { currency: "USD", base: 1 })).status).toBe(400);
  });

  it("compares offers with what-if exchange rates and sign-on amortization", async () => {
    await send("POST", "/api/offers", { company: "Euro GmbH", currency: "EUR", base: 100000, signOn: 8000 });
    const plain = await get<{ offers: Array<{ company: string; inProfileCurrency: unknown }> }>("/api/offers/compare");
    expect(plain.offers.find((row) => row.company === "Euro GmbH")?.inProfileCurrency).toBeNull();

    const whatIf = await get<{ offers: Array<{ company: string; inProfileCurrency: { base: number } | null; comp: { signOnAmortizationYears: number } }>; fx: { overridden: string[] } }>(
      "/api/offers/compare?fx=EUR:1.1&years=2",
    );
    const euro = whatIf.offers.find((row) => row.company === "Euro GmbH");
    expect(euro?.inProfileCurrency?.base).toBe(110000);
    expect(euro?.comp.signOnAmortizationYears).toBe(2);
    expect(whatIf.fx.overridden).toEqual(["EUR"]);
    expect((await http(port, "/api/offers/compare?fx=EUR:zero", { headers: bearer() })).status).toBe(400);
    expect((await http(port, "/api/offers/compare?years=40", { headers: bearer() })).status).toBe(400);
  });

  it("plans the negotiation with the assumptions you set", async () => {
    const plan = await get<{ numbers: { anchor: number; walkAway: number | null }; expectedValue: { inputs: { pImprove: number } } }>(
      `/api/offers/${offerId}/negotiation?pImprove=0.5&captureRate=0.4`,
    );
    expect(plan.expectedValue.inputs.pImprove).toBe(0.5);
    expect(plan.numbers.anchor).toBeGreaterThan(0);
    expect((await http(port, `/api/offers/${offerId}/negotiation?pImprove=0.9&pWithdraw=0.2`, { headers: bearer() })).status).toBe(400);
    expect((await http(port, `/api/offers/${offerId}/negotiation?pImprove=2`, { headers: bearer() })).status).toBe(400);
  });

  it("keeps contract checklist ticks per offer", async () => {
    const ticked = await send("POST", `/api/offers/${offerId}/checklist`, { clauseId: "equity", checked: true });
    expect(ticked.json()).toMatchObject({ clauseId: "equity", checked: true, progress: { checked: 1 } });
    const checklist = await get<{ disclaimer: string; clauses: Array<{ id: string; checkedAt: string | null }>; progress: { checked: number } }>(
      `/api/offers/${offerId}/checklist`,
    );
    expect(checklist.disclaimer).toMatch(/not legal advice/i);
    expect(checklist.clauses.find((clause) => clause.id === "equity")?.checkedAt).not.toBeNull();
    expect((await send("POST", `/api/offers/${offerId}/checklist`, { clauseId: "made_up", checked: true })).status).toBe(400);
    expect((await send("POST", `/api/offers/${offerId}/checklist`, { clauseId: "equity" })).status).toBe(400);
  });
});
