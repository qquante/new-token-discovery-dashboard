import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGameCandidate, classifyUrl } from '../src/game-classifier.js';

test('classifyGameCandidate marks playable website with engine signals as confirmed game', () => {
  const result = classifyGameCandidate({
    token: {
      name: 'Dungeon Runner',
      symbol: 'RUN',
      description: 'Play now. WebGL arcade game with leaderboard.'
    },
    socials: {
      website: 'https://example.com/play',
      extraLinks: []
    },
    metadata: {},
    websiteEvidence: {
      ok: true,
      status: 200,
      title: 'Dungeon Runner - Play Now',
      description: 'A browser game',
      finalUrl: 'https://example.com/play',
      signals: [
        { tag: 'html_canvas', category: 'game', score: 2, reason: 'canvas' },
        { tag: 'html_game_engine', category: 'game', score: 4, reason: 'phaser' }
      ]
    }
  });

  assert.equal(result.classification, 'game_confirmed');
  assert.equal(result.category, 'game');
  assert.ok(result.score >= 8);
  assert.ok(result.tags.includes('game_keyword'));
  assert.ok(result.tags.includes('html_game_engine'));
});

test('classifyGameCandidate keeps generic meme token as not game', () => {
  const result = classifyGameCandidate({
    token: {
      name: 'Green Candle',
      symbol: 'CANDLE',
      description: 'community meme token'
    },
    socials: {},
    metadata: {}
  });

  assert.equal(result.classification, 'not_game');
  assert.equal(result.category, 'unknown');
});

test('classifyGameCandidate marks mini app language as app candidate', () => {
  const result = classifyGameCandidate({
    token: {
      name: 'Trade Bot',
      symbol: 'BOT',
      description: 'Telegram mini app and web app for traders'
    },
    socials: {},
    metadata: {}
  });

  assert.equal(result.classification, 'app_likely');
  assert.equal(result.category, 'app');
  assert.ok(result.tags.includes('telegram_mini_app'));
});

test('classifyUrl scores known game hosts and game-like paths', () => {
  const signals = classifyUrl('https://studio.itch.io/my-game/play');

  assert.ok(signals.some((signal) => signal.tag === 'game_host'));
  assert.ok(signals.some((signal) => signal.tag === 'game_path'));
});
