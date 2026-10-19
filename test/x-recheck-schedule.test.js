import assert from 'node:assert/strict';
import test from 'node:test';
import { buildXRecheckDelays, shouldAutoRecheckX } from '../src/x-recheck-schedule.js';

test('buildXRecheckDelays checks quickly for 1min then slows until 5min', () => {
  const delays = buildXRecheckDelays();

  assert.equal(delays.length, 20);
  assert.equal(delays[0], 5_000);
  assert.equal(delays[11], 60_000);
  assert.equal(delays[12], 90_000);
  assert.equal(delays.at(-1), 300_000);
});

test('shouldAutoRecheckX only schedules provisional X statuses with a usable X source', () => {
  assert.equal(
    shouldAutoRecheckX({
      mint: 'Mint111',
      xProfile: 'https://x.com/project',
      classification: 'game_possible',
      gameScore: 4,
      xCheck: { status: 'alpha_unposted' }
    }),
    true
  );

  assert.equal(
    shouldAutoRecheckX({
      mint: 'Mint111',
      xProfile: 'https://x.com/project',
      classification: 'game_possible',
      gameScore: 4,
      xCheck: { status: 'x_mismatch_other_mint' }
    }),
    false
  );

  assert.equal(
    shouldAutoRecheckX({
      mint: 'Mint111',
      classification: 'game_possible',
      gameScore: 4,
      xCheck: { status: 'alpha_unposted' }
    }),
    false
  );

  assert.equal(
    shouldAutoRecheckX({
      mint: 'Mint111',
      xProfile: 'https://x.com/project',
      classification: 'not_game',
      gameScore: 0,
      xCheck: { status: 'alpha_unposted' }
    }),
    false
  );

  assert.equal(
    shouldAutoRecheckX({
      mint: 'Mint111',
      xProfile: 'https://x.com/project',
      classification: 'game_possible',
      gameScore: 4,
      xCheck: { status: 'x_linked_status_no_mint' }
    }),
    false
  );
});
