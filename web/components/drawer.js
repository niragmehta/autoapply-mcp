import { html, useEffect, useId, useRef } from "../lib/html.js";
import { IconButton } from "./ui.js";

/**
 * The detail panel. It sits beside the table rather than over it, so the
 * list stays usable; focus moves in when it opens and returns to whatever
 * opened it when it closes. Escape closes it.
 */
export function Drawer({ title, sub, onClose, wide, actions, children }) {
  const titleId = useId();
  const panel = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    opener.current = document.activeElement;
    panel.current?.querySelector("h2")?.focus();
    return () => {
      const target = opener.current;
      if (target instanceof HTMLElement && document.contains(target)) target.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return html`<aside class=${`drawer${wide ? " drawer--wide" : ""}`} aria-labelledby=${titleId} ref=${panel}>
    <div class="drawer__head">
      <div class="drawer__title">
        <h2 id=${titleId} tabindex="-1">${title}</h2>
        ${sub ? html`<div class="muted small">${sub}</div>` : null}
      </div>
      ${actions ?? null}
      <${IconButton} icon="close" label="Close details" onClick=${onClose} />
    </div>
    <div class="drawer__body">${children}</div>
  </aside>`;
}
