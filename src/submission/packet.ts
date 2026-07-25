import type { DraftAnswer } from "../domain/job.js";
import { sha256 } from "../util/hash.js";

/**
 * A submission packet is the exact content that will be sent to an employer.
 * It is hashed so approval binds to specific content: if anything changes after
 * a human approves, the hash no longer matches and submission is refused.
 */

export type SubmissionPacket = {
  applicationId: string;
  jobId: string;
  company: string;
  jobTitle: string;
  applyUrl: string;
  resumeId: string;
  resumePath: string;
  coverLetter: string;
  answers: DraftAnswer[];
};

export function computePacketHash(packet: Omit<SubmissionPacket, "applicationId">): string {
  const canonical = JSON.stringify({
    jobId: packet.jobId,
    applyUrl: packet.applyUrl,
    resumeId: packet.resumeId,
    resumePath: packet.resumePath,
    coverLetter: packet.coverLetter.trim(),
    answers: [...packet.answers]
      .map((answer) => ({ key: answer.questionKey, value: answer.answer.trim() }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  });
  return sha256(canonical);
}

/** Human-readable preview of exactly what will be submitted. */
export function renderPacketPreview(packet: SubmissionPacket): string {
  const lines = [
    `Company:   ${packet.company}`,
    `Role:      ${packet.jobTitle}`,
    `Apply URL: ${packet.applyUrl}`,
    `Resume:    ${packet.resumeId} (${packet.resumePath})`,
    "",
    "Answers to be submitted:",
  ];
  for (const answer of packet.answers) {
    const flag = answer.requiresHuman ? " [NEEDS HUMAN]" : "";
    const value = answer.answer.trim().length > 0 ? answer.answer : "(empty)";
    lines.push(`  - ${answer.label}${flag}`);
    lines.push(`      ${value.replace(/\n/g, "\n      ")}`);
    lines.push(`      source: ${answer.source}${answer.citation ? ` (${answer.citation})` : ""}`);
  }
  if (packet.coverLetter.trim().length > 0) {
    lines.push("", "Cover letter:", packet.coverLetter);
  }
  return lines.join("\n");
}
