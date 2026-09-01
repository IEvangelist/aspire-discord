const threadReferencePattern =
  /\b(?:op|ops|op's|original\s+poster|this\s+(?:post|thread|question)|(?:question|post|thread|message|reply)\s+above|(?:replied-to|selected|forwarded)\s+message|above|answer\s+(?:the|this|their|his|her|it)\b|help\s+(?:me\s+)?(?:answer|out)|their\s+question)\b/iu;
const threadReferencePhrasePattern =
  /\b(?:op(?:'s|s)?|original\s+poster|this\s+(?:post|thread|question)|(?:question|post|thread|message|reply)\s+above)\b/giu;
const threadRequestFillerPattern =
  /\b(?:about|above|again|answer|can|could|follow|for|help|her|his|it|last|latest|me|message|out|please|post|question|reply|respond|the|their|this|thread|to|up|what|will|would|you)\b/giu;

export function referencesThread(value: string | undefined): boolean {
  return Boolean(value?.trim() && threadReferencePattern.test(value));
}

export function isThreadOnlyReference(value: string | undefined): boolean {
  if (!referencesThread(value)) {
    return false;
  }
  const remainder = value
    ?.replace(threadReferencePhrasePattern, ' ')
    .replace(threadRequestFillerPattern, ' ')
    .replace(/[^\p{L}\p{N}+#.]+/gu, '');
  return !remainder;
}

export function resolveQuestion(
  typedQuestion: string | undefined,
  ...fallbackQuestions: readonly (string | undefined)[]
): string | undefined {
  const typed = typedQuestion?.trim() ?? '';
  if (typed && !isThreadOnlyReference(typed)) {
    return typed;
  }
  for (const fallback of fallbackQuestions) {
    const question = fallback?.trim();
    if (question) {
      return question;
    }
  }
  return undefined;
}
