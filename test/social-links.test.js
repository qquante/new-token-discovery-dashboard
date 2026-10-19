import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSocialFields, firstText, toXProfile } from '../src/social-links.js';

test('buildSocialFields keeps structured website, X profile, telegram and pump URL', () => {
  const fields = buildSocialFields({
    mint: 'Mint111',
    coinDetail: {
      website: 'https://example.com',
      twitter: 'https://x.com/dev/status/123',
      telegram: 'https://t.me/example'
    },
    metadata: {}
  });

  assert.equal(fields.pumpUrl, 'https://pump.fun/coin/Mint111');
  assert.equal(fields.website, 'https://example.com');
  assert.equal(fields.twitter, 'https://x.com/dev/status/123');
  assert.equal(fields.xProfile, 'https://x.com/dev');
  assert.equal(fields.telegram, 'https://t.me/example');
});

test('buildSocialFields extracts social links from metadata description', () => {
  const fields = buildSocialFields({
    mint: 'Mint222',
    coinDetail: {},
    metadata: {
      description: 'site https://project.example join https://t.me/project follow https://twitter.com/project'
    }
  });

  assert.equal(fields.website, 'https://project.example');
  assert.equal(fields.twitter, 'https://twitter.com/project');
  assert.equal(fields.xProfile, 'https://x.com/project');
  assert.equal(fields.telegram, 'https://t.me/project');
});

test('buildSocialFields does not treat image or metadata URLs as websites', () => {
  const fields = buildSocialFields({
    mint: 'Mint333',
    coinDetail: {
      image_uri: 'https://edge.uxento.io/image/token',
      metadata_uri: 'https://meta.uxento.io/data/token'
    },
    metadata: {
      image: 'https://ipfs.io/ipfs/image',
      createdOn: 'https://pump.fun'
    }
  });

  assert.equal(fields.website, null);
  assert.deepEqual(fields.extraLinks, []);
});

test('buildSocialFields moves X URLs from website field to twitter fields', () => {
  const fields = buildSocialFields({
    mint: 'Mint444',
    coinDetail: {
      website: 'https://x.com/example/status/123'
    },
    metadata: {}
  });

  assert.equal(fields.website, null);
  assert.equal(fields.twitter, 'https://x.com/example/status/123');
  assert.equal(fields.xProfile, 'https://x.com/example');
});

test('firstText ignores empty values', () => {
  assert.equal(firstText('', '  ', null, 'ok'), 'ok');
});

test('toXProfile normalizes status links to profile links', () => {
  assert.equal(toXProfile('https://x.com/elonmusk/status/1?s=20'), 'https://x.com/elonmusk');
});
