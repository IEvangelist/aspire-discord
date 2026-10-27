import { describe, expect, it } from 'vitest';
import {
  isThreadOnlyReference,
  needsConversationReferent,
  referencesThread,
} from '../../src/discord/context-reference.js';
import { isUserAllowed } from '../../src/discord/authorizer.js';

describe('Discord context references', () => {
  it('recognizes a request that relies entirely on surrounding context', () => {
    expect(referencesThread("Please answer the OP's question above")).toBe(true);
    expect(isThreadOnlyReference('answer the OP above')).toBe(true);
    expect(isThreadOnlyReference('answer the message above')).toBe(true);
  });

  it('distinguishes a substantive follow-up that references context', () => {
    expect(isThreadOnlyReference('Why does the answer above fail on Azure?')).toBe(false);
  });

  it.each([
    ['can you help', true],
    ['this', true],
    ['yeah', true],
    ['look at this', true],
    ['why is this failing?', true],
    ['answer the OP above', true],
    ['can you help with Azure Container Apps probes?', false],
    ['create an issue about this', false],
    ['What changed in Aspire 13.6?', false],
  ] as const)('identifies whether "%s" needs a topic from context', (text, expected) => {
    expect(needsConversationReferent(text)).toBe(expected);
  });

  it('allows everyone when the allow list is empty', () => {
    expect(isUserAllowed('1', new Set())).toBe(true);
    expect(isUserAllowed('1', new Set(['2']))).toBe(false);
    expect(isUserAllowed('2', new Set(['2']))).toBe(true);
  });
});
