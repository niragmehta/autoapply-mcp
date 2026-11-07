import { html, useEffect, useState } from "../lib/html.js";
import { dismissToast, subscribeToasts } from "../lib/store.js";
import { IconButton } from "./ui.js";

/** Toasts announce results politely; they never carry the only copy of important information. */
export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => subscribeToasts(setItems), []);
  return html`<div class="toasts" role="status" aria-live="polite">
    ${items.map(
      (item) => html`<div class=${`toast${item.tone === "bad" ? " toast--bad" : ""}`} key=${item.id}>
        <p>${item.message}${item.href ? html` <a href=${item.href}>${item.linkText ?? "Open"}</a>` : null}</p>
        <${IconButton} icon="close" label="Dismiss" onClick=${() => dismissToast(item.id)} />
      </div>`,
    )}
  </div>`;
}
