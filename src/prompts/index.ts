import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROMPT_GROUND_RULES, userPrompt } from "./helpers.js";
import { registerToolsetPrompts, type ToolsetName } from "../toolsets.js";

const GUIDE = [
  "You are operating autoapply-mcp, a governed job-application pipeline. Walk the candidate through whichever stage they need:",
  "",
  "1. Setup: check profile readiness, fill gaps conversationally, verify boards.",
  "2. Find: discover jobs from configured boards, harvest new companies, import job alerts.",
  "3. Judge: confirm postings are live and legitimate, evaluate fit in depth, skip weak matches.",
  "4. Prepare: draft answers from verified facts, tailor the resume and cover letter, preview, approve.",
  "5. Apply: submit within the campaign's limits, or hand the packet to the candidate.",
  "6. Follow through: read replies, record outcomes, follow up, prepare for interviews, negotiate offers.",
  "",
  "Start with campaign_status to see where the campaign stands, then ask what the candidate wants to do next.",
  "",
  PROMPT_GROUND_RULES,
].join("\n");

/** Registers the pipeline guide plus the guided workflows of each enabled toolset as MCP prompts. */
export function registerPrompts(server: McpServer, toolsets: readonly ToolsetName[]): void {
  server.registerPrompt(
    "autoapply_guide",
    { title: "Guide: the whole pipeline", description: "Orients the agent on every stage of the pipeline and where to start." },
    () => userPrompt(GUIDE),
  );
  registerToolsetPrompts(server, toolsets);
}
