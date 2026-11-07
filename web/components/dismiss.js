import { plural } from "../lib/format.js";
import { html, useEffect, useId, useRef } from "../lib/html.js";
import { Button } from "./ui.js";

/**
 * Dismissal, stated before the click. Restoring brings a role back to the
 * queue but not its application: that stays skipped, with a rejection on
 * its packet, until it is prepared and approved again.
 *
 * count: roles being dismissed; unsent: how many have an unsent application.
 */
export function DismissConfirm({ count = 1, unsent = 0, busy, onConfirm, onCancel }) {
  const titleId = useId();
  const box = useRef(null);
  const many = count > 1;

  useEffect(() => {
    box.current?.focus();
  }, []);

  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    // Stops the drawer around it from closing too.
    event.preventDefault();
    onCancel();
  };

  const applicationLine = !unsent
    ? null
    : many
      ? `${unsent} of them ${unsent === 1 ? "has an unsent application" : "have unsent applications"}. Each is set to skipped and a rejection is recorded against its current packet, so an earlier approval no longer lets it be sent. Each is also taken out of any prepared batch.`
      : "Its unsent application is set to skipped and a rejection is recorded against its current packet, so an earlier approval no longer lets it be sent. It is also taken out of any prepared batch.";

  return html`<div class="notice notice--held dismiss-confirm" role="group" aria-labelledby=${titleId} tabindex="-1" ref=${box} onKeyDown=${onKeyDown}>
    <p class="notice__title" id=${titleId}>${many ? `Dismiss ${plural(count, "role")}?` : "Dismiss this role?"}</p>
    <ul class="plain-list">
      <li>${many ? "They leave the queue, with the same roles on any other board." : "It leaves the queue, with the same role on any other board."}</li>
      ${applicationLine ? html`<li>${applicationLine}</li>` : null}
      <li>
        ${unsent
          ? "Restoring a role later puts it back in the queue, but not its application: prepare and approve that again."
          : `You can restore ${many ? "them" : "it"} from the Dismissed filter.`}
      </li>
    </ul>
    <div class="dismiss-confirm__actions">
      <${Button} kind="danger" busy=${busy} onClick=${onConfirm}>${many ? `Dismiss ${count}` : "Dismiss role"}</${Button}>
      <${Button} kind="ghost" disabled=${busy} onClick=${onCancel}>Keep ${many ? "them" : "it"}</${Button}>
    </div>
  </div>`;
}

/** The toast after dismissing, built from what the server reports it did. */
export function dismissedText(results, failed = []) {
  const list = Array.isArray(results) ? results : [results];
  const skipped = list.filter((entry) => entry.skippedApplicationId).length;
  const batchItems = list.reduce((sum, entry) => sum + (Number(entry.batchItemsSkipped) || 0), 0);
  const parts = [list.length === 1 && failed.length === 0 ? "Dismissed." : `Dismissed ${plural(list.length, "role")}.`];
  if (skipped === 1 && list.length === 1) parts.push("Its application is skipped, with a rejection recorded against its packet.");
  else if (skipped) parts.push(`${plural(skipped, "application")} skipped, each with a rejection recorded against its packet.`);
  if (batchItems) parts.push(`Taken out of ${plural(batchItems, "prepared batch", "prepared batches")}.`);
  if (failed.length) parts.push(`${plural(failed.length, "was", "were")} refused: ${failed.map((entry) => entry.message).join("; ")}`);
  return parts.join(" ");
}
