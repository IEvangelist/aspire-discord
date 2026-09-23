import type { TokenCredential } from '@azure/core-auth';
import { CryptographyClient } from '@azure/keyvault-keys';
import type { GitHubAppSigner } from './github-app.js';
import { IssuePublishError } from './types.js';

const signingTimeoutMs = 15_000;
const keyIdentifierPattern =
  /^https:\/\/[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]\.vault\.azure\.net\/keys\/[A-Za-z0-9-]{1,127}\/[A-Fa-f0-9]{32}$/u;

export function validateGitHubSigningKeyId(value: string): string {
  try {
    if (value.trim() !== value || !keyIdentifierPattern.test(value)) {
      throw new Error('Invalid key identifier.');
    }
    const url = new URL(value);
    if (url.hostname.split('.')[0]?.includes('--')) {
      throw new Error('Invalid vault name.');
    }
    return url.href;
  } catch {
    throw new IssuePublishError('Invalid GitHub App signing key identifier.', false);
  }
}

export class KeyVaultGitHubAppSigner implements GitHubAppSigner {
  readonly #keyId: string;
  readonly #client: Pick<CryptographyClient, 'signData'>;

  public constructor(
    keyId: string,
    credential: TokenCredential,
    cryptoClient?: Pick<CryptographyClient, 'signData'>,
  ) {
    this.#keyId = validateGitHubSigningKeyId(keyId);
    try {
      const url = new URL(this.#keyId);
      const [, , name, version] = url.pathname.split('/');
      if (!name || !version) {
        throw new Error('Invalid key identifier.');
      }
      // An identifier string triggers an SDK keys/get; a material-free descriptor signs remotely only.
      this.#client =
        cryptoClient ??
        new CryptographyClient(
          {
            id: this.#keyId,
            name,
            properties: { name, vaultUrl: url.origin, version },
          },
          credential,
          { retryOptions: { maxRetries: 0 }, redirectOptions: { maxRetries: 0 } },
        );
    } catch {
      throw new IssuePublishError('GitHub App signing client initialization failed.', false);
    }
  }

  public async sign(data: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
    if (signal?.aborted) {
      throw new IssuePublishError('GitHub App signing failed.', false);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, signingTimeoutMs);
    timeout.unref();
    const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let abort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => {
          reject(new Error('Signing cancelled.'));
        };
        requestSignal.addEventListener('abort', abort, { once: true });
      });
      const result = await Promise.race([
        this.#client.signData('RS256', data, { abortSignal: requestSignal }),
        cancelled,
      ]);
      if (
        requestSignal.aborted ||
        result.algorithm !== 'RS256' ||
        result.keyID !== this.#keyId ||
        !(result.result instanceof Uint8Array) ||
        result.result.byteLength < 256 ||
        result.result.byteLength > 1024
      ) {
        throw new Error('Invalid signing result.');
      }
      return Uint8Array.from(result.result);
    } catch {
      throw new IssuePublishError('GitHub App signing failed.', false);
    } finally {
      clearTimeout(timeout);
      if (abort) {
        requestSignal.removeEventListener('abort', abort);
      }
    }
  }
}
