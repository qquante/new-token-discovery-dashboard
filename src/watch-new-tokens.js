import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildSocialFields, firstText } from './social-links.js';

const DEFAULT_WS_URL = 'wss://pumpportal.fun/api/data';
const DEFAULT_FRONTEND_BASE_URL = 'https://frontend-api-v3.pump.fun';
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
const DEFAULT_TIME_ZONE = process.env.TZ || 'America/Sao_Paulo';

const options = parseArgs(process.argv.slice(2));
const seenMints = new Set();
const pendingRecords = new Map();
let eventCount = 0;
let nextEmitSequence = 1;
let isFlushingRecords = false;
let shouldStop = false;
let ws;

if (typeof WebSocket === 'undefined') {
  console.error('Node atual nao expoe WebSocket global. Use Node >= 22.');
  process.exit(1);
}

process.on('SIGINT', () => {
  shouldStop = true;
  console.log('\nEncerrando monitor...');
  try {
    ws?.close();
  } catch {
    process.exit(0);
  }
});

await ensureLogPath(options.logPath);
printStartBanner(options);
connect(1);

function parseArgs(args) {
  const parsed = {
    wsUrl: process.env.PUMPPORTAL_WS_URL || DEFAULT_WS_URL,
    frontendBaseUrl: process.env.PUMP_FRONTEND_BASE_URL || DEFAULT_FRONTEND_BASE_URL,
    rpcUrl: process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL,
    timeZone: DEFAULT_TIME_ZONE,
    max: null,
    reconnect: true,
    frontend: true,
    metadata: true,
    rpcTime: true,
    includeIncomplete: false,
    json: false,
    metadataTimeoutMs: 3500,
    frontendTimeoutMs: 3500,
    rpcTimeoutMs: 5000,
    logPath: defaultLogPath()
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [key, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const nextValue = () => inlineValue ?? args[++index];

    switch (key) {
      case '--ws-url':
        parsed.wsUrl = nextValue();
        break;
      case '--frontend-base-url':
        parsed.frontendBaseUrl = trimTrailingSlash(nextValue());
        break;
      case '--rpc-url':
        parsed.rpcUrl = nextValue();
        break;
      case '--tz':
        parsed.timeZone = nextValue();
        break;
      case '--max':
        parsed.max = Number.parseInt(nextValue(), 10);
        break;
      case '--metadata-timeout-ms':
        parsed.metadataTimeoutMs = Number.parseInt(nextValue(), 10);
        break;
      case '--frontend-timeout-ms':
        parsed.frontendTimeoutMs = Number.parseInt(nextValue(), 10);
        break;
      case '--rpc-timeout-ms':
        parsed.rpcTimeoutMs = Number.parseInt(nextValue(), 10);
        break;
      case '--log-path':
        parsed.logPath = nextValue();
        break;
      case '--no-reconnect':
        parsed.reconnect = false;
        break;
      case '--no-frontend':
        parsed.frontend = false;
        break;
      case '--no-metadata':
        parsed.metadata = false;
        break;
      case '--rpc-time':
        parsed.rpcTime = true;
        break;
      case '--no-rpc-time':
        parsed.rpcTime = false;
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--include-incomplete':
        parsed.includeIncomplete = true;
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

  if (parsed.max !== null && (!Number.isFinite(parsed.max) || parsed.max <= 0)) {
    console.error('--max precisa ser um inteiro positivo.');
    process.exit(1);
  }

  parsed.frontendBaseUrl = trimTrailingSlash(parsed.frontendBaseUrl);
  return parsed;
}

function connect(attempt) {
  ws = new WebSocket(options.wsUrl);

  ws.addEventListener('open', () => {
    logControl(`WS conectado: ${options.wsUrl}`);
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  });

  ws.addEventListener('message', (message) => {
    const receivedAtMs = Date.now();
    const rawText = String(message.data);
    let event;

    try {
      event = JSON.parse(rawText);
    } catch {
      logControl(`Mensagem nao JSON: ${rawText}`);
      return;
    }

    if (event.message) {
      logControl(event.message);
      return;
    }

    if (event.txType !== 'create' || !event.mint) {
      if (options.json) {
        printJson({ kind: 'ignored', receivedAt: new Date(receivedAtMs).toISOString(), event });
      }
      return;
    }

    if (!options.includeIncomplete && !hasLaunchMetadata(event)) {
      if (options.json) {
        printJson({ kind: 'ignored_incomplete_create', receivedAt: new Date(receivedAtMs).toISOString(), event });
      }
      return;
    }

    if (seenMints.has(event.mint)) {
      return;
    }

    if (options.max !== null && eventCount >= options.max) {
      return;
    }

    seenMints.add(event.mint);
    eventCount += 1;
    void handleCreateEvent(event, receivedAtMs, eventCount);

    if (options.max !== null && eventCount >= options.max) {
      shouldStop = true;
      ws.close();
    }
  });

  ws.addEventListener('error', (error) => {
    logControl(`WS erro: ${error.message || String(error)}`);
  });

  ws.addEventListener('close', () => {
    if (shouldStop || !options.reconnect) {
      logControl('WS fechado.');
      return;
    }

    const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    logControl(`WS fechado. Reconectando em ${delayMs}ms...`);
    setTimeout(() => connect(attempt + 1), delayMs);
  });
}

async function handleCreateEvent(event, receivedAtMs, sequence) {
  const startedAtMs = Date.now();
  const [coinDetail, metadata, rpcBlockTimeMs] = await Promise.all([
    options.frontend ? fetchCoinDetail(event.mint) : null,
    options.metadata ? fetchMetadata(event.uri) : null,
    options.rpcTime && event.signature ? fetchRpcBlockTime(event.signature) : null
  ]);

  const frontendCreatedAtMs = normalizeTimestampMs(coinDetail?.created_timestamp);
  const eventCreatedAtMs =
    normalizeTimestampMs(event.created_timestamp) ??
    normalizeTimestampMs(event.timestamp) ??
    null;
  const launch = selectLaunchTime({
    rpcBlockTimeMs,
    eventCreatedAtMs,
    frontendCreatedAtMs,
    receivedAtMs
  });

  const enrichedAtMs = Date.now();
  const socials = buildSocialFields({ coinDetail, metadata, mint: event.mint });
  const record = {
    sequence,
    mint: event.mint,
    signature: event.signature ?? null,
    name: coinDetail?.name ?? metadata?.name ?? event.name ?? null,
    symbol: coinDetail?.symbol ?? metadata?.symbol ?? event.symbol ?? null,
    creator: coinDetail?.creator ?? event.traderPublicKey ?? null,
    txType: event.txType,
    pool: event.pool ?? coinDetail?.pool ?? null,
    launchAt: launch.ms ? new Date(launch.ms).toISOString() : null,
    launchSource: launch.source,
    frontendCreatedAt: frontendCreatedAtMs ? new Date(frontendCreatedAtMs).toISOString() : null,
    receivedAt: new Date(receivedAtMs).toISOString(),
    latencyMs: launch.ms ? receivedAtMs - launch.ms : null,
    enrichMs: enrichedAtMs - startedAtMs,
    metadataUri: coinDetail?.metadata_uri ?? event.uri ?? null,
    image: coinDetail?.image_uri ?? metadata?.image ?? null,
    description: firstText(coinDetail?.description, metadata?.description),
    pumpUrl: socials.pumpUrl,
    website: socials.website,
    twitter: socials.twitter,
    xProfile: socials.xProfile,
    telegram: socials.telegram,
    links: socials.extraLinks,
    marketCapSol: numberOrNull(event.marketCapSol ?? coinDetail?.market_cap),
    usdMarketCap: numberOrNull(coinDetail?.usd_market_cap),
    bondingCurve: coinDetail?.bonding_curve ?? event.bondingCurveKey ?? null,
    rawEvent: event,
    detailSource: coinDetail ? 'frontend-api-v3' : null,
    metadataSource: metadata ? 'metadata_uri' : null,
    rpcBlockTime: rpcBlockTimeMs ? new Date(rpcBlockTimeMs).toISOString() : null
  };

  await queueRecord(record);
}

async function fetchCoinDetail(mint) {
  const url = `${options.frontendBaseUrl}/coins/${encodeURIComponent(mint)}`;
  const delays = [0, 500, 1500];
  let lastError;

  for (const delayMs of delays) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      return await fetchJson(url, options.frontendTimeoutMs);
    } catch (error) {
      lastError = error;
    }
  }

  logControl(`Falha frontend ${mint}: ${lastError?.message ?? 'erro desconhecido'}`);
  return null;
}

async function fetchMetadata(uri) {
  if (!uri || !/^https?:\/\//i.test(uri)) {
    return null;
  }

  try {
    return await fetchJson(uri, options.metadataTimeoutMs);
  } catch (error) {
    logControl(`Falha metadata ${uri}: ${error.message}`);
    return null;
  }
}

async function fetchRpcBlockTime(signature) {
  const body = {
    jsonrpc: '2.0',
    id: `pump-${Date.now()}`,
    method: 'getTransaction',
    params: [
      signature,
      {
        encoding: 'json',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      }
    ]
  };

  try {
    const response = await fetchJson(options.rpcUrl, options.rpcTimeoutMs, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    return response?.result?.blockTime ? response.result.blockTime * 1000 : null;
  } catch (error) {
    logControl(`Falha RPC ${signature}: ${error.message}`);
    return null;
  }
}

async function fetchJson(url, timeoutMs, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'pump-fun-game-readonly-monitor/0.1',
        ...(init.headers ?? {})
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new Error('empty JSON response');
    }

    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error(`invalid JSON: ${error.message}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function printHuman(record, timeZone) {
  const launch = record.launchAt ? `${formatTime(record.launchAt, timeZone)} (${record.launchSource})` : 'n/a';
  const received = formatTime(record.receivedAt, timeZone);
  const latency = formatDuration(record.latencyMs);
  const usd = record.usdMarketCap === null ? 'n/a' : `$${formatNumber(record.usdMarketCap, 2)}`;
  const sol = record.marketCapSol === null ? 'n/a' : `${formatNumber(record.marketCapSol, 4)} SOL`;

  console.log(
    compactLines([
      '',
      `#${record.sequence} ${record.name ?? 'sem nome'} (${record.symbol ?? 'sem simbolo'})`,
      `mint      ${record.mint}`,
      `launch    ${launch}`,
      `received  ${received}`,
      `latency   ${latency} | enrich ${record.enrichMs}ms`,
      `creator   ${record.creator ?? 'n/a'}`,
      `mcap      ${sol} | ${usd}`,
      `pump      ${record.pumpUrl}`,
      `site      ${record.website ?? 'n/a'}`,
      `x profile ${record.xProfile ?? 'n/a'}`,
      record.twitter && record.twitter !== record.xProfile ? `x link    ${record.twitter}` : null,
      `telegram  ${record.telegram ?? 'n/a'}`,
      record.links?.length ? `links     ${record.links.join(' | ')}` : null,
      `desc      ${record.description ? truncate(record.description, 220) : 'n/a'}`,
      `metadata  ${record.metadataUri ?? 'n/a'}`,
      `image     ${record.image ?? 'n/a'}`,
      `tx        ${record.signature ?? 'n/a'}`
    ]).join('\n')
  );
}

async function queueRecord(record) {
  pendingRecords.set(record.sequence, record);
  await flushRecords();
}

async function flushRecords() {
  if (isFlushingRecords) {
    return;
  }

  isFlushingRecords = true;
  try {
    while (pendingRecords.has(nextEmitSequence)) {
      const record = pendingRecords.get(nextEmitSequence);
      pendingRecords.delete(nextEmitSequence);
      await appendJsonl(options.logPath, record);

      if (options.json) {
        printJson(record);
      } else {
        printHuman(record, options.timeZone);
      }

      nextEmitSequence += 1;
    }
  } finally {
    isFlushingRecords = false;
  }
}

function printStartBanner(parsed) {
  console.log('Pump.fun new token monitor - READ ONLY');
  console.log(`WS        ${parsed.wsUrl}`);
  console.log(`frontend  ${parsed.frontend ? parsed.frontendBaseUrl : 'disabled'}`);
  console.log(`metadata  ${parsed.metadata ? 'enabled' : 'disabled'}`);
  console.log(`rpc time  ${parsed.rpcTime ? parsed.rpcUrl : 'disabled'}`);
  console.log(`timezone  ${parsed.timeZone}`);
  console.log(`log       ${parsed.logPath}`);
  console.log('Aguardando tokens novos...\n');
}

function logControl(message) {
  if (options.json) {
    printJson({ kind: 'control', at: new Date().toISOString(), message });
    return;
  }

  console.log(`[${formatTime(Date.now(), options.timeZone)}] ${message}`);
}

function printJson(value) {
  console.log(JSON.stringify(value));
}

async function appendJsonl(logPath, record) {
  if (!logPath) {
    return;
  }

  await appendFile(logPath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function ensureLogPath(logPath) {
  if (!logPath) {
    return;
  }

  await mkdir(dirname(logPath), { recursive: true });
}

function defaultLogPath() {
  const date = new Date().toISOString().slice(0, 10);
  return resolve(process.cwd(), 'logs', `pump-new-tokens-${date}.jsonl`);
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

function hasLaunchMetadata(event) {
  return Boolean(event.name || event.symbol || event.uri);
}

function selectLaunchTime({ rpcBlockTimeMs, eventCreatedAtMs, frontendCreatedAtMs, receivedAtMs }) {
  if (rpcBlockTimeMs) {
    return { ms: rpcBlockTimeMs, source: 'rpc_blockTime' };
  }

  if (eventCreatedAtMs) {
    return { ms: eventCreatedAtMs, source: 'event_timestamp' };
  }

  if (frontendCreatedAtMs && Math.abs(receivedAtMs - frontendCreatedAtMs) <= 15 * 60 * 1000) {
    return { ms: frontendCreatedAtMs, source: 'frontend_created_timestamp' };
  }

  if (frontendCreatedAtMs) {
    return { ms: null, source: 'frontend_created_timestamp_stale_ignored' };
  }

  return { ms: null, source: null };
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function compactLines(lines) {
  return lines.filter((line) => line !== null && line !== undefined);
}

function truncate(value, maxLength) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function formatTime(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false
  }).format(date);
}

function formatDuration(ms) {
  if (ms === null || ms === undefined) {
    return 'n/a';
  }

  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs < 1000) {
    return `${sign}${abs}ms`;
  }

  return `${sign}${(abs / 1000).toFixed(3)}s`;
}

function formatNumber(value, decimals) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals
  }).format(value);
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
  npm run watch
  npm run watch -- --max=10
  npm run watch -- --no-metadata
  npm run watch -- --no-frontend
  npm run watch -- --rpc-time
  npm run watch -- --json

Flags:
  --max=N                    encerra depois de N tokens
  --ws-url=URL               sobrescreve WebSocket
  --frontend-base-url=URL    sobrescreve frontend API
  --rpc-url=URL              sobrescreve Solana RPC para --rpc-time
  --rpc-time                 busca blockTime via getTransaction
  --no-rpc-time              desliga busca de blockTime via RPC
  --include-incomplete       tambem mostra create sem name/symbol/uri no WS
  --no-frontend              nao busca /coins/{mint}
  --no-metadata              nao busca metadata_uri/IPFS
  --json                     imprime JSON por linha
  --log-path=PATH            caminho do JSONL, vazio desativa
  --tz=America/Sao_Paulo     timezone da saida humana
`);
}
