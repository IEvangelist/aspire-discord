import { describe, expect, it } from 'vitest';
import { ConversationState } from '../../src/discord/conversation-state.js';
import type { GroundedAnswer } from '../../src/domain.js';

const actor = { userId: '123', guildId: '789', channelId: '456' };
const clarification: GroundedAnswer = {
  answer: 'Which repository?',
  citations: [],
  isGrounded: false,
  topScore: 0,
  source: 'conversation',
  requiresReply: true,
  pendingIssue: { title: 'Testing', body: '1.2.3' },
};
describe('requester conversation continuity', () => {
  it('keeps explicit fields and request context for the same requester/channel/server only', () => {
    const state = new ConversationState();
    state.remember(actor, 'Create an issue. Subject Testing and desc 1.2.3', clarification);
    expect(state.get(actor)).toMatchObject({
      requiresReply: true,
      pendingIssue: { title: 'Testing', body: '1.2.3' },
    });
    expect(state.get(actor)?.history).toContain('Subject Testing and desc 1.2.3');
    for (const other of [
      { ...actor, userId: 'other' },
      { ...actor, channelId: 'other' },
      { ...actor, guildId: 'other' },
      { ...actor, guildId: null },
    ])
      expect(state.get(other)).toBeUndefined();
  });
  it('bounds lifetime, entries and context without retaining tokens', () => {
    let now = 0;
    const state = new ConversationState(() => now, 100, 2);
    state.remember(actor, 'password=not-for-retention', clarification);
    expect(state.get(actor)?.history).not.toContain('not-for-retention');
    state.remember({ ...actor, userId: 'two' }, 'x'.repeat(12_000), clarification);
    expect(state.get({ ...actor, userId: 'two' })?.history.length).toBeLessThanOrEqual(8_000);
    state.remember({ ...actor, userId: 'three' }, 'x', clarification);
    expect(state.get(actor)).toBeUndefined();
    now = 101;
    expect(state.get({ ...actor, userId: 'three' })).toBeUndefined();
  });
  it('clears pending fields and passive follow-up capture after completion or a topic change', () => {
    const state = new ConversationState();
    state.remember(actor, 'Create an issue', clarification);
    state.remember(actor, 'aspire.dev', {
      answer: 'The preview is ready.',
      citations: [],
      isGrounded: false,
      topScore: 0,
    });
    expect(state.get(actor)).toMatchObject({ requiresReply: false });
    expect(state.get(actor)?.pendingIssue).toBeUndefined();
    state.clear(actor);
    expect(state.get(actor)).toBeUndefined();
  });
});
