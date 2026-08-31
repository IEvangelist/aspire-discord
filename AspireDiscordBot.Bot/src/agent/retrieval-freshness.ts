import type { VectorSearchResult } from '../domain.js';

const versionedWhatsNewPattern =
  /(?:^|\/)whats-new\/aspire-(?<major>\d+)(?:-(?<minor>\d+))?(?:[./]|$)/iu;

interface AspireVersion {
  readonly major: number;
  readonly minor?: number;
}

export function prioritizeCurrentDocumentation(
  results: readonly VectorSearchResult[],
  query: string,
  limit: number,
): readonly VectorSearchResult[] {
  const requested = isLatestAspireReleaseQuestion(query)
    ? undefined
    : requestedAspireVersion(query);

  return results
    .filter((result) => {
      const historical = versionFromResult(result);
      if (!historical) {
        return true;
      }
      return requested ? versionsMatch(requested, historical) : false;
    })
    .slice(0, limit);
}

export function isLatestAspireReleaseQuestion(question: string): boolean {
  const normalized = question.toLocaleLowerCase('en-US');
  const explicitlyAsksForCurrency = /\b(?:current|latest|newest|most recent)\b/u.test(normalized);
  const asksWhatsNew = /\bwhat(?:'s| is) new\b/u.test(normalized);
  if (requestedAspireVersion(question)) {
    return explicitlyAsksForCurrency;
  }
  return (
    (explicitlyAsksForCurrency || asksWhatsNew) &&
    /\b(?:aspire|release|version|available|stable)\b/u.test(normalized)
  );
}

export function isVersionedWhatsNewPath(path: string): boolean {
  return versionedWhatsNewPattern.test(path.replaceAll('\\', '/'));
}

function versionFromResult(result: VectorSearchResult): AspireVersion | undefined {
  let urlPath = '';
  try {
    urlPath = new URL(result.url).pathname;
  } catch {
    // Retrieval payload validation normally prevents malformed URLs.
  }
  for (const value of [result.path, urlPath]) {
    const match = versionedWhatsNewPattern.exec(value.replaceAll('\\', '/'));
    const major = Number(match?.groups?.major);
    const minorText = match?.groups?.minor;
    if (Number.isSafeInteger(major) && major > 0) {
      return {
        major,
        ...(minorText === undefined ? {} : { minor: Number(minorText) }),
      };
    }
  }
  return undefined;
}

function requestedAspireVersion(question: string): AspireVersion | undefined {
  const normalized = question.toLocaleLowerCase('en-US');
  const patterns = [
    /\baspire\s+(?:version\s+)?v?(?<major>\d+)(?:[.-](?<minor>\d+))?(?:[.-]\d+)?\b/u,
    /\bversion\s+v?(?<major>\d+)(?:[.-](?<minor>\d+))?(?:[.-]\d+)?\s+(?:of\s+)?aspire\b/u,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    const major = Number(match?.groups?.major);
    const minorText = match?.groups?.minor;
    if (Number.isSafeInteger(major) && major > 0) {
      return {
        major,
        ...(minorText === undefined ? {} : { minor: Number(minorText) }),
      };
    }
  }
  return undefined;
}

function versionsMatch(requested: AspireVersion, result: AspireVersion): boolean {
  return (
    requested.major === result.major &&
    (requested.minor === undefined ||
      result.minor === undefined ||
      requested.minor === result.minor)
  );
}
