// Runs inside the staged bot without a Discord token or any write-capable tool.
(async () => {
  const { resolveModalities } = await import('./dist/src/discord/modality-resolver.js');
  const reference = 'How do I keep custom Container Apps health probes across Aspire deployments?';
  const thread = { context: `[Original poster]\n${reference}`, starterQuestion: reference, status: 'found' };
  const reply = {
    context: `[Replied-to user message]\n${reference}`,
    files: [], images: [], notices: [], question: reference, status: 'found',
  };
  for (const input of [
    { typed: 'can you help', thread },
    { typed: 'this', reply, thread: { status: 'not-a-thread' } },
  ]) {
    const resolved = resolveModalities(input);
    if (resolved.question !== 'Please answer the referenced Aspire question.' ||
        resolved.displayQuestion !== reference || resolved.referencedQuestion !== reference ||
        resolved.allowIssueDraft !== false) {
      throw new Error('Context resolution did not match the deployed source.');
    }
  }
  console.log('ASPIRE_STAGED_CONTEXT_OK');
})().catch(() => { console.log('ASPIRE_STAGED_CONTEXT_FAILED'); process.exit(1); });
