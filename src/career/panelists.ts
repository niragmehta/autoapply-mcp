import type { Interviewer } from "./types.js";

/**
 * Panelist roles: who is in the room and what each kind of interviewer probes
 * for. Adapted from career-ops panelist-roles.mjs and modes/interview-prep.md
 * (MIT). A classification is a hint for preparation, never a fact about the
 * person; the agent should override it when the candidate knows better.
 */

const PANELIST_KINDS = ["recruiter", "hiring_manager", "peer", "executive", "other"] as const;
type PanelistKind = (typeof PANELIST_KINDS)[number];

type PanelistRole = { kind: PanelistKind; label: string; probes: string[]; prepare: string[] };

export const PANELIST_ROLES: readonly PanelistRole[] = [
  {
    kind: "recruiter",
    label: "Recruiter or talent partner",
    probes: [
      "Motivation: why this company, why this role, why now",
      "Compensation expectations",
      "Location, remote arrangement and work authorization",
      "Timeline, notice period and other processes",
      "Clear, concise communication",
    ],
    prepare: [
      "A 60-90 second background pitch",
      "A compensation answer consistent with the profile's disclosure policy",
      "Availability, notice period and start date",
    ],
  },
  {
    kind: "hiring_manager",
    label: "Hiring manager or skip-level",
    probes: [
      "Why this role and why now",
      "Scope and ownership actually held",
      "How the first 90 days would go",
      "Leadership, collaboration and judgment under trade-offs",
      "Delivery track record",
    ],
    prepare: [
      "Two behavioral stories, each with a reflection",
      "A first-90-days outline drawn from the posting",
      "Two or three sharp questions about the team's current work",
    ],
  },
  {
    kind: "peer",
    label: "Peer engineer or practitioner",
    probes: [
      "Depth in the core skills the posting names",
      "Applied scenarios and trade-offs",
      "Code, design and review quality",
      "Day-to-day collaboration",
    ],
    prepare: [
      "The technical stories behind the strongest facts",
      "Reverse questions on on-call, code review and deploy cadence",
    ],
  },
  {
    kind: "executive",
    label: "Executive or founder",
    probes: ["Strategic thinking and business impact", "Ownership at scale", "Values and culture", "Long-term motivation"],
    prepare: ["One story framed by its business outcome", "A question about where the company is heading"],
  },
  {
    kind: "other",
    label: "Unclassified interviewer",
    probes: ["Unknown: ask the recruiter what this conversation covers"],
    prepare: ["A concise pitch and two impact stories", "A closing question about what they care about most in this role"],
  },
];

/**
 * First match wins. Executives come before managers and managers before
 * peers, because "VP Engineering" and "Engineering Manager" both also say
 * "engineering".
 */
const KIND_PATTERNS: ReadonlyArray<readonly [PanelistKind, RegExp]> = [
  [
    "executive",
    /\b(?:chief|cto|ceo|cio|ciso|cpo|coo|cfo|founder|co-?founder|president|vp|svp|evp|vice president|general manager)\b/i,
  ],
  ["recruiter", /\b(?:recruit\w*|talent|sourcer|sourcing|people partner|people operations|hr|human resources|coordinator)\b/i],
  ["hiring_manager", /\b(?:hiring manager|manager|director|head of|team lead|supervisor)\b/i],
  [
    "peer",
    /\b(?:engineer\w*|developer|scientist|analyst|architect|designer|researcher|sre|programmer|consultant|specialist|staff|principal|tech lead|lead|member of technical staff)\b/i,
  ],
];

type PanelistClassification = { kind: PanelistKind; label: string; matched: string | null };

export function classifyPanelist(role: string): PanelistClassification {
  for (const [kind, pattern] of KIND_PATTERNS) {
    const found = pattern.exec(role);
    if (found) return { kind, label: roleFor(kind).label, matched: found[0] };
  }
  return { kind: "other", label: roleFor("other").label, matched: null };
}

function roleFor(kind: PanelistKind): PanelistRole {
  const role = PANELIST_ROLES.find((entry) => entry.kind === kind);
  if (!role) throw new Error(`no panelist role ${kind}`);
  return role;
}

type PanelistHint = Interviewer & PanelistClassification & { probes: string[]; prepare: string[] };

export function panelHints(interviewers: readonly Interviewer[]): PanelistHint[] {
  return interviewers.map((interviewer) => {
    const classification = classifyPanelist(interviewer.role);
    const role = roleFor(classification.kind);
    return { ...interviewer, ...classification, probes: role.probes, prepare: role.prepare };
  });
}
