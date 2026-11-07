import type { InterviewStage } from "./types.js";

/**
 * Stage guides, prep-time blocks and the red-flag rubric. Adapted from
 * career-ops modes/interview/plan.md, interview/practice.md and
 * interview-redflag.md (MIT). Generic by design: company-specific questions
 * come from research, and inferred ones must be labelled as inferred.
 */

type StageGuide = {
  stage: InterviewStage;
  label: string;
  typicalMinutes: string;
  focus: string;
  defaultQuestions: string[];
};

export const STAGE_GUIDES: Readonly<Record<InterviewStage, StageGuide>> = {
  recruiter_screen: {
    stage: "recruiter_screen",
    label: "Recruiter screen",
    typicalMinutes: "20-30",
    focus: "Fit, motivation, compensation, logistics and communication - not technical depth.",
    defaultQuestions: [
      "Walk me through your background.",
      "Why this company, and why this role?",
      "Why are you looking to leave your current role?",
      "What are your compensation expectations?",
      "Where are you located, and what is your work authorization and availability?",
      "What questions do you have for me?",
    ],
  },
  hiring_manager: {
    stage: "hiring_manager",
    label: "Hiring manager",
    typicalMinutes: "30-45",
    focus: "Motivation, scope, judgment, leadership and how the candidate would approach the team's problems.",
    defaultQuestions: [
      "Tell me about yourself and what you are looking for next.",
      "What is the hardest problem you have solved, and how?",
      "Tell me about a time you met resistance to a change you proposed.",
      "What does this title mean to you, day to day?",
      "How would you approach your first 90 days here?",
      "Tell me about a time you were wrong. What did you learn?",
    ],
  },
  technical: {
    stage: "technical",
    label: "Technical round",
    typicalMinutes: "45-60",
    focus: "Depth in the core skills the posting names, applied to realistic scenarios; possibly live exercises.",
    defaultQuestions: [
      "Explain how a core technology from the posting works under the hood.",
      "When would you choose an established pattern or framework, and when not?",
      "Walk me through a fundamental building block you rely on in this domain.",
      "How would you tackle the most advanced topic in this posting?",
      "Tell me about a high-stakes failure in production and how you handled it.",
      "How have you raised the quality bar on a team?",
    ],
  },
  system_design: {
    stage: "system_design",
    label: "System design",
    typicalMinutes: "45-60",
    focus: "Constraints, components, trade-offs, failure modes and how quality is measured.",
    defaultQuestions: [
      "Design a system close to what this team builds.",
      "What fails first at ten times the load, or at half the budget?",
      "How would you know the system is correct, and how would you measure it?",
      "How would you validate it after launch?",
    ],
  },
  behavioral: {
    stage: "behavioral",
    label: "Behavioral round",
    typicalMinutes: "45-60",
    focus: "STAR stories with a reflection: delivery, failure, influence, teamwork and ownership.",
    defaultQuestions: [
      "Tell me about a difficult project you delivered.",
      "Tell me about a significant failure.",
      "Tell me about influencing a team you did not manage.",
      "Describe the best team you have worked on and your part in it.",
      "Tell me about simplifying something complex.",
      "Tell me about solving a problem that was not your job.",
    ],
  },
  onsite: {
    stage: "onsite",
    label: "Onsite or loop",
    typicalMinutes: "180-300",
    focus: "Several audiences in sequence: plan per panelist, keep the freshest material for the deepest slot, never repeat one proof point word for word.",
    defaultQuestions: [
      "Expect one recruiter or hiring-manager conversation, one or more technical or design rounds and a behavioral round.",
      "Prepare a tailored closing question for each panelist.",
    ],
  },
  other: {
    stage: "other",
    label: "Other conversation",
    typicalMinutes: "30-60",
    focus: "Unknown format: ask the recruiter what it covers and who attends.",
    defaultQuestions: ["Tell me about yourself.", "Why are you interested in this role?", "What questions do you have?"],
  },
};

type PrepBlock = { block: string; share: number; minutes: number | null; focus: string };

type BlockSpec = readonly [block: string, share: number, focus: string];

const NARRATIVE = "Background timeline, why this company tied to your history, strongest proof point in 30 seconds.";
const PRIORITY = "The single most likely topic: concept, then the story that proves it, then likely follow-ups.";
const SECONDARY = "The next most likely topic, same pattern.";
const STORIES = "Map likely questions to stories, rehearse each two-minute version and its reflection.";
const RESEARCH = "Product pages, recent news, the team's work; three or four sharp questions.";
const PRACTICE = "A timed practice run, one question at a time (interview_practice).";
const REST = "Buffer and rest; stop studying 60-90 minutes before the interview.";

const DEFAULT_BLOCKS: readonly BlockSpec[] = [
  ["Lock the narrative", 0.15, NARRATIVE],
  ["Priority domain", 0.25, PRIORITY],
  ["Secondary domain", 0.2, SECONDARY],
  ["Behavioral stories", 0.15, STORIES],
  ["Company research", 0.1, RESEARCH],
  ["Practice run", 0.1, PRACTICE],
  ["Buffer and rest", 0.05, REST],
];

/** A screen shifts weight toward stories and research (career-ops plan.md). */
const BLOCKS_BY_STAGE: Partial<Record<InterviewStage, readonly BlockSpec[]>> = {
  recruiter_screen: [
    ["Lock the narrative", 0.25, NARRATIVE],
    ["Company research", 0.2, RESEARCH],
    ["Behavioral stories", 0.2, STORIES],
    ["Compensation, logistics and questions", 0.15, "Compensation answer per disclosure policy, availability, notice period, questions to ask."],
    ["Priority domain", 0.1, PRIORITY],
    ["Practice run", 0.05, PRACTICE],
    ["Buffer and rest", 0.05, REST],
  ],
  hiring_manager: [
    ["Lock the narrative", 0.15, NARRATIVE],
    ["Behavioral stories", 0.25, STORIES],
    ["Priority domain", 0.2, PRIORITY],
    ["Company research and first 90 days", 0.15, "The team's current work, a first-90-days outline, two or three sharp questions."],
    ["Practice run", 0.15, PRACTICE],
    ["Buffer and rest", 0.1, REST],
  ],
  behavioral: [
    ["Lock the narrative", 0.15, NARRATIVE],
    ["Behavioral stories", 0.35, STORIES],
    ["Priority domain", 0.15, PRIORITY],
    ["Company research", 0.1, RESEARCH],
    ["Practice run", 0.15, PRACTICE],
    ["Buffer and rest", 0.1, REST],
  ],
};

/** Time blocks for a stage; with `hoursAvailable`, each block's minutes too. */
export function prepBlocks(stage: InterviewStage, hoursAvailable?: number): PrepBlock[] {
  const specs = BLOCKS_BY_STAGE[stage] ?? DEFAULT_BLOCKS;
  const totalMinutes = hoursAvailable !== undefined && hoursAvailable > 0 ? hoursAvailable * 60 : null;
  return specs.map(([block, share, focus]) => ({
    block,
    share,
    minutes: totalMinutes === null ? null : Math.round(totalMinutes * share),
    focus,
  }));
}

export const RED_FLAG_RUBRIC = {
  signals: [
    { id: "scope_ambiguity", label: "Scope ambiguity", lookFor: "No measurable success criteria; circular or contradictory responsibilities." },
    { id: "defensive_closure", label: "Defensive closure", lookFor: "A thread redirected or closed right after a strong answer; no follow-up." },
    { id: "evaluator_gap", label: "Evaluator competency gap", lookFor: "The interviewer cannot engage with a domain-correct answer or asks domain-unfamiliar questions." },
    { id: "process", label: "Process signals", lookFor: "Contradictory criteria, no knowledge of earlier rounds, shifting requirements, no structured follow-up." },
    {
      id: "protected_grounds",
      label: "Protected-grounds questions",
      lookFor: "Questions about age, family plans, religion, national origin, health or similar. One borderline question scores 0; repeated probing or two or more distinct grounds marks the session.",
    },
  ],
  scoring: "Each signal adds 1 when seen in one session and 2 when seen in two or more sessions; maximum 10.",
  levels: [
    { range: "0-1", level: "none", message: "No structural red flags detected." },
    { range: "2-3", level: "caution", message: "Enter with eyes open." },
    { range: "4+", level: "warning", message: "Reconsider." },
  ],
  rules: [
    "Observations, not verdicts: quote the interviewer's words and describe the pattern.",
    "Read the interviewer's turns, not the candidate's.",
    "Never call a question illegal or discriminatory; that depends on jurisdiction and context, and this is not legal advice.",
    "A mismatch between the posting's scope or pay and what was discussed is reported separately and does not add to the score.",
  ],
} as const;
