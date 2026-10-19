import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildSocialFields, firstText } from './social-links.js';

const DEFAULT_FRONTEND_BASE_URL = 'https://frontend-api-v3.pump.fun';
const DEFAULT_TIME_ZONE = process.env.TZ || 'America/Sao_Paulo';
const MAX_PAGE_SIZE_SEEN = 70;

const options = parseArgs(process.argv.slice(2));
const seenMints = new Set();
const startedAtMs = Date.now();

await mkdir(options.outDir, { recursive: true });
await writeCsvHeader(options.csvPath);

printStart(options);
await runBackfill();

async function runBackfill() {
  let offset = options.offsetStart;
  let pageCount = 0;
  let totalFetched = 0;
  let totalAccepted = 0;
  let totalDuplicates = 0;
  let oldestAcceptedMs = null;
  let newestAcceptedMs = null;
  let stopReason = 'completed';

  while (true) {
    if (options.maxPages !== null && pageCount >= options.maxPages) {
      stopReason = 'max_pages';
      break;
    }

    if (options.maxTokens !== null && totalAccepted >= options.maxTokens) {
      stopReason = 'max_tokens';
      break;
    }

    const pageStartedAt = Date.now();
    const coins = await fetchCoinsPage(offset);
    pageCount += 1;

    if (!coins.length) {
      stopReason =
        oldestAcceptedMs && oldestAcceptedMs > options.sinceMs
          ? 'frontend_window_exhausted_before_since'
          : 'empty_page';
      break;
    }

    totalFetched += coins.length;

    const normalized = [];
    let pageDuplicates = 0;
    let pageOlderThanSince = 0;
    let pageNewerThanUntil = 0;

    for (const coin of coins) {
      const createdAtMs = normalizeTimestampMs(coin.created_timestamp);

      if (createdAtMs && createdAtMs > options.untilMs) {
        pageNewerThanUntil += 1;
        continue;
      }

      if (createdAtMs && createdAtMs < options.sinceMs) {
        pageOlderThanSince += 1;
        continue;
      }

      if (seenMints.has(coin.mint)) {
        pageDuplicates += 1;
        continue;
      }

      if (options.maxTokens !== null && totalAccepted + normalized.length >= options.maxTokens) {
        continue;
      }

      seenMints.add(coin.mint);
      const record = normalizeCoin(coin);
      normalized.push(record);

      if (record.createdAtMs) {
        oldestAcceptedMs =
          oldestAcceptedMs === null ? record.createdAtMs : Math.min(oldestAcceptedMs, record.createdAtMs);
        newestAcceptedMs =
          newestAcceptedMs === null ? record.createdAtMs : Math.max(newestAcceptedMs, record.createdAtMs);
      }
    }

    totalDuplicates += pageDuplicates;
    totalAccepted += normalized.length;

    await appendRecords(normalized);

    if (options.printTokens) {
      for (const record of normalized) {
        printToken(record);
      }
    }

    const pageOldestMs = Math.min(...coins.map((coin) => normalizeTimestampMs(coin.created_timestamp)).filter(Boolean));
    const pageNewestMs = Math.max(...coins.map((coin) => normalizeTimestampMs(coin.created_timestamp)).filter(Boolean));

    printProgress({
      offset,
      pageCount,
      fetched: coins.length,
      accepted: normalized.length,
      duplicates: pageDuplicates,
      olderThanSince: pageOlderThanSince,
      newerThanUntil: pageNewerThanUntil,
      totalAccepted,
      pageOldestMs: Number.isFinite(pageOldestMs) ? pageOldestMs : null,
      pageNewestMs: Number.isFinite(pageNewestMs) ? pageNewestMs : null,
      elapsedMs: Date.now() - pageStartedAt
    });

    if (coins.every((coin) => normalizeTimestampMs(coin.created_timestamp) < options.sinceMs)) {
      stopReason = 'reached_since_cutoff';
      break;
    }

    offset += options.step;
    await sleep(options.delayMs);
  }

  const summary = {
    mode: 'frontend-api-v3-best-effort',
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date().toISOString(),
    since: new Date(options.sinceMs).toISOString(),
    until: new Date(options.untilMs).toISOString(),
    stopReason,
    pageCount,
    totalFetched,
    totalAccepted,
    totalDuplicates,
    oldestAcceptedAt: oldestAcceptedMs ? new Date(oldestAcceptedMs).toISOString() : null,
    newestAcceptedAt: newestAcceptedMs ? new Date(newestAcceptedMs).toISOString() : null,
    jsonlPath: options.jsonlPath,
    csvPath: options.csvPath
  };

  await writeFile(options.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  printSummary(summary);
}

function parseArgs(args) {
  const nowMs = Date.now();
  const parsed = {
    frontendBaseUrl: process.env.PUMP_FRONTEND_BASE_URL || DEFAULT_FRONTEND_BASE_URL,
    timeZone: DEFAULT_TIME_ZONE,
    days: 14,
    sinceMs: null,
    untilMs: nowMs,
    pageSize: MAX_PAGE_SIZE_SEEN,
    overlap: 10,
    offsetStart: 0,
    delayMs: 150,
    maxPages: null,
    maxTokens: null,
    printTokens: false,
    includeNsfw: true,
    outDir: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [key, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const nextValue = () => inlineValue ?? args[++index];

    switch (key) {
      case '--frontend-base-url':
        parsed.frontendBaseUrl = trimTrailingSlash(nextValue());
        break;
      case '--days':
        parsed.days = Number.parseFloat(nextValue());
        break;
      case '--since':
        parsed.sinceMs = parseDateMs(nextValue(), '--since');
        break;
      case '--until':
        parsed.untilMs = parseDateMs(nextValue(), '--until');
        break;
      case '--page-size':
        parsed.pageSize = Number.parseInt(nextValue(), 10);
        break;
      case '--overlap':
        parsed.overlap = Number.parseInt(nextValue(), 10);
        break;
      case '--offset-start':
        parsed.offsetStart = Number.parseInt(nextValue(), 10);
        break;
      case '--delay-ms':
        parsed.delayMs = Number.parseInt(nextValue(), 10);
        break;
      case '--max-pages':
        parsed.maxPages = Number.parseInt(nextValue(), 10);
        break;
      case '--max-tokens':
        parsed.maxTokens = Number.parseInt(nextValue(), 10);
        break;
      case '--out-dir':
        parsed.outDir = nextValue();
        break;
      case '--tz':
        parsed.timeZone = nextValue();
        break;
      case '--print-tokens':
        parsed.printTokens = true;
        break;
      case '--no-nsfw':
        parsed.includeNsfw = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        console.error(`Flag desconhecida: ${arg}`);
        printHelp();
        process.exit(1);
    }
  }

  if (!parsed.sinceMs) {
    parsed.sinceMs = parsed.untilMs - parsed.days * 24 * 60 * 60 * 1000;
  }

  parsed.pageSize = clampInt(parsed.pageSize, 1, MAX_PAGE_SIZE_SEEN, '--page-size');
  parsed.overlap = clampInt(parsed.overlap, 0, parsed.pageSize - 1, '--overlap');
  parsed.offsetStart = clampInt(parsed.offsetStart, 0, Number.MAX_SAFE_INTEGER, '--offset-start');
  parsed.delayMs = clampInt(parsed.delayMs, 0, 60_000, '--delay-ms');
  parsed.step = Math.max(1, parsed.pageSize - parsed.overlap);
  parsed.frontendBaseUrl = trimTrailingSlash(parsed.frontendBaseUrl);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  parsed.outDir = resolve(process.cwd(), parsed.outDir ?? 'history', `pump-history-${stamp}`);
  parsed.jsonlPath = resolve(parsed.outDir, 'tokens.jsonl');
  parsed.csvPath = resolve(parsed.outDir, 'tokens.csv');
  parsed.summaryPath = resolve(parsed.outDir, 'summary.json');

  return parsed;
}

async function fetchCoinsPage(offset) {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(options.pageSize),
    sort: 'created_timestamp',
    order: 'DESC',
    includeNsfw: String(options.includeNsfw)
  });
  const url = `${options.frontendBaseUrl}/coins?${params}`;
  return fetchJsonWithRetry(url, 4);
}

async function fetchJsonWithRetry(url, attempts) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'pump-fun-game-history-backfill/0.1'
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const text = await response.text();
      if (!text.trim()) {
        throw new Error('empty JSON response');
      }

      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        throw new Error('expected array response');
      }

      return parsed;
    } catch (error) {
      lastError = error;
      await sleep(500 * attempt);
    }
  }

  throw new Error(`Falha fetch ${url}: ${lastError?.message ?? 'erro desconhecido'}`);
}

function normalizeCoin(coin) {
  const createdAtMs = normalizeTimestampMs(coin.created_timestamp);
  const socials = buildSocialFields({ coinDetail: coin, metadata: null, mint: coin.mint });

  return {
    mint: coin.mint ?? null,
    name: coin.name ?? null,
    symbol: coin.symbol ?? null,
    createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
    createdAtMs,
    creator: coin.creator ?? null,
    pumpUrl: socials.pumpUrl,
    website: socials.website,
    twitter: socials.twitter,
    xProfile: socials.xProfile,
    telegram: socials.telegram,
    links: socials.extraLinks,
    description: firstText(coin.description),
    image: coin.image_uri ?? null,
    metadataUri: coin.metadata_uri ?? null,
    marketCapSol: numberOrNull(coin.market_cap ?? coin.market_cap_quote),
    usdMarketCap: numberOrNull(coin.usd_market_cap),
    bondingCurve: coin.bonding_curve ?? null,
    associatedBondingCurve: coin.associated_bonding_curve ?? null,
    complete: Boolean(coin.complete),
    nsfw: Boolean(coin.nsfw),
    isBanned: Boolean(coin.is_banned),
    raw: coin
  };
}

async function appendRecords(records) {
  if (!records.length) {
    return;
  }

  await appendFile(options.jsonlPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  await appendFile(options.csvPath, records.map(toCsvRow).join('\n') + '\n', 'utf8');
}

async function writeCsvHeader(csvPath) {
  const header = [
    'created_at',
    'mint',
    'name',
    'symbol',
    'creator',
    'pump_url',
    'website',
    'x_profile',
    'twitter',
    'telegram',
    'description',
    'image',
    'metadata_uri',
    'market_cap_sol',
    'usd_market_cap',
    'bonding_curve',
    'complete',
    'nsfw',
    'is_banned'
  ];
  await writeFile(csvPath, `${header.join(',')}\n`, 'utf8');
}

function toCsvRow(record) {
  return [
    record.createdAt,
    record.mint,
    record.name,
    record.symbol,
    record.creator,
    record.pumpUrl,
    record.website,
    record.xProfile,
    record.twitter,
    record.telegram,
    record.description,
    record.image,
    record.metadataUri,
    record.marketCapSol,
    record.usdMarketCap,
    record.bondingCurve,
    record.complete,
    record.nsfw,
    record.isBanned
  ].map(csvValue).join(',');
}

function csvValue(value) {
  if (value === null || value === undefined) {
    return '';
  }

  const text = String(value);
  if (!/[",\n\r]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll('"', '""')}"`;
}

function printStart(parsed) {
  console.log('Pump.fun history backfill - FRONTEND API BEST EFFORT');
  console.log(`frontend  ${parsed.frontendBaseUrl}`);
  console.log(`since     ${formatTime(parsed.sinceMs, parsed.timeZone)}`);
  console.log(`until     ${formatTime(parsed.untilMs, parsed.timeZone)}`);
  console.log(`page      size=${parsed.pageSize} overlap=${parsed.overlap} step=${parsed.step}`);
  console.log(`delay     ${parsed.delayMs}ms`);
  console.log(`out       ${parsed.outDir}`);
  console.log('');
}

function printProgress(progress) {
  console.log(
    [
      `page=${progress.pageCount}`,
      `offset=${progress.offset}`,
      `fetched=${progress.fetched}`,
      `accepted=${progress.accepted}`,
      `dupes=${progress.duplicates}`,
      `older=${progress.olderThanSince}`,
      `newer=${progress.newerThanUntil}`,
      `total=${progress.totalAccepted}`,
      `newest=${progress.pageNewestMs ? formatTime(progress.pageNewestMs, options.timeZone) : 'n/a'}`,
      `oldest=${progress.pageOldestMs ? formatTime(progress.pageOldestMs, options.timeZone) : 'n/a'}`,
      `ms=${progress.elapsedMs}`
    ].join(' ')
  );
}

function printToken(record) {
  console.log(
    [
      `  ${formatTime(record.createdAtMs, options.timeZone)}`,
      `${record.name ?? 'sem nome'} (${record.symbol ?? 'sem simbolo'})`,
      record.mint,
      `site=${record.website ?? 'n/a'}`,
      `x=${record.xProfile ?? 'n/a'}`,
      `tg=${record.telegram ?? 'n/a'}`
    ].join(' | ')
  );
}

function printSummary(summary) {
  console.log('');
  console.log('Resumo');
  console.log(`status    ${summary.stopReason}`);
  console.log(`tokens    ${summary.totalAccepted}`);
  console.log(`pages     ${summary.pageCount}`);
  console.log(`oldest    ${summary.oldestAcceptedAt ?? 'n/a'}`);
  console.log(`newest    ${summary.newestAcceptedAt ?? 'n/a'}`);
  if (summary.stopReason === 'frontend_window_exhausted_before_since') {
    console.log('warning   frontend publico acabou antes do cutoff; resultado nao cobre a janela inteira');
  }
  console.log(`jsonl     ${summary.jsonlPath}`);
  console.log(`csv       ${summary.csvPath}`);
  console.log(`summary   ${summary.jsonlPath.replace(/tokens\.jsonl$/, 'summary.json')}`);
}

function normalizeTimestampMs(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseDateMs(value, flag) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    console.error(`${flag} invalido: ${value}`);
    process.exit(1);
  }

  return parsed;
}

function clampInt(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(`${name} precisa ser inteiro entre ${min} e ${max}.`);
    process.exit(1);
  }

  return value;
}

function formatTime(value, timeZone) {
  if (!value) {
    return 'n/a';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`
Uso:
  npm run history -- --days=14
  npm run history -- --since=2026-06-14T00:00:00Z
  npm run history -- --days=14 --print-tokens

Flags:
  --days=N                   janela relativa; default 14
  --since=ISO                inicio absoluto
  --until=ISO                fim absoluto; default agora
  --page-size=N              max observado 70
  --overlap=N                overlap contra drift de offset; default 10
  --offset-start=N           offset inicial
  --delay-ms=N               pausa entre paginas; default 150
  --max-pages=N              limite para smoke/teste
  --max-tokens=N             limite de tokens aceitos
  --out-dir=PATH             pasta de saida
  --print-tokens             imprime cada token aceito
  --no-nsfw                  includeNsfw=false
`);
}
