import { describe, expect, it } from 'vitest';
import {
  isThreadOnlyReference,
  referencesThread,
  resolveQuestion,
} from '../../src/discord/ask-resolver.js';
import { isUserAllowed } from '../../src/discord/authorizer.js';

describe('Discord question policy', () => {
  it('prefers a substantive typed question', () => {
    expect(resolveQuestion('How do I add Redis?', 'OP question')).toBe('How do I add Redis?');
  });

  it('resolves a thread-only request to the latest user turn', () => {
    expect(referencesThread("Please answer the OP's question above")).toBe(true);
    expect(isThreadOnlyReference('answer the OP above')).toBe(true);
    expect(resolveQuestion('answer the OP above', 'Why does deployment still fail?')).toBe(
      'Why does deployment still fail?',
    );
  });

  it('preserves a substantive follow-up that references thread history', () => {
    expect(isThreadOnlyReference('Why does the answer above fail on Azure?')).toBe(false);
    expect(resolveQuestion('Why does the answer above fail on Azure?', 'How do I deploy?')).toBe(
      'Why does the answer above fail on Azure?',
    );
  });

  it('allows everyone when the allow list is empty', () => {
    expect(isUserAllowed('1', new Set())).toBe(true);
    expect(isUserAllowed('1', new Set(['2']))).toBe(false);
    expect(isUserAllowed('2', new Set(['2']))).toBe(true);
  });
});
