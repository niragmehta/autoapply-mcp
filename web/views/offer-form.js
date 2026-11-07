import { api } from "../api.js";
import { FormError, SelectField, TextArea, TextField, useDraft, useSubmit, useUnsavedGuard } from "../components/form.js";
import { Button } from "../components/ui.js";
import { label } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useResource } from "../lib/hooks.js";
import { toast, useMeta } from "../lib/store.js";

/** Recording an offer (from an application, or for a company) and editing its terms. */

const AMOUNTS = ["base", "bonusTargetAmount", "bonusTargetPct", "equityValueAnnual", "signOn", "relocation"];
const TEXTS = ["title", "level", "equityDetails", "benefitsNotes", "location", "remotePolicy"];
const DATES = ["startDate", "deadline"];

function initialDraft(offer, applicationId, currency) {
  const value = (key) => (offer?.[key] === null || offer?.[key] === undefined ? "" : String(offer[key]));
  return {
    applicationId: applicationId ?? "",
    company: "",
    currency: offer?.currency ?? currency,
    status: offer?.status ?? "received",
    ...Object.fromEntries([...AMOUNTS, ...TEXTS, ...DATES].map((key) => [key, value(key)])),
  };
}

/** A number field's text as a number; "" is "not given". */
function amount(text) {
  if (String(text).trim() === "") return null;
  const parsed = Number(String(text).replace(/[,\s]/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function recordBody(draft) {
  const body = { currency: draft.currency.trim().toUpperCase(), status: draft.status };
  if (draft.applicationId) body.applicationId = draft.applicationId;
  else if (draft.company.trim()) body.company = draft.company.trim();
  for (const key of AMOUNTS) {
    const parsed = amount(draft[key]);
    if (parsed !== null) body[key] = parsed;
  }
  for (const key of [...TEXTS, ...DATES]) if (draft[key].trim()) body[key] = draft[key].trim();
  return body;
}

/** An edit sends every field; a cleared amount or date becomes null, which clears it. */
function updateBody(draft) {
  const body = { currency: draft.currency.trim().toUpperCase(), status: draft.status };
  for (const key of AMOUNTS) body[key] = amount(draft[key]);
  for (const key of TEXTS) body[key] = draft[key].trim();
  for (const key of DATES) body[key] = draft[key].trim() || null;
  if (body.base === null) delete body.base;
  return body;
}

/** Amounts that are not numbers are caught here: sent as JSON they would quietly become "cleared". */
function amountErrors(draft) {
  return Object.fromEntries(AMOUNTS.filter((key) => Number.isNaN(amount(draft[key]))).map((key) => [key, "Enter a number, such as 185000."]));
}

export function OfferForm({ offer, applicationId, onSaved, onCancel, onDirty }) {
  const meta = useMeta().data;
  const statuses = meta?.career?.offerStatuses ?? ["received", "negotiating", "accepted", "declined", "expired"];
  const applications = useResource(() => (offer ? Promise.resolve(null) : api.get("/api/applications", { pageSize: 200 })), [offer?.id]);
  const { draft, set, dirty } = useDraft(initialDraft(offer, applicationId, meta?.compensation?.profileCurrency ?? "USD"));
  const guard = useUnsavedGuard(dirty, onDirty);
  const { busy, error, errors: serverErrors, submit } = useSubmit();
  const [local, setLocal] = useState({});
  const errors = { ...serverErrors, ...local };
  const save = async (event) => {
    event.preventDefault();
    const invalid = amountErrors(draft);
    setLocal(invalid);
    if (Object.keys(invalid).length) return;
    const result = await submit(() => (offer ? api.patch(`/api/offers/${encodeURIComponent(offer.id)}`, updateBody(draft)) : api.post("/api/offers", recordBody(draft))));
    if (!result) return;
    guard.release();
    toast(offer ? (result.changed?.length ? "Offer saved." : "Nothing changed.") : result.outcomeRecorded ? 'Offer recorded. "Offer" noted on the application.' : "Offer recorded.");
    for (const warning of result.warnings ?? []) toast(warning, { tone: "bad" });
    onSaved(result.offer);
  };
  const money = (key, text, hint) => html`<${TextField} id=${`offer-${key}`} label=${text} inputmode="decimal" value=${draft[key]} onInput=${set(key)} hint=${hint} error=${errors[key]} />`;
  return html`<form class="stack" onSubmit=${save} noValidate>
    <${FormError} error=${error} />
    <div class="form-grid">
      ${offer
        ? null
        : html`<${SelectField}
              id="offer-application"
              label="Application"
              wide
              value=${draft.applicationId}
              onChange=${set("applicationId")}
              any="None: an offer from elsewhere"
              options=${(applications.data?.rows ?? []).map((row) => ({ value: row.id, label: `${row.company}: ${row.title}` }))}
              hint="From an application, the company and title come from its posting and the offer is noted on it."
            />
            ${draft.applicationId ? null : html`<${TextField} id="offer-company" label="Company" required value=${draft.company} onInput=${set("company")} maxlength="200" error=${errors.company} />`}`}
      <${TextField} id="offer-title" label="Title" value=${draft.title} onInput=${set("title")} maxlength="200" />
      <${TextField} id="offer-level" label="Level" value=${draft.level} onInput=${set("level")} maxlength="100" placeholder="e.g. Senior, L5" />
      <${TextField} id="offer-currency" label="Currency" required value=${draft.currency} onInput=${set("currency")} maxlength="3" hint="Three letters, e.g. USD" error=${errors.currency} />
      ${money("base", "Base salary a year", "Required.")}
      ${money("bonusTargetPct", "Target bonus, % of base")}
      ${money("bonusTargetAmount", "Target bonus, amount", "Used instead of the percentage when both are given.")}
      ${money("equityValueAnnual", "Equity value a year", "Grant value divided by vesting years.")}
      ${money("signOn", "Sign-on bonus")}
      ${money("relocation", "Relocation")}
      <${TextField} id="offer-start" label="Start date" type="date" value=${draft.startDate.slice(0, 10)} onInput=${set("startDate")} error=${errors.startDate} />
      <${TextField} id="offer-deadline" label="Decide by" type="date" value=${draft.deadline.slice(0, 10)} onInput=${set("deadline")} error=${errors.deadline} />
      <${SelectField} id="offer-status" label="Status" value=${draft.status} onChange=${set("status")} options=${statuses.map((status) => ({ value: status, label: label(status) }))} />
      <${TextField} id="offer-location" label="Location" value=${draft.location} onInput=${set("location")} maxlength="200" />
      <${TextField} id="offer-remote" label="Remote policy" value=${draft.remotePolicy} onInput=${set("remotePolicy")} maxlength="200" placeholder="e.g. hybrid, 2 days" />
      <${TextArea} id="offer-equity" label="Equity details" rows=${2} value=${draft.equityDetails} onInput=${set("equityDetails")} maxlength="2000" hint="Grant type, units, vesting, cliff, strike price." />
      <${TextArea} id="offer-benefits" label="Benefits notes" rows=${2} value=${draft.benefitsNotes} onInput=${set("benefitsNotes")} maxlength="4000" />
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy}>${offer ? "Save offer" : "Record offer"}</${Button}>
      <${Button} kind="ghost" onClick=${() => {
        guard.release();
        onCancel();
      }}>Cancel</${Button}>
    </div>
  </form>`;
}
