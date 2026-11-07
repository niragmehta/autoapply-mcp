import { html, useEffect, useId, useRef, useState } from "../lib/html.js";
import { releaseLeaveGuard } from "../lib/router.js";
import { Drawer } from "./drawer.js";
import { Button } from "./ui.js";

/**
 * Two-step confirmation, inline: the first click opens a held notice that
 * says what will happen; only its own button acts. Focus moves into it and
 * Escape backs out without closing the panel around it.
 */
export function ConfirmInline({ title, children, confirmLabel, cancelLabel = "Keep it", busy, onConfirm, onCancel, danger = true }) {
  const titleId = useId();
  const box = useRef(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onCancel();
  };
  return html`<div class="notice notice--held dismiss-confirm" role="group" aria-labelledby=${titleId} tabindex="-1" ref=${box} onKeyDown=${onKeyDown}>
    <p class="notice__title" id=${titleId}>${title}</p>
    ${children}
    <div class="dismiss-confirm__actions">
      <${Button} kind=${danger ? "danger" : "primary"} busy=${busy} onClick=${onConfirm}>${confirmLabel}</${Button}>
      <${Button} kind="ghost" disabled=${busy} onClick=${onCancel}>${cancelLabel}</${Button}>
    </div>
  </div>`;
}

/** "Delete..." that asks first. `consequence` says what goes, and what stays. */
export function DeleteAction({ what, consequence, busy, onDelete, label = "Delete..." }) {
  const [asking, setAsking] = useState(false);
  const triggerId = useId();
  const cancel = () => {
    setAsking(false);
    requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
  };
  if (asking) {
    return html`<${ConfirmInline} title=${`Delete ${what}?`} confirmLabel="Delete" busy=${busy} onConfirm=${onDelete} onCancel=${cancel}>
      <p>${consequence} This cannot be undone.</p>
    </${ConfirmInline}>`;
  }
  // The visible word is short; the name says what would be deleted.
  return html`<${Button} id=${triggerId} kind="ghost" label=${`Delete ${what}`} onClick=${() => setAsking(true)}>${label}</${Button}>`;
}

/**
 * A drawer for an editor. With unsaved changes, closing it (the button or
 * Escape) first asks to discard them; the rest of the app asks through the
 * leave guard (useUnsavedGuard).
 */
export function EditorDrawer({ dirty, onClose, onDiscard, children, ...drawer }) {
  const [asking, setAsking] = useState(false);
  const close = () => (dirty ? setAsking(true) : onClose());
  return html`<${Drawer} ...${drawer} onClose=${close}>
    ${asking
      ? html`<div class="drawer__section">
          <${ConfirmInline}
            title="Discard your changes?"
            confirmLabel="Discard changes"
            cancelLabel="Keep editing"
            onConfirm=${() => {
              setAsking(false);
              onDiscard?.();
              releaseLeaveGuard();
              onClose();
            }}
            onCancel=${() => setAsking(false)}
          >
            <p>What you typed here has not been saved.</p>
          </${ConfirmInline}>
        </div>`
      : null}
    ${children}
  </${Drawer}>`;
}
