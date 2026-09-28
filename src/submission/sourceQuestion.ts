const SOURCE_QUESTION = /how did you (?:hear|find)|how were you referred|where did you (?:hear|learn)|referral source/;
const SOURCE_LABEL = /^(?:source|application source|recruiting source|job source|candidate source)$/;

export function isRecruitingSourceLabel(normalizedLabel: string): boolean {
  return SOURCE_QUESTION.test(normalizedLabel) || SOURCE_LABEL.test(normalizedLabel);
}

export function sourceAnswerMismatch(fieldLabel: string, answerLabel: string): boolean {
  return isRecruitingSourceLabel(fieldLabel) && !isRecruitingSourceLabel(answerLabel);
}
