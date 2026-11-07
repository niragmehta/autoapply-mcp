import { employerLabel, findCompanyName, labelMatchesKey, type ApplicationIndex } from "./companies.js";
import { knownSender } from "./senders.js";

/**
 * Decides from the envelope alone whether a message could be hiring mail.
 * Nothing else is downloaded, so this is what keeps unrelated mail in the
 * same mailbox unread.
 */

export type EnvelopeView = {
  fromAddress: string;
  fromName: string;
  replyTo: readonly string[];
  subject: string;
};

export type CandidateReason = "recruiting-sender" | "company-domain" | "company-named";

/** Words that make a subject naming an applied company read as hiring mail (a manual forward, say). */
const HIRING_WORDS =
  /\b(?:appl(?:y|ied|ying|ications?)|interview\w*|candida(?:te|cy)|position|role|opportunit\w*|offer|next steps?|recruit\w*|hiring|assessment|update|thank you)\b/i;

export function candidateReason(envelope: EnvelopeView, index: ApplicationIndex): CandidateReason | null {
  const addresses = [envelope.fromAddress, ...envelope.replyTo].filter((address) => address.length > 0);
  if (addresses.some((address) => knownSender(address) !== null)) return "recruiting-sender";
  const labels = addresses.map(employerLabel).filter((label) => label.length > 0);
  if (labels.length > 0) {
    for (const company of index.companies.values()) {
      if (labels.some((label) => [...company.keys].some((key) => labelMatchesKey(label, key)))) return "company-domain";
    }
  }
  const header = `${envelope.fromName}\n${envelope.subject}`;
  if (!HIRING_WORDS.test(header)) return null;
  const lowered = header.toLowerCase();
  for (const company of index.companies.values()) {
    if (findCompanyName(header, company, true, lowered)) return "company-named";
  }
  return null;
}
