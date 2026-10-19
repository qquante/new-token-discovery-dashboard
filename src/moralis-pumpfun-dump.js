import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const BASE_URL = 'https://solana-gateway.moralis.io';
const ALL_STATES = ['new', 'bonding', 'graduated'];
const DEFAULT_STATES = ['new'];
const DEFAULT_TIME_ZONE = process.env.TZ || 'America/Sao_Paulo';

const options = parseArgs(process.argv.slice(2));
const apiKey = process.env.MORALIS_API_KEY;

if (!apiKey) {
  console.error('MORALIS_API_KEY nao definido no ambiente.');
  process.exit(1);
}

await mkdir(options.outDir, { recursive: true });
await mkdir(resolve(options.outDir, 'raw-pages'), { recursive: true });

printStart(options);
const stateResults = [];

for (const state of options.states) {
  stateResults.push(await dumpState(state));
}

const merged = mergeStateTokens(stateResults.flatMap((result) => result.tokens));
let metadataByMint = new Map();
let metadataStatus = options.metadata ? 'pending' : 'disabled';

if (options.metadata) {
  try {
    metadataByMint = await dumpMetadata([...merged.keys()]);
    metadataStatus = 'ok';
  } catch (error) {
    metadataStatus = `skipped: ${error.message}`;
    console.log(`metadata skipped: ${error.message}`);
  }
}

const records = [...merged.values()].map((record) => {
  const metadata = metadataByMint.get(record.tokenAddress) ?? null;
  return {
    ...record,
    metadata,
    metadataName: metadata?.name ?? null,
    metadataSymbol: metadata?.symbol ?? null,
    metadataUri: metadata?.metaplex?.metadataUri ?? null,
    metadataDescription: metadata?.description ?? null,
    metadataLinks: metadata?.links ?? null,
    metadataScore: metadata?.score ?? null,
    possibleSpam: metadata?.possibleSpam ?? null,
    isVerifiedContract: metadata?.isVerifiedContract ?? null
  };
});

await writeFile(options.tokensJsonlPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
await writeFile(options.tokensCsvPath, toCsv(records), 'utf8');

const summary = {
  mode: 'moralis-pumpfun-dump',
  startedAt: options.startedAt,
  finishedAt: new Date().toISOString(),
  states: options.states,
  pageLimit: options.limit,
  stateSummaries: stateResults.map(({ state, pages, total, accepted, error }) => ({ state, pages, total, accepted, error })),
  uniqueTokens: records.length,
  metadataFetched: metadataByMint.size,
  metadataStatus,
  outDir: options.outDir,
  tokensJsonlPath: options.tokensJsonlPath,
  tokensCsvPath: options.tokensCsvPath
};

await writeFile(options.summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
printSummary(summary);

async function dumpState(state) {
  let cursor = null;
  let page = 0;
  let total = 0;
  let accepted = 0;
  let error = null;
  let previousOldestMs = null;
  const seenCursors = new Set();
  const seenPageKeys = new Set();
  const tokens = [];
  const rawPagePath = resolve(options.outDir, 'raw-pages', `${state}.pages.jsonl`);
  const rawTokenPath = resolve(options.outDir, `${state}.tokens.raw.jsonl`);

  while (true) {
    if (options.maxPages !== null && page >= options.maxPages) {
      break;
    }

    const url = new URL(`/token/mainnet/exchange/pumpfun/${state}`, BASE_URL);
    url.searchParams.set('limit', String(options.limit));
    if (cursor) {
      url.searchParams.set('cursor', cursor);
    }

    let envelope;
    try {
      envelope = await moralisJson(url, { method: 'GET' });
    } catch (caught) {
      error = caught.message;
      console.log(`state=${state} stopped_by_error=${caught.message}`);
      break;
    }

    const result = Array.isArray(envelope.result) ? envelope.result : [];
    page += 1;
    total += result.length;
    const pageKey = makePageKey(state, result);
    if (seenPageKeys.has(pageKey)) {
      console.log(`state=${state} stopped_by_repeated_page page=${page}`);
      break;
    }
    seenPageKeys.add(pageKey);

    await appendFile(
      rawPagePath,
      JSON.stringify({ state, page, fetchedAt: new Date().toISOString(), envelope }) + '\n',
      'utf8'
    );

    const pageTokens = result
      .filter((token) => withinTimeWindow(state, token))
      .map((token) => ({ moralisState: state, ...token }));
    if (pageTokens.length) {
      await appendFile(rawTokenPath, pageTokens.map((token) => JSON.stringify(token)).join('\n') + '\n', 'utf8');
      tokens.push(...pageTokens);
      accepted += pageTokens.length;
    }

    printStateProgress({
      state,
      page,
      count: result.length,
      total,
      cursor: envelope.cursor,
      first: firstTime(result[0]),
      last: firstTime(result.at(-1))
    });

    if (hasTimeFilter(state) && result.length > 0) {
      const pageTimes = result.map((token) => stateTimeMs(state, token)).filter(Boolean);
      const newestPageMs = Math.max(...pageTimes);
      const oldestPageMs = Math.min(...pageTimes);

      if (previousOldestMs && Number.isFinite(newestPageMs) && newestPageMs > previousOldestMs) {
        console.log(`state=${state} stopped_by_time_rewind page=${page}`);
        break;
      }

      if (Number.isFinite(oldestPageMs)) {
        previousOldestMs = oldestPageMs;
      }

      if (Number.isFinite(oldestPageMs) && oldestPageMs < options.sinceMs) {
        break;
      }
    }

    if (!envelope.cursor || result.length === 0) {
      break;
    }

    if (seenCursors.has(envelope.cursor)) {
      console.log(`state=${state} stopped_by_repeated_cursor page=${page}`);
      break;
    }
    seenCursors.add(envelope.cursor);

    cursor = envelope.cursor;
    await sleep(options.delayMs);
  }

  return { state, pages: page, total, accepted, error, tokens };
}

async function dumpMetadata(mints) {
  const metadataPath = resolve(options.outDir, 'metadata.raw.jsonl');
  const metadataByMint = new Map();

  for (let index = 0; index < mints.length; index += options.metadataBatchSize) {
    const addresses = mints.slice(index, index + options.metadataBatchSize);
    const envelope = await moralisJson(new URL('/token/mainnet/metadata', BASE_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addresses })
    });
    const rows = Array.isArray(envelope) ? envelope : [];

    if (rows.length) {
      await appendFile(metadataPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
    }

    for (const row of rows) {
      const mint = row.mint ?? row.tokenAddress ?? row.address;
      if (mint) {
        metadataByMint.set(mint, row);
      }
    }

    console.log(`metadata batch=${Math.floor(index / options.metadataBatchSize) + 1} addresses=${addresses.length} returned=${rows.length} total=${metadataByMint.size}`);
    await sleep(options.delayMs);
  }

  return metadataByMint;
}

async function moralisJson(url, init, attempt = 1) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      'X-API-Key': apiKey,
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();

  if (!response.ok) {
    if ((response.status === 429 || response.status >= 500) && attempt <= options.retries) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : options.retryDelayMs * attempt;
      console.log(`retry status=${response.status} attempt=${attempt} delayMs=${delay}`);
      await sleep(delay);
      return moralisJson(url, init, attempt + 1);
    }

    throw new Error(`Moralis HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  if (!text.trim()) {
    return null;
  }

  return JSON.parse(text);
}

function mergeStateTokens(tokens) {
  const byMint = new Map();

  for (const token of tokens) {
    const tokenAddress = token.tokenAddress;
    if (!tokenAddress) {
      continue;
    }

    const existing = byMint.get(tokenAddress) ?? {
      tokenAddress,
      moralisStates: [],
      stateRecords: {},
      name: null,
      symbol: null,
      logo: null,
      decimals: null,
      priceNative: null,
      priceUsd: null,
      liquidity: null,
      fullyDilutedValuation: null,
      createdAt: null,
      graduatedAt: null,
      bondingCurveProgress: null
    };

    if (!existing.moralisStates.includes(token.moralisState)) {
      existing.moralisStates.push(token.moralisState);
    }

    existing.stateRecords[token.moralisState] = token;
    for (const key of [
      'name',
      'symbol',
      'logo',
      'decimals',
      'priceNative',
      'priceUsd',
      'liquidity',
      'fullyDilutedValuation',
      'createdAt',
      'graduatedAt',
      'bondingCurveProgress'
    ]) {
      if (existing[key] === null || existing[key] === undefined) {
        existing[key] = token[key] ?? existing[key];
      }
    }

    byMint.set(tokenAddress, existing);
  }

  return byMint;
}

function toCsv(records) {
  const header = [
    'token_address',
    'moralis_states',
    'name',
    'symbol',
    'decimals',
    'created_at',
    'graduated_at',
    'bonding_curve_progress',
    'price_native',
    'price_usd',
    'liquidity',
    'fully_diluted_valuation',
    'logo',
    'metadata_name',
    'metadata_symbol',
    'metadata_uri',
    'metadata_description',
    'metadata_links_json',
    'metadata_score',
    'possible_spam',
    'is_verified_contract'
  ];

  const rows = records.map((record) =>
    [
      record.tokenAddress,
      record.moralisStates.join('|'),
      record.name,
      record.symbol,
      record.decimals,
      record.createdAt,
      record.graduatedAt,
      record.bondingCurveProgress,
      record.priceNative,
      record.priceUsd,
      record.liquidity,
      record.fullyDilutedValuation,
      record.logo,
      record.metadataName,
      record.metadataSymbol,
      record.metadataUri,
      record.metadataDescription,
      record.metadataLinks ? JSON.stringify(record.metadataLinks) : null,
      record.metadataScore,
      record.possibleSpam,
      record.isVerifiedContract
    ].map(csvValue).join(',')
  );

  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

function parseArgs(args) {
  const parsed = {
    states: DEFAULT_STATES,
    limit: 100,
    delayMs: 150,
    retries: 5,
    retryDelayMs: 1000,
    maxPages: null,
    metadata: true,
    metadataBatchSize: 100,
    sinceMs: null,
    untilMs: null,
    allowUnboundedBonding: false,
    outDir: null,
    timeZone: DEFAULT_TIME_ZONE,
    startedAt: new Date().toISOString()
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [key, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const nextValue = () => inlineValue ?? args[++index];

    switch (key) {
      case '--states':
        parsed.states = nextValue().split(',').map((state) => state.trim()).filter(Boolean);
        break;
      case '--limit':
        parsed.limit = Number.parseInt(nextValue(), 10);
        break;
      case '--delay-ms':
        parsed.delayMs = Number.parseInt(nextValue(), 10);
        break;
      case '--max-pages':
        parsed.maxPages = Number.parseInt(nextValue(), 10);
        break;
      case '--metadata-batch-size':
        parsed.metadataBatchSize = Number.parseInt(nextValue(), 10);
        break;
      case '--out-dir':
        parsed.outDir = nextValue();
        break;
      case '--days':
        parsed.sinceMs = Date.now() - Number.parseFloat(nextValue()) * 24 * 60 * 60 * 1000;
        break;
      case '--since':
        parsed.sinceMs = parseDateMs(nextValue(), '--since');
        break;
      case '--until':
        parsed.untilMs = parseDateMs(nextValue(), '--until');
        break;
      case '--tz':
        parsed.timeZone = nextValue();
        break;
      case '--no-metadata':
        parsed.metadata = false;
        break;
      case '--allow-unbounded-bonding':
        parsed.allowUnboundedBonding = true;
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

  for (const state of parsed.states) {
    if (!ALL_STATES.includes(state)) {
      console.error(`state invalido: ${state}`);
      process.exit(1);
    }
  }

  if (parsed.states.includes('bonding') && parsed.maxPages === null && !parsed.allowUnboundedBonding) {
    console.error('bonding nao tem timestamp; use --max-pages=N ou --allow-unbounded-bonding para paginar sem limite temporal.');
    process.exit(1);
  }

  parsed.limit = clampInt(parsed.limit, 1, 100, '--limit');
  parsed.delayMs = clampInt(parsed.delayMs, 0, 60_000, '--delay-ms');
  parsed.metadataBatchSize = clampInt(parsed.metadataBatchSize, 1, 100, '--metadata-batch-size');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  parsed.outDir = resolve(process.cwd(), parsed.outDir ?? 'moralis-dumps', `pumpfun-${stamp}`);
  parsed.tokensJsonlPath = resolve(parsed.outDir, 'tokens.merged.jsonl');
  parsed.tokensCsvPath = resolve(parsed.outDir, 'tokens.merged.csv');
  parsed.summaryPath = resolve(parsed.outDir, 'summary.json');
  return parsed;
}

function withinTimeWindow(state, token) {
  if (!hasTimeFilter(state)) {
    return true;
  }

  const timestamp = stateTimeMs(state, token);
  if (!timestamp) {
    return true;
  }

  if (options.sinceMs && timestamp < options.sinceMs) {
    return false;
  }

  if (options.untilMs && timestamp > options.untilMs) {
    return false;
  }

  return true;
}

function hasTimeFilter(state) {
  return state === 'new' || state === 'graduated';
}

function stateTimeMs(state, token) {
  const value = state === 'graduated' ? token.graduatedAt : token.createdAt;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function makePageKey(state, result) {
  const first = result[0];
  const last = result.at(-1);
  return [
    state,
    result.length,
    first?.tokenAddress ?? '',
    firstTime(first) ?? '',
    last?.tokenAddress ?? '',
    firstTime(last) ?? ''
  ].join('|');
}

function parseDateMs(value, flag) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    console.error(`${flag} invalido: ${value}`);
    process.exit(1);
  }

  return parsed;
}

function printStart(parsed) {
  console.log('Moralis Pump.fun dump');
  console.log(`states    ${parsed.states.join(',')}`);
  console.log(`limit     ${parsed.limit}`);
  console.log(`metadata  ${parsed.metadata ? 'enabled' : 'disabled'}`);
  console.log(`since     ${parsed.sinceMs ? new Date(parsed.sinceMs).toISOString() : 'none'}`);
  console.log(`until     ${parsed.untilMs ? new Date(parsed.untilMs).toISOString() : 'none'}`);
  console.log(`out       ${parsed.outDir}`);
  console.log('');
}

function printStateProgress({ state, page, count, total, cursor, first, last }) {
  console.log(
    [
      `state=${state}`,
      `page=${page}`,
      `count=${count}`,
      `total=${total}`,
      `first=${first ?? 'n/a'}`,
      `last=${last ?? 'n/a'}`,
      `cursor=${cursor ? 'yes' : 'no'}`
    ].join(' ')
  );
}

function printSummary(summary) {
  console.log('');
  console.log('Resumo Moralis');
  for (const item of summary.stateSummaries) {
    console.log(`${item.state.padEnd(10)} pages=${item.pages} total=${item.total} accepted=${item.accepted}${item.error ? ` error=${item.error}` : ''}`);
  }
  console.log(`unique    ${summary.uniqueTokens}`);
  console.log(`metadata  ${summary.metadataFetched}`);
  console.log(`meta_stat ${summary.metadataStatus}`);
  console.log(`jsonl     ${summary.tokensJsonlPath}`);
  console.log(`csv       ${summary.tokensCsvPath}`);
  console.log(`summary   ${summary.outDir}\\summary.json`);
}

function firstTime(token) {
  return token?.createdAt ?? token?.graduatedAt ?? null;
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

function clampInt(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(`${name} precisa ser inteiro entre ${min} e ${max}.`);
    process.exit(1);
  }

  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`
Uso:
  $env:MORALIS_API_KEY = "..."
  npm run moralis:dump
  npm run moralis:dump -- --states=new
  npm run moralis:dump -- --states=graduated --days=14

Flags:
  --states=new,bonding,graduated
  --limit=N                   max 100
  --delay-ms=N                pausa entre requests
  --max-pages=N               limite por estado
  --allow-unbounded-bonding   permite bonding sem max-pages; bonding nao tem timestamp
  --days=N                    aplica cutoff em new/graduated
  --since=ISO                 cutoff absoluto em new/graduated
  --until=ISO                 fim absoluto em new/graduated
  --no-metadata               nao chama metadata batch
  --metadata-batch-size=N     max 100
  --out-dir=PATH              pasta de saida
`);
}
