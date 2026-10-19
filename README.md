# New Token Discovery Dashboard

A read-only token-discovery toolkit with social-link classification, recheck policies and a local dashboard.

![review](https://img.shields.io/badge/review-private-374151) ![primary](https://img.shields.io/badge/primary-JavaScript-2563EB) [![LinkedIn](https://img.shields.io/badge/LinkedIn-Douglas%20Silva-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/douglas-silva-data-analyst/)

[Overview](#overview) · [Architecture](#architecture) · [Setup](#setup) · [Validation](#validation) · [Roadmap](#roadmap) · [Review notes](docs/REVIEW.md)

## Overview

- Source watchers collect new-token observations.
- Social-link and candidate classifiers expose explainable categories.
- Recheck policies schedule follow-up checks for provisional social results.

**Technology:** JavaScript · Node.js · native fetch · HTML/CSS dashboard · node:test

**Persistence and data:** Local JSON/JSONL outputs feed the dashboard. Prior scans, RPC dumps and provider credentials are excluded.

## Architecture

```text
Token observation → link extraction → candidate/social classification → local scan records → dashboard
```

| Location | Review focus |
| --- | --- |
| [`src/game-classifier.js`](src/game-classifier.js) | Source/configuration inspected for scope and structure |
| [`src/social-links.js`](src/social-links.js) | Source/configuration inspected for scope and structure |
| [`src/x-check-policy.js`](src/x-check-policy.js) | Source/configuration inspected for scope and structure |
| [`src/x-recheck-schedule.js`](src/x-recheck-schedule.js) | Source/configuration inspected for scope and structure |
| [`dashboard/app.js`](dashboard/app.js) | Source/configuration inspected for scope and structure |

Internal package and module names are retained where changing them would affect imports or compatibility. This descriptive repository name does not imply a completed package/API migration.

## Setup

Node.js >=22. The test/ suites run with node --test. Live watchers require local environment configuration and are separate from unit tests.

Start from an isolated environment. Use `.env.example` when present and inspect the configuration loader: an example file is not necessarily loaded automatically. Runtime databases, real account sessions and private credentials are not bundled. Live integration prerequisites are separate from local tests.

## Validation

Static parsing checked 0 Python files and 10 strict JSON files. Python syntax errors: 0; JSON errors: 0. The selected offline suite passed.

```console
node --test test/game-classifier.test.js test/social-links.test.js test/twitter-x-check.test.js test/x-check-policy.test.js test/x-recheck-schedule.test.js
```

These results apply to the selected checks on the preparation copy. They do not establish deployment readiness, full coverage, live provider availability or measured performance. CI definitions, when present under `docs/ci-templates/`, are inactive review templates; no remote CI badge is claimed.

## Limits and current status

This is a discovery monitor, not a game. The classifier's unit tests do not validate all live providers. Backfill and social API commands may consume quotas and were not run.

This private snapshot is for code and portfolio review. Generated runtime material and unreviewed binary assets may be excluded. [Review notes](docs/REVIEW.md) record preparation scope, findings and outstanding validation.

## Roadmap

- [ ] Document synthetic dashboard input and classifier labels.
- [ ] Add provider-schema fixtures for changing upstream responses.
- [ ] Review rate limits and persistent resume behavior for backfills.

## History and attribution

No recoverable original Git history was verified for this snapshot. Import and preparation commits use their actual current dates; filesystem timestamps are not treated as development dates.

No open-source license is granted by this preparation. A license and attribution review is required before public redistribution.

## Maintainer and feedback

Douglas de Oliveira Silva · [GitHub](https://github.com/qquante) · [LinkedIn](https://www.linkedin.com/in/douglas-silva-data-analyst/)

For this private review, report reproducible issues with a minimal fixture and the exact check output. Keep account data, credentials and generated sensitive reports out of issues and commits. Existing contribution guidelines apply where present.

**Topics:** `javascript`, `nodejs`, `solana`, `data-collection`, `dashboard`, `classification`
