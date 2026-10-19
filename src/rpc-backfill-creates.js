import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_IDL_URL = 'https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json';
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
const DEFAULT_TIME_ZONE = process.env.TZ || 'America/Sao_Paulo';
const DAY_MS = 24 * 60 * 60 * 1000;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEXES = new Map([...BASE58_ALPHABET].map((char, index) => [char, index]));

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  remaining() {
    return this.bytes.length - this.offset;
  }

  readU32() {
    this.require(4);
    const value =
      this.bytes[this.offset] |
      (this.bytes[this.offset + 1] << 8) |
      (this.bytes[this.offset + 2] << 16) |
      (this.bytes[this.offset + 3] << 24);
    this.offset += 4;
    return value >>> 0;
  }

  readString() {
    const length = this.readU32();
    this.require(length);
    const value = new TextDecoder().decode(this.bytes.subarray(this.offset, this.offset + length));
    this.offset += length;
    return value;
  }

  readPubkey() {
    this.require(32);
    const value = base58Encode(this.bytes.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return value;
  }

  readBool() {
    this.require(1);
    const value = this.bytes[this.offset] !== 0;
    this.offset += 1;
    return value;
  }

  require(length) {
    if (this.remaining() < length) {
      throw new Error(`decode underflow need=${length} remaining=${this.remaining()}`);
    }
  }
}

const FALLBACK_CREATE_INSTRUCTIONS = [
  {
    name: 'create',
    discriminator: [24, 30, 200, 40, 5, 28, 7, 119],
    accounts: [
      { name: 'mint' },
      { name: 'mint_authority' },
      { name: 'bonding_curve' },
      { name: 'associated_bonding_curve' },
      { name: 'global' },
      { name: 'mpl_token_metadata' },
      { name: 'metadata' },
      { name: 'user' },
      { name: 'system_program' },
      { name: 'token_program' },
      { name: 'associated_token_program' },
      { name: 'rent' },
      { name: 'event_authority' },
      { name: 'program' }
    ]
  },
  {
    name: 'create_v2',
    discriminator: [214, 144, 76, 236, 95, 139, 49, 180],
    accounts: [
      { name: 'mint' },
      { name: 'mint_authority' },
      { name: 'bonding_curve' },
      { name: 'associated_bonding_curve' },
      { name: 'global' },
      { name: 'user' },
      { name: 'system_program' },
      { name: 'token_program' },
      { name: 'associated_token_program' },
      { name: 'mayhem_program_id' },
      { name: 'global_params' },
      { name: 'sol_vault' },
      { name: 'mayhem_state' },
      { name: 'mayhem_token_vault' },
      { name: 'event_authority' },
      { name: 'program' }
    ]
  }
];

const options = parseArgs(process.argv.slice(2));
const seenSignatures = new Set();
const stats = {
  signaturePages: 0,
  signaturesFetched: 0,
  signaturesInWindow: 0,
  signaturesSkippedErr: 0,
  transactionsRequested: 0,
  transactionsFetched: 0,
  transactionsNull: 0,
  transactionsFailed: 0,
  createsFound: 0,
  oldestSignatureMs: null,
  newestSignatureMs: null,
  oldestCreateMs: null,
  newestCreateMs: null
};

await mkdir(options.outDir, { recursive: true });
await mkdir(resolve(options.outDir, 'raw-pages'), { recursive: true });
await writeFile(options.createsCsvPath, csvHeader() + '\n', 'utf8');

printStart(options);
const instructionMap = await loadCreateInstructionMap();
const stopReason = await backfillCreates(instructionMap);
const summary = {
  mode: 'rpc-pumpfun-create-backfill',
  startedAt: options.startedAt,
  finishedAt: new Date().toISOString(),
  stopReason,
  programId: PUMP_PROGRAM_ID,
  idlUrl: PUMP_IDL_URL,
  rpcUrl: redactedRpcUrl(options.rpcUrl),
  commitment: options.commitment,
  since: new Date(options.sinceMs).toISOString(),
  until: new Date(options.untilMs).toISOString(),
  maxSignaturePages: options.maxSignaturePages,
  maxTransactions: options.maxTransactions,
  stats,
  outDir: options.outDir,
  signaturesJsonlPath: options.signaturesJsonlPath,
  createsJsonlPath: options.createsJsonlPath,
  createsCsvPath: options.createsCsvPath
};

await writeFile(options.summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');
printSummary(summary);

async function backfillCreates(instructionMap) {
  if (options.signatures.length) {
    const directSignatures = options.signatures.map((signature) => ({
      signature,
      slot: null,
      err: null,
      memo: null,
      blockTime: null,
      confirmationStatus: null
    }));
    stats.signaturesFetched += directSignatures.length;
    stats.signaturesInWindow += directSignatures.length;
    await appendFile(
      options.signaturesJsonlPath,
      directSignatures.map((signatureInfo) => JSON.stringify({ fetchedAt: new Date().toISOString(), direct: true, ...signatureInfo })).join('\n') + '\n',
      'utf8'
    );
    await processSignatures(directSignatures, instructionMap);
    return 'direct_signatures';
  }

  let before = options.before;
  let stopReason = 'completed';

  while (true) {
    if (options.maxSignaturePages !== null && stats.signaturePages >= options.maxSignaturePages) {
      stopReason = 'max_signature_pages';
      break;
    }

    if (options.maxTransactions !== null && stats.transactionsRequested >= options.maxTransactions) {
      stopReason = 'max_transactions';
      break;
    }

    const pageStartedAt = Date.now();
    const page = await fetchSignaturePage(before);
    stats.signaturePages += 1;

    await appendFile(
      options.signaturePagesJsonlPath,
      JSON.stringify({ page: stats.signaturePages, fetchedAt: new Date().toISOString(), before, result: page }) + '\n',
      'utf8'
    );

    if (!page.length) {
      stopReason = 'empty_signature_page';
      break;
    }

    stats.signaturesFetched += page.length;
    before = page.at(-1).signature;

    const pageWindow = [];
    let pageNewerThanUntil = 0;
    let pageOlderThanSince = 0;
    let pageSkippedErr = 0;
    let pageDuplicates = 0;
    let pageOldestMs = null;
    let pageNewestMs = null;

    for (const signatureInfo of page) {
      const blockTimeMs = normalizeBlockTimeMs(signatureInfo.blockTime);
      if (blockTimeMs !== null) {
        pageOldestMs = pageOldestMs === null ? blockTimeMs : Math.min(pageOldestMs, blockTimeMs);
        pageNewestMs = pageNewestMs === null ? blockTimeMs : Math.max(pageNewestMs, blockTimeMs);
        stats.oldestSignatureMs =
          stats.oldestSignatureMs === null ? blockTimeMs : Math.min(stats.oldestSignatureMs, blockTimeMs);
        stats.newestSignatureMs =
          stats.newestSignatureMs === null ? blockTimeMs : Math.max(stats.newestSignatureMs, blockTimeMs);
      }

      await appendFile(
        options.signaturesJsonlPath,
        JSON.stringify({ page: stats.signaturePages, fetchedAt: new Date().toISOString(), ...signatureInfo }) + '\n',
        'utf8'
      );

      if (seenSignatures.has(signatureInfo.signature)) {
        pageDuplicates += 1;
        continue;
      }
      seenSignatures.add(signatureInfo.signature);

      if (blockTimeMs !== null && blockTimeMs > options.untilMs) {
        pageNewerThanUntil += 1;
        continue;
      }

      if (blockTimeMs !== null && blockTimeMs < options.sinceMs) {
        pageOlderThanSince += 1;
        continue;
      }

      if (!options.includeFailedSignatures && signatureInfo.err) {
        pageSkippedErr += 1;
        stats.signaturesSkippedErr += 1;
        continue;
      }

      pageWindow.push(signatureInfo);
    }

    stats.signaturesInWindow += pageWindow.length;
    printSignaturePageProgress({
      elapsedMs: Date.now() - pageStartedAt,
      page: stats.signaturePages,
      fetched: page.length,
      inWindow: pageWindow.length,
      newerThanUntil: pageNewerThanUntil,
      olderThanSince: pageOlderThanSince,
      skippedErr: pageSkippedErr,
      duplicates: pageDuplicates,
      pageOldestMs,
      pageNewestMs
    });

    const remainingTransactions =
      options.maxTransactions === null ? pageWindow.length : Math.max(0, options.maxTransactions - stats.transactionsRequested);
    const signaturesToProcess = pageWindow.slice(0, remainingTransactions);
    await processSignatures(signaturesToProcess, instructionMap);

    if (options.maxTransactions !== null && stats.transactionsRequested >= options.maxTransactions) {
      stopReason = 'max_transactions';
      break;
    }

    if (pageOldestMs !== null && pageOldestMs < options.sinceMs) {
      stopReason = 'reached_since';
      break;
    }
  }

  return stopReason;
}

async function fetchSignaturePage(before) {
  const config = {
    commitment: options.commitment,
    limit: options.signatureLimit
  };

  if (before) {
    config.before = before;
  }

  return rpcCall('getSignaturesForAddress', [PUMP_PROGRAM_ID, config]);
}

async function processSignatures(signatureInfos, instructionMap) {
  if (!signatureInfos.length) {
    return;
  }

  let next = 0;
  const workers = Array.from({ length: Math.min(options.txConcurrency, signatureInfos.length) }, async () => {
    while (next < signatureInfos.length) {
      const current = next;
      next += 1;
      await processSignature(signatureInfos[current], instructionMap);
      if (options.txDelayMs > 0) {
        await sleep(options.txDelayMs);
      }
    }
  });

  await Promise.all(workers);
}

async function processSignature(signatureInfo, instructionMap) {
  stats.transactionsRequested += 1;

  let transaction;
  try {
    transaction = await fetchTransaction(signatureInfo.signature);
  } catch (error) {
    stats.transactionsFailed += 1;
    console.log(`tx_error signature=${signatureInfo.signature} error=${error.message}`);
    return;
  }

  if (!transaction) {
    stats.transactionsNull += 1;
    return;
  }

  stats.transactionsFetched += 1;
  await appendFile(
    options.transactionsJsonlPath,
    JSON.stringify({ fetchedAt: new Date().toISOString(), signatureInfo, transaction }) + '\n',
    'utf8'
  );

  if (!options.includeFailedTransactions && transaction.meta?.err) {
    return;
  }

  const records = extractCreateRecords(transaction, signatureInfo, instructionMap);
  if (!records.length) {
    printTxProgress(false);
    return;
  }

  stats.createsFound += records.length;
  for (const record of records) {
    const createdMs = normalizeBlockTimeMs(record.blockTime);
    if (createdMs !== null) {
      stats.oldestCreateMs = stats.oldestCreateMs === null ? createdMs : Math.min(stats.oldestCreateMs, createdMs);
      stats.newestCreateMs = stats.newestCreateMs === null ? createdMs : Math.max(stats.newestCreateMs, createdMs);
    }
  }

  await appendFile(options.createsJsonlPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
  await appendFile(options.createsCsvPath, records.map(toCsvLine).join('\n') + '\n', 'utf8');

  if (options.printCreates) {
    for (const record of records) {
      printCreate(record);
    }
  }
  printTxProgress(true);
}

async function fetchTransaction(signature) {
  return rpcCall('getTransaction', [
    signature,
    {
      encoding: 'json',
      commitment: options.commitment,
      maxSupportedTransactionVersion: 0
    }
  ]);
}

function extractCreateRecords(transaction, signatureInfo, instructionMap) {
  const keys = accountKeysForTransaction(transaction);
  const topLevelInstructions = transaction.transaction?.message?.instructions ?? [];
  const innerInstructionGroups = transaction.meta?.innerInstructions ?? [];
  const records = [];

  for (let instructionIndex = 0; instructionIndex < topLevelInstructions.length; instructionIndex += 1) {
    const record = decodeInstructionRecord({
      transaction,
      signatureInfo,
      instruction: topLevelInstructions[instructionIndex],
      instructionMap,
      keys,
      instructionIndex,
      parentInstructionIndex: null,
      source: 'top_level'
    });

    if (record) {
      records.push(record);
    }
  }

  for (const group of innerInstructionGroups) {
    const innerInstructions = group.instructions ?? [];
    for (let instructionIndex = 0; instructionIndex < innerInstructions.length; instructionIndex += 1) {
      const record = decodeInstructionRecord({
        transaction,
        signatureInfo,
        instruction: innerInstructions[instructionIndex],
        instructionMap,
        keys,
        instructionIndex,
        parentInstructionIndex: group.index ?? null,
        source: 'inner'
      });

      if (record) {
        records.push(record);
      }
    }
  }

  return records;
}

function decodeInstructionRecord({
  transaction,
  signatureInfo,
  instruction,
  instructionMap,
  keys,
  instructionIndex,
  parentInstructionIndex,
  source
}) {
  const programId = instruction.programId ?? keys[instruction.programIdIndex] ?? null;
  if (programId !== PUMP_PROGRAM_ID) {
    return null;
  }

  let data;
  try {
    data = instructionDataBytes(instruction.data);
  } catch {
    return null;
  }

  if (data.length < 8) {
    return null;
  }

  const discriminatorHex = bytesToHex(data.subarray(0, 8));
  const idlInstruction = instructionMap.get(discriminatorHex);
  if (!idlInstruction) {
    return null;
  }

  let decoded;
  try {
    decoded = decodeCreateArgs(idlInstruction.name, data.subarray(8));
  } catch (error) {
    decoded = { decodeError: error.message };
  }

  const resolvedAccounts = resolveInstructionAccounts(instruction.accounts ?? [], keys);
  const accountByName = mapAccountsByName(idlInstruction.accounts ?? [], resolvedAccounts);
  const blockTime = transaction.blockTime ?? signatureInfo.blockTime ?? null;
  const signature = transaction.transaction?.signatures?.[0] ?? signatureInfo.signature;
  const mint = accountByName.mint ?? resolvedAccounts[0] ?? null;
  const user = accountByName.user ?? null;

  return {
    signature,
    slot: transaction.slot ?? signatureInfo.slot ?? null,
    blockTime,
    blockTimeIso: blockTime ? new Date(blockTime * 1000).toISOString() : null,
    confirmationStatus: signatureInfo.confirmationStatus ?? null,
    instructionName: idlInstruction.name,
    instructionSource: source,
    instructionIndex,
    parentInstructionIndex,
    discriminatorHex,
    mint,
    user,
    creator: decoded.creator ?? null,
    name: decoded.name ?? null,
    symbol: decoded.symbol ?? null,
    uri: decoded.uri ?? null,
    isMayhemMode: decoded.isMayhemMode ?? null,
    isCashbackEnabled: decoded.isCashbackEnabled ?? null,
    decodeError: decoded.decodeError ?? null,
    pumpUrl: mint ? `https://pump.fun/coin/${mint}` : null,
    accounts: accountByName,
    rawAccounts: resolvedAccounts
  };
}

function decodeCreateArgs(instructionName, bytes) {
  const reader = new ByteReader(bytes);
  const name = reader.readString();
  const symbol = reader.readString();
  const uri = reader.readString();
  const creator = reader.readPubkey();

  if (instructionName === 'create') {
    return { name, symbol, uri, creator };
  }

  if (instructionName === 'create_v2') {
    return {
      name,
      symbol,
      uri,
      creator,
      isMayhemMode: reader.readBool(),
      isCashbackEnabled: reader.remaining() > 0 ? reader.readBool() : null
    };
  }

  return { name, symbol, uri, creator };
}

async function loadCreateInstructionMap() {
  let instructions = FALLBACK_CREATE_INSTRUCTIONS;
  let idlStatus = 'fallback';

  if (options.fetchIdl) {
    try {
      const response = await fetch(PUMP_IDL_URL, {
        headers: { 'user-agent': 'pump-fun-game-rpc-backfill/0.1' },
        signal: AbortSignal.timeout(options.requestTimeoutMs)
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const idl = await response.json();
      instructions = idl.instructions.filter((instruction) => instruction.name === 'create' || instruction.name === 'create_v2');
      idlStatus = `loaded ${PUMP_IDL_URL}`;
    } catch (error) {
      idlStatus = `fallback after IDL fetch failed: ${error.message}`;
    }
  }

  console.log(`idl       ${idlStatus}`);
  const instructionMap = new Map();
  for (const instruction of instructions) {
    instructionMap.set(bytesToHex(Uint8Array.from(instruction.discriminator)), instruction);
  }
  return instructionMap;
}

async function rpcCall(method, params, attempt = 1) {
  let response;
  let text;
  try {
    response = await fetch(options.rpcUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'pump-fun-game-rpc-backfill/0.1'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `${method}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        method,
        params
      }),
      signal: AbortSignal.timeout(options.requestTimeoutMs)
    });
    text = await response.text();
  } catch (error) {
    if (attempt <= options.retryCount) {
      await sleep(backoffMs(attempt));
      return rpcCall(method, params, attempt + 1);
    }
    throw error;
  }

  if (!response.ok) {
    if ((response.status === 429 || response.status >= 500) && attempt <= options.retryCount) {
      await sleep(backoffMs(attempt));
      return rpcCall(method, params, attempt + 1);
    }
    throw new Error(`RPC HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const envelope = JSON.parse(text);
  if (envelope.error) {
    const message = `${envelope.error.code ?? 'rpc_error'} ${envelope.error.message ?? JSON.stringify(envelope.error)}`;
    if (attempt <= options.retryCount && isRetryableRpcError(envelope.error)) {
      await sleep(backoffMs(attempt));
      return rpcCall(method, params, attempt + 1);
    }
    throw new Error(`RPC ${message}`);
  }

  return envelope.result;
}

function isRetryableRpcError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('too many') || message.includes('rate') || message.includes('timeout') || message.includes('try again');
}

function accountKeysForTransaction(transaction) {
  const staticKeys = (transaction.transaction?.message?.accountKeys ?? []).map(accountKeyToString);
  const loadedWritable = (transaction.meta?.loadedAddresses?.writable ?? []).map(accountKeyToString);
  const loadedReadonly = (transaction.meta?.loadedAddresses?.readonly ?? []).map(accountKeyToString);
  return [...staticKeys, ...loadedWritable, ...loadedReadonly];
}

function accountKeyToString(accountKey) {
  if (typeof accountKey === 'string') {
    return accountKey;
  }
  if (typeof accountKey?.pubkey === 'string') {
    return accountKey.pubkey;
  }
  return String(accountKey);
}

function resolveInstructionAccounts(accounts, keys) {
  if (!Array.isArray(accounts)) {
    return [];
  }
  return accounts.map((accountIndex) => keys[accountIndex] ?? String(accountIndex));
}

function mapAccountsByName(idlAccounts, resolvedAccounts) {
  const mapped = {};
  for (let index = 0; index < idlAccounts.length; index += 1) {
    const name = idlAccounts[index]?.name ?? `account_${index}`;
    mapped[name] = resolvedAccounts[index] ?? null;
  }
  return mapped;
}

function instructionDataBytes(data) {
  if (Array.isArray(data)) {
    return Uint8Array.from(data);
  }
  if (typeof data !== 'string') {
    throw new Error('instruction data missing');
  }
  return base58Decode(data);
}

function base58Decode(value) {
  if (!value) {
    return new Uint8Array();
  }

  const bytes = [0];
  for (const char of value) {
    const carryStart = BASE58_INDEXES.get(char);
    if (carryStart === undefined) {
      throw new Error(`invalid base58 char ${char}`);
    }

    let carry = carryStart;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (const char of value) {
    if (char !== '1') {
      break;
    }
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

function base58Encode(bytes) {
  if (!bytes.length) {
    return '';
  }

  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index] * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }
    digits.push(0);
  }

  return digits.reverse().map((digit) => BASE58_ALPHABET[digit]).join('');
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeBlockTimeMs(blockTime) {
  if (typeof blockTime !== 'number' || !Number.isFinite(blockTime)) {
    return null;
  }
  return blockTime * 1000;
}

function toCsvLine(record) {
  return [
    record.signature,
    record.slot,
    record.blockTime,
    record.blockTimeIso,
    record.instructionName,
    record.instructionSource,
    record.instructionIndex,
    record.parentInstructionIndex,
    record.mint,
    record.user,
    record.creator,
    record.name,
    record.symbol,
    record.uri,
    record.isMayhemMode,
    record.isCashbackEnabled,
    record.decodeError,
    record.pumpUrl,
    JSON.stringify(record.accounts)
  ].map(csvCell).join(',');
}

function csvHeader() {
  return [
    'signature',
    'slot',
    'block_time',
    'created_at',
    'instruction_name',
    'instruction_source',
    'instruction_index',
    'parent_instruction_index',
    'mint',
    'user',
    'creator',
    'name',
    'symbol',
    'uri',
    'is_mayhem_mode',
    'is_cashback_enabled',
    'decode_error',
    'pump_url',
    'accounts_json'
  ].join(',');
}

function csvCell(value) {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function printStart(parsed) {
  console.log('Pump.fun RPC create backfill - READ ONLY');
  console.log(`program   ${PUMP_PROGRAM_ID}`);
  console.log(`rpc       ${redactedRpcUrl(parsed.rpcUrl)}`);
  console.log(`window    ${new Date(parsed.sinceMs).toISOString()} -> ${new Date(parsed.untilMs).toISOString()}`);
  console.log(`out       ${parsed.outDir}`);
  console.log(`limits    signature_pages=${parsed.maxSignaturePages ?? 'none'} tx=${parsed.maxTransactions ?? 'none'} concurrency=${parsed.txConcurrency}`);
  console.log('');
}

function printSignaturePageProgress(progress) {
  console.log(
    [
      `sig_page=${progress.page}`,
      `fetched=${progress.fetched}`,
      `window=${progress.inWindow}`,
      `newer=${progress.newerThanUntil}`,
      `older=${progress.olderThanSince}`,
      `err=${progress.skippedErr}`,
      `dup=${progress.duplicates}`,
      `oldest=${progress.pageOldestMs ? new Date(progress.pageOldestMs).toISOString() : '-'}`,
      `newest=${progress.pageNewestMs ? new Date(progress.pageNewestMs).toISOString() : '-'}`,
      `elapsed=${progress.elapsedMs}ms`
    ].join(' ')
  );
}

function printTxProgress(found) {
  if (found || stats.transactionsRequested % 25 === 0) {
    console.log(
      [
        `tx=${stats.transactionsRequested}`,
        `fetched=${stats.transactionsFetched}`,
        `null=${stats.transactionsNull}`,
        `failed=${stats.transactionsFailed}`,
        `creates=${stats.createsFound}`
      ].join(' ')
    );
  }
}

function printCreate(record) {
  console.log('');
  console.log(`#${stats.createsFound} ${record.name ?? '-'} (${record.symbol ?? '-'})`);
  console.log(`mint      ${record.mint ?? '-'}`);
  console.log(`creator   ${record.creator ?? record.user ?? '-'}`);
  console.log(`created   ${record.blockTimeIso ?? '-'}`);
  console.log(`uri       ${record.uri ?? '-'}`);
  console.log(`pump      ${record.pumpUrl ?? '-'}`);
  console.log(`tx        https://solscan.io/tx/${record.signature}`);
}

function printSummary(summary) {
  console.log('');
  console.log('Resumo RPC create');
  console.log(`stop      ${summary.stopReason}`);
  console.log(`pages     ${summary.stats.signaturePages}`);
  console.log(`sigs      fetched=${summary.stats.signaturesFetched} window=${summary.stats.signaturesInWindow}`);
  console.log(`tx        requested=${summary.stats.transactionsRequested} fetched=${summary.stats.transactionsFetched} null=${summary.stats.transactionsNull} failed=${summary.stats.transactionsFailed}`);
  console.log(`creates   ${summary.stats.createsFound}`);
  console.log(`createwin ${summary.stats.oldestCreateMs ? new Date(summary.stats.oldestCreateMs).toISOString() : '-'} -> ${summary.stats.newestCreateMs ? new Date(summary.stats.newestCreateMs).toISOString() : '-'}`);
  console.log(`csv       ${summary.createsCsvPath}`);
  console.log(`jsonl     ${summary.createsJsonlPath}`);
}

function parseArgs(args) {
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replaceAll(':', '-').replace(/\.\d{3}Z$/, '');
  const parsed = {
    startedAt,
    rpcUrl: process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL,
    days: 14,
    sinceMs: null,
    untilMs: Date.now(),
    before: null,
    outDir: null,
    commitment: 'finalized',
    signatureLimit: 1000,
    maxSignaturePages: null,
    maxTransactions: null,
    txConcurrency: 2,
    txDelayMs: 50,
    requestTimeoutMs: 30000,
    retryCount: 5,
    signatures: [],
    includeFailedSignatures: false,
    includeFailedTransactions: false,
    printCreates: false,
    fetchIdl: true
  };

  const nextValue = (index, inline) => {
    if (inline !== undefined) {
      return inline;
    }
    const value = args[index + 1];
    if (!value) {
      throw new Error(`Valor ausente para ${args[index]}`);
    }
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const equalsIndex = args[index].indexOf('=');
    const flag = equalsIndex === -1 ? args[index] : args[index].slice(0, equalsIndex);
    const inline = equalsIndex === -1 ? undefined : args[index].slice(equalsIndex + 1);
    switch (flag) {
      case '--rpc-url':
        parsed.rpcUrl = nextValue(index, inline);
        index += inline === undefined ? 1 : 0;
        break;
      case '--days':
        parsed.days = Number.parseFloat(nextValue(index, inline));
        index += inline === undefined ? 1 : 0;
        break;
      case '--since':
        parsed.sinceMs = Date.parse(nextValue(index, inline));
        index += inline === undefined ? 1 : 0;
        break;
      case '--until':
        parsed.untilMs = Date.parse(nextValue(index, inline));
        index += inline === undefined ? 1 : 0;
        break;
      case '--before':
        parsed.before = nextValue(index, inline);
        index += inline === undefined ? 1 : 0;
        break;
      case '--signature':
        parsed.signatures.push(nextValue(index, inline));
        index += inline === undefined ? 1 : 0;
        break;
      case '--out-dir':
        parsed.outDir = nextValue(index, inline);
        index += inline === undefined ? 1 : 0;
        break;
      case '--commitment':
        parsed.commitment = nextValue(index, inline);
        index += inline === undefined ? 1 : 0;
        break;
      case '--signature-limit':
        parsed.signatureLimit = Number.parseInt(nextValue(index, inline), 10);
        index += inline === undefined ? 1 : 0;
        break;
      case '--max-signature-pages':
      case '--max-pages':
        parsed.maxSignaturePages = Number.parseInt(nextValue(index, inline), 10);
        index += inline === undefined ? 1 : 0;
        break;
      case '--max-transactions':
      case '--max-tx':
        parsed.maxTransactions = Number.parseInt(nextValue(index, inline), 10);
        index += inline === undefined ? 1 : 0;
        break;
      case '--tx-concurrency':
        parsed.txConcurrency = Number.parseInt(nextValue(index, inline), 10);
        index += inline === undefined ? 1 : 0;
        break;
      case '--tx-delay-ms':
        parsed.txDelayMs = Number.parseInt(nextValue(index, inline), 10);
        index += inline === undefined ? 1 : 0;
        break;
      case '--request-timeout-ms':
        parsed.requestTimeoutMs = Number.parseInt(nextValue(index, inline), 10);
        index += inline === undefined ? 1 : 0;
        break;
      case '--retry-count':
        parsed.retryCount = Number.parseInt(nextValue(index, inline), 10);
        index += inline === undefined ? 1 : 0;
        break;
      case '--include-failed-signatures':
        parsed.includeFailedSignatures = true;
        break;
      case '--include-failed-transactions':
        parsed.includeFailedTransactions = true;
        break;
      case '--print-creates':
        parsed.printCreates = true;
        break;
      case '--no-idl-fetch':
        parsed.fetchIdl = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Argumento desconhecido: ${args[index]}`);
    }
  }

  if (!parsed.sinceMs) {
    parsed.sinceMs = Date.now() - parsed.days * DAY_MS;
  }

  validateOptions(parsed);
  parsed.outDir = resolve(process.cwd(), parsed.outDir ?? 'rpc-dumps', `pumpfun-creates-${stamp}`);
  parsed.signaturePagesJsonlPath = resolve(parsed.outDir, 'raw-pages', 'signature-pages.raw.jsonl');
  parsed.signaturesJsonlPath = resolve(parsed.outDir, 'signatures.raw.jsonl');
  parsed.transactionsJsonlPath = resolve(parsed.outDir, 'transactions.raw.jsonl');
  parsed.createsJsonlPath = resolve(parsed.outDir, 'creates.jsonl');
  parsed.createsCsvPath = resolve(parsed.outDir, 'creates.csv');
  parsed.summaryPath = resolve(parsed.outDir, 'summary.json');
  return parsed;
}

function validateOptions(parsed) {
  if (!parsed.rpcUrl) {
    throw new Error('RPC URL ausente. Use SOLANA_RPC_URL ou --rpc-url.');
  }
  if (!Number.isFinite(parsed.sinceMs) || !Number.isFinite(parsed.untilMs)) {
    throw new Error('Janela invalida. Use --days, --since ou --until com datas validas.');
  }
  if (parsed.sinceMs > parsed.untilMs) {
    throw new Error('--since precisa ser anterior a --until.');
  }
  if (!Number.isInteger(parsed.signatureLimit) || parsed.signatureLimit < 1 || parsed.signatureLimit > 1000) {
    throw new Error('--signature-limit precisa ficar entre 1 e 1000.');
  }
  if (!Number.isInteger(parsed.txConcurrency) || parsed.txConcurrency < 1) {
    throw new Error('--tx-concurrency precisa ser >= 1.');
  }
}

function printHelp() {
  console.log(`
Uso:
  npm run rpc:creates -- --days=14
  npm run rpc:creates -- --rpc-url=https://... --days=14 --tx-concurrency=4
  npm run rpc:creates -- --days=1 --max-pages=1 --max-tx=50 --print-creates

O que faz:
  - Busca assinaturas do programa Pump.fun via getSignaturesForAddress.
  - Baixa transacoes via getTransaction.
  - Filtra apenas instrucoes create/create_v2 pelo discriminador Anchor do IDL oficial.
  - Salva criaçoes em creates.csv e creates.jsonl.

Flags principais:
  --rpc-url=URL                 RPC Solana. Default: SOLANA_RPC_URL ou ${DEFAULT_RPC_URL}
  --days=N                      janela relativa. Default: 14
  --since=ISO                   inicio exato da janela
  --until=ISO                   fim exato da janela
  --max-pages=N                 limita paginas de assinaturas para smoke
  --max-tx=N                    limita getTransaction para smoke
  --signature=SIG               processa uma assinatura especifica, sem varrer paginas
  --tx-concurrency=N            concorrencia de getTransaction. Default: 2
  --print-creates               imprime cada criaçao achada no terminal
`);
}

function backoffMs(attempt) {
  return Math.min(30000, 500 * 2 ** (attempt - 1));
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function redactedRpcUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.search) {
      parsed.search = '?...';
    }
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '***';
    }
    const tokenLike = parsed.pathname.match(/\/([A-Za-z0-9_-]{24,})$/);
    if (tokenLike) {
      parsed.pathname = parsed.pathname.replace(tokenLike[1], '...');
    }
    return parsed.toString();
  } catch {
    return '<invalid-rpc-url>';
  }
}
