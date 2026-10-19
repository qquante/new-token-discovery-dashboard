import assert from 'node:assert/strict';
import test from 'node:test';
import { selectInitialXCheckMode, shouldRunFullXCheck } from '../src/x-check-policy.js';

test('shouldRunFullXCheck only allows scored game/app candidates', () => {
  assert.equal(
    shouldRunFullXCheck({
      classification: 'game_possible',
      gameScore: 4
    }),
    true
  );

  assert.equal(
    shouldRunFullXCheck({
      classification: 'not_game',
      gameScore: 9
    }),
    false
  );

  assert.equal(
    shouldRunFullXCheck(
      {
        classification: 'app_possible',
        gameScore: 3
      },
      { minScore: 4 }
    ),
    false
  );
});

test('selectInitialXCheckMode skips low-score linked statuses by default', () => {
  assert.equal(
    selectInitialXCheckMode({
      classification: 'not_game',
      gameScore: 0,
      twitter: 'https://x.com/project/status/2074107494029512924'
    }),
    'not_game_or_low_score'
  );

  assert.equal(
    selectInitialXCheckMode(
      {
        classification: 'not_game',
        gameScore: 0,
        twitter: 'https://x.com/project/status/2074107494029512924'
      },
      { linkedOnlyLowScore: true }
    ),
    'linked_only'
  );
});

test('selectInitialXCheckMode still runs full check for real candidates', () => {
  assert.equal(
    selectInitialXCheckMode({
      classification: 'game_possible',
      gameScore: 5,
      twitter: 'https://x.com/project/status/2074107494029512924'
    }),
    'full'
  );
});
