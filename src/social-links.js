const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
const TELEGRAM_HOSTS = new Set(['t.me', 'telegram.me', 'www.t.me', 'www.telegram.me']);

export function buildSocialFields({ coinDetail, metadata, mint }) {
  const allLinks = uniqueLinks([
    ...extractUrlsFromObject(coinDetail),
    ...extractUrlsFromObject(metadata)
  ]);
  const descriptionLinks = uniqueLinks([
    ...extractUrls(firstText(valueByPath(coinDetail, 'description'), valueByPath(metadata, 'description')) ?? '')
  ]);
  const websiteCandidates = [
    valueByPath(coinDetail, 'website'),
    valueByPath(metadata, 'website'),
    valueByPath(metadata, 'external_url'),
    valueByPath(metadata, 'externalUrl'),
    valueByPath(metadata, 'extensions.website'),
    valueByPath(metadata, 'links.website')
  ];

  const website = firstWebsiteText(
    ...websiteCandidates,
    firstWebsiteLink(descriptionLinks)
  );

  const twitter = firstText(
    valueByPath(coinDetail, 'twitter'),
    valueByPath(coinDetail, 'x'),
    valueByPath(metadata, 'twitter'),
    valueByPath(metadata, 'x'),
    valueByPath(metadata, 'twitter_url'),
    valueByPath(metadata, 'twitterUrl'),
    valueByPath(metadata, 'extensions.twitter'),
    valueByPath(metadata, 'extensions.x'),
    valueByPath(metadata, 'links.twitter'),
    valueByPath(metadata, 'links.x'),
    firstLinkFromValues(websiteCandidates, X_HOSTS),
    firstLinkByHost(allLinks, X_HOSTS)
  );

  const telegram = firstText(
    valueByPath(coinDetail, 'telegram'),
    valueByPath(coinDetail, 'tg'),
    valueByPath(metadata, 'telegram'),
    valueByPath(metadata, 'tg'),
    valueByPath(metadata, 'telegram_url'),
    valueByPath(metadata, 'telegramUrl'),
    valueByPath(metadata, 'extensions.telegram'),
    valueByPath(metadata, 'links.telegram'),
    firstLinkFromValues(websiteCandidates, TELEGRAM_HOSTS),
    firstLinkByHost(allLinks, TELEGRAM_HOSTS)
  );

  const selected = new Set([website, twitter, telegram].filter(Boolean));
  return {
    pumpUrl: mint ? `https://pump.fun/coin/${mint}` : null,
    website,
    twitter,
    xProfile: toXProfile(twitter),
    telegram,
    extraLinks: descriptionLinks.filter((link) => !selected.has(link) && isUsefulExtraLink(link)).slice(0, 5)
  };
}

export function firstText(...values) {
  for (const value of values.flat()) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return null;
}

export function toXProfile(url) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    if (!X_HOSTS.has(parsed.hostname.toLowerCase())) {
      return null;
    }

    const [handle] = parsed.pathname.split('/').filter(Boolean);
    if (!handle || ['home', 'i', 'search'].includes(handle.toLowerCase())) {
      return null;
    }

    return `https://x.com/${handle}`;
  } catch {
    return null;
  }
}

function firstWebsiteText(...values) {
  for (const value of values.flat()) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (!trimmed || !isWebsiteValue(trimmed)) {
      continue;
    }

    return trimmed;
  }

  return null;
}

function isWebsiteValue(value) {
  const urls = extractUrls(value);
  if (!urls.length) {
    return true;
  }

  return urls.some((url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return !X_HOSTS.has(host) && !TELEGRAM_HOSTS.has(host) && !host.endsWith('pump.fun') && !isAssetOrMetadataLink(url);
    } catch {
      return false;
    }
  });
}

function extractUrlsFromObject(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string') {
    return extractUrls(value);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractUrlsFromObject(item, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.values(value).flatMap((item) => extractUrlsFromObject(item, depth + 1));
  }

  return [];
}

function extractUrls(text) {
  return Array.from(String(text).matchAll(/https?:\/\/[^\s"'<>),]+/gi), (match) =>
    normalizeUrl(match[0])
  ).filter(Boolean);
}

function normalizeUrl(url) {
  return url.replace(/[.,;:!?]+$/g, '');
}

function firstLinkByHost(links, hosts) {
  return links.find((link) => {
    try {
      return hosts.has(new URL(link).hostname.toLowerCase());
    } catch {
      return false;
    }
  }) ?? null;
}

function firstLinkFromValues(values, hosts) {
  return firstLinkByHost(values.flatMap((value) => (typeof value === 'string' ? extractUrls(value) : [])), hosts);
}

function firstWebsiteLink(links) {
  return links.find((link) => {
    try {
      const parsed = new URL(link);
      const host = parsed.hostname.toLowerCase();
      return (
        !X_HOSTS.has(host) &&
        !TELEGRAM_HOSTS.has(host) &&
        !isAssetOrMetadataLink(link) &&
        !host.endsWith('pump.fun')
      );
    } catch {
      return false;
    }
  }) ?? null;
}

function isUsefulExtraLink(link) {
  try {
    const parsed = new URL(link);
    const host = parsed.hostname.toLowerCase();
    return !isAssetOrMetadataLink(link) && !host.endsWith('pump.fun');
  } catch {
    return false;
  }
}

function isAssetOrMetadataLink(link) {
  const lower = link.toLowerCase();
  try {
    const host = new URL(link).hostname.toLowerCase();
    return (
      host.includes('ipfs') ||
      host.includes('axiom') ||
      host.includes('metadata') ||
      lower.match(/\.(png|jpe?g|webp|gif|svg|json)(\?|$)/i)
    );
  } catch {
    return true;
  }
}

function uniqueLinks(links) {
  return [...new Set(links.filter(Boolean))];
}

function valueByPath(object, path) {
  return path.split('.').reduce((value, key) => {
    if (value && typeof value === 'object') {
      return value[key];
    }

    return undefined;
  }, object);
}
