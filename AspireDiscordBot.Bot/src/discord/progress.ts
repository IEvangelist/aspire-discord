import type { Logger } from 'pino';
import type { AnswerProgress, AnswerProgressPhase } from '../domain.js';

const defaultRefreshMilliseconds = 8_000;
const defaultMinimumUpdateMilliseconds = 2_000;

const phaseMessages: Readonly<Record<AnswerProgressPhase, readonly string[]>> = {
  reading: ['🔎 Reading the question...', '🧩 Picking out the important details...'],
  'checking-links': [
    '🔗 Opening the shared context safely...',
    '🕵️ Checking the linked details...',
  ],
  'searching-docs': [
    '📚 Checking the current Aspire docs...',
    '🔍 Looking through current Aspire guidance...',
  ],
  researching: [
    '🧭 Cross-checking the evidence...',
    '🛠️ Verifying details against current source...',
  ],
  writing: ['✍️ Writing the answer...', '🧵 Pulling the findings together...'],
};

interface ProgressControllerOptions {
  readonly logger: Logger;
  readonly minimumUpdateMilliseconds?: number;
  readonly refreshMilliseconds?: number;
  readonly seed: string;
  readonly sendTyping?: () => Promise<unknown>;
  readonly update: (content: string) => Promise<unknown>;
}

export class DiscordProgressController {
  #current: AnswerProgressPhase = 'reading';
  #pending = Promise.resolve();
  #phaseTimer: NodeJS.Timeout | undefined;
  #lastPublishedAt = 0;
  #rotation = 0;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;

  public constructor(private readonly options: ProgressControllerOptions) {}

  public async start(alreadyVisible = false): Promise<void> {
    if (this.#timer || this.#stopped) {
      return;
    }
    await this.#queue(async () => {
      if (!alreadyVisible) {
        await this.options.update(progressMessage(this.#current, this.options.seed));
      }
      this.#lastPublishedAt = Date.now();
      await this.options.sendTyping?.();
    });
    this.#timer = setInterval(() => {
      void this.#refresh();
    }, this.options.refreshMilliseconds ?? defaultRefreshMilliseconds);
    this.#timer.unref();
  }

  public async report(progress: AnswerProgress): Promise<void> {
    if (this.#stopped || progress.phase === this.#current) {
      return;
    }
    this.#current = progress.phase;
    this.#rotation = 0;
    const minimum = this.options.minimumUpdateMilliseconds ?? defaultMinimumUpdateMilliseconds;
    const delay = Math.max(0, minimum - (Date.now() - this.#lastPublishedAt));
    if (delay === 0) {
      await this.#publishCurrent();
      return;
    }
    if (!this.#phaseTimer) {
      this.#phaseTimer = setTimeout(() => {
        this.#phaseTimer = undefined;
        void this.#publishCurrent();
      }, delay);
      this.#phaseTimer.unref();
    }
  }

  public async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#phaseTimer) {
      clearTimeout(this.#phaseTimer);
      this.#phaseTimer = undefined;
    }
    await this.#pending;
  }

  async #refresh(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    const minimum = this.options.minimumUpdateMilliseconds ?? defaultMinimumUpdateMilliseconds;
    if (Date.now() - this.#lastPublishedAt < minimum) {
      return;
    }
    if (this.#phaseTimer) {
      clearTimeout(this.#phaseTimer);
      this.#phaseTimer = undefined;
    }
    this.#rotation++;
    const phase = this.#current;
    const content = progressMessage(phase, this.options.seed, this.#rotation);
    await this.#queue(async () => {
      await this.options.update(content);
      this.#lastPublishedAt = Date.now();
      await this.options.sendTyping?.();
    });
  }

  async #publishCurrent(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    const content = progressMessage(this.#current, this.options.seed);
    await this.#queue(async () => {
      await this.options.update(content);
      this.#lastPublishedAt = Date.now();
      await this.options.sendTyping?.();
    });
  }

  async #queue(action: () => Promise<void>): Promise<void> {
    this.#pending = this.#pending.then(action, action).catch((error: unknown) => {
      this.options.logger.debug(
        {
          errorType: error instanceof Error ? error.name : 'Error',
          phase: this.#current,
        },
        'Could not update Discord progress.',
      );
    });
    await this.#pending;
  }
}

export function progressMessage(phase: AnswerProgressPhase, seed: string, rotation = 0): string {
  const messages = phaseMessages[phase];
  const index = (stableHash(seed) + rotation) % messages.length;
  return `${messages[index]}\n-# I will keep this updated while I work.`;
}

function stableHash(value: string): number {
  let hash = 0;
  for (const character of value) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash;
}
