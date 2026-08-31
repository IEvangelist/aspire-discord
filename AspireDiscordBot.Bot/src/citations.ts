import type { Citation, VectorSearchResult } from './domain.js';
import { sanitizeForAgent } from './safety.js';

export class CitationRegistry {
  readonly #byUrl = new Map<string, Citation>();
  readonly #ordered: Citation[] = [];

  public get all(): readonly Citation[] {
    return [...this.#ordered];
  }

  public register(title: string, url: string, repo: string): number {
    const key = url.toLocaleLowerCase('en-US');
    const existing = this.#byUrl.get(key);
    if (existing) {
      return existing.number;
    }

    const citation: Citation = {
      number: this.#ordered.length + 1,
      repo,
      title,
      url,
    };
    this.#byUrl.set(key, citation);
    this.#ordered.push(citation);
    return citation.number;
  }

  public formatResults(
    results: readonly VectorSearchResult[],
    maxCharactersPerResult = 1_200,
  ): string {
    if (results.length === 0) {
      return 'No matching documentation was found for that query.';
    }

    return results
      .map((result) => {
        const number = this.register(result.title, result.url, result.repo);
        const heading = result.heading ? ` - ${sanitizeForAgent(result.heading)}` : '';
        const content =
          result.content.length > maxCharactersPerResult
            ? `${result.content.slice(0, maxCharactersPerResult)}…`
            : result.content;
        return `[${String(number)}] ${sanitizeForAgent(result.title)}${heading} (${result.url})\n${sanitizeForAgent(content)}`;
      })
      .join('\n\n');
  }

  public formatEntry(
    title: string,
    url: string,
    repo: string,
    content: string,
    maxCharacters = 1_200,
  ): string {
    const number = this.register(title, url, repo);
    const body = content.length > maxCharacters ? `${content.slice(0, maxCharacters)}…` : content;
    return `[${String(number)}] ${sanitizeForAgent(title)} (${url})\n${sanitizeForAgent(body)}`;
  }

  public citedBy(answer: string, fallbackToAll = true): readonly Citation[] {
    const selected: Citation[] = [];
    const seen = new Set<number>();
    for (const match of answer.matchAll(/\[(\d+)\]/gu)) {
      const number = Number(match[1]);
      if (!Number.isSafeInteger(number) || number < 1 || seen.has(number)) {
        continue;
      }
      const citation = this.#ordered[number - 1];
      if (citation) {
        seen.add(number);
        selected.push(citation);
      }
    }
    return selected.length > 0 || !fallbackToAll ? selected : [...this.#ordered];
  }
}
