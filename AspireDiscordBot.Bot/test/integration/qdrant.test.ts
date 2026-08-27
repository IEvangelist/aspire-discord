import { QdrantClient } from '@qdrant/js-client-rest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QdrantStore } from '../../src/agent/qdrant-store.js';
import { createTestConfig } from '../helpers/config.js';
import { testLogger } from '../helpers/logger.js';

const endpoint = process.env.QDRANT_TEST_URL;
const suite = endpoint ? describe : describe.skip;
const collection = `node_test_${crypto.randomUUID().replaceAll('-', '')}`;

suite('QdrantStore integration', () => {
  const client = new QdrantClient({ checkCompatibility: false, url: endpoint! });

  beforeAll(async () => {
    await client.createCollection(collection, {
      vectors: { distance: 'Cosine', size: 3 },
    });
    await client.upsert(collection, {
      points: [
        {
          id: crypto.randomUUID(),
          payload: {
            content: 'Use AddRedis.',
            heading: 'Redis',
            path: 'redis.md',
            repo: 'microsoft/aspire.dev',
            title: 'Redis',
            url: 'https://aspire.dev/caching/redis/',
          },
          vector: [1, 0, 0],
        },
      ],
      wait: true,
    });
  });

  afterAll(async () => {
    await client.deleteCollection(collection);
  });

  it('queries compatible C# ingestion payloads', async () => {
    const config = createTestConfig({
      qdrant: {
        apiCollection: collection,
        docsCollection: collection,
        url: endpoint!,
      },
    });
    const store = new QdrantStore(config.qdrant, testLogger);

    const results = await store.searchDocs([1, 0, 0], 5);

    expect(results[0]?.title).toBe('Redis');
    expect(await store.isReady()).toBe(true);
  });
});
