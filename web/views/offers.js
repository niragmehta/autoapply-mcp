import { api } from "../api.js";
import { EditorDrawer } from "../components/confirm.js";
import { DataTable } from "../components/table.js";
import { TabPanel, Tabs } from "../components/tabs.js";
import { Button, Check, Empty, ErrorNotice, PageHead, Plate, Skeleton } from "../components/ui.js";
import { inDays, money } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { useMeta, useStatus } from "../lib/store.js";
import { OfferForm } from "./offer-form.js";
import { ContractChecklist, NegotiationPlan } from "./offer-plan.js";

/**
 * Offers side by side in one currency, with what-if exchange rates and the
 * sign-on spread you choose; each offer's terms, a negotiation plan and the
 * contract checklist. Nothing here is advice; every assumption is shown.
 */

const YEARS = [1, 2, 3, 4, 5, 6];

function percentText(value) {
  if (value === null || value === undefined) return "";
  return `${value > 0 ? "+" : ""}${Math.round(value)}%`;
}

function rangePosition(position) {
  if (position === null || position === undefined) return null;
  if (position < 0) return "Below the posted range";
  if (position > 1) return "Above the posted range";
  return `${Math.round(position * 100)}% up the range`;
}

function parseFx(text) {
  return Object.fromEntries(
    (text ?? "")
      .split(",")
      .map((part) => part.split(":"))
      .filter(([code, rate]) => code && rate)
      .map(([code, rate]) => [code, rate]),
  );
}

/** What-if rates for currencies among the offers that differ from the comparison's own. */
function FxControls({ data, fxText }) {
  const meta = useMeta().data;
  const base = meta?.compensation?.campaignCurrency ?? data.currency;
  const configured = meta?.compensation?.fx ?? {};
  const codes = [...new Set(data.offers.map((row) => row.comp.currency))].filter((code) => code !== data.currency);
  const [rates, setRates] = useState(() => parseFx(fxText));
  if (codes.length === 0) return null;
  const apply = (event) => {
    event.preventDefault();
    const entries = Object.entries(rates).filter(([, value]) => String(value).trim() !== "");
    setQuery({ fx: entries.length ? entries.map(([code, value]) => `${code}:${String(value).trim()}`).join(",") : undefined });
  };
  return html`<form class="fx-controls" onSubmit=${apply} aria-labelledby="fx-title">
    <p id="fx-title" class="field__label">What-if exchange rates <span class="muted">(this comparison only; nothing is saved)</span></p>
    <div class="row">
      ${codes.map(
        (code) => html`<div class="field fx-field" key=${code}>
          <label class="field__label small" for=${`fx-${code}`}>1 ${code} =</label>
          <span class="row" style=${{ flexWrap: "nowrap" }}>
            <input id=${`fx-${code}`} class="input" inputmode="decimal" style=${{ width: "6rem" }} placeholder=${configured[code] ? String(configured[code]) : "rate"} value=${rates[code] ?? ""} onInput=${(event) => setRates({ ...rates, [code]: event.currentTarget.value })} />
            <span class="small">${base}</span>
          </span>
          <span class="field__hint">${configured[code] ? `Configured: ${configured[code]}` : "No configured rate"}</span>
        </div>`,
      )}
      <div class="field"><span class="field__label" aria-hidden="true">${"\u00a0"}</span><span class="row"><${Button} type="submit">Compare</${Button}>${fxText ? html`<${Button} kind="ghost" onClick=${() => {
        setRates({});
        setQuery({ fx: undefined });
      }}>Use configured rates</${Button}>` : null}</span></div>
    </div>
  </form>`;
}

function Comparison({ query }) {
  const includeClosed = query.get("closed") === "1";
  const years = query.get("years") ?? "";
  const fxText = query.get("fx") ?? "";
  const comparison = useResource(() => api.get("/api/offers/compare", { includeClosed: includeClosed ? "true" : "", years, fx: fxText }), [includeClosed, years, fxText]);
  const data = comparison.data;
  const currency = data?.currency;
  const top = data?.ranking?.[0];
  const columns = [
    { key: "offer", label: "Offer", render: (row) => html`<span class="cell-main">${row.company}</span><span class="cell-sub">${row.title}${row.level ? ` · ${row.level}` : ""}</span>` },
    { key: "status", label: "Status", render: (row) => html`<${Plate} value=${row.status} />` },
    { key: "base", label: "Base", numeric: true, render: (row) => money(row.comp.base, row.comp.currency) },
    {
      key: "year",
      label: "First year",
      numeric: true,
      render: (row) => (row.inProfileCurrency ? money(row.inProfileCurrency.firstYearTotal, currency) : html`<span class="muted" title="No exchange rate for this currency">-</span>`),
    },
    {
      key: "annual",
      label: "Annualized",
      numeric: true,
      render: (row) => (row.inProfileCurrency ? html`<strong>${money(row.inProfileCurrency.annualizedTotal, currency)}</strong>` : html`<span class="muted">No rate</span>`),
    },
    {
      key: "target",
      label: "Against target",
      render: (row) =>
        row.vsTarget
          ? html`<span class=${row.vsTarget.delta >= 0 ? "text-ok" : "text-warn"}>${money(row.vsTarget.delta, currency)} ${percentText(row.vsTarget.pct)}</span>
              ${row.vsMinimum && !row.vsMinimum.meets ? html`<span class="cell-sub text-bad">Below your minimum</span>` : null}`
          : html`<span class="muted">-</span>`,
    },
    {
      key: "posting",
      label: "Posted range",
      render: (row) =>
        row.posting
          ? html`<span class="small">${row.posting.raw || "-"}</span>${rangePosition(row.posting.positionInRange) ? html`<span class="cell-sub">${rangePosition(row.posting.positionInRange)}</span>` : null}`
          : html`<span class="muted small">Not published</span>`,
    },
    {
      key: "deadline",
      label: "Decide by",
      render: (row) =>
        row.deadline
          ? html`<span class="nowrap">${row.deadline.slice(0, 10)}</span><span class=${`cell-sub${row.daysToDeadline !== null && row.daysToDeadline <= 7 ? " text-warn" : ""}`}>${inDays(row.daysToDeadline)}</span>`
          : html`<span class="muted">-</span>`,
    },
  ];
  return html`<div class="stack">
    <div class="filters offer-controls">
      <div class="field">
        <span class="field__label">Show</span>
        <${Check} checked=${includeClosed} onChange=${(value) => setQuery({ closed: value ? "1" : undefined })}>Include declined and expired</${Check}>
      </div>
      <div class="field">
        <label class="field__label" for="offers-years">Spread a sign-on over</label>
        <select id="offers-years" class="select" value=${years || "4"} onChange=${(event) => setQuery({ years: event.currentTarget.value === "4" ? undefined : event.currentTarget.value })}>
          ${YEARS.map((value) => html`<option value=${String(value)}>${value} year${value === 1 ? "" : "s"}</option>`)}
        </select>
      </div>
    </div>
    ${data ? html`<${FxControls} key=${fxText} data=${data} fxText=${fxText} />` : null}
    ${comparison.error ? html`<${ErrorNotice} error=${comparison.error} onRetry=${comparison.reload} />` : null}
    <${DataTable}
      caption="Offers compared"
      columns=${columns}
      rows=${data?.offers}
      rowKey=${(row) => row.offerId}
      loading=${comparison.loading}
      selectedKey=${query.get("offer")}
      onOpen=${(row) => setQuery({ offer: row.offerId }, { replace: false })}
      empty=${html`<${Empty} title="No offers in play" action=${html`<a class="btn" href="/offers?offer=new">Record an offer</a>`}>
        Record an offer from its application to compare it with the others in ${currency ?? "your profile's currency"}, plan the negotiation and read the contract with a checklist.
      </${Empty}>`}
    />
    ${data?.offers?.some((row) => row.warnings.length)
      ? html`<ul class="plain-list small">${data.offers.flatMap((row) => row.warnings.map((warning, index) => html`<li key=${`${row.offerId}-${index}`}><strong>${row.company}:</strong> ${warning}</li>`))}</ul>`
      : null}
    ${top && data.offers.length > 1 ? html`<p>Highest annualized: <strong>${top.company}</strong>, ${money(top.annualizedTotal, currency)}.</p>` : null}
    ${data?.assumptions?.length
      ? html`<details class="small">
          <summary>How these totals are computed</summary>
          <ul class="plain-list" style=${{ marginTop: "0.5rem" }}>${data.assumptions.map((assumption) => html`<li>${assumption}</li>`)}</ul>
        </details>`
      : null}
  </div>`;
}

const OFFER_TABS = [
  { id: "terms", label: "Terms" },
  { id: "plan", label: "Negotiation plan" },
  { id: "contract", label: "Contract checklist" },
];

function OfferDrawer({ offerId, applicationId, tab, onClose, onChanged }) {
  const isNew = offerId === "new";
  const loaded = useResource(() => (isNew ? Promise.resolve(null) : api.get(`/api/offers/${encodeURIComponent(offerId)}`)), [offerId]);
  const [dirty, setDirty] = useState(false);
  const offer = loaded.data?.offer;
  const current = OFFER_TABS.some((entry) => entry.id === tab) ? tab : "terms";
  return html`<${EditorDrawer}
    wide
    dirty=${dirty}
    title=${isNew ? "Record an offer" : offer ? `${offer.company}${offer.title ? `: ${offer.title}` : ""}` : "Offer"}
    sub=${offer ? `${money(loaded.data.comp.annualizedTotal, offer.currency)} a year, annualized` : "Its terms as the employer wrote them"}
    onClose=${onClose}
  >
    ${loaded.error ? html`<div class="drawer__section"><${ErrorNotice} error=${loaded.error} onRetry=${loaded.reload} /></div>` : null}
    ${!isNew && !offer && !loaded.error ? html`<div class="drawer__section"><${Skeleton} lines=${8} /></div>` : null}
    ${isNew
      ? html`<section class="drawer__section"><${OfferForm} applicationId=${applicationId} onDirty=${setDirty} onSaved=${(saved) => onChanged(saved, true)} onCancel=${onClose} /></section>`
      : null}
    ${offer
      ? html`<div class="drawer__section">
          <${Tabs} label="Offer" idPrefix="offer" tabs=${OFFER_TABS} current=${current} onChange=${(id) => setQuery({ tab: id === "terms" ? undefined : id })} />
          <${TabPanel} idPrefix="offer" current=${current}>
            ${current === "terms"
              ? html`<${OfferForm} key=${offer.updatedAt} offer=${offer} onDirty=${setDirty} onSaved=${(saved) => {
                  loaded.reload({ quiet: true });
                  onChanged(saved, false);
                }} onCancel=${onClose} />`
              : current === "plan"
                ? html`<${NegotiationPlan} offerId=${offer.id} />`
                : html`<${ContractChecklist} offerId=${offer.id} />`}
          </${TabPanel}>
        </div>`
      : null}
  </${EditorDrawer}>`;
}

export default function Offers({ query }) {
  useTitle("Offers");
  const openOffer = query.get("offer");
  const status = useStatus();
  const [version, setVersion] = useState(0);
  return html`<div>
    <${PageHead}
      title="Offers"
      sub="Every offer in one currency, a negotiation plan for each, and a checklist for reading the contract. Information, not advice."
      actions=${html`<a class="btn btn--primary" href="/offers?offer=new">Record offer</a>`}
    />
    <${Comparison} key=${version} query=${query} />
    ${openOffer
      ? html`<${OfferDrawer}
          key=${openOffer}
          offerId=${openOffer}
          applicationId=${query.get("app") ?? ""}
          tab=${query.get("tab")}
          onClose=${() => setQuery({ offer: undefined, tab: undefined, app: undefined })}
          onChanged=${(saved, created) => {
            setVersion((value) => value + 1);
            status.reload({ quiet: true });
            if (created) setQuery({ offer: saved.id, app: undefined });
          }}
        />`
      : null}
  </div>`;
}
