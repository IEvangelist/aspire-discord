const threadReferencePattern =
  /\b(?:op|ops|op's|original\s+poster|this\s+(?:post|thread|question)|(?:question|post|thread)\s+above|above|answer\s+(?:the|this|their|his|her|it)\b|help\s+(?:me\s+)?(?:answer|out)|their\s+question)\b/iu;

export function referencesThread(value: string | undefined): boolean {
  return Boolean(value?.trim() && threadReferencePattern.test(value));
}

export function resolveQuestion(
  typedQuestion: string | undefined,
  originalPost: string | undefined,
): string | undefined {
  const typed = typedQuestion?.trim() ?? '';
  if (!typed || referencesThread(typed)) {
    const original = originalPost?.trim();
    return original ? original : undefined;
  }
  return typed;
}
