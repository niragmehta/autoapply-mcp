import { Empty, PageHead } from "../components/ui.js";
import { html } from "../lib/html.js";
import { useTitle } from "../lib/hooks.js";

export default function NotFound({ path }) {
  useTitle("Not found");
  return html`<div>
    <${PageHead} title="No page here" sub=${path} />
    <div class="panel">
      <${Empty} title="This address does not match a dashboard page" action=${html`<a class="btn" href="/">Go to the overview</a>`}>
        Pages are listed in the bar at the top. Press ? for keyboard shortcuts.
      </${Empty}>
    </div>
  </div>`;
}
