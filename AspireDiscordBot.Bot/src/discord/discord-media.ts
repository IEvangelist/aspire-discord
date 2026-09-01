const attachmentHosts = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const attachmentPathPattern = /^\/attachments\/\d+\/\d+\/[^/]+$/u;
const externalProxyHostPattern = /^images-ext-\d+\.discordapp\.net$/u;
const externalProxyPathPattern = /^\/external\/[A-Za-z0-9_-]{20,}\/https?\/[^/]+\/.+$/u;

export function validateDiscordAttachmentUrl(value: string): URL {
  return validateDiscordUrl(value, false);
}

export function validateDiscordImageUrl(value: string): URL {
  return validateDiscordUrl(value, true);
}

function validateDiscordUrl(value: string, allowImageProxy: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The Discord media URL was invalid.');
  }

  const hostname = url.hostname.toLocaleLowerCase('en-US');
  const allowedPath =
    (attachmentHosts.has(hostname) && attachmentPathPattern.test(url.pathname)) ||
    (allowImageProxy &&
      (externalProxyHostPattern.test(hostname) || hostname === 'media.discordapp.net') &&
      externalProxyPathPattern.test(url.pathname));
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.href.length > 2_048 ||
    !allowedPath
  ) {
    throw new Error('The media was not hosted by Discord or its approved image proxy.');
  }
  return url;
}
