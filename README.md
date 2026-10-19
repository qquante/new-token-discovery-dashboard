# New Token Discovery Dashboard

A read-only token-discovery toolkit with social-link classification, recheck policies and a local dashboard.

## Features

- Source watchers collect new-token observations.
- Social-link and candidate classifiers expose explainable categories.
- Recheck policies schedule follow-up checks for provisional social results.

## Stack

JavaScript · Node.js · native fetch · HTML/CSS dashboard · node:test

Local JSON/JSONL outputs feed the dashboard. Prior scans, RPC dumps and provider credentials are excluded.

## Getting started

Node.js >=22. The test/ suites run with node --test. Live watchers require local environment configuration and are separate from unit tests.

## How it works

```text
Token observation → link extraction → candidate/social classification → local scan records → dashboard
```

## Current limitations

This is a discovery monitor, not a game. The classifier's unit tests do not validate all live providers. Backfill and social API commands may consume quotas and were not run.

## Tests

```console
node --test test/game-classifier.test.js test/social-links.test.js test/twitter-x-check.test.js test/x-check-policy.test.js test/x-recheck-schedule.test.js
```

These checks use offline fixtures or controlled backends.

## License

No open-source license has been granted. Redistribution terms remain to be defined.
