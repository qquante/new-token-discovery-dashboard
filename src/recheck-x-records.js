import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createXChecker } from './twitter-x-check.js';

const DEFAULT_TWITTERAPI_IO_BASE_URL = 'https://api.twitterapi.io';
const options = parseArgs(process.argv.slice(2));

if (!process.env.TWITTERAPI_IO_KEY) {
  console.error('TWITTERAPI_IO_KEY ausente. Preencha .env.');
  process.exit(1);
}

const xChecker = createXChecker({
  apiKey: process.env.TWITTERAPI_IO_KEY,
  baseUrl: process.env.TWITTERAPI_IO_BASE_URL || DEFAULT_TWITTERAPI_IO_BASE_URL,
  timeoutMs: options.xTimeoutMs,
  cacheTtlMs: 0
});

const records = uniqueRecords(await readJsonl(options.logPath));
const selected = records.filter(matchesOptions).slice(-options.max);

if (!selected.length) {
  console.log('Nenhum registro encontrado para recheck.');
  process.exit(0);
}

console.log(`Rechecando ${selected.length} registro(s) em ${options.logPath}`);

for (const record of selected) {
  const xCheck = await xChecker.check({
    xProfile: record.xProfile,
    xUrl: record.twitter,
    mint: record.mint
  });
  const updated = {
    ...record,
    xCheck,
    xRecheck: {
      at: new Date().toISOString(),
      previousStatus: record.xCheck?.status ?? null,
      previousCheckedAt: record.xCheck?.checkedAt ?? null
    }
  };

  if (options.append) {
    await appendFile(options.logPath, `${JSON.stringify(updated)}\n`, 'utf8');
  }

  console.log(
    [
      `#${record.sequence ?? '-'}`,
      record.name ? JSON.stringify(record.name) : 'sem_nome',
      `mint=${record.mint}`,
      `old=${record.xCheck?.status ?? 'none'}`,
      `new=${xCheck.status}`,
      xCheck.mentionedMints?.length ? `mints=${xCheck.mentionedMints.join(',')}` : null,
      xCheck.recentTweetsSource ? `source=${xCheck.recentTweetsSource}` : null
    ]
      .filter(Boolean)
      .join(' ')
  );
}

if (options.append) {
  console.log('Atualizacoes anexadas ao JSONL. O dashboard usa a ultima linha por assinatura/mint.');
} else {
  console.log('Dry-run. Rode com --append para gravar as linhas corrigidas.');
}

function matchesOptions(record) {
  if (options.mints.size && !options.mints.has(record.mint)) {
    return false;
  }

  if (options.handles.size) {
    const handle = extractHandle(record.xProfile || record.twitter || '');
    if (!handle || !options.handles.has(handle.toLowerCase())) {
      return false;
    }
  }

  if (options.statuses.size && !options.statuses.has(record.xCheck?.status)) {
    return false;
  }

  return Boolean(record.mint && (record.xProfile || record.twitter));
}

async function readJsonl(path) {
  const text = await readFile(path, 'utf8');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseArgs(args) {
  const parsed = {
    date: new Date().toISOString().slice(0, 10),
    logPath: null,
    mints: new Set(),
    handles: new Set(),
    statuses: new Set(),
    max: 25,
    append: false,
    xTimeoutMs: 6000
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? null : arg.slice(equalsIndex + 1);
    const nextValue = () => inlineValue ?? args[++index];

    switch (key) {
      case '--date':
        parsed.date = nextValue();
        break;
      case '--log-path':
        parsed.logPath = nextValue();
        break;
      case '--mint':
        addCsv(parsed.mints, nextValue());
        break;
      case '--handle':
        addCsv(parsed.handles, nextValue().toLowerCase());
        break;
      case '--status':
        addCsv(parsed.statuses, nextValue());
        break;
      case '--max':
        parsed.max = Number.parseInt(nextValue(), 10);
        break;
      case '--x-timeout-ms':
        parsed.xTimeoutMs = Number.parseInt(nextValue(), 10);
        break;
      case '--append':
        parsed.append = true;
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

  if (!parsed.logPath) {
    parsed.logPath = resolve(process.cwd(), 'game-candidates', `pump-game-scan-${parsed.date}.jsonl`);
  }

  if (!Number.isFinite(parsed.max) || parsed.max <= 0) {
    console.error('--max precisa ser inteiro positivo.');
    process.exit(1);
  }

  if (!Number.isFinite(parsed.xTimeoutMs) || parsed.xTimeoutMs < 500) {
    console.error('--x-timeout-ms precisa ser inteiro >= 500.');
    process.exit(1);
  }

  return parsed;
}

function addCsv(set, value) {
  for (const item of String(value).split(',')) {
    const trimmed = item.trim();
    if (trimmed) {
      set.add(trimmed);
    }
  }
}

function extractHandle(value) {
  try {
    const parsed = new URL(String(value));
    const [handle] = parsed.pathname.split('/').filter(Boolean);
    return handle && !['i', 'home', 'search'].includes(handle.toLowerCase()) ? handle : null;
  } catch {
    return null;
  }
}

function uniqueRecords(records) {
  const map = new Map();
  for (const record of records) {
    map.set(record.signature ?? record.mint ?? String(record.sequence), record);
  }
  return [...map.values()];
}

function printHelp() {
  console.log(`
Uso:
  npm run x:recheck -- --mint=<mint> --append
  npm run x:recheck -- --handle=morganogoodrich --append
  npm run x:recheck -- --status=alpha_unposted --max=20 --append

Flags:
  --date=YYYY-MM-DD          data do JSONL. Default: hoje
  --log-path=PATH            caminho explicito do JSONL
  --mint=MINT[,MINT]         filtra mint(s)
  --handle=HANDLE[,HANDLE]   filtra handle(s) do X
  --status=STATUS[,STATUS]   filtra status anterior do xCheck
  --max=N                    maximo de registros. Default: 25
  --append                   grava linha corrigida no fim do JSONL
`);
}
