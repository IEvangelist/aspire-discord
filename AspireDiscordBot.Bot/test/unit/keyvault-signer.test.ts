import { createHash } from 'node:crypto';
import type { TokenCredential } from '@azure/core-auth';
import { createHttpHeaders } from '@azure/core-rest-pipeline';
import type { CryptographyClient, KeyVaultKey, SignResult } from '@azure/keyvault-keys';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KeyVaultGitHubAppSigner,
  validateGitHubSigningKeyId,
} from '../../src/issues/keyvault-signer.js';
import { GitHubAppIssuePublisher } from '../../src/issues/github-app.js';
import { IssuePublishError } from '../../src/issues/types.js';

const { constructorMock, signDataMock } = vi.hoisted(() => ({
  constructorMock: vi.fn(),
  signDataMock: vi.fn<CryptographyClient['signData']>(),
}));

vi.mock('@azure/keyvault-keys', () => ({ CryptographyClient: constructorMock }));

const keyId =
  'https://issue-signing.vault.azure.net/keys/github-app/0123456789abcdef0123456789abcdef';
const signature = new Uint8Array(256).fill(42);
const input = Buffer.from('jwt-header.jwt-payload');
const credential: TokenCredential = {
  getToken: async () => ({ token: 'test-only-token', expiresOnTimestamp: Date.now() + 60_000 }),
};

function result(extra: Partial<SignResult> = {}): SignResult {
  return { algorithm: 'RS256', keyID: keyId, result: signature, ...extra };
}

beforeEach(() => {
  constructorMock.mockImplementation(function () {
    return { signData: signDataMock };
  });
  signDataMock.mockResolvedValue(result());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('validateGitHubSigningKeyId', () => {
  it('accepts a pinned public Azure key version and normalizes the vault hostname', () => {
    expect(validateGitHubSigningKeyId(keyId)).toBe(keyId);
    expect(validateGitHubSigningKeyId(keyId.replace('issue-signing', 'Issue-Signing'))).toBe(keyId);
  });

  it.each([
    keyId.replace('https:', 'http:'),
    keyId.replace('issue-signing.vault.azure.net', 'evil.example'),
    keyId.replace('.vault.azure.net', '.vault.azure.net.evil.example'),
    keyId.replace('.vault.azure.net', '.vault.azure.cn'),
    keyId.replace('.vault.azure.net', '.managedhsm.azure.net'),
    keyId.replace('issue-signing.vault.azure.net', '127.0.0.1'),
    keyId.replace('issue-signing.vault.azure.net', 'localhost'),
    keyId.replace('issue-signing.', 'ab.'),
    keyId.replace('issue-signing.', 'issue--signing.'),
    keyId.replace('https://', 'https://user:password@'),
    keyId.replace('.azure.net/', '.azure.net:443/'),
    keyId.replace('.azure.net/', '.azure.net:444/'),
    keyId.replace('/keys/', '/secrets/'),
    keyId.replace('/keys/', '/keys/../keys/'),
    keyId.replace('/keys/', '/keys\\'),
    keyId.replace('/github-app/', '/github%2Dapp/'),
    keyId.replace('/0123456789abcdef0123456789abcdef', ''),
    keyId.replace('/0123456789abcdef0123456789abcdef', '/latest'),
    keyId.replace('/0123456789abcdef0123456789abcdef', '/0123456789abcdef'),
    keyId.replace('/0123456789abcdef0123456789abcdef', '/g123456789abcdef0123456789abcdef'),
    `${keyId}/`,
    `${keyId}/extra`,
    `${keyId}?api-version=7.4`,
    `${keyId}#fragment`,
    `${keyId}\n`,
    ` ${keyId}`,
    '',
  ])('rejects non-versioned or unsafe key identifiers: %s', (value) => {
    expect(() => validateGitHubSigningKeyId(value)).toThrow(
      new IssuePublishError('Invalid GitHub App signing key identifier.', false),
    );
    expect(() => new KeyVaultGitHubAppSigner(value, credential)).toThrow(
      'Invalid GitHub App signing key identifier.',
    );
    expect(constructorMock).not.toHaveBeenCalled();
  });
});

describe('KeyVaultGitHubAppSigner', () => {
  it('constructs a sign-only remote client with no key material and no retries', async () => {
    const signer = new KeyVaultGitHubAppSigner(keyId, credential);
    expect(constructorMock).toHaveBeenCalledExactlyOnceWith(
      {
        id: keyId,
        name: 'github-app',
        properties: {
          name: 'github-app',
          version: '0123456789abcdef0123456789abcdef',
          vaultUrl: 'https://issue-signing.vault.azure.net',
        },
      },
      credential,
      {
        retryOptions: { maxRetries: 0 },
        redirectOptions: { maxRetries: 0 },
      },
    );
    await expect(signer.sign(input)).resolves.toEqual(signature);
    expect(signDataMock).toHaveBeenCalledExactlyOnceWith('RS256', input, {
      abortSignal: expect.any(AbortSignal),
    });
  });

  it('accepts an injected signData client without creating another SDK client', async () => {
    const client = {
      signData: vi.fn<CryptographyClient['signData']>().mockResolvedValue(result()),
    };
    const signer = new KeyVaultGitHubAppSigner(keyId, credential, client);
    await expect(signer.sign(input)).resolves.toEqual(signature);
    expect(client.signData).toHaveBeenCalledExactlyOnceWith('RS256', input, {
      abortSignal: expect.any(AbortSignal),
    });
    expect(constructorMock).not.toHaveBeenCalled();
  });

  it.each([200, 302, 429, 503])(
    'the installed SDK uses only keys/sign without retries or redirects for HTTP %i',
    async (status) => {
      const { CryptographyClient: RealCryptographyClient } = await vi.importActual<{
        CryptographyClient: typeof CryptographyClient;
      }>('@azure/keyvault-keys');
      new KeyVaultGitHubAppSigner(keyId, credential);
      const descriptor = constructorMock.mock.calls[0]![0] as KeyVaultKey;
      const requests: { method: string; url: string; body: string | undefined }[] = [];
      const cryptoClient = new RealCryptographyClient(descriptor, credential, {
        retryOptions: { maxRetries: 0 },
        redirectOptions: { maxRetries: 0 },
        httpClient: {
          sendRequest: async (request) => {
            requests.push({
              method: request.method,
              url: request.url,
              body: typeof request.body === 'string' ? request.body : undefined,
            });
            if (!request.headers.has('authorization')) {
              return {
                request,
                status: 401,
                headers: createHttpHeaders({
                  'www-authenticate':
                    'Bearer authorization="https://login.windows.net/unit-test-tenant", resource="https://vault.azure.net"',
                }),
              };
            }
            return {
              request,
              status,
              headers: createHttpHeaders({
                'content-type': 'application/json',
                ...(status === 302 ? { location: 'https://evil.example/sign' } : {}),
              }),
              bodyAsText: JSON.stringify(
                status === 200
                  ? { kid: keyId, value: Buffer.from(signature).toString('base64url') }
                  : { error: { code: 'TestFailure', message: 'PRIVATE_SDK_FAILURE' } },
              ),
            };
          },
        },
      });
      const signer = new KeyVaultGitHubAppSigner(keyId, credential, cryptoClient);
      if (status === 200) {
        await expect(signer.sign(input)).resolves.toEqual(signature);
      } else {
        await expect(signer.sign(input)).rejects.toMatchObject({
          outcomeUnknown: false,
          message: 'GitHub App signing failed.',
        });
      }
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.method).toBe('POST');
        const url = new URL(request.url);
        expect(`${url.origin}${url.pathname}`).toBe(`${keyId}/sign`);
      }
      expect(JSON.parse(requests[1]!.body!)).toEqual({
        alg: 'RS256',
        value: createHash('sha256').update(input).digest('base64url'),
      });
    },
  );

  it.each([
    { algorithm: 'RS512' },
    { keyID: keyId.replace('0123456789abcdef0123456789abcdef', 'f'.repeat(32)) },
    { keyID: keyId.replace('/github-app/', '/another-key/') },
    { keyID: keyId.replace('issue-signing.', 'another-vault.') },
    { keyID: keyId.replace('/0123456789abcdef0123456789abcdef', '') },
    { keyID: '' },
    { result: new Uint8Array(0) },
    { result: new Uint8Array(32) },
    { result: new Uint8Array(255) },
    { result: new Uint8Array(1025) },
  ])('rejects unexpected signing result %# without exposing its contents', async (extra) => {
    signDataMock.mockResolvedValueOnce(result(extra));
    const signer = new KeyVaultGitHubAppSigner(keyId, credential);
    await expect(signer.sign(input)).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'GitHub App signing failed.',
    });
    expect(signDataMock).toHaveBeenCalledOnce();
  });

  it('requires the versioned key ID in the SDK signing result', async () => {
    signDataMock.mockResolvedValueOnce({ algorithm: 'RS256', result: signature });
    const signer = new KeyVaultGitHubAppSigner(keyId, credential);
    await expect(signer.sign(input)).rejects.toMatchObject({ outcomeUnknown: false });
  });

  it('stops before any GitHub request if the SDK returns a different signing key version', async () => {
    signDataMock.mockResolvedValueOnce(
      result({ keyID: keyId.replace('0123456789abcdef0123456789abcdef', 'f'.repeat(32)) }),
    );
    const fetchMock = vi.fn<typeof fetch>();
    const publisher = new GitHubAppIssuePublisher(
      { appId: '4968096', signer: new KeyVaultGitHubAppSigner(keyId, credential) },
      fetchMock,
    );
    await expect(publisher.create('dotnet/aspire', 'Title', 'Body')).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'GitHub App authentication failed.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes SDK errors without preserving messages, requests, responses, or causes', async () => {
    signDataMock.mockRejectedValueOnce(
      Object.assign(new Error('PRIVATE_SDK_MESSAGE'), {
        request: { body: 'PRIVATE_SIGNING_JWT' },
        response: { body: 'PRIVATE_KEY_BYTES' },
        cause: new Error('PRIVATE_TOKEN'),
      }),
    );
    const signer = new KeyVaultGitHubAppSigner(keyId, credential);
    const error: unknown = await signer.sign(input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      outcomeUnknown: false,
      message: 'GitHub App signing failed.',
    });
    expect(error).not.toHaveProperty('request');
    expect(error).not.toHaveProperty('response');
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('PRIVATE');
    expect(signDataMock).toHaveBeenCalledOnce();
  });

  it('sanitizes SDK constructor failures', () => {
    constructorMock.mockImplementationOnce(function () {
      throw new Error('PRIVATE_SDK_INITIALIZATION');
    });
    expect(() => new KeyVaultGitHubAppSigner(keyId, credential)).toThrow(
      'GitHub App signing client initialization failed.',
    );
  });

  it('does not invoke signData if the caller is already cancelled', async () => {
    const signer = new KeyVaultGitHubAppSigner(keyId, credential);
    await expect(signer.sign(input, AbortSignal.abort())).rejects.toMatchObject({
      outcomeUnknown: false,
    });
    expect(signDataMock).not.toHaveBeenCalled();
  });

  it('releases a cancelled caller even when the SDK ignores its abort signal', async () => {
    const pending = Promise.withResolvers<SignResult>();
    signDataMock.mockReturnValueOnce(pending.promise);
    const signer = new KeyVaultGitHubAppSigner(keyId, credential);
    const controller = new AbortController();
    const assertion = expect(signer.sign(input, controller.signal)).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'GitHub App signing failed.',
    });
    controller.abort(new Error('PRIVATE_ABORT_REASON'));
    await assertion;
    expect(signDataMock.mock.calls[0]![2]?.abortSignal?.aborted).toBe(true);
    expect(signDataMock).toHaveBeenCalledOnce();
    pending.resolve(result());
  });

  it('times out after fifteen seconds even when the SDK ignores cancellation, without retrying', async () => {
    vi.useFakeTimers();
    signDataMock.mockImplementationOnce(() => new Promise<SignResult>(() => undefined));
    const signer = new KeyVaultGitHubAppSigner(keyId, credential);
    const assertion = expect(signer.sign(input)).rejects.toMatchObject({
      outcomeUnknown: false,
      message: 'GitHub App signing failed.',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(signDataMock.mock.calls[0]![2]?.abortSignal?.aborted).toBe(true);
    expect(signDataMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up its deadline when signing completes successfully', async () => {
    vi.useFakeTimers();
    const signer = new KeyVaultGitHubAppSigner(keyId, credential);
    await expect(signer.sign(input)).resolves.toEqual(signature);
    expect(vi.getTimerCount()).toBe(0);
  });
});
