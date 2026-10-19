import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { classifyGameCandidate, inspectWebsite } from './game-classifier.js';
import { buildSocialFields, firstText } from './social-links.js';
import { createSkippedXCheck, createXChecker } from './twitter-x-check.js';
import { selectInitialXCheckMode } from './x-check-policy.js';
import { buildXRecheckDelays, shouldAutoRecheckX } from './x-recheck-schedule.js';

const DEFAULT_WS_URL = 'wss://pumpportal.fun/api/data';
const DEFAULT_FRONTEND_BASE_URL = 'https://frontend-api-v3.pump.fun';
const DEFAULT_TWITTERAPI_IO_BASE_URL = 'https://api.twitterapi.io';
const DEFAULT_TIME_ZONE = process.env.TZ || 'America/Sao_Paulo';

const options = parseArgs(process.argv.slice(2));
const xChecker = createXChecker({
  apiKey: options.twitterApiKey,
  baseUrl: options.twitterBaseUrl,
  timeoutMs: options.xTimeoutMs,
  includeReplies: options.xIncludeReplies,
  cacheTtlMs: options.xCacheTtlMs,
  profileCacheTtlMs: options.xProfileCacheTtlMs,
  pinnedCacheTtlMs: options.xPinnedCacheTtlMs
});
const xRecheckDelays = buildXRecheckDelays({
  fastEveryMs: options.xRecheckFastEveryMs,
  fastUntilMs: options.xRecheckFastUntilMs,
  slowEveryMs: options.xRecheckSlowEveryMs,
  untilMs: options.xRecheckUntilMs
});
const seenMints = new Set();
const xRecheckTimers = new Set();
let scannedCount = 0;
let candidateCount = 0;
let xRechecksInFlight = 0;
let shouldStop = false;
let ws;

if (typeof WebSocket === 'undefined') {
  console.error('Node atual nao expoe WebSocket global. Use Node >= 22.');
  process.exit(1);
}

process.on('SIGINT', () => {
  shouldStop = true;
  console.log('\nEncerrando game discovery...');
  clearXRecheckTimers();
  try {
    ws?.close();
  } catch {
    process.exit(0);
  }
});

await ensureLogPath(options.logPath);
await ensureLogPath(options.candidateLogPath);
printStartBanner(options);
connect(1);

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
      return;
    }

    if (!options.includeIncomplete && !hasLaunchMetadata(event)) {
      return;
    }

    if (seenMints.has(event.mint)) {
      return;
    }

    if (options.max !== null && scannedCount >= options.max) {
      return;
    }

    seenMints.add(event.mint);
    scannedCount += 1;
    void handleCreateEvent(event, receivedAtMs, scannedCount);

    if (options.max !== null && scannedCount >= options.max) {
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
  const [coinDetail, metadata] = await Promise.all([
    options.frontend ? fetchCoinDetail(event.mint) : null,
    options.metadata ? fetchMetadata(event.uri) : null
  ]);

  const socials = buildSocialFields({ coinDetail, metadata, mint: event.mint });
  const token = normalizeToken({ sequence, event, coinDetail, metadata, socials, receivedAtMs });
  const websiteEvidence =
    options.inspectSite && socials.website
      ? await inspectWebsite(socials.website, { timeoutMs: options.siteTimeoutMs })
      : null;
  const game = classifyGameCandidate({ token, socials, metadata, websiteEvidence });
  let record = {
    ...token,
    classification: game.classification,
    category: game.category,
    gameScore: game.score,
    gameBreakdown: {
      gameScore: game.gameScore,
      appScore: game.appScore,
      tags: game.tags,
      reasons: game.reasons
    },
    websiteEvidence,
    xCheck: null,
    enrichMs: null,
    rawEvent: event,
    detailSource: coinDetail ? 'frontend-api-v3' : null,
    metadataSource: metadata ? 'metadata_uri' : null
  };
  record.xCheck = await runInitialXCheck(record);
  const enrichedAtMs = Date.now();
  record = {
    ...record,
    enrichMs: enrichedAtMs - startedAtMs
  };

  await appendJsonl(options.logPath, record);

  const isCandidate = isCandidateRecord(record);
  if (isCandidate) {
    candidateCount += 1;
    beepCandidate();
    await appendJsonl(options.candidateLogPath, record);
  }

  scheduleXAutoRecheck(record, { candidateLogged: isCandidate });

  if (options.json) {
    if (options.printAll || isCandidate) {
      printJson(record);
    }
    return;
  }

  if (options.printAll || isCandidate) {
    printHuman(record, isCandidate);
  } else {
    printScanLine(record);
  }
}

async function runInitialXCheck(record) {
  if (!options.xCheck) {
    return null;
  }

  const mode = selectInitialXCheckMode(record, {
    minScore: options.minScore,
    linkedOnlyLowScore: options.xLinkedOnlyLowScore
  });

  if (mode === 'full') {
    return xChecker.check({
      xProfile: record.xProfile,
      xUrl: record.twitter,
      mint: record.mint,
      mode: 'full'
    });
  }

  if (mode === 'linked_only') {
    return xChecker.check({
      xProfile: record.xProfile,
      xUrl: record.twitter,
      mint: record.mint,
      mode: 'linked_only'
    });
  }

  return createSkippedXCheck({
    status: 'x_skipped_low_signal',
    reason: mode,
    xProfile: record.xProfile,
    xUrl: record.twitter
  });
}

function scheduleXAutoRecheck(record, { candidateLogged = false } = {}) {
  if (!options.xAutoRecheck || !options.xCheck || !shouldAutoRecheckX(record, { minScore: options.minScore })) {
    return;
  }

  const state = {
    record,
    startedAtMs: Date.now(),
    nextIndex: 0,
    candidateLogged
  };

  logVerbose(
    `x recheck agendado #${record.sequence} ${record.mint}: ${xRecheckDelays.length} checks ate ${Math.round(options.xRecheckUntilMs / 1000)}s`
  );
  scheduleNextXRecheck(state);
}

function scheduleNextXRecheck(state) {
  if (
    shouldStop ||
    state.nextIndex >= xRecheckDelays.length ||
    !shouldAutoRecheckX(state.record, { minScore: options.minScore })
  ) {
    return;
  }

  const delayMs = xRecheckDelays[state.nextIndex];
  const dueInMs = Math.max(0, state.startedAtMs + delayMs - Date.now());
  const timer = setTimeout(() => {
    xRecheckTimers.delete(timer);
    void runXAutoRecheck(state);
  }, dueInMs);
  timer.unref?.();
  xRecheckTimers.add(timer);
}

async function runXAutoRecheck(state) {
  if (shouldStop || !shouldAutoRecheckX(state.record, { minScore: options.minScore })) {
    return;
  }

  if (xRechecksInFlight >= options.xRecheckConcurrency) {
    const timer = setTimeout(() => {
      xRecheckTimers.delete(timer);
      void runXAutoRecheck(state);
    }, 1000);
    timer.unref?.();
    xRecheckTimers.add(timer);
    return;
  }

  const attempt = state.nextIndex + 1;
  const scheduledDelayMs = xRecheckDelays[state.nextIndex];
  const previousStatus = state.record.xCheck?.status ?? null;
  state.nextIndex += 1;
  xRechecksInFlight += 1;

  try {
    const xCheck = await xChecker.check({
      xProfile: state.record.xProfile,
      xUrl: state.record.twitter,
      mint: state.record.mint
    });
    const updatedRecord = {
      ...state.record,
      xCheck,
      xRecheck: {
        mode: 'auto',
        attempt,
        scheduledDelayMs,
        elapsedSinceInitialMs: Date.now() - state.startedAtMs,
        previousStatus,
        at: new Date().toISOString()
      }
    };

    state.record = updatedRecord;
    await appendJsonl(options.logPath, updatedRecord);

    const isCandidate = isCandidateRecord(updatedRecord);
    if (isCandidate && !state.candidateLogged) {
      state.candidateLogged = true;
      candidateCount += 1;
      beepCandidate();
      await appendJsonl(options.candidateLogPath, updatedRecord);
    }

    printXRecheckLine(updatedRecord, previousStatus, attempt);

    if (shouldAutoRecheckX(updatedRecord, { minScore: options.minScore })) {
      scheduleNextXRecheck(state);
    }
  } catch (error) {
    logControl(`xrecheck erro #${state.record.sequence} mint=${state.record.mint}: ${error.message}`);
    scheduleNextXRecheck(state);
  } finally {
    xRechecksInFlight -= 1;
  }
}

function clearXRecheckTimers() {
  for (const timer of xRecheckTimers) {
    clearTimeout(timer);
  }
  xRecheckTimers.clear();
}

function isCandidateRecord(record) {
  const isXRejected = ['x_mismatch_other_mint', 'x_conflict_many_other_mints'].includes(record.xCheck?.status);
  return record.gameScore >= options.minScore && record.classification !== 'not_game' && !isXRejected;
}

function printXRecheckLine(record, previousStatus, attempt) {
  const statusChanged = previousStatus !== record.xCheck?.status;
  const parts = [
    `xrecheck=${attempt}`,
    `scan=${record.sequence}`,
    statusChanged ? `changed=${previousStatus}->${record.xCheck?.status}` : `status=${record.xCheck?.status}`,
    record.xCheck?.recentTweetsSource ? `source=${record.xCheck.recentTweetsSource}` : null,
    record.xCheck?.mentionedMints?.length ? `xmints=${record.xCheck.mentionedMints.length}` : null,
    `mint=${record.mint}`,
    `name=${quoteTiny(record.name ?? '-')}`
  ].filter(Boolean);

  if (options.json) {
    printJson({
      kind: 'x_recheck',
      at: new Date().toISOString(),
      attempt,
      previousStatus,
      record
    });
    return;
  }

  console.log(parts.join(' '));
}

function normalizeToken({ sequence, event, coinDetail, metadata, socials, receivedAtMs }) {
  const frontendCreatedAtMs = normalizeTimestampMs(coinDetail?.created_timestamp);
  const eventCreatedAtMs =
    normalizeTimestampMs(event.created_timestamp) ??
    normalizeTimestampMs(event.timestamp) ??
    null;
  const launch = selectLaunchTime({
    eventCreatedAtMs,
    frontendCreatedAtMs,
    receivedAtMs
  });

  return {
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
    bondingCurve: coinDetail?.bonding_curve ?? event.bondingCurveKey ?? null
  };
}

async function fetchCoinDetail(mint) {
  const url = `${options.frontendBaseUrl}/coins/${encodeURIComponent(mint)}`;
  const delays = [0, 400];
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

  logVerbose(`frontend skipped ${mint}: ${lastError?.message ?? 'erro desconhecido'}`);
  return null;
}

async function fetchMetadata(uri) {
  if (!uri || !/^https?:\/\//i.test(uri)) {
    return null;
  }

  try {
    return await fetchJson(uri, options.metadataTimeoutMs);
  } catch (error) {
    logVerbose(`metadata skipped ${uri}: ${error.message}`);
    return null;
  }
}

async function fetchJson(url, timeoutMs, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      accept: 'application/json',
      'user-agent': 'pump-fun-game-discovery/0.1',
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
}

function printHuman(record, isCandidate) {
  const launch = record.launchAt ? `${formatTime(record.launchAt, options.timeZone)} (${record.launchSource})` : 'n/a';
  const score = `${record.gameScore} ${record.classification}/${record.category}`;
  const siteStatus = record.websiteEvidence
    ? `${record.websiteEvidence.status ?? 'n/a'} ${record.websiteEvidence.error ?? 'ok'} ${record.websiteEvidence.elapsedMs}ms`
    : 'not_checked';
  const tags = record.gameBreakdown.tags.length ? record.gameBreakdown.tags.join(', ') : 'none';
  const prefix = isCandidate ? 'CANDIDATE' : 'SCAN';

  console.log(
    compactLines([
      '',
      `${prefix} #${record.sequence} ${record.name ?? 'sem nome'} (${record.symbol ?? 'sem simbolo'})`,
      `score     ${score}`,
      `tags      ${tags}`,
      `mint      ${record.mint}`,
      `launch    ${launch}`,
      `creator   ${record.creator ?? 'n/a'}`,
      `pump      ${record.pumpUrl}`,
      `site      ${record.website ?? 'n/a'}`,
      `site chk  ${siteStatus}`,
      record.websiteEvidence?.title ? `title     ${truncate(record.websiteEvidence.title, 140)}` : null,
      `x profile ${record.xProfile ?? 'n/a'}`,
      record.twitter && record.twitter !== record.xProfile ? `x link    ${record.twitter}` : null,
      `telegram  ${record.telegram ?? 'n/a'}`,
      record.xCheck ? `x check   ${formatXCheck(record.xCheck)}` : null,
      record.xCheck?.mentionedMints?.length ? `x mints   ${record.xCheck.mentionedMints.join(' | ')}` : null,
      record.xCheck?.evidence?.length ? `x ev      ${formatXEvidence(record.xCheck.evidence[0])}` : null,
      record.links?.length ? `links     ${record.links.join(' | ')}` : null,
      `desc      ${record.description ? truncate(record.description, 220) : 'n/a'}`,
      `metadata  ${record.metadataUri ?? 'n/a'}`,
      `tx        ${record.signature ?? 'n/a'}`
    ]).join('\n')
  );
}

function printScanLine(record) {
  console.log(
    [
      `scan=${record.sequence}`,
      `candidates=${candidateCount}`,
      `score=${record.gameScore}`,
      `class=${record.classification}`,
      `x=${record.xCheck?.status ?? 'off'}`,
      record.xCheck?.mentionedMints?.length ? `xmints=${record.xCheck.mentionedMints.length}` : null,
      `mint=${record.mint}`,
      `name=${quoteTiny(record.name ?? '-')}`
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function printStartBanner(parsed) {
  console.log('Pump.fun game discovery - READ ONLY');
  console.log(`WS          ${parsed.wsUrl}`);
  console.log(`frontend    ${parsed.frontend ? parsed.frontendBaseUrl : 'disabled'}`);
  console.log(`metadata    ${parsed.metadata ? 'enabled' : 'disabled'}`);
  console.log(`site check  ${parsed.inspectSite ? `enabled timeout=${parsed.siteTimeoutMs}ms` : 'disabled'}`);
  console.log(
    `x check     ${
      parsed.xCheck
        ? `enabled ${parsed.twitterBaseUrl} timeout=${parsed.xTimeoutMs}ms replies=${parsed.xIncludeReplies ? 'yes' : 'no'} profileCache=${parsed.xProfileCacheTtlMs / 1000}s pinnedCache=${parsed.xPinnedCacheTtlMs / 1000}s`
        : parsed.twitterApiKey
          ? 'disabled by flag'
          : 'disabled missing TWITTERAPI_IO_KEY'
    }`
  );
  console.log(
    `x recheck   ${
      parsed.xCheck && parsed.xAutoRecheck
        ? `enabled every=${parsed.xRecheckFastEveryMs / 1000}s until=${parsed.xRecheckFastUntilMs / 1000}s then=${parsed.xRecheckSlowEveryMs / 1000}s until=${parsed.xRecheckUntilMs / 1000}s concurrency=${parsed.xRecheckConcurrency}`
        : 'disabled'
    }`
  );
  console.log(
    `x policy    full only for game/app candidates; low-score linked status ${
      parsed.xLinkedOnlyLowScore ? 'checked' : 'skipped'
    }`
  );
  console.log('timestamp   frontend/event only');
  console.log(`min score   ${parsed.minScore}`);
  console.log(`beep        ${parsed.beep ? `enabled mode=${parsed.beepMode} count=${parsed.beepCount}` : 'disabled'}`);
  console.log(`log         ${parsed.logPath}`);
  console.log(`candidates  ${parsed.candidateLogPath}`);
  console.log('Aguardando tokens novos...\n');
}

function parseArgs(args) {
  const parsed = {
    wsUrl: process.env.PUMPPORTAL_WS_URL || DEFAULT_WS_URL,
    frontendBaseUrl: process.env.PUMP_FRONTEND_BASE_URL || DEFAULT_FRONTEND_BASE_URL,
    timeZone: DEFAULT_TIME_ZONE,
    max: null,
    minScore: 4,
    reconnect: true,
    frontend: true,
    metadata: true,
    inspectSite: true,
    includeIncomplete: false,
    printAll: false,
    verbose: false,
    beep: true,
    beepMode: process.platform === 'win32' ? 'both' : 'terminal',
    beepCount: 2,
    json: false,
    metadataTimeoutMs: 1800,
    frontendTimeoutMs: 1800,
    siteTimeoutMs: 2200,
    xCheck: Boolean(process.env.TWITTERAPI_IO_KEY),
    twitterApiKey: process.env.TWITTERAPI_IO_KEY || null,
    twitterBaseUrl: process.env.TWITTERAPI_IO_BASE_URL || DEFAULT_TWITTERAPI_IO_BASE_URL,
    xTimeoutMs: 4500,
    xIncludeReplies: false,
    xCacheTtlMs: 0,
    xProfileCacheTtlMs: 60_000,
    xPinnedCacheTtlMs: 60_000,
    xLinkedOnlyLowScore: false,
    xAutoRecheck: true,
    xRecheckFastEveryMs: 5_000,
    xRecheckFastUntilMs: 60_000,
    xRecheckSlowEveryMs: 30_000,
    xRecheckUntilMs: 5 * 60_000,
    xRecheckConcurrency: 2,
    logPath: defaultLogPath('pump-game-scan'),
    candidateLogPath: defaultLogPath('pump-game-candidates')
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : arg.slice(equalsIndex + 1);
    const nextValue = () => inlineValue ?? args[++index];

    switch (key) {
      case '--ws-url':
        parsed.wsUrl = nextValue();
        break;
      case '--frontend-base-url':
        parsed.frontendBaseUrl = trimTrailingSlash(nextValue());
        break;
      case '--tz':
        parsed.timeZone = nextValue();
        break;
      case '--max':
        parsed.max = Number.parseInt(nextValue(), 10);
        break;
      case '--min-score':
        parsed.minScore = Number.parseInt(nextValue(), 10);
        break;
      case '--metadata-timeout-ms':
        parsed.metadataTimeoutMs = Number.parseInt(nextValue(), 10);
        break;
      case '--frontend-timeout-ms':
        parsed.frontendTimeoutMs = Number.parseInt(nextValue(), 10);
        break;
      case '--site-timeout-ms':
        parsed.siteTimeoutMs = Number.parseInt(nextValue(), 10);
        break;
      case '--x-timeout-ms':
        parsed.xTimeoutMs = Number.parseInt(nextValue(), 10);
        break;
      case '--x-cache-ttl-ms':
        parsed.xCacheTtlMs = Number.parseInt(nextValue(), 10);
        break;
      case '--x-profile-cache-ttl-ms':
        parsed.xProfileCacheTtlMs = Number.parseInt(nextValue(), 10);
        break;
      case '--x-pinned-cache-ttl-ms':
        parsed.xPinnedCacheTtlMs = Number.parseInt(nextValue(), 10);
        break;
      case '--x-recheck-fast-every-ms':
        parsed.xRecheckFastEveryMs = Number.parseInt(nextValue(), 10);
        break;
      case '--x-recheck-fast-until-ms':
        parsed.xRecheckFastUntilMs = Number.parseInt(nextValue(), 10);
        break;
      case '--x-recheck-slow-every-ms':
        parsed.xRecheckSlowEveryMs = Number.parseInt(nextValue(), 10);
        break;
      case '--x-recheck-until-ms':
        parsed.xRecheckUntilMs = Number.parseInt(nextValue(), 10);
        break;
      case '--x-recheck-concurrency':
        parsed.xRecheckConcurrency = Number.parseInt(nextValue(), 10);
        break;
      case '--twitterapi-base-url':
        parsed.twitterBaseUrl = trimTrailingSlash(nextValue());
        break;
      case '--log-path':
        parsed.logPath = nextValue();
        break;
      case '--candidate-log-path':
        parsed.candidateLogPath = nextValue();
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
      case '--no-site-inspection':
        parsed.inspectSite = false;
        break;
      case '--x-check':
        parsed.xCheck = true;
        break;
      case '--no-x-check':
        parsed.xCheck = false;
        break;
      case '--x-auto-recheck':
        parsed.xAutoRecheck = true;
        break;
      case '--no-x-auto-recheck':
        parsed.xAutoRecheck = false;
        break;
      case '--x-include-replies':
        parsed.xIncludeReplies = true;
        break;
      case '--x-linked-only-low-score':
        parsed.xLinkedOnlyLowScore = true;
        break;
      case '--no-x-linked-only-low-score':
        parsed.xLinkedOnlyLowScore = false;
        break;
      case '--include-incomplete':
        parsed.includeIncomplete = true;
        break;
      case '--print-all':
        parsed.printAll = true;
        break;
      case '--verbose':
        parsed.verbose = true;
        break;
      case '--beep-count':
        parsed.beepCount = Number.parseInt(nextValue(), 10);
        break;
      case '--beep-mode':
        parsed.beepMode = nextValue();
        break;
      case '--no-beep':
        parsed.beep = false;
        break;
      case '--json':
        parsed.json = true;
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

  if (!Number.isFinite(parsed.minScore) || parsed.minScore < 0) {
    console.error('--min-score precisa ser um inteiro >= 0.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.beepCount) || parsed.beepCount < 1) {
    console.error('--beep-count precisa ser um inteiro >= 1.');
    process.exit(1);
  }

  if (!['terminal', 'windows', 'both'].includes(parsed.beepMode)) {
    console.error('--beep-mode precisa ser terminal, windows ou both.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.xTimeoutMs) || parsed.xTimeoutMs < 500) {
    console.error('--x-timeout-ms precisa ser um inteiro >= 500.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.xCacheTtlMs) || parsed.xCacheTtlMs < 0) {
    console.error('--x-cache-ttl-ms precisa ser um inteiro >= 0.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.xProfileCacheTtlMs) || parsed.xProfileCacheTtlMs < 0) {
    console.error('--x-profile-cache-ttl-ms precisa ser um inteiro >= 0.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.xPinnedCacheTtlMs) || parsed.xPinnedCacheTtlMs < 0) {
    console.error('--x-pinned-cache-ttl-ms precisa ser um inteiro >= 0.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.xRecheckFastEveryMs) || parsed.xRecheckFastEveryMs < 1000) {
    console.error('--x-recheck-fast-every-ms precisa ser um inteiro >= 1000.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.xRecheckFastUntilMs) || parsed.xRecheckFastUntilMs < parsed.xRecheckFastEveryMs) {
    console.error('--x-recheck-fast-until-ms precisa ser >= --x-recheck-fast-every-ms.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.xRecheckSlowEveryMs) || parsed.xRecheckSlowEveryMs < 1000) {
    console.error('--x-recheck-slow-every-ms precisa ser um inteiro >= 1000.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.xRecheckUntilMs) || parsed.xRecheckUntilMs < parsed.xRecheckFastUntilMs) {
    console.error('--x-recheck-until-ms precisa ser >= --x-recheck-fast-until-ms.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.xRecheckConcurrency) || parsed.xRecheckConcurrency < 1) {
    console.error('--x-recheck-concurrency precisa ser um inteiro >= 1.');
    process.exit(1);
  }

  if (parsed.xCheck && !parsed.twitterApiKey) {
    console.error('TWITTERAPI_IO_KEY ausente. Preencha .env ou rode com --no-x-check.');
    process.exit(1);
  }

  parsed.frontendBaseUrl = trimTrailingSlash(parsed.frontendBaseUrl);
  parsed.twitterBaseUrl = trimTrailingSlash(parsed.twitterBaseUrl);
  return parsed;
}

function printHelp() {
  console.log(`
Uso:
  npm run watch:games
  npm run watch:games -- --print-all
  npm run watch:games -- --max=10 --print-all
  npm run watch:games -- --min-score=6

Flags:
  --max=N                    encerra depois de N tokens escaneados
  --min-score=N              minimo para imprimir/salvar candidato. Default: 4
  --print-all                imprime todos os tokens, nao so candidatos
  --no-beep                  desliga alerta sonoro/terminal bell em candidato
  --beep-count=N             quantidade de bips por candidato. Default: 2
  --beep-mode=terminal|windows|both
  --no-site-inspection       nao baixa HTML do site
  --no-x-check               desliga checagem X/Twitter mesmo com TWITTERAPI_IO_KEY
  --x-check                  exige checagem X/Twitter. Requer TWITTERAPI_IO_KEY
  --x-timeout-ms=N           timeout por chamada na TwitterAPI.io. Default: 4500
  --x-include-replies        inclui replies nos ultimos 20 tweets
  --x-profile-cache-ttl-ms=N cache de user/info. Default: 60000
  --x-pinned-cache-ttl-ms=N  cache de pinned tweets. Default: 60000
  --x-linked-only-low-score  tambem checa tweet/status linkado em tokens low-score/not_game
  --no-x-auto-recheck        desliga recheck automatico de status provisorios
  --x-recheck-concurrency=N  maximo de rechecks X simultaneos. Default: 2
                             X completo roda so para candidatos game/app; low-score pula X por default
  --no-metadata              nao busca metadata_uri/IPFS
  --no-frontend              nao busca /coins/{mint}
  --verbose                  mostra erros de frontend/metadata
  --json                     imprime JSON por linha
`);
}

function logControl(message) {
  if (options.json) {
    printJson({ kind: 'control', at: new Date().toISOString(), message });
    return;
  }

  console.log(`[${formatTime(Date.now(), options.timeZone)}] ${message}`);
}

function logVerbose(message) {
  if (options.verbose) {
    logControl(message);
  }
}

function printJson(value) {
  console.log(JSON.stringify(value));
}

function beepCandidate() {
  if (!options.beep || options.json) {
    return;
  }

  if (options.beepMode === 'terminal' || options.beepMode === 'both') {
    process.stdout.write('\u0007'.repeat(options.beepCount));
  }

  if ((options.beepMode === 'windows' || options.beepMode === 'both') && process.platform === 'win32') {
    const commands = Array.from({ length: options.beepCount }, (_, index) => {
      const frequency = index % 2 === 0 ? 1200 : 1600;
      return `[Console]::Beep(${frequency}, 180)`;
    }).join('; Start-Sleep -Milliseconds 80; ');
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', commands], {
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  }
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

function defaultLogPath(prefix) {
  const date = new Date().toISOString().slice(0, 10);
  return resolve(process.cwd(), 'game-candidates', `${prefix}-${date}.jsonl`);
}

function hasLaunchMetadata(event) {
  return Boolean(event.name || event.symbol || event.uri);
}

function selectLaunchTime({ eventCreatedAtMs, frontendCreatedAtMs, receivedAtMs }) {
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

function quoteTiny(value) {
  return JSON.stringify(truncate(value, 48));
}

function formatXCheck(xCheck) {
  const bits = [
    xCheck.status,
    xCheck.handle ? `@${xCheck.handle}` : null,
    Number.isFinite(xCheck.elapsedMs) ? `${xCheck.elapsedMs}ms` : null,
    xCheck.cacheHit ? 'cache' : null,
    xCheck.recentTweetsChecked !== undefined ? `tweets=${xCheck.recentTweetsChecked}` : null,
    xCheck.pinnedTweetsChecked !== undefined ? `pinned=${xCheck.pinnedTweetsChecked}` : null,
    xCheck.linkedTweetsChecked ? `linked=${xCheck.linkedTweetsChecked}` : null,
    xCheck.otherMints?.length ? `other=${xCheck.otherMints.length}` : null,
    xCheck.error ? `err=${truncate(xCheck.error, 80)}` : null,
    xCheck.apiMessage && xCheck.status === 'x_profile_unavailable' ? `msg=${truncate(xCheck.apiMessage, 80)}` : null
  ].filter(Boolean);

  return bits.join(' ');
}

function formatXEvidence(evidence) {
  return [
    evidence.source,
    evidence.matched,
    evidence.mint,
    evidence.tweetId ? `tweet=${evidence.tweetId}` : null,
    evidence.text ? truncate(evidence.text, 140) : null
  ]
    .filter(Boolean)
    .join(' ');
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

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
