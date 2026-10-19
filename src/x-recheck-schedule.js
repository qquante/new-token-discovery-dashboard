export const RECHECKABLE_X_STATUSES = new Set([
  'alpha_unposted',
  'x_mentions_pump_unclear',
  'x_profile_unavailable',
  'x_error'
]);

export function buildXRecheckDelays({
  fastEveryMs = 5_000,
  fastUntilMs = 60_000,
  slowEveryMs = 30_000,
  untilMs = 5 * 60_000
} = {}) {
  assertPositive('fastEveryMs', fastEveryMs);
  assertPositive('fastUntilMs', fastUntilMs);
  assertPositive('slowEveryMs', slowEveryMs);
  assertPositive('untilMs', untilMs);

  if (fastUntilMs > untilMs) {
    throw new Error('fastUntilMs precisa ser <= untilMs');
  }

  const delays = [];
  for (let delayMs = fastEveryMs; delayMs <= fastUntilMs; delayMs += fastEveryMs) {
    delays.push(delayMs);
  }

  for (let delayMs = fastUntilMs + slowEveryMs; delayMs <= untilMs; delayMs += slowEveryMs) {
    delays.push(delayMs);
  }

  return delays;
}

export function shouldAutoRecheckX(record, { minScore = 4 } = {}) {
  const status = record?.xCheck?.status;
  if (!status || !RECHECKABLE_X_STATUSES.has(status)) {
    return false;
  }

  return Boolean(
    record.mint &&
      (record.xProfile || record.twitter) &&
      record.classification &&
      record.classification !== 'not_game' &&
      Number(record.gameScore) >= minScore
  );
}

function assertPositive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} precisa ser positivo`);
  }
}
