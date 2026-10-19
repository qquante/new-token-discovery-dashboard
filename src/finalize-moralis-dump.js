import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const targetDir = process.argv[2];

if (!targetDir) {
  console.error('Uso: node src/finalize-moralis-dump.js <dump-dir>');
  process.exit(1);
}

const outDir = resolve(process.cwd(), targetDir);
const files = (await readdir(outDir)).filter((file) => file.endsWith('.tokens.raw.jsonl'));
const byMint = new Map();
const stateCounts = {};
let rawLines = 0;

for (const file of files) {
  const text = await readFile(resolve(outDir, file), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    rawLines += 1;
    const token = JSON.parse(line);
    const mint = token.tokenAddress;
    if (!mint) {
      continue;
    }

    stateCounts[token.moralisState] = (stateCounts[token.moralisState] ?? 0) + 1;
    const existing = byMint.get(mint) ?? {
      tokenAddress: mint,
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

    byMint.set(mint, existing);
  }
}

const records = [...byMint.values()];
records.sort((a, b) => (Date.parse(b.createdAt ?? b.graduatedAt ?? 0) || 0) - (Date.parse(a.createdAt ?? a.graduatedAt ?? 0) || 0));

await writeFile(resolve(outDir, 'tokens.merged.partial.jsonl'), records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
await writeFile(resolve(outDir, 'tokens.merged.partial.csv'), toCsv(records), 'utf8');

const timestamps = records
  .map((record) => Date.parse(record.createdAt ?? record.graduatedAt))
  .filter((value) => Number.isFinite(value));
const summary = {
  mode: 'moralis-pumpfun-finalize-partial',
  finalizedAt: new Date().toISOString(),
  outDir,
  rawFiles: files,
  rawLines,
  stateCounts,
  uniqueTokens: records.length,
  newestAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
  oldestAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
  jsonlPath: resolve(outDir, 'tokens.merged.partial.jsonl'),
  csvPath: resolve(outDir, 'tokens.merged.partial.csv')
};

await writeFile(resolve(outDir, 'summary.partial.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(summary, null, 2));

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
    'logo'
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
      record.logo
    ].map(csvValue).join(',')
  );

  return `${header.join(',')}\n${rows.join('\n')}\n`;
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
