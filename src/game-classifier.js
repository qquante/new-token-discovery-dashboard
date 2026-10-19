const GAME_HOSTS = [
  'itch.io',
  'gamejolt.com',
  'newgrounds.com',
  'crazygames.com',
  'kongregate.com',
  'roblox.com',
  'poki.com',
  'armorgames.com',
  'miniclip.com'
];

const APP_HOSTS = [
  'play.google.com',
  'apps.apple.com',
  'testflight.apple.com',
  'chromewebstore.google.com',
  'store.steampowered.com'
];

const TEXT_RULES = [
  {
    tag: 'game_keyword',
    category: 'game',
    score: 2,
    pattern:
      /\b(game|games|gaming|jogo|jogar|arcade|rpg|mmorpg|roguelike|shooter|fps|battle|arena|quest|dungeon|boss|loot|idle|clicker|runner|platformer|puzzle|wordle|casino|slots|blackjack|poker|lottery|gamble|gambling|wager|tournament|leaderboard)\b/i
  },
  {
    tag: 'play_phrase',
    category: 'game',
    score: 2,
    pattern: /\b(play now|play game|start game|new game|play to earn|p2e|high score|level up)\b/i
  },
  {
    tag: 'game_engine_text',
    category: 'game',
    score: 4,
    pattern: /\b(unity|webgl|phaser|godot|playcanvas|babylon|pixi|construct\s?3|three\.js|unreal engine)\b/i
  },
  {
    tag: 'app_keyword',
    category: 'app',
    score: 2,
    pattern: /\b(app|dapp|mini app|telegram app|bot|tool|platform|dashboard|mobile app|web app)\b/i
  },
  {
    tag: 'telegram_mini_app',
    category: 'app',
    score: 3,
    pattern: /\b(telegram mini app|tg mini app|ton mini app|miniapp)\b/i
  }
];

const HTML_SIGNAL_RULES = [
  { tag: 'html_canvas', category: 'game', score: 2, pattern: /<canvas\b/i },
  { tag: 'html_webgl', category: 'game', score: 3, pattern: /\b(webgl|unityloader|unityweb|unityinstance)\b/i },
  { tag: 'html_game_engine', category: 'game', score: 4, pattern: /\b(phaser|godot|playcanvas|babylon|pixi|construct\s?3|three\.js)\b/i },
  { tag: 'html_play_button', category: 'game', score: 2, pattern: /\b(play now|start game|play game|new game|leaderboard|high score)\b/i },
  { tag: 'html_telegram_webapp', category: 'app', score: 3, pattern: /\btelegram-web-app|telegram web app|tgwebapp\b/i }
];

export function classifyGameCandidate({ token = {}, socials = {}, metadata = {}, websiteEvidence = null } = {}) {
  const reasons = [];
  const tags = new Set();
  const categoryScores = { game: 0, app: 0 };
  let score = 0;

  const add = (points, tag, reason, category = 'game') => {
    score += points;
    categoryScores[category] = (categoryScores[category] ?? 0) + points;
    tags.add(tag);
    reasons.push({ tag, score: points, category, reason });
  };

  const textCorpus = buildTextCorpus({ token, socials, metadata, websiteEvidence });
  for (const rule of TEXT_RULES) {
    if (rule.pattern.test(textCorpus)) {
      add(rule.score, rule.tag, `matched text rule: ${rule.tag}`, rule.category);
    }
  }

  for (const url of [socials.website, ...(socials.extraLinks ?? [])].filter(Boolean)) {
    const urlSignals = classifyUrl(url);
    for (const signal of urlSignals) {
      add(signal.score, signal.tag, signal.reason, signal.category);
    }
  }

  if (websiteEvidence) {
    if (websiteEvidence.ok) {
      add(1, 'website_reachable', `website HTTP ${websiteEvidence.status}`, 'app');
    }

    for (const signal of websiteEvidence.signals ?? []) {
      add(signal.score, signal.tag, signal.reason, signal.category);
    }
  }

  const strongGameSignal = [...tags].some((tag) =>
    ['game_host', 'game_path', 'html_canvas', 'html_webgl', 'html_game_engine', 'html_play_button', 'game_engine_text'].includes(tag)
  );
  const strongSiteGameSignal = [...tags].some((tag) =>
    ['html_canvas', 'html_webgl', 'html_game_engine', 'html_play_button'].includes(tag)
  );
  const category = categoryScores.game >= Math.max(3, categoryScores.app) ? 'game' : categoryScores.app >= 3 ? 'app' : 'unknown';
  const classification = classifyScore({ score, category, strongGameSignal, strongSiteGameSignal, websiteOk: websiteEvidence?.ok });

  return {
    classification,
    category,
    score,
    gameScore: categoryScores.game,
    appScore: categoryScores.app,
    tags: [...tags],
    reasons
  };
}

export async function inspectWebsite(url, { timeoutMs = 4500, maxBytes = 250_000 } = {}) {
  const startedAtMs = Date.now();

  if (!isHttpUrl(url)) {
    return {
      ok: false,
      url,
      finalUrl: null,
      status: null,
      contentType: null,
      title: null,
      description: null,
      signals: [],
      elapsedMs: Date.now() - startedAtMs,
      error: 'not_http_url'
    };
  }

  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': 'pump-fun-game-discovery/0.1'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    const contentType = response.headers.get('content-type') ?? null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes));
    const title = extractTitle(html);
    const description = extractMetaDescription(html);
    const signals = extractHtmlSignals(html);

    return {
      ok: response.ok,
      url,
      finalUrl: response.url,
      status: response.status,
      contentType,
      title,
      description,
      signals,
      elapsedMs: Date.now() - startedAtMs,
      error: response.ok ? null : `HTTP ${response.status}`
    };
  } catch (error) {
    return {
      ok: false,
      url,
      finalUrl: null,
      status: null,
      contentType: null,
      title: null,
      description: null,
      signals: [],
      elapsedMs: Date.now() - startedAtMs,
      error: error.name === 'TimeoutError' ? 'timeout' : error.message
    };
  }
}

export function classifyUrl(url) {
  const signals = [];
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (GAME_HOSTS.some((gameHost) => host === gameHost || host.endsWith(`.${gameHost}`))) {
      signals.push({ tag: 'game_host', category: 'game', score: 4, reason: `known game host: ${host}` });
    }

    if (APP_HOSTS.some((appHost) => host === appHost || host.endsWith(`.${appHost}`))) {
      signals.push({ tag: 'app_host', category: 'app', score: 3, reason: `known app host: ${host}` });
    }

    if (/(^|\W)(play|game|games|arcade|rpg|quest|battle|arena|casino|app)(\W|$)/i.test(`${host}${pathname}`)) {
      signals.push({ tag: 'game_path', category: 'game', score: 2, reason: `game-like URL: ${host}${pathname}` });
    }
  } catch {
    return signals;
  }

  return signals;
}

function classifyScore({ score, category, strongGameSignal, strongSiteGameSignal, websiteOk }) {
  if (category === 'game' && score >= 8 && websiteOk && strongSiteGameSignal) {
    return 'game_confirmed';
  }

  if (category === 'game' && score >= 8 && strongGameSignal) {
    return 'game_likely';
  }

  if (category === 'game' && score >= 4) {
    return 'game_possible';
  }

  if (category === 'app' && score >= 5) {
    return 'app_likely';
  }

  if (category === 'app' && score >= 3) {
    return 'app_possible';
  }

  return 'not_game';
}

function buildTextCorpus({ token, socials, metadata, websiteEvidence }) {
  return [
    token.name,
    token.symbol,
    token.description,
    token.metadataUri,
    socials.website,
    socials.twitter,
    socials.telegram,
    ...(socials.extraLinks ?? []),
    ...collectStrings(metadata),
    websiteEvidence?.title,
    websiteEvidence?.description,
    websiteEvidence?.finalUrl
  ]
    .filter(Boolean)
    .join('\n');
}

function collectStrings(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectStrings(item, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.values(value).flatMap((item) => collectStrings(item, depth + 1));
  }

  return [];
}

function extractHtmlSignals(html) {
  return HTML_SIGNAL_RULES.filter((rule) => rule.pattern.test(html)).map((rule) => ({
    tag: rule.tag,
    category: rule.category,
    score: rule.score,
    reason: `matched website HTML rule: ${rule.tag}`
  }));
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanHtmlText(match[1]) : null;
}

function extractMetaDescription(html) {
  const match =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i) ??
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  return match ? cleanHtmlText(match[1]) : null;
}

function cleanHtmlText(value) {
  return String(value)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
