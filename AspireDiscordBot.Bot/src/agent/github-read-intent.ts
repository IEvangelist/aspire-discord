import { isIssueRequest } from '../issues/drafting.js';
import type { ActivityRequest } from './github-activity.js';

export type GitHubReadIntent =
  | { readonly kind: 'report'; readonly request: ActivityRequest; readonly defaultWindow: boolean }
  | { readonly kind: 'research' }
  | { readonly kind: 'clarify'; readonly message: string };

const day = 86_400_000;
const subject =
  /\b(?:github|gh|issues?|bugs?|pull requests?|prs?|commits?|releases?|repositories|repos?|activity|contributions?|comments?|reviews?)\b/iu;
const readAction =
  /^(?:please\s+)?(?:look (?:at|up)|show|list|find|search|summari[sz]e|report|review|check|fetch|get|tell me|give me|what|which|who|how many|any|are there|is there|can you|could you|would you|and)\b/iu;
const userPattern = /\b(?:from|by|for|of|user(?:name)?)\s+@?([a-z0-9][a-z0-9_-]{0,80})\b/giu;
const loginPattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/iu;
const reserved = new Set([
  'this',
  'last',
  'the',
  'a',
  'an',
  'me',
  'them',
  'him',
  'her',
  'that',
  'these',
  'those',
  'all',
  'our',
  'both',
  'each',
  'user',
]);
const months = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

export function classifyGitHubRead(
  question: string,
  history = '',
  now: Date = new Date(),
): GitHubReadIntent | undefined {
  const text = question.replace(/<@!?\d+>/gu, '').trim();
  const userActivity =
    /^what has @?([a-z0-9][a-z0-9-]{0,38})\s+(?:done|contributed|been working on)\b/iu.exec(text);
  if (isIssueRequest(text) || (!subject.test(text) && !userActivity) || !readAction.test(text))
    return undefined;
  // Explanations of programming behavior still belong to the documentation workflow.
  if (
    /^(?:how (?!many\b)|why\b)/iu.test(text) ||
    /^(?:what (?:causes?|does|is (?:causing|this|that|the cause))|which (?:setting|configuration|api))\b/iu.test(
      text,
    ) ||
    /^(?:can|could|would) you (?:explain|help|teach)\b/iu.test(text)
  )
    return undefined;
  let explicitRepository = false;
  for (const match of text.matchAll(
    /(?:repo:|https:\/\/github\.com\/|\bin\s+)([a-z0-9_.-]+\/[a-z0-9_.-]+)/giu,
  )) {
    explicitRepository = true;
    if (
      match[1] &&
      !['microsoft/aspire', 'microsoft/aspire.dev'].includes(match[1].toLowerCase())
    ) {
      return clarification(
        'I can read GitHub activity only in microsoft/aspire and microsoft/aspire.dev.',
      );
    }
  }
  if (
    explicitRepository ||
    /\b(?:open|closed|merged|assigned|unassigned|label(?:s)?)\b/iu.test(text)
  ) {
    return { kind: 'research' };
  }
  const category =
    userActivity || /\b(?:activity|contributions?|everything|all (?:their|his|her))\b/iu.test(text)
      ? 'activity'
      : /\b(?:pull requests?|prs?)\b/iu.test(text)
        ? 'pull-requests'
        : /\b(?:issues?|bugs?)\b/iu.test(text)
          ? 'issues'
          : undefined;
  if (!category) return { kind: 'research' };
  if (
    category !== 'activity' &&
    /\b(?:commented|commenter|reviewed|reviewer|involves|participated|closed|merged|assigned|updated|label)\b/iu.test(
      text,
    )
  ) {
    return { kind: 'research' };
  }

  const candidates = usernames(text);
  if (userActivity?.[1]) candidates.push(userActivity[1]);
  const followup = /^(?:what about|and |show (?:their|his|her)|list (?:their|his|her))/iu.test(
    text,
  );
  if (candidates.length === 0 && followup) candidates.push(...usernames(history.slice(-4_000)));
  const unique = [...new Set(candidates.map((name) => name.toLowerCase()))];
  if (unique.length > 1) return clarification('Which single GitHub username should I report on?');
  const username = unique[0];
  if (!username) {
    return /\b(?:activity|contributions?|their|his|her|username|user)\b/iu.test(text)
      ? clarification(
          'Which GitHub username should I look up in microsoft/aspire and microsoft/aspire.dev?',
        )
      : { kind: 'research' };
  }
  if (!loginPattern.test(username) || username.includes('--')) {
    return clarification(
      'Please provide a valid GitHub username (not a display name or email address).',
    );
  }
  const window = dateWindow(text, now);
  if (typeof window === 'string') return clarification(window);
  let effective = window;
  if (!window.explicit && followup) {
    const previous = dateWindow(history.slice(-4_000), now);
    if (typeof previous !== 'string' && previous.explicit) effective = previous;
  }
  return {
    kind: 'report',
    request: { kind: category, username, since: effective.since, until: effective.until },
    defaultWindow: !effective.explicit,
  };
}

function clarification(message: string): GitHubReadIntent {
  return { kind: 'clarify', message };
}

function usernames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(userPattern)) {
    const name = match[1];
    if (
      name &&
      text[match.index + match[0].length] !== '/' &&
      !reserved.has(name.toLowerCase()) &&
      !/^\d{4}(?:-\d{2})?/u.test(name) &&
      !months.includes(name.toLowerCase())
    )
      names.push(name);
  }
  for (const match of text.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9_-]{0,80})\b/giu)) {
    if (match[1]) names.push(match[1]);
  }
  const possessive =
    /\b([a-z0-9][a-z0-9-]{0,38})['’]s\s+(?:github\s+)?(?:issues?|prs?|pull requests?|activity|contributions?)\b/iu.exec(
      text,
    );
  if (possessive?.[1]) names.push(possessive[1]);
  return names;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dateWindow(
  text: string,
  now: Date,
): { since: string; until: string; explicit: boolean } | string {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let start = new Date(today.getTime() - 29 * day);
  let end = today;
  let explicit = true;
  const dates = [...text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/gu)].map((match) => match[1] ?? '');
  if (
    dates.some((value) => {
      const parsed = new Date(`${value}T00:00:00Z`);
      return !Number.isFinite(parsed.getTime()) || iso(parsed) !== value;
    })
  )
    return 'Please use valid calendar dates in YYYY-MM-DD format.';
  const rolling = /\b(?:last|past)\s+(\d{1,4})\s+days?\b/iu.exec(text);
  const namedMonth = new RegExp(`\\b(${months.join('|')})(?:\\s+(\\d{4}))?\\b`, 'iu').exec(text);
  if (
    /\b(?:before|after|until)\b/iu.test(text) ||
    [...text.matchAll(new RegExp(`\\b(?:${months.join('|')})\\b`, 'giu'))].length > 1
  ) {
    return 'Please specify an inclusive date range (YYYY-MM-DD to YYYY-MM-DD) for that time filter.';
  }
  if (dates.length > 2) return 'Please specify one date range for the GitHub report.';
  if (dates.length > 0) {
    start = new Date(`${dates[0]}T00:00:00Z`);
    end = dates[1] ? new Date(`${dates[1]}T00:00:00Z`) : /\bsince\b/iu.test(text) ? today : start;
  } else if (/\bthis month\b/iu.test(text)) {
    start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  } else if (/\blast month\b/iu.test(text)) {
    start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  } else if (/\byesterday\b/iu.test(text)) {
    start = new Date(today.getTime() - day);
    end = start;
  } else if (/\btoday\b/iu.test(text)) {
    start = today;
  } else if (/\b(?:this|last) week\b/iu.test(text)) {
    const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * day);
    start = /\blast week\b/iu.test(text) ? new Date(monday.getTime() - 7 * day) : monday;
    if (/\blast week\b/iu.test(text)) end = new Date(monday.getTime() - day);
  } else if (/\bthis year\b/iu.test(text)) {
    start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  } else if (rolling?.[1]) {
    const count = Number(rolling[1]);
    if (count < 1 || count > 366) return 'Please choose a GitHub activity range of 1 to 366 days.';
    start = new Date(today.getTime() - (count - 1) * day);
  } else if (namedMonth?.[1]) {
    const year = namedMonth[2] ? Number(namedMonth[2]) : today.getUTCFullYear();
    const month = months.indexOf(namedMonth[1].toLowerCase());
    start = new Date(Date.UTC(year, month, 1));
    end = new Date(Math.min(today.getTime(), Date.UTC(year, month + 1, 0)));
  } else if (
    /\b(?:all time|ever|quarter|last year|past year|last \w+|since|between|before|after)\b|\b\d{4}(?:-\d{2})?\b/iu.test(
      text,
    )
  ) {
    return 'Please specify a date range (YYYY-MM-DD to YYYY-MM-DD, up to 366 days) for this GitHub report.';
  } else {
    explicit = false;
  }
  if (explicit && /\bsince\b/iu.test(text) && dates.length <= 1) end = today;
  if (start > end || end > today || end.getTime() - start.getTime() >= 366 * day) {
    return 'Please choose a valid, non-future date range of at most 366 days.';
  }
  return { since: iso(start), until: iso(end), explicit };
}
