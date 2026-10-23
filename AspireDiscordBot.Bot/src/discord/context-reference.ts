const threadReferencePattern =
  /\b(?:op|ops|op's|original\s+poster|this\s+(?:post|thread|question)|(?:question|post|thread|message|reply)\s+above|(?:replied-to|forwarded)\s+message|above|answer\s+(?:the|this|their|his|her|it)\b|help\s+(?:me\s+)?(?:answer|out)|their\s+question)\b/iu;
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

// This only determines whether the message needs a referent. The agent, not this helper,
// chooses whether the current requester wants an answer, a read, or a draft.
export function needsConversationReferent(value: string | undefined): boolean {
  const text = value?.trim() ?? '';
  if (!text) return true;
  if (isThreadOnlyReference(text)) return true;
  const remaining = text
    .replace(
      /\b(?:a|about|above|again|am|answer|at|can|could|do|doesn't|explain|failing|fix|for|help|here|hm|i|is|it|look|me|of|ok|okay|please|question|right|show|sure|that|the|their|there|this|thread|to|understand|what|why|with|would|yeah|yep|you)\b/giu,
      ' ',
    )
    .replace(/[^\p{L}\p{N}+#.]+/gu, '');
  return !remaining;
}
