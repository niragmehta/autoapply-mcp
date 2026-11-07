import { api } from "../api.js";
import { TextField } from "../components/form.js";
import { Button, CopyButton, ErrorNotice, Plate, Skeleton } from "../components/ui.js";
import { label, money, num } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource } from "../lib/hooks.js";
import { toast } from "../lib/store.js";

/**
 * Per offer: a negotiation plan under assumptions you set (the anchor, the
 * target, a walk-away number for your eyes only, the counter split across
 * levers, its expected value and the risks), and the contract checklist
 * with the clauses you have read. Information only, never legal advice.
 */

const ASSUMPTIONS = [
  ["pImprove", "Chance they improve the offer", "0 to 1. How likely the employer improves something when asked professionally.", 0.7],
  ["captureRate", "Share of the ask you get", "0 to 1. Of the increase you ask for, how much you end up with.", 0.5],
  ["pWithdraw", "Chance they withdraw it", "0 to 1. Kept small; asking politely rarely loses an offer.", 0.02],
  ["horizonYears", "Years the raise counts", "0.5 to 10. How long a higher base keeps paying.", 3],
];

function Assumptions({ values, onApply }) {
  const [text, setText] = useState(Object.fromEntries(ASSUMPTIONS.map(([key, , , fallback]) => [key, String(values[key] ?? fallback)])));
  const apply = (event) => {
    event.preventDefault();
    onApply(Object.fromEntries(Object.entries(text).map(([key, value]) => [key, value.trim()])));
  };
  return html`<form class="stack" onSubmit=${apply} aria-label="Assumptions">
    <div class="form-grid">
      ${ASSUMPTIONS.map(([key, text_, hint]) => html`<${TextField} key=${key} id=${`assume-${key}`} label=${text_} hint=${hint} inputmode="decimal" value=${text[key]} onInput=${(value) => setText({ ...text, [key]: value })} />`)}
    </div>
    <div><${Button} type="submit">Recalculate</${Button}></div>
  </form>`;
}

export function NegotiationPlan({ offerId }) {
  const [assumptions, setAssumptions] = useState({});
  const plan = useResource(() => api.get(`/api/offers/${encodeURIComponent(offerId)}/negotiation`, assumptions), [offerId, JSON.stringify(assumptions)]);
  const data = plan.data;
  const currency = data?.currency;
  const talking = data ? data.talkingPoints.map((point, index) => `${index + 1}. ${point}`).join("\n") : "";
  return html`<div class="stack">
    ${plan.error ? html`<${ErrorNotice} error=${plan.error} onRetry=${plan.reload} />` : null}
    ${plan.loading && !data ? html`<${Skeleton} lines=${8} />` : null}
    ${data
      ? html`
          <section aria-labelledby="plan-numbers">
            <h3 id="plan-numbers">The numbers</h3>
            <table class="table plan-numbers">
              <caption class="sr-only">Anchor, target and walk-away, a year in total</caption>
              <tbody>
                <tr><th scope="row">Open with</th><td class="num"><strong>${money(data.numbers.anchor, currency)}</strong></td><td class="small">${data.numbers.basis.anchor}</td></tr>
                <tr><th scope="row">Aim to settle at</th><td class="num"><strong>${money(data.numbers.target, currency)}</strong></td><td class="small">${data.numbers.basis.target}</td></tr>
                <tr class="plan-private">
                  <th scope="row">Walk away below <${Plate} text="Private" tone="held" /></th>
                  <td class="num"><strong>${data.numbers.walkAway === null ? "Unknown" : money(data.numbers.walkAway, currency)}</strong></td>
                  <td class="small">${data.numbers.basis.walkAway}. ${data.numbers.privateNote}</td>
                </tr>
                <tr><th scope="row">The offer today</th><td class="num">${money(data.current.annualizedTotal, currency)}</td><td class="small">Annualized; base ${money(data.current.base, currency)}.</td></tr>
              </tbody>
            </table>
          </section>
          <section aria-labelledby="plan-counter">
            <h3 id="plan-counter">The counter</h3>
            <p>${data.recommendedCounter.summary}</p>
            <table class="table plan-levers">
              <caption class="sr-only">Levers</caption>
              <thead><tr><th scope="col">Lever</th><th scope="col" class="num">Now</th><th scope="col" class="num">Ask</th><th scope="col">Note</th></tr></thead>
              <tbody>
                ${data.levers.map(
                  (lever) => html`<tr key=${lever.lever}>
                    <td><span class="cell-main">${label(lever.lever)}</span></td>
                    <td class="num" data-label="Now">${typeof lever.current === "number" ? money(lever.current, currency) : lever.current}</td>
                    <td class="num" data-label="Ask">${lever.ask === null ? "-" : typeof lever.ask === "number" ? money(lever.ask, currency) : lever.ask}</td>
                    <td class="small">${lever.note}</td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </section>
          <section aria-labelledby="plan-talk">
            <div class="section__head"><h3 id="plan-talk">What to say</h3><${CopyButton} text=${talking} label="Copy" /></div>
            <ol class="plain-list">${data.talkingPoints.map((point) => html`<li>${point}</li>`)}</ol>
            ${data.proofPoints.length ? html`<p class="small">Proof from your stories: ${data.proofPoints.map((point) => point.title).join("; ")}.</p>` : null}
          </section>
          ${data.risks.length
            ? html`<section aria-labelledby="plan-risks"><h3 id="plan-risks">Risks</h3><ul class="plain-list text-warn">${data.risks.map((risk) => html`<li>${risk}</li>`)}</ul></section>`
            : null}
          <section aria-labelledby="plan-ev">
            <h3 id="plan-ev">Is asking worth it?</h3>
            <p>
              Expected value of negotiating: <strong class=${data.expectedValue.positive ? "text-ok" : "text-warn"}>${money(data.expectedValue.value, currency)}</strong>.
              It stops being worth it if the chance they withdraw passes ${num(Math.round(data.expectedValue.breakEvenWithdrawProbability * 1000) / 10)}%.
            </p>
            <${Assumptions} values=${data.expectedValue.inputs} onApply=${setAssumptions} />
            <details class="small"><summary>How this is worked out</summary>
              <p style=${{ marginTop: "0.5rem" }} class="mono">${data.expectedValue.formula}</p>
              <ul class="plain-list">${data.expectedValue.assumptions.map((text) => html`<li>${text}</li>`)}</ul>
            </details>
          </section>
          <p class="small muted">${data.disclaimer}</p>
        `
      : null}
  </div>`;
}

const TAG_TONE = { "[commonly negotiated]": "info", "[ask your lawyer]": "warn", "[standard]": "muted" };

function Clause({ clause, offerId, onTicked }) {
  const [busy, run] = useAction(toast);
  // Shown ticked at once; put back if the server refuses.
  const [checked, setChecked] = useState(clause.checkedAt !== null);
  const tick = async (next) => {
    setChecked(next);
    const result = await run(() => api.post(`/api/offers/${encodeURIComponent(offerId)}/checklist`, { clauseId: clause.id, checked: next }));
    if (result) onTicked();
    else setChecked(!next);
  };
  return html`<li class=${`clause${clause.relevantToThisOffer ? " clause--relevant" : ""}`}>
    <div class="clause__head">
      <label class="check">
        <input type="checkbox" checked=${checked} aria-busy=${busy ? "true" : undefined} onChange=${(event) => tick(event.currentTarget.checked)} />
        <span class="cell-main">${clause.title}</span>
      </label>
      <span class="row">${clause.tags.map((tag) => html`<${Plate} key=${tag} text=${tag.replace(/[[\]]/g, "")} tone=${TAG_TONE[tag] ?? "muted"} />`)}</span>
    </div>
    ${clause.relevance ? html`<p class="small clause__why">${clause.relevance}</p>` : null}
    <div class="clause__cols">
      <div><p class="field__label small">What to check</p><ul class="plain-list small">${clause.whatToCheck.map((item) => html`<li>${item}</li>`)}</ul></div>
      <div><p class="field__label small">Ask your lawyer</p><ul class="plain-list small">${clause.questionsForLawyer.map((item) => html`<li>${item}</li>`)}</ul></div>
    </div>
  </li>`;
}

export function ContractChecklist({ offerId }) {
  const checklist = useResource(() => api.get(`/api/offers/${encodeURIComponent(offerId)}/checklist`), [offerId]);
  const data = checklist.data;
  const questions = data
    ? [...data.clauses.flatMap((clause) => clause.questionsForLawyer), ...data.generalQuestionsForLawyer].map((question, index) => `${index + 1}. ${question}`).join("\n")
    : "";
  return html`<div class="stack">
    ${checklist.error ? html`<${ErrorNotice} error=${checklist.error} onRetry=${checklist.reload} />` : null}
    ${checklist.loading && !data ? html`<${Skeleton} lines=${8} />` : null}
    ${data
      ? html`
          <p class="notice"><span>${data.disclaimer}</span></p>
          <div class="section__head">
            <p><strong>${data.progress.checked} of ${data.progress.total}</strong> clauses read. Clauses this offer makes relevant are marked.</p>
            <${CopyButton} text=${questions} label="Copy every lawyer question" />
          </div>
          <ul class="rows clauses">${data.clauses.map((clause) => html`<${Clause} key=${clause.id} clause=${clause} offerId=${offerId} onTicked=${() => checklist.reload({ quiet: true })} />`)}</ul>
          <section aria-labelledby="checklist-general">
            <h3 id="checklist-general">Also ask</h3>
            <ul class="plain-list small">${data.generalQuestionsForLawyer.map((item) => html`<li>${item}</li>`)}</ul>
            <h3>Check for what is missing</h3>
            <ul class="plain-list small">${data.absencesToCheck.map((item) => html`<li>${item}</li>`)}</ul>
          </section>
        `
      : null}
  </div>`;
}
