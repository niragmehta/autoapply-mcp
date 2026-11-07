import { html, useState } from "../lib/html.js";
import { label as labelOf, num, tone as toneOf } from "../lib/format.js";
import { toast } from "../lib/store.js";
import { safeHref } from "../lib/urls.js";

/** The small shared vocabulary: plates, buttons, icons, fields, meters, headings and states. */

const ICONS = {
  chevron: html`<path d="M6 3.5 10.5 8 6 12.5" />`,
  close: html`<path d="M4 4l8 8M12 4l-8 8" />`,
  external: html`<path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" />`,
  refresh: html`<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" />`,
  play: html`<path d="M5 3.5v9l7-4.5z" />`,
  stop: html`<path d="M4.5 4.5h7v7h-7z" />`,
  arrowUp: html`<path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" />`,
  arrowDown: html`<path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />`,
  copy: html`<path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />`,
  menu: html`<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />`,
  download: html`<path d="M8 2.5v7.5M4.75 7 8 10.25 11.25 7M3 13.25h10" />`,
  search: html`<path d="M7 2.75a4.25 4.25 0 1 0 0 8.5 4.25 4.25 0 0 0 0-8.5zM10.1 10.1l3.15 3.15" />`,
  bell: html`<path d="M4 11.25V7.5a4 4 0 0 1 8 0v3.75l1 1.25H3zM6.5 13.75a1.6 1.6 0 0 0 3 0" />`,
};

export function Icon({ name, title }) {
  return html`<svg class="icon" viewBox="0 0 16 16" aria-hidden=${title ? undefined : "true"} role=${title ? "img" : undefined}>
    ${title ? html`<title>${title}</title>` : null}${ICONS[name] ?? null}
  </svg>`;
}

/** A status plate. Text always carries the meaning; the tint only reinforces it. */
export function Plate({ value, text, tone, href, title }) {
  const className = `plate plate--${tone ?? toneOf(value)}`;
  const content = text ?? labelOf(value);
  return href
    ? html`<a class=${className} href=${href} title=${title}>${content}</a>`
    : html`<span class=${className} title=${title}>${content}</span>`;
}

export function TierPlate({ tier }) {
  if (!tier || tier === "none") return html`<span class="muted">-</span>`;
  const variant = tier === "B" ? " plate--tier-b" : tier === "C" ? " plate--tier-c" : "";
  return html`<span class=${`plate plate--tier${variant}`} title=${`Tier ${tier}`}>${tier}</span>`;
}

export function Button({ kind = "secondary", small, busy, disabled, type = "button", onClick, children, title, label, form, id }) {
  const className = `btn btn--${kind}${small ? " btn--small" : ""}`;
  return html`<button
    type=${type}
    id=${id}
    class=${className}
    onClick=${onClick}
    disabled=${disabled || busy}
    aria-busy=${busy ? "true" : undefined}
    title=${title}
    aria-label=${label}
    form=${form}
  >
    ${children}
  </button>`;
}

export function IconButton({ icon, label, onClick }) {
  return html`<button type="button" class="icon-btn" onClick=${onClick} aria-label=${label} title=${label}><${Icon} name=${icon} /></button>`;
}

export function Field({ label, hint, error, id, children }) {
  return html`<div class="field">
    <label class="field__label" for=${id}>${label}</label>
    ${children}
    ${error ? html`<span class="field__error" id=${`${id}-error`}>${error}</span>` : hint ? html`<span class="field__hint" id=${`${id}-hint`}>${hint}</span>` : null}
  </div>`;
}

/** A row of pressable toggles, for multi-select filters with few options. */
export function Toggles({ legend, options, value, onChange }) {
  const selected = new Set(value);
  const flip = (option) => {
    const next = new Set(selected);
    if (next.has(option.value)) next.delete(option.value);
    else next.add(option.value);
    onChange(options.map((entry) => entry.value).filter((entry) => next.has(entry)));
  };
  return html`<fieldset>
    <legend>${legend}</legend>
    <div class="toggles" role="group">
      ${options.map(
        (option) => html`<button type="button" aria-pressed=${selected.has(option.value) ? "true" : "false"} onClick=${() => flip(option)}>
          ${option.label}${option.count !== undefined ? html`<span class="count">${option.count}</span>` : null}
        </button>`,
      )}
    </div>
  </fieldset>`;
}

/** One choice from a few: pressed buttons in the toggle style; pressing the current one keeps it. */
export function Segmented({ legend = "Show", hideLegend = false, options, value, onChange }) {
  return html`<fieldset>
    <legend class=${hideLegend ? "sr-only" : undefined}>${legend}</legend>
    <div class="toggles" role="group">
      ${options.map(
        (option) => html`<button type="button" aria-pressed=${option.value === value ? "true" : "false"} onClick=${() => option.value !== value && onChange(option.value)}>
          ${option.label}${option.count !== undefined ? html`<span class="count">${option.count}</span>` : null}
        </button>`,
      )}
    </div>
  </fieldset>`;
}

export function Switch({ checked, onChange, label, disabled }) {
  return html`<button
    type="button"
    role="switch"
    class="switch"
    aria-checked=${checked ? "true" : "false"}
    aria-label=${label}
    disabled=${disabled}
    onClick=${() => onChange(!checked)}
  ></button>`;
}

export function Check({ checked, onChange, children, disabled }) {
  return html`<label class="check">
    <input type="checkbox" checked=${checked} disabled=${disabled} onChange=${(event) => onChange(event.currentTarget.checked)} />
    <span>${children}</span>
  </label>`;
}

/** A filled bar for a value against a limit; the text says the numbers. */
export function Meter({ value, max, text }) {
  const ratio = max ? Math.min(1, value / max) : 0;
  return html`<div class="meter">
    <div class="meter__bar" role="img" aria-label=${text}>
      <span class=${`meter__fill${ratio >= 1 ? " meter__fill--full" : ""}`} style=${{ "--p": ratio }}></span>
    </div>
  </div>`;
}

export function Progress({ done, total }) {
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  return html`<span class="progress-cell">
    <span class="progress" role="progressbar" aria-valuemin="0" aria-valuemax=${total || 0} aria-valuenow=${done || 0} aria-label="Progress">
      <span class="progress__fill" style=${{ "--p": ratio }}></span>
    </span>
    <span class="small muted">${total > 0 ? `${done}/${total}` : "-"}</span>
  </span>`;
}

export function PageHead({ title, sub, actions }) {
  return html`<div class="page-head">
    <div class="page-head__text">
      <h1>${title}</h1>
      ${sub ? html`<p class="page-head__sub">${sub}</p>` : null}
    </div>
    ${actions ? html`<div class="page-head__actions">${actions}</div>` : null}
  </div>`;
}

export function Section({ id, title, note, actions, children }) {
  return html`<section class="section" aria-labelledby=${id}>
    <div class="section__head">
      <h2 id=${id}>${title}</h2>
      ${note ? html`<p class="section__note">${note}</p>` : null}
      ${actions ?? null}
    </div>
    ${children}
  </section>`;
}

export function Empty({ title, children, action }) {
  return html`<div class="empty">
    <p class="empty__title">${title}</p>
    ${children ? html`<p class="empty__body">${children}</p>` : null}
    ${action ?? null}
  </div>`;
}

export function ErrorNotice({ error, onRetry }) {
  if (!error) return null;
  return html`<div class="notice notice--bad" role="alert">
    <p class="notice__title">${error.code === "offline" ? "Lost contact with the dashboard" : "Could not load this"}</p>
    <p>${error.message}</p>
    ${onRetry ? html`<div><${Button} small onClick=${() => onRetry()}><${Icon} name="refresh" /> Try again</${Button}></div>` : null}
  </div>`;
}

export function Skeleton({ lines = 3, width = "100%" }) {
  return html`<div class="stack" aria-hidden="true">
    ${Array.from({ length: lines }, (_, index) => html`<span class="skeleton" style=${{ width: index === lines - 1 ? "60%" : width }}></span>`)}
  </div>`;
}

export function ExternalLink({ href, children }) {
  if (!href) return null;
  const safe = safeHref(href);
  if (!safe) return html`<span>${children}</span>`;
  return html`<a href=${safe} target="_blank" rel="noopener noreferrer">${children} <${Icon} name="external" /></a>`;
}

/** Copies text for the person to paste and send themselves; nothing is sent from here. */
export function CopyButton({ text, label = "Copy", small = true }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Copying was blocked by the browser; select the text and copy it instead.", { tone: "bad" });
    }
  };
  return html`<${Button} small=${small} onClick=${copy} disabled=${!text}>
    <${Icon} name="copy" /> ${copied ? "Copied" : label}
  </${Button}>`;
}

/** Below this many cases a rate is shown, but marked as a small sample. */
export const SMALL_SAMPLE = 10;

/** A rate always with its sample: "25% · 3 of 12". */
export function RateText({ rate, empty = "-" }) {
  if (!rate || rate.rate === null || rate.n === 0) return html`<span class="muted">${empty}${rate?.n === 0 ? html`<span class="sr-only"> (no cases)</span>` : null}</span>`;
  const small = rate.n < SMALL_SAMPLE;
  return html`<span class=${`rate${small ? " rate--small" : ""}`} title=${small ? "Small sample: read with care" : undefined}>
    <span class="rate__value">${Math.round(rate.rate * 100)}%</span>
    <span class="rate__n">${num(rate.count)} of ${num(rate.n)}</span>
  </span>`;
}
