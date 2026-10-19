const DEFAULT_BASE_URL = 'https://api.twitterapi.io';
const DEFAULT_TIMEOUT_MS = 4500;
const DEFAULT_CACHE_TTL_MS = 0;
const DEFAULT_PROFILE_CACHE_TTL_MS = 60_000;
const DEFAULT_PINNED_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_PINNED_TWEETS = 5;
const MAX_EVIDENCE = 20;

export function createXChecker({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  includeReplies = false,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  profileCacheTtlMs = DEFAULT_PROFILE_CACHE_TTL_MS,
  pinnedCacheTtlMs = DEFAULT_PINNED_CACHE_TTL_MS,
  maxPinnedTweets = DEFAULT_MAX_PINNED_TWEETS,
  fetchImpl = globalThis.fetch
} = {}) {
  const enabled = Boolean(apiKey);
  const snapshotCache = new Map();
  const profileCache = new Map();
  const pinnedCache = new Map();
  const normalizedBaseUrl = trimTrailingSlash(baseUrl || DEFAULT_BASE_URL);

  async function check({ xProfile, xUrl, mint, mode = 'full' }) {
    const startedAtMs = Date.now();
    const handle = extractXHandle(xProfile);
    const linkedTweetIds = extractXTweetIds(xUrl);

    if (!enabled) {
      return {
        enabled: false,
        status: 'x_not_configured',
        handle,
        profileUrl: handle ? `https://x.com/${handle}` : null,
        checkedAt: new Date().toISOString(),
        elapsedMs: 0
      };
    }

    if (mode === 'linked_only') {
      if (!linkedTweetIds.length) {
        return createSkippedXCheck({
          status: 'x_skipped_no_linked_status',
          reason: 'linked_only requested but no direct status tweet id was found',
          xProfile,
          xUrl,
          startedAtMs
        });
      }

      try {
        const linkedTweets = await fetchLinkedTweets(linkedTweetIds);
        const snapshot = {
          ok: true,
          handle,
          requestedHandle: handle,
          profileFetched: false,
          profile: null,
          includeReplies,
          recentTweetsSource: null,
          recentTweetsChecked: 0,
          pinnedTweetsChecked: 0,
          linkedTweetIds,
          linkedTweetsChecked: linkedTweets.checked,
          lastTweetsHasNextPage: false,
          parts: linkedTweets.parts,
          errors: linkedTweets.errors,
          fetchedAt: new Date().toISOString(),
          fetchElapsedMs: Date.now() - startedAtMs
        };
        return buildXCheck({ snapshot, chainMint: mint, startedAtMs, cacheHit: false });
      } catch (error) {
        return errorCheck({
          handle,
          startedAtMs,
          status: 'x_error',
          message: error.message
        });
      }
    }

    if (!handle && linkedTweetIds.length > 0 && typeof fetchImpl === 'function') {
      try {
        const linkedTweets = await fetchLinkedTweets(linkedTweetIds);
        const snapshot = {
          ok: true,
          handle: null,
          requestedHandle: null,
          profileFetched: false,
          profile: null,
          includeReplies,
          recentTweetsChecked: 0,
          pinnedTweetsChecked: 0,
          linkedTweetIds,
          linkedTweetsChecked: linkedTweets.checked,
          lastTweetsHasNextPage: false,
          parts: linkedTweets.parts,
          errors: linkedTweets.errors,
          fetchedAt: new Date().toISOString(),
          fetchElapsedMs: Date.now() - startedAtMs
        };
        return buildXCheck({ snapshot, chainMint: mint, startedAtMs, cacheHit: false });
      } catch (error) {
        return errorCheck({
          handle: null,
          startedAtMs,
          status: 'x_error',
          message: error.message
        });
      }
    }

    if (!handle) {
      return {
        enabled: true,
        status: 'x_no_profile',
        handle: null,
        profileUrl: null,
        checkedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAtMs
      };
    }

    if (typeof fetchImpl !== 'function') {
      return errorCheck({
        handle,
        startedAtMs,
        status: 'x_error',
        message: 'fetch unavailable'
      });
    }

    try {
      const { snapshot, cacheHit } = await getSnapshot(handle);
      const linkedTweets = linkedTweetIds.length ? await fetchLinkedTweets(linkedTweetIds) : null;
      const snapshotWithLinkedTweets = linkedTweets
        ? {
            ...snapshot,
            linkedTweetIds,
            linkedTweetsChecked: linkedTweets.checked,
            parts: [...(snapshot.parts ?? []), ...linkedTweets.parts],
            errors: [...(snapshot.errors ?? []), ...linkedTweets.errors]
          }
        : snapshot;
      return buildXCheck({ snapshot: snapshotWithLinkedTweets, chainMint: mint, startedAtMs, cacheHit });
    } catch (error) {
      return errorCheck({
        handle,
        startedAtMs,
        status: 'x_error',
        message: error.message
      });
    }
  }

  async function getSnapshot(handle) {
    if (cacheTtlMs <= 0) {
      return { snapshot: await fetchSnapshot(handle), cacheHit: false };
    }

    const key = handle.toLowerCase();
    const now = Date.now();
    const cached = snapshotCache.get(key);

    if (cached && now - cached.createdAtMs <= cacheTtlMs) {
      return { snapshot: await cached.promise, cacheHit: true };
    }

    const promise = fetchSnapshot(handle);
    snapshotCache.set(key, { createdAtMs: now, promise });
    promise.catch(() => snapshotCache.delete(key));
    return { snapshot: await promise, cacheHit: false };
  }

  async function fetchSnapshot(handle) {
    const startedAtMs = Date.now();
    const { response: info, cacheHit: profileCacheHit } = await getProfileInfo(handle);
    const user = info.body?.data;

    if (!apiSuccess(info) || !user || (!user.id && !user.userName)) {
      return {
        ok: false,
        handle,
        requestedHandle: handle,
        profileFetched: false,
        apiStatus: info.body?.status ?? null,
        apiMessage: info.body?.msg ?? info.body?.message ?? 'profile unavailable',
        profileCacheHit,
        pinnedCacheHit: false,
        errors: [],
        fetchedAt: new Date().toISOString(),
        fetchElapsedMs: Date.now() - startedAtMs
      };
    }

    const resolvedHandle = user.userName || handle;
    const pinnedTweetIds = firstArray(user.pinnedTweetIds).map(String).filter(Boolean).slice(0, maxPinnedTweets);
    const recentTweetsPromise = fetchRecentTweets({
      userId: user.id,
      handle: resolvedHandle,
      includeReplies
    });
    const pinnedTweetsPromise = getPinnedTweets(pinnedTweetIds);

    const [recentTweetsResult, pinnedTweetsResult] = await Promise.all([recentTweetsPromise, pinnedTweetsPromise]);
    const pinnedTweetsResponse = pinnedTweetsResult.response;
    const recentTweets = recentTweetsResult.tweets;
    const pinnedTweets = apiSuccess(pinnedTweetsResponse)
      ? firstArray(pinnedTweetsResponse.body?.data, pinnedTweetsResponse.body?.tweets, pinnedTweetsResponse.body?.data?.tweets)
      : [];
    const errors = [
      ...recentTweetsResult.errors,
      pinnedTweetsResponse && !apiSuccess(pinnedTweetsResponse) ? responseError('pinned_tweets', pinnedTweetsResponse) : null,
      pinnedTweetIds.length > 0 && pinnedTweets.length < pinnedTweetIds.length
        ? {
            endpoint: 'pinned_tweets',
            httpStatus: pinnedTweetsResponse?.httpStatus ?? null,
            apiStatus: pinnedTweetsResponse?.body?.status ?? null,
            message: `pinnedTweetIds=${pinnedTweetIds.length} returned=${pinnedTweets.length}`
          }
        : null
    ].filter(Boolean);
    const parts = [
      ...collectProfileParts(user),
      ...pinnedTweets.flatMap((tweet) => collectTweetParts(tweet, 'pinned_tweet')),
      ...recentTweets.flatMap((tweet, index) => collectTweetParts(tweet, `recent_tweet[${index}]`))
    ];

    return {
      ok: true,
      handle: resolvedHandle,
      requestedHandle: handle,
      profileFetched: true,
      profileCacheHit,
      pinnedCacheHit: pinnedTweetsResult.cacheHit,
      profile: {
        id: user.id ?? null,
        userName: resolvedHandle,
        name: user.name ?? null,
        description: firstString(user.profile_bio?.description, user.description),
        url: user.url ?? null,
        followers: numberOrNull(user.followers),
        createdAt: user.createdAt ?? null,
        isBlueVerified: Boolean(user.isBlueVerified),
        verifiedType: user.verifiedType ?? null,
        pinnedTweetIds,
        urlCount: countProfileUrls(user)
      },
      includeReplies,
      recentTweetsSource: recentTweetsResult.source,
      recentTweetsChecked: recentTweets.length,
      pinnedTweetsChecked: pinnedTweets.length,
      lastTweetsHasNextPage: recentTweetsResult.hasNextPage,
      errors,
      parts,
      fetchedAt: new Date().toISOString(),
      fetchElapsedMs: Date.now() - startedAtMs
    };
  }

  async function getProfileInfo(handle) {
    const cacheKey = handle.toLowerCase();
    return getCachedApiResponse({
      cache: profileCache,
      cacheKey,
      ttlMs: profileCacheTtlMs,
      fetcher: () => apiGet(`/twitter/user/info?userName=${encodeURIComponent(handle)}`),
      shouldCache: (response) => {
        const user = response.body?.data;
        return apiSuccess(response) && Boolean(user && (user.id || user.userName));
      }
    });
  }

  async function getPinnedTweets(pinnedTweetIds) {
    if (!pinnedTweetIds.length) {
      return { response: null, cacheHit: false };
    }

    const ids = pinnedTweetIds.join(',');
    return getCachedApiResponse({
      cache: pinnedCache,
      cacheKey: ids,
      ttlMs: pinnedCacheTtlMs,
      fetcher: () => safeApiGet(`/twitter/tweets?tweet_ids=${encodeURIComponent(ids)}`),
      shouldCache: apiSuccess
    });
  }

  async function getCachedApiResponse({ cache, cacheKey, ttlMs, fetcher, shouldCache }) {
    if (ttlMs <= 0) {
      return { response: await fetcher(), cacheHit: false };
    }

    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && now - cached.createdAtMs <= ttlMs) {
      return { response: await cached.promise, cacheHit: true };
    }

    const promise = fetcher();
    cache.set(cacheKey, { createdAtMs: now, promise });

    try {
      const response = await promise;
      if (!shouldCache(response)) {
        cache.delete(cacheKey);
      }
      return { response, cacheHit: false };
    } catch (error) {
      cache.delete(cacheKey);
      throw error;
    }
  }

  async function fetchLinkedTweets(tweetIds) {
    const response = await safeApiGet(`/twitter/tweets?tweet_ids=${encodeURIComponent(tweetIds.slice(0, 5).join(','))}`);
    const tweets = apiSuccess(response)
      ? firstArray(response.body?.data, response.body?.tweets, response.body?.data?.tweets)
      : [];

    return {
      checked: tweets.length,
      parts: tweets.flatMap((tweet) => collectTweetParts(tweet, 'linked_tweet')),
      errors: apiSuccess(response) ? [] : [responseError('linked_tweets', response)]
    };
  }

  async function fetchRecentTweets({ userId, handle, includeReplies: withReplies }) {
    const errors = [];

    if (userId) {
      const timelineResponse = await safeApiGet(
        `/twitter/user/tweet_timeline?userId=${encodeURIComponent(userId)}&includeReplies=${withReplies ? 'true' : 'false'}`
      );

      if (apiSuccess(timelineResponse)) {
        const tweets = firstArray(timelineResponse.body?.data?.tweets, timelineResponse.body?.tweets, timelineResponse.body?.data);
        if (tweets.length > 0) {
          return {
            source: 'tweet_timeline',
            tweets,
            hasNextPage: Boolean(timelineResponse.body?.has_next_page),
            errors
          };
        }
      } else {
        errors.push(responseError('tweet_timeline', timelineResponse));
      }
    }

    const key = userId ? `userId=${encodeURIComponent(userId)}` : `userName=${encodeURIComponent(handle)}`;
    const lastTweetsResponse = await safeApiGet(
      `/twitter/user/last_tweets?${key}&includeReplies=${withReplies ? 'true' : 'false'}`
    );

    if (!apiSuccess(lastTweetsResponse)) {
      errors.push(responseError('last_tweets', lastTweetsResponse));
      return {
        source: userId ? 'tweet_timeline_empty_last_tweets_failed' : 'last_tweets_failed',
        tweets: [],
        hasNextPage: false,
        errors
      };
    }

    return {
      source: userId ? 'tweet_timeline_empty_last_tweets' : 'last_tweets',
      tweets: firstArray(lastTweetsResponse.body?.data?.tweets, lastTweetsResponse.body?.tweets),
      hasNextPage: Boolean(lastTweetsResponse.body?.has_next_page),
      errors
    };
  }

  async function safeApiGet(path) {
    try {
      return await apiGet(path);
    } catch (error) {
      return { ok: false, httpStatus: null, body: null, elapsedMs: null, error: error.message };
    }
  }

  async function apiGet(path) {
    const startedAtMs = Date.now();
    const response = await fetchImpl(`${normalizedBaseUrl}${path}`, {
      headers: {
        accept: 'application/json',
        'user-agent': 'pump-fun-game-discovery/0.1',
        'x-api-key': apiKey
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let body;

    try {
      body = text.trim() ? JSON.parse(text) : null;
    } catch (error) {
      throw new Error(`invalid JSON from twitterapi.io: ${error.message}`);
    }

    return {
      ok: response.ok,
      httpStatus: response.status,
      body,
      elapsedMs: Date.now() - startedAtMs
    };
  }

  return { enabled, check };
}

export function createSkippedXCheck({
  status = 'x_skipped_low_signal',
  reason = null,
  xProfile = null,
  xUrl = null,
  startedAtMs = Date.now()
} = {}) {
  const handle = extractXHandle(xProfile);
  return {
    enabled: true,
    status,
    reason,
    handle,
    profileUrl: handle ? `https://x.com/${handle}` : null,
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    profileFetched: false,
    linkedTweetIds: extractXTweetIds(xUrl),
    linkedTweetsChecked: 0,
    mentionedMints: [],
    mentionsCurrentMint: false,
    otherMints: [],
    evidence: []
  };
}

export function extractXHandle(value) {
  if (!value) {
    return null;
  }

  const raw = String(value).trim();
  const direct = raw.match(/^@?([A-Za-z0-9_]{1,15})$/);
  if (direct) {
    return direct[1];
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) {
      return null;
    }

    const [handle] = parsed.pathname.split('/').filter(Boolean);
    if (!handle || ['home', 'i', 'search', 'intent', 'share'].includes(handle.toLowerCase())) {
      return null;
    }

    return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle : null;
  } catch {
    return null;
  }
}

export function extractXTweetIds(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = new URL(String(value).trim());
    const host = parsed.hostname.toLowerCase();
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(host)) {
      return [];
    }

    const segments = parsed.pathname.split('/').filter(Boolean);
    const ids = [];
    for (let index = 0; index < segments.length; index += 1) {
      if (['status', 'statuses'].includes(segments[index].toLowerCase()) && /^\d+$/.test(segments[index + 1] ?? '')) {
        ids.push(segments[index + 1]);
      }
    }

    return [...new Set(ids)].slice(0, 5);
  } catch {
    return [];
  }
}

export function buildXCheck({ snapshot, chainMint, startedAtMs = Date.now(), cacheHit = false }) {
  if (!snapshot.ok) {
    return {
      enabled: true,
      status: 'x_profile_unavailable',
      handle: snapshot.handle,
      profileUrl: snapshot.handle ? `https://x.com/${snapshot.handle}` : null,
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAtMs,
      cacheHit,
      profileCacheHit: Boolean(snapshot.profileCacheHit),
      pinnedCacheHit: Boolean(snapshot.pinnedCacheHit),
      profileFetched: false,
      apiStatus: snapshot.apiStatus,
      apiMessage: snapshot.apiMessage,
      errors: snapshot.errors ?? []
    };
  }

  const evidence = extractMintEvidence(snapshot.parts);
  const mentionsPumpUnclear = snapshot.parts.some((part) => /\bpump\.fun\b/i.test(part.text)) && evidence.length === 0;
  const linkedTweetWithoutMint = Boolean(snapshot.linkedTweetIds?.length && snapshot.linkedTweetsChecked && evidence.length === 0);
  const classification = classifyMintEvidence({ chainMint, evidence, mentionsPumpUnclear, linkedTweetWithoutMint });

  return {
    enabled: true,
    status: classification.status,
    handle: snapshot.handle,
    requestedHandle: snapshot.requestedHandle,
    profileUrl: snapshot.handle ? `https://x.com/${snapshot.handle}` : null,
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    fetchElapsedMs: snapshot.fetchElapsedMs,
    cacheHit,
    profileCacheHit: Boolean(snapshot.profileCacheHit),
    pinnedCacheHit: Boolean(snapshot.pinnedCacheHit),
    profileFetched: snapshot.profileFetched,
    profile: snapshot.profile,
    includeReplies: snapshot.includeReplies,
    recentTweetsSource: snapshot.recentTweetsSource ?? null,
    recentTweetsChecked: snapshot.recentTweetsChecked,
    pinnedTweetsChecked: snapshot.pinnedTweetsChecked,
    linkedTweetIds: snapshot.linkedTweetIds ?? [],
    linkedTweetsChecked: snapshot.linkedTweetsChecked ?? 0,
    lastTweetsHasNextPage: snapshot.lastTweetsHasNextPage,
    mentionedMints: classification.mentionedMints,
    mentionsCurrentMint: classification.mentionsCurrentMint,
    otherMints: classification.otherMints,
    mentionsPumpUnclear,
    linkedTweetWithoutMint,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    errors: snapshot.errors
  };
}

export function classifyMintEvidence({ chainMint, evidence = [], mentionsPumpUnclear = false, linkedTweetWithoutMint = false }) {
  const mentionedMints = [...new Set(evidence.map((item) => item.mint).filter(Boolean))];
  const mentionsCurrentMint = Boolean(chainMint && mentionedMints.includes(chainMint));
  const otherMints = chainMint ? mentionedMints.filter((mint) => mint !== chainMint) : mentionedMints;

  if (mentionsCurrentMint && otherMints.length > 0) {
    return { status: 'x_mixed_mints', mentionedMints, mentionsCurrentMint, otherMints };
  }

  if (mentionsCurrentMint) {
    return { status: 'x_confirmed_current_mint', mentionedMints, mentionsCurrentMint, otherMints };
  }

  if (otherMints.length > 1) {
    return { status: 'x_conflict_many_other_mints', mentionedMints, mentionsCurrentMint, otherMints };
  }

  if (otherMints.length === 1) {
    return { status: 'x_mismatch_other_mint', mentionedMints, mentionsCurrentMint, otherMints };
  }

  if (mentionsPumpUnclear) {
    return { status: 'x_mentions_pump_unclear', mentionedMints, mentionsCurrentMint, otherMints };
  }

  if (linkedTweetWithoutMint) {
    return { status: 'x_linked_status_no_mint', mentionedMints, mentionsCurrentMint, otherMints };
  }

  return { status: 'alpha_unposted', mentionedMints, mentionsCurrentMint, otherMints };
}

export function extractMintEvidence(parts) {
  const evidence = [];
  const seen = new Set();

  for (const part of parts) {
    const text = String(part.text ?? '');
    const patterns = [
      { type: 'pump_url', regex: /pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44}(?:pump|bonk)?)/gi },
      {
        type: 'ca_hint',
        regex:
          /(?:\bCA\b|contract address|contract|token address|\bmint\b|address)\s*(?:[\])}:=\-–—]+)?\s*([1-9A-HJ-NP-Za-km-z]{32,44}(?:pump|bonk)?)/gi
      },
      { type: 'raw_pump_suffix', regex: /\b([1-9A-HJ-NP-Za-km-z]{25,44}(?:pump|bonk))\b/g }
    ];

    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern.regex)) {
        const mint = match[1];
        const key = [mint, pattern.type, part.source, part.tweetId ?? 'profile'].join('|');
        if (seen.has(key)) {
          continue;
        }

        seen.add(key);
        evidence.push({
          mint,
          matched: pattern.type,
          source: part.source,
          tweetId: part.tweetId ?? null,
          tweetUrl: part.tweetUrl ?? null,
          createdAt: part.createdAt ?? null,
          author: part.author ?? null,
          text: truncate(text, 260)
        });
      }
    }
  }

  return evidence;
}

function collectProfileParts(user) {
  return [
    part('bio.description', user.description),
    part('bio.profile_bio.description', user.profile_bio?.description),
    ...collectUrlEntityParts('bio.entities.url', user.entities?.url?.urls),
    ...collectUrlEntityParts('bio.entities.description', user.entities?.description?.urls),
    ...collectUrlEntityParts('bio.profile_bio.url', user.profile_bio?.entities?.url?.urls),
    ...collectUrlEntityParts('bio.profile_bio.description', user.profile_bio?.entities?.description?.urls)
  ].filter(Boolean);
}

function collectTweetParts(tweet, source, depth = 0) {
  if (!tweet || typeof tweet !== 'object' || depth > 2) {
    return [];
  }

  const meta = {
    tweetId: tweet.id ?? null,
    tweetUrl: tweet.twitterUrl ?? tweet.url ?? null,
    createdAt: tweet.createdAt ?? null,
    author: tweet.author?.userName ?? null
  };
  const parts = [
    part(`${source}.text`, tweet.text, meta),
    part(`${source}.url`, [tweet.url, tweet.twitterUrl].filter(Boolean).join(' '), meta),
    ...collectUrlEntityParts(`${source}.entities.urls`, tweet.entities?.urls, meta),
    ...collectTweetParts(tweet.quoted_tweet, `${source}.quoted_tweet`, depth + 1),
    ...collectTweetParts(tweet.retweeted_tweet, `${source}.retweeted_tweet`, depth + 1)
  ];

  return parts.filter(Boolean);
}

function collectUrlEntityParts(source, urls, meta = {}) {
  return firstArray(urls)
    .map((url) => part(source, [url.expanded_url, url.display_url, url.url].filter(Boolean).join(' '), meta))
    .filter(Boolean);
}

function part(source, text, meta = {}) {
  const value = String(text ?? '').trim();
  if (!value) {
    return null;
  }

  return { source, text: value, ...meta };
}

function apiSuccess(response) {
  return Boolean(response?.ok && response.body?.status === 'success');
}

function responseError(endpoint, response) {
  return {
    endpoint,
    httpStatus: response?.httpStatus ?? null,
    apiStatus: response?.body?.status ?? null,
    message: response?.error ?? response?.body?.msg ?? response?.body?.message ?? 'request failed'
  };
}

function errorCheck({ handle, startedAtMs, status, message }) {
  return {
    enabled: true,
    status,
    handle,
    profileUrl: handle ? `https://x.com/${handle}` : null,
    checkedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAtMs,
    error: message
  };
}

function countProfileUrls(user) {
  return (
    (user.url ? 1 : 0) +
    firstArray(user.entities?.url?.urls).length +
    firstArray(user.entities?.description?.urls).length +
    firstArray(user.profile_bio?.entities?.url?.urls).length +
    firstArray(user.profile_bio?.entities?.description?.urls).length
  );
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function truncate(value, maxLength) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}
