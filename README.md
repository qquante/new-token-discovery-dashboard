# New Token Discovery Dashboard

![Language: JavaScript](https://img.shields.io/badge/Language-JavaScript-F7DF1E?style=flat-square&logo=javascript) ![Node.js: 22+](https://img.shields.io/badge/Node.js-22%2B-555555?style=flat-square) [![License: MIT](https://img.shields.io/badge/License-MIT-555555?style=flat-square)](LICENSE)

Monitor new Pump.fun token observations, collect social links and surface game/app candidates with explicit classification reasons.

This Node.js toolkit joins several research paths: streaming discovery, website/social inspection, X checks and historical/RPC backfills. The dashboard is a view over those records, not an independent source of verified project status.

## Why a candidate is shown

[game-classifier.js](src/game-classifier.js) scores text, known game/app hosts and HTML signals such as canvas, WebGL and engine references. Reasons retain tags and score contributions. A “game candidate” means the heuristics found relevant evidence; it does not prove there is a playable game.

X checks have a separate policy. [x-check-policy.js](src/x-check-policy.js) selects full versus linked-only checks, while [x-recheck-schedule.js](src/x-recheck-schedule.js) revisits selected provisional states using bounded fast/slow intervals. Unavailable profiles and unclear mentions remain explicit states.

## Start with local policy tests

Requires Node.js 22+; the package has no declared third-party runtime dependencies.

```console
node --test
```

The suites cover classifier rules, social links, X interpretation and recheck scheduling. They do not establish current third-party API access.

## Choose an operational path

| Purpose | Declared npm command |
| --- | --- |
| New-token stream | `npm run watch` |
| Game/app candidate watcher | `npm run watch:games` |
| Local dashboard | `npm run dashboard` |
| Historical input | `npm run history` |
| Moralis collection/finalization | `npm run moralis:dump` / `npm run moralis:finalize` |
| RPC creation backfill | `npm run rpc:creates` |

Commands using `--env-file=.env` need local configuration; see [.env.example](.env.example). Even commands called `smoke` contact live sources. Historical `summary.partial.json` files preserve partial collection status and must not be interpreted as complete-chain coverage.

**Technology:** JavaScript · Node.js · native fetch · HTML/CSS dashboard · node:test

Project-authored source: [MIT](LICENSE). Third-party components retain their own notices and terms.
