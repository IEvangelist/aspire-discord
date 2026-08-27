export type SafetyCategory =
  'allowed' | 'empty' | 'jailbreak' | 'prompt-injection' | 'system-prompt-extraction' | 'too-long';

export interface SafetyVerdict {
  readonly category: SafetyCategory;
  readonly isAllowed: boolean;
  readonly reason?: string;
}

const injectionPatterns = [
  /ignore\s+(?:all\s+|the\s+|any\s+|your\s+)?(?:previous|prior|earlier|above|preceding|system)\s+(?:instruction|instructions|prompt|prompts|message|messages|rule|rules|context|directive|directives)/u,
  /disregard\s+(?:all\s+|the\s+|any\s+|your\s+|everything\s+)?(?:previous|prior|earlier|above|preceding|system|instruction|instructions|prompt|rule|rules)/u,
  /forget\s+(?:all\s+|the\s+|any\s+|your\s+|everything\s+|about\s+)?(?:previous|prior|earlier|above|instruction|instructions|prompt|rule|rules|what)/u,
  /(?:here\s+are|these\s+are|follow\s+these|new)\s+(?:your\s+)?(?:new\s+)?(?:instruction|instructions|rules|directives)/u,
  /(?:override|overrule|bypass|change|update|replace)\s+(?:your\s+|the\s+|all\s+)?(?:rule|rules|instruction|instructions|system\s+prompt|guardrail|guardrails|restriction|restrictions)/u,
  /(?:end\s+of\s+(?:prompt|context|system|instructions))|(?:-{2,}\s*end)|(?:<\/?(?:system|instructions|prompt)>)/u,
];

const jailbreakPatterns = [
  /(?:pretend|act|behave|roleplay|role\s*play)\s+(?:to\s+be|as|like|that\s+you)/u,
  /you\s+are\s+(?:now|no\s+longer|from\s+now|actually|really)\b/u,
  /(?:developer|debug|admin|god|sudo|root|unrestricted)\s+mode/u,
  /\bdan\b|do\s+anything\s+now|stay\s+in\s+character/u,
  /(?:no|without|ignore|remove|drop)\s+(?:restrictions|limits|filters|rules|guardrails|safety|constraints)/u,
  /(?:bypass|circumvent|get\s+around|work\s+around|evade)\s+(?:the\s+|your\s+|all\s+)?(?:filter|filters|safety|guardrail|guardrails|restriction|restrictions|rules)/u,
];

const extractionPatterns = [
  /(?:reveal|show|print|display|output|expose|leak|give\s+me)\s+(?:me\s+)?(?:your\s+(?:system\s+prompt|system\s+message|initial\s+prompt|instructions|prompt|configuration|rules)|(?:the\s+)?(?:system\s+prompt|system\s+message|initial\s+prompt))/u,
  /(?:repeat|echo|say|write\s+out)\s+(?:back\s+)?(?:your\s+|the\s+|everything\s+|all\s+)?(?:system\s+prompt|instructions|prompt|text\s+above|words\s+above)/u,
  /what\s+(?:are|were|is)\s+(?:your|the)\s+(?:system\s+)?(?:instruction|instructions|prompt|rules|guidelines|directives)/u,
];

const answerLeakPatterns = [
  /(?:you are the aspire documentation assistant|security\s*[—\-:]\s*read carefully|answering rules:)/iu,
  /(?:untrusted data|do not treat as instructions|=== (?:begin|end) (?:context|question))/iu,
  /(?:i am now|as (?:a|an) (?:dan|jailbroken)|developer mode (?:enabled|activated)|i will ignore (?:my|all|previous))/iu,
  /(?:my system prompt|my instructions are|the context (?:i was|provided to me))/iu,
];

const fencePattern = /===+\s*(?:BEGIN|END)\s+(?:CONTEXT|QUESTION)[^=]*===+/giu;
const roleMarkerPattern = /^\s*(?:system|assistant|developer)\s*:/gimu;

export function evaluateQuestion(question: string, maxLength: number): SafetyVerdict {
  if (!question.trim()) {
    return { category: 'empty', isAllowed: false, reason: 'Empty question.' };
  }
  if (question.length > maxLength) {
    return {
      category: 'too-long',
      isAllowed: false,
      reason: `Question exceeds ${String(maxLength)} characters.`,
    };
  }

  const normalized = normalizeForSafety(question);
  if (extractionPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      category: 'system-prompt-extraction',
      isAllowed: false,
      reason: 'Matched a system-prompt extraction pattern.',
    };
  }
  if (injectionPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      category: 'prompt-injection',
      isAllowed: false,
      reason: 'Matched a prompt-injection pattern.',
    };
  }
  if (jailbreakPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      category: 'jailbreak',
      isAllowed: false,
      reason: 'Matched a jailbreak pattern.',
    };
  }

  return { category: 'allowed', isAllowed: true };
}

export function isAnswerSafe(answer: string): boolean {
  return Boolean(answer.trim()) && !answerLeakPatterns.some((pattern) => pattern.test(answer));
}

export function sanitizeForAgent(value: string): string {
  return value.replace(fencePattern, ' ').replace(roleMarkerPattern, ' ');
}

function normalizeForSafety(value: string): string {
  return value
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
    .replace(/(?<=\p{L})[-_.\u200b](?=\p{L})/gu, '');
}
