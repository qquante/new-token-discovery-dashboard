import { extractXTweetIds } from './twitter-x-check.js';

export function shouldRunFullXCheck(record, { minScore = 4 } = {}) {
  return Boolean(record?.classification && record.classification !== 'not_game' && Number(record.gameScore) >= minScore);
}

export function selectInitialXCheckMode(record, { minScore = 4, linkedOnlyLowScore = false } = {}) {
  if (shouldRunFullXCheck(record, { minScore })) {
    return 'full';
  }

  if (linkedOnlyLowScore && extractXTweetIds(record?.twitter).length > 0) {
    return 'linked_only';
  }

  return 'not_game_or_low_score';
}
