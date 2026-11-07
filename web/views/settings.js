import { Tabs, TabPanel } from "../components/tabs.js";
import { PageHead } from "../components/ui.js";
import { html } from "../lib/html.js";
import { useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { AnswersLibrary } from "./settings-answers.js";
import { CampaignSettings, ProfileSettings } from "./settings-config.js";

/** Settings: the answers library to edit, and what the campaign and profile say, read-only. */

const TABS = [
  { id: "answers", label: "Answers library" },
  { id: "campaign", label: "Campaign" },
  { id: "profile", label: "Profile" },
];

export default function Settings({ query }) {
  useTitle("Settings");
  const requested = query.get("tab");
  const current = TABS.some((tab) => tab.id === requested) ? requested : "answers";
  return html`<div>
    <${PageHead} title="Settings" sub="The answers forms reuse, and the campaign and profile they come from. Every save is written to the file with a backup of the previous version." />
    <${Tabs} label="Settings" idPrefix="settings" tabs=${TABS} current=${current} onChange=${(id) => setQuery({ tab: id === "answers" ? undefined : id, answer: undefined, q: undefined, group: undefined })} />
    <${TabPanel} idPrefix="settings" current=${current}>
      ${current === "answers" ? html`<${AnswersLibrary} query=${query} />` : null}
      ${current === "campaign" ? html`<${CampaignSettings} />` : null}
      ${current === "profile" ? html`<${ProfileSettings} />` : null}
    </${TabPanel}>
  </div>`;
}
