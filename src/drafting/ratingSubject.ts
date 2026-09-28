function ratingSubject(text: string): "candidate" | "company" | null {
  if (!/\b(?:rate|rating|rank|ranking|assess)\b/i.test(text)) return null;
  if (/\byourself\b|\byour (?:skills?|proficiency|experience|knowledge|ability)\b/i.test(text)) return "candidate";
  if (/\b(?:company|companies|organization|employer)\b/i.test(text)) return "company";
  return null;
}

export function ratingSubjectMismatch(question: string, describedBy: readonly string[]): boolean {
  const asked = ratingSubject(question);
  const answered = ratingSubject(describedBy.join(" "));
  return asked !== null && answered !== null && asked !== answered;
}
