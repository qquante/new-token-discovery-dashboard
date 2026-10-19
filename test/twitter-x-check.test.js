import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyMintEvidence,
  createSkippedXCheck,
  createXChecker,
  extractMintEvidence,
  extractXHandle,
  extractXTweetIds
} from '../src/twitter-x-check.js';

const CURRENT_MINT = '5Dq9LnhLRiisTQPfb21pgoGZt8h3E9h31JyiSzvYpump';
const OTHER_MINT = '4SnKwnz6DyagftnFqdxsvWvehrcbEDhxmmXNQk2Jpump';

test('extractXHandle normalizes profile and status URLs', () => {
  assert.equal(extractXHandle('https://x.com/project/status/123?s=20'), 'project');
  assert.equal(extractXHandle('https://twitter.com/Project_123'), 'Project_123');
  assert.equal(extractXHandle('@plain_handle'), 'plain_handle');
  assert.equal(extractXHandle('https://example.com/project'), null);
});

test('extractXTweetIds reads direct status links', () => {
  assert.deepEqual(extractXTweetIds('https://x.com/project/status/2074107494029512924?s=20'), [
    '2074107494029512924'
  ]);
  assert.deepEqual(extractXTweetIds('https://twitter.com/project/statuses/12345'), ['12345']);
  assert.deepEqual(extractXTweetIds('https://x.com/project'), []);
});

test('extractMintEvidence finds pump URLs, CA hints and raw pump suffixes', () => {
  const evidence = extractMintEvidence([
    {
      source: 'bio.entities.url',
      text: `https://pump.fun/coin/${CURRENT_MINT}`
    },
    {
      source: 'recent_tweet[0].text',
      tweetId: '1',
      text: `CA: ${OTHER_MINT}`
    },
    {
      source: 'recent_tweet[1].text',
      tweetId: '2',
      text: `raw ${CURRENT_MINT}`
    }
  ]);

  assert.deepEqual(
    [...new Set(evidence.map((item) => item.mint))],
    [CURRENT_MINT, OTHER_MINT]
  );
  assert.ok(evidence.some((item) => item.matched === 'pump_url'));
  assert.ok(evidence.some((item) => item.matched === 'ca_hint'));
  assert.ok(evidence.some((item) => item.matched === 'raw_pump_suffix'));
});

test('extractMintEvidence finds CA after parenthesized ticker bio marker', () => {
  const bioMint = '6VZGgmMHuKMMhy8ivPuKuf2qpycuoz9djbJ6HfXEASY';
  const evidence = extractMintEvidence([
    {
      source: 'bio.description',
      text: `Build Zyrvath | $VATH (CA) ${bioMint}`
    }
  ]);

  assert.deepEqual(evidence.map((item) => item.mint), [bioMint]);
  assert.equal(evidence[0].matched, 'ca_hint');
});

test('classifyMintEvidence compares posted mints against chain mint', () => {
  assert.equal(
    classifyMintEvidence({
      chainMint: CURRENT_MINT,
      evidence: [{ mint: CURRENT_MINT }]
    }).status,
    'x_confirmed_current_mint'
  );

  assert.equal(
    classifyMintEvidence({
      chainMint: CURRENT_MINT,
      evidence: [{ mint: OTHER_MINT }]
    }).status,
    'x_mismatch_other_mint'
  );

  assert.equal(
    classifyMintEvidence({
      chainMint: CURRENT_MINT,
      evidence: []
    }).status,
    'alpha_unposted'
  );

  assert.equal(
    classifyMintEvidence({
      chainMint: CURRENT_MINT,
      evidence: [],
      linkedTweetWithoutMint: true
    }).status,
    'x_linked_status_no_mint'
  );
});

test('createXChecker fetches pinned tweet through user/info pinnedTweetIds', async () => {
  const calledPaths = [];
  const checker = createXChecker({
    apiKey: 'test-key',
    baseUrl: 'https://api.test',
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calledPaths.push(`${parsed.pathname}${parsed.search}`);

      if (parsed.pathname === '/twitter/user/info') {
        return jsonResponse({
          status: 'success',
          msg: 'success',
          data: {
            id: '42',
            userName: 'game',
            name: 'Game',
            description: 'new game',
            pinnedTweetIds: ['pin-1'],
            profile_bio: {
              description: 'bio',
              entities: {}
            }
          }
        });
      }

      if (parsed.pathname === '/twitter/user/last_tweets') {
        return jsonResponse({
          status: 'success',
          msg: 'success',
          data: {
            tweets: [
              {
                id: 'tweet-1',
                text: 'no contract yet',
                createdAt: 'Mon Jul 06 12:00:00 +0000 2026',
                entities: { urls: [] }
              }
            ]
          },
          has_next_page: false,
          next_cursor: ''
        });
      }

      if (parsed.pathname === '/twitter/tweets') {
        return jsonResponse({
          status: 'success',
          message: 'success',
          data: [
            {
              id: 'pin-1',
              text: `Pinned CA: ${CURRENT_MINT}`,
              createdAt: 'Mon Jul 06 10:00:00 +0000 2026',
              entities: { urls: [] }
            }
          ]
        });
      }

      return jsonResponse({ status: 'error', msg: 'not found' }, 404);
    }
  });

  const result = await checker.check({ xProfile: 'https://x.com/game', mint: CURRENT_MINT });

  assert.equal(result.status, 'x_confirmed_current_mint');
  assert.equal(result.pinnedTweetsChecked, 1);
  assert.deepEqual(result.mentionedMints, [CURRENT_MINT]);
  assert.ok(calledPaths.some((path) => path.startsWith('/twitter/tweets?tweet_ids=pin-1')));
});

test('createXChecker checks linked status tweets without treating them as alpha', async () => {
  const checker = createXChecker({
    apiKey: 'test-key',
    baseUrl: 'https://api.test',
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);

      if (parsed.pathname === '/twitter/user/info') {
        return jsonResponse({
          status: 'success',
          msg: 'success',
          data: {
            id: '42',
            userName: 'game',
            name: 'Game',
            description: '',
            pinnedTweetIds: []
          }
        });
      }

      if (parsed.pathname === '/twitter/user/last_tweets') {
        return jsonResponse({
          status: 'success',
          msg: 'success',
          data: { tweets: [] },
          has_next_page: false,
          next_cursor: ''
        });
      }

      if (parsed.pathname === '/twitter/tweets') {
        return jsonResponse({
          status: 'success',
          message: 'success',
          data: [
            {
              id: '2074107494029512924',
              text: 'generic unrelated announcement',
              entities: { urls: [] }
            }
          ]
        });
      }

      return jsonResponse({ status: 'error', msg: 'not found' }, 404);
    }
  });

  const result = await checker.check({
    xProfile: 'https://x.com/game',
    xUrl: 'https://x.com/game/status/2074107494029512924',
    mint: CURRENT_MINT
  });

  assert.equal(result.status, 'x_linked_status_no_mint');
  assert.equal(result.linkedTweetsChecked, 1);
  assert.deepEqual(result.mentionedMints, []);
});

test('createXChecker linked_only fetches only direct status tweets', async () => {
  const calls = [];
  const checker = createXChecker({
    apiKey: 'test-key',
    baseUrl: 'https://api.test',
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.pathname);

      if (parsed.pathname === '/twitter/tweets') {
        return jsonResponse({
          status: 'success',
          message: 'success',
          tweets: [
            {
              id: '2074107494029512924',
              text: `CA: ${OTHER_MINT}`,
              entities: { urls: [] }
            }
          ]
        });
      }

      throw new Error(`unexpected API call ${parsed.pathname}`);
    }
  });

  const result = await checker.check({
    xProfile: 'https://x.com/game',
    xUrl: 'https://x.com/game/status/2074107494029512924',
    mint: CURRENT_MINT,
    mode: 'linked_only'
  });

  assert.equal(result.status, 'x_mismatch_other_mint');
  assert.deepEqual(calls, ['/twitter/tweets']);
});

test('createSkippedXCheck marks low-signal records without API calls', () => {
  const result = createSkippedXCheck({
    status: 'x_skipped_low_signal',
    reason: 'not_game_or_low_score',
    xProfile: 'https://x.com/project',
    xUrl: 'https://x.com/project/status/123'
  });

  assert.equal(result.status, 'x_skipped_low_signal');
  assert.equal(result.handle, 'project');
  assert.deepEqual(result.linkedTweetIds, ['123']);
});

test('createXChecker checks x.com/i/status links even without a profile handle', async () => {
  const checker = createXChecker({
    apiKey: 'test-key',
    baseUrl: 'https://api.test',
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);

      if (parsed.pathname === '/twitter/tweets') {
        return jsonResponse({
          status: 'success',
          message: 'success',
          data: [
            {
              id: '2072365121469301238',
              text: `CA ${OTHER_MINT}`,
              entities: { urls: [] }
            }
          ]
        });
      }

      return jsonResponse({ status: 'error', msg: 'not found' }, 404);
    }
  });

  const result = await checker.check({
    xProfile: null,
    xUrl: 'https://x.com/i/status/2072365121469301238',
    mint: CURRENT_MINT
  });

  assert.equal(result.status, 'x_mismatch_other_mint');
  assert.equal(result.handle, null);
  assert.equal(result.linkedTweetsChecked, 1);
  assert.deepEqual(result.mentionedMints, [OTHER_MINT]);
});

test('createXChecker uses tweet_timeline when last_tweets is empty for new profiles', async () => {
  const checker = createXChecker({
    apiKey: 'test-key',
    baseUrl: 'https://api.test',
    timeoutMs: 1000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);

      if (parsed.pathname === '/twitter/user/info') {
        return jsonResponse({
          status: 'success',
          msg: 'success',
          data: {
            id: '2073612650605412353',
            userName: 'DegenSoccerGame',
            name: 'Degen Soccer',
            description: '1v1 soccer in your browser',
            pinnedTweetIds: ['2073621461806285024']
          }
        });
      }

      if (parsed.pathname === '/twitter/user/tweet_timeline') {
        return jsonResponse({
          status: 'success',
          msg: 'success',
          data: {
            tweets: [
              {
                id: '2073910053032034791',
                text: `CA: ${OTHER_MINT}`,
                entities: { urls: [] }
              }
            ]
          },
          has_next_page: false,
          next_cursor: ''
        });
      }

      if (parsed.pathname === '/twitter/tweets') {
        return jsonResponse({
          status: 'success',
          msg: 'success',
          tweets: []
        });
      }

      if (parsed.pathname === '/twitter/user/last_tweets') {
        return jsonResponse({
          status: 'success',
          msg: 'success',
          data: { tweets: [] },
          has_next_page: false,
          next_cursor: ''
        });
      }

      return jsonResponse({ status: 'error', msg: 'not found' }, 404);
    }
  });

  const result = await checker.check({
    xProfile: 'https://x.com/DegenSoccerGame',
    mint: CURRENT_MINT
  });

  assert.equal(result.status, 'x_mismatch_other_mint');
  assert.equal(result.recentTweetsSource, 'tweet_timeline');
  assert.equal(result.recentTweetsChecked, 1);
  assert.deepEqual(result.mentionedMints, [OTHER_MINT]);
});

test('createXChecker caches profile and pinned tweets while refreshing timeline', async () => {
  const calledPaths = [];
  let timelineCalls = 0;
  const checker = createXChecker({
    apiKey: 'test-key',
    baseUrl: 'https://api.test',
    timeoutMs: 1000,
    profileCacheTtlMs: 60_000,
    pinnedCacheTtlMs: 60_000,
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      calledPaths.push(parsed.pathname);

      if (parsed.pathname === '/twitter/user/info') {
        return jsonResponse({
          status: 'success',
          msg: 'success',
          data: {
            id: '42',
            userName: 'game',
            name: 'Game',
            description: 'new game',
            pinnedTweetIds: ['pin-1'],
            profile_bio: { description: '', entities: {} }
          }
        });
      }

      if (parsed.pathname === '/twitter/user/tweet_timeline') {
        timelineCalls += 1;
        return jsonResponse({
          status: 'success',
          msg: 'success',
          data: {
            tweets: [
              {
                id: `tweet-${timelineCalls}`,
                text: timelineCalls === 1 ? 'not posted yet' : `CA: ${CURRENT_MINT}`,
                entities: { urls: [] }
              }
            ]
          },
          has_next_page: false
        });
      }

      if (parsed.pathname === '/twitter/tweets') {
        return jsonResponse({
          status: 'success',
          message: 'success',
          data: [
            {
              id: 'pin-1',
              text: 'pinned without contract',
              entities: { urls: [] }
            }
          ]
        });
      }

      throw new Error(`unexpected API call ${parsed.pathname}`);
    }
  });

  const first = await checker.check({ xProfile: 'https://x.com/game', mint: CURRENT_MINT });
  const second = await checker.check({ xProfile: 'https://x.com/game', mint: CURRENT_MINT });

  assert.equal(first.status, 'alpha_unposted');
  assert.equal(second.status, 'x_confirmed_current_mint');
  assert.equal(calledPaths.filter((path) => path === '/twitter/user/info').length, 1);
  assert.equal(calledPaths.filter((path) => path === '/twitter/tweets').length, 1);
  assert.equal(calledPaths.filter((path) => path === '/twitter/user/tweet_timeline').length, 2);
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
