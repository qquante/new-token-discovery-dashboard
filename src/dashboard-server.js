import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const DASHBOARD_DIR = resolve(ROOT_DIR, 'dashboard');
const LOG_DIR = resolve(ROOT_DIR, 'game-candidates');
const HOST = process.env.DASHBOARD_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.DASHBOARD_PORT || '8787', 10);
const DEFAULT_LIMIT = 5000;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (url.pathname === '/') {
      await sendFile(response, join(DASHBOARD_DIR, 'index.html'));
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(response, {
        ok: true,
        at: new Date().toISOString(),
        logDir: LOG_DIR
      });
      return;
    }

    if (url.pathname === '/api/dates') {
      sendJson(response, await listLogDates());
      return;
    }

    if (url.pathname === '/api/records') {
      const date = normalizeDate(url.searchParams.get('date')) || todayDate();
      const limit = positiveInt(url.searchParams.get('limit'), DEFAULT_LIMIT);
      const records = uniqueRecords(await readRecords(date, limit));
      sendJson(response, {
        date,
        logPath: logPathForDate(date),
        count: records.length,
        summary: summarizeRecords(records),
        records: records.map(compactRecord)
      });
      return;
    }

    if (url.pathname === '/api/stream') {
      const date = normalizeDate(url.searchParams.get('date')) || todayDate();
      await streamRecords(request, response, date);
      return;
    }

    if (url.pathname.startsWith('/assets/')) {
      await sendFile(response, safeAssetPath(url.pathname));
      return;
    }

    sendText(response, 404, 'not found');
  } catch (error) {
    console.error(error);
    sendJson(response, { ok: false, error: error.message }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pump.fun game dashboard: http://${HOST}:${PORT}`);
  console.log(`Lendo logs de: ${LOG_DIR}`);
});

async function listLogDates() {
  await ensureLogDirExists();
  const files = await readdir(LOG_DIR);
  const dates = files
    .map((file) => file.match(/^pump-game-scan-(\d{4}-\d{2}-\d{2})\.jsonl$/)?.[1])
    .filter(Boolean)
    .sort()
    .reverse();

  return {
    dates,
    today: todayDate()
  };
}

async function readRecords(date, limit) {
  const path = logPathForDate(date);
  let text;

  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  return lines.slice(-limit).map((line) => parseRecord(line)).filter(Boolean);
}

async function streamRecords(request, response, date) {
  const path = logPathForDate(date);
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });

  sendSse(response, 'ready', {
    date,
    logPath: path,
    at: new Date().toISOString()
  });

  let offset = await fileSize(path);
  let carry = '';
  const interval = setInterval(async () => {
    try {
      const size = await fileSize(path);
      if (size < offset) {
        offset = 0;
        carry = '';
      }

      if (size > offset) {
        const chunk = await readFileRange(path, offset, size - 1);
        offset = size;
        const text = carry + chunk;
        const lines = text.split(/\r?\n/);
        carry = lines.pop() ?? '';

        for (const line of lines) {
          const record = parseRecord(line);
          if (record) {
            sendSse(response, 'record', compactRecord(record));
          }
        }
      } else {
        sendSse(response, 'ping', { at: new Date().toISOString() });
      }
    } catch (error) {
      sendSse(response, 'error', { message: error.message });
    }
  }, 1000);

  request.on('close', () => {
    clearInterval(interval);
  });
}

function summarizeRecords(records) {
  const summary = {
    total: records.length,
    candidates: 0,
    gameOrApp: 0,
    alphaUnposted: 0,
    xConfirmed: 0,
    xRedFlags: 0,
    xNeedsReview: 0,
    xNoProfile: 0,
    xChecked: 0,
    siteOk: 0
  };

  for (const record of records) {
    if (record.classification && record.classification !== 'not_game') {
      summary.gameOrApp += 1;
    }

    if (record.websiteEvidence?.ok) {
      summary.siteOk += 1;
    }

    if (record.gameScore >= 4 && record.classification !== 'not_game') {
      summary.candidates += 1;
    }

    const status = record.xCheck?.status;
    if (!status) {
      continue;
    }

    if (!['x_no_profile', 'x_not_configured'].includes(status)) {
      summary.xChecked += 1;
    }

    if (status === 'alpha_unposted') {
      summary.alphaUnposted += 1;
    } else if (status === 'x_confirmed_current_mint') {
      summary.xConfirmed += 1;
    } else if (['x_mismatch_other_mint', 'x_conflict_many_other_mints'].includes(status)) {
      summary.xRedFlags += 1;
    } else if (['x_mixed_mints', 'x_mentions_pump_unclear', 'x_linked_status_no_mint'].includes(status)) {
      summary.xNeedsReview += 1;
    } else if (status === 'x_no_profile') {
      summary.xNoProfile += 1;
    }
  }

  return summary;
}

function uniqueRecords(records) {
  const map = new Map();
  for (const record of records) {
    map.set(recordKey(record), record);
  }
  return [...map.values()];
}

function recordKey(record) {
  return record.signature ?? record.mint ?? String(record.sequence);
}

function compactRecord(record) {
  return {
    sequence: record.sequence ?? null,
    mint: record.mint ?? null,
    signature: record.signature ?? null,
    name: record.name ?? null,
    symbol: record.symbol ?? null,
    creator: record.creator ?? null,
    launchAt: record.launchAt ?? null,
    receivedAt: record.receivedAt ?? null,
    latencyMs: record.latencyMs ?? null,
    enrichMs: record.enrichMs ?? null,
    image: record.image ?? null,
    description: record.description ?? null,
    pumpUrl: record.pumpUrl ?? (record.mint ? `https://pump.fun/coin/${record.mint}` : null),
    website: record.website ?? null,
    twitter: record.twitter ?? null,
    xProfile: record.xProfile ?? null,
    telegram: record.telegram ?? null,
    links: record.links ?? [],
    marketCapSol: record.marketCapSol ?? null,
    usdMarketCap: record.usdMarketCap ?? null,
    classification: record.classification ?? null,
    category: record.category ?? null,
    gameScore: record.gameScore ?? 0,
    gameBreakdown: record.gameBreakdown ?? null,
    websiteEvidence: compactWebsiteEvidence(record.websiteEvidence),
    xCheck: compactXCheck(record.xCheck),
    raw: record
  };
}

function compactWebsiteEvidence(value) {
  if (!value) {
    return null;
  }

  return {
    ok: Boolean(value.ok),
    status: value.status ?? null,
    url: value.url ?? null,
    finalUrl: value.finalUrl ?? null,
    title: value.title ?? null,
    description: value.description ?? null,
    signals: value.signals ?? [],
    elapsedMs: value.elapsedMs ?? null,
    error: value.error ?? null
  };
}

function compactXCheck(value) {
  if (!value) {
    return null;
  }

  return {
    enabled: Boolean(value.enabled),
    status: value.status ?? null,
    handle: value.handle ?? null,
    requestedHandle: value.requestedHandle ?? null,
    profileUrl: value.profileUrl ?? null,
    checkedAt: value.checkedAt ?? null,
    elapsedMs: value.elapsedMs ?? null,
    fetchElapsedMs: value.fetchElapsedMs ?? null,
    cacheHit: Boolean(value.cacheHit),
    profileFetched: Boolean(value.profileFetched),
    profile: value.profile ?? null,
    includeReplies: Boolean(value.includeReplies),
    recentTweetsSource: value.recentTweetsSource ?? null,
    recentTweetsChecked: value.recentTweetsChecked ?? null,
    pinnedTweetsChecked: value.pinnedTweetsChecked ?? null,
    linkedTweetIds: value.linkedTweetIds ?? [],
    linkedTweetsChecked: value.linkedTweetsChecked ?? null,
    mentionedMints: value.mentionedMints ?? [],
    mentionsCurrentMint: Boolean(value.mentionsCurrentMint),
    otherMints: value.otherMints ?? [],
    mentionsPumpUnclear: Boolean(value.mentionsPumpUnclear),
    linkedTweetWithoutMint: Boolean(value.linkedTweetWithoutMint),
    evidence: value.evidence ?? [],
    errors: value.errors ?? [],
    apiStatus: value.apiStatus ?? null,
    apiMessage: value.apiMessage ?? null,
    error: value.error ?? null
  };
}

function parseRecord(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function sendSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function sendFile(response, path) {
  const bytes = await readFile(path);
  response.writeHead(200, {
    'content-type': contentType(path),
    'cache-control': 'no-cache'
  });
  response.end(bytes);
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache'
  });
  response.end(JSON.stringify(value));
}

function sendText(response, status, text) {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-cache'
  });
  response.end(text);
}

function safeAssetPath(pathname) {
  const name = basename(pathname);
  const path = resolve(DASHBOARD_DIR, name);

  if (!path.startsWith(DASHBOARD_DIR)) {
    throw new Error('invalid asset path');
  }

  return path;
}

function logPathForDate(date) {
  return resolve(LOG_DIR, `pump-game-scan-${date}.jsonl`);
}

function normalizeDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) ? String(value) : null;
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function ensureLogDirExists() {
  try {
    await stat(LOG_DIR);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

function readFileRange(path, start, end) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    const stream = createReadStream(path, { start, end, encoding: 'utf8' });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(chunks.join('')));
  });
}

function contentType(path) {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'application/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}
