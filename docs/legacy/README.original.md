> Historical project notes. Paths, operational status, badges and test claims below are retained as archival reference and have not all been revalidated. Use the root README and docs/REVIEW.md for this review snapshot.

# Pump.fun New Token Monitor

Monitor read-only para novos tokens da Pump.fun.

## Rodar

```powershell
npm run watch
```

Smoke test com 3 tokens:

```powershell
npm run smoke
```

Monitor de candidatos a jogo/app:

```powershell
npm run watch:games
```

Para usar a API do X/Twitter, preencha:

```powershell
notepad .env
```

```env
TWITTERAPI_IO_KEY=sua_key_aqui
TWITTERAPI_IO_BASE_URL=https://api.twitterapi.io
```

Smoke do detector de jogos/apps:

```powershell
npm run games:smoke
```

Dashboard local dos scans:

```powershell
npm run dashboard
```

Abra `http://127.0.0.1:8787`. Deixe `npm run watch:games` rodando em outro terminal; o dashboard le `game-candidates/pump-game-scan-YYYY-MM-DD.jsonl` e recebe novos registros via stream.

Historico das ultimas 2 semanas via frontend publico:

```powershell
npm run history -- --days=14
```

Dump Moralis Pump.fun:

```powershell
$env:MORALIS_API_KEY = "..."
npm run moralis:dump
```

Backfill on-chain de criacoes via RPC Solana:

```powershell
$env:SOLANA_RPC_URL = "https://seu-rpc-archive"
npm run rpc:creates -- --days=14 --tx-concurrency=4
```

Smoke do RPC:

```powershell
npm run rpc:creates -- --days=1 --max-pages=1 --max-tx=50 --print-creates
```

Smoke do historico:

```powershell
npm run history -- --days=14 --max-pages=3 --print-tokens
```

## Saida

Cada token imprime:

- `launch`: tempo de criacao reportado pelo frontend publico da Pump.fun, quando disponivel.
  Se o frontend ainda nao indexou, o script usa `blockTime` da transacao via RPC Solana.
- `received`: tempo local em que o evento chegou via WebSocket.
- `latency`: diferenca entre `received` e `launch`.
- `enrich`: tempo gasto buscando detalhe do token e metadata URI.
- `pump`: pagina do token na Pump.fun.
- `site`, `x profile`, `x link`, `telegram`, `desc`: dados sociais/metadata quando o token publica esses campos.
- `x check`: resultado da TwitterAPI.io quando existe `x profile` e `TWITTERAPI_IO_KEY`.
  O fluxo usa `user/info` para bio e `pinnedTweetIds`, busca pinados por `/twitter/tweets`, e busca posts por `tweet_timeline`; `last_tweets` fica como fallback.
  Se o token publica um link direto para um tweet/status, esse tweet tambem e buscado por ID.
  Para economizar API, o X completo roda so depois que o token vira candidato game/app. Tokens low-score/`not_game` pulam X por padrao.
  Se quiser voltar a checar tweet/status linkado direto em low-score, use `--x-linked-only-low-score`.
  `user/info` e pinned tweets usam cache curto de 60s; a timeline continua fresca em cada check/recheck.
  Status provisorios de candidatos game/app sao rechecados automaticamente a cada 5s ate 1min, depois a cada 30s ate 5min.

O monitor tambem grava JSONL em `logs/` para auditoria.
O detector de jogos/apps grava tudo em `game-candidates/pump-game-scan-YYYY-MM-DD.jsonl` e candidatos em `game-candidates/pump-game-candidates-YYYY-MM-DD.jsonl`.
O dashboard usa esses JSONL e nao faz transacao, RPC ou broadcast.

O backfill historico grava JSONL e CSV em `history/`.
O dump Moralis grava JSONL/CSV em `moralis-dumps/`.
O backfill RPC grava assinaturas, transacoes brutas e criacoes em `rpc-dumps/`.

## Variaveis uteis

- `PUMPPORTAL_WS_URL`: WebSocket da PumpPortal. Default: `wss://pumpportal.fun/api/data`.
- `PUMP_FRONTEND_BASE_URL`: API publica usada para enriquecer. Default: `https://frontend-api-v3.pump.fun`.
- `TWITTERAPI_IO_KEY`: chave da TwitterAPI.io para checar bio, pinados e ultimos posts do X.
- `TWITTERAPI_IO_BASE_URL`: base da TwitterAPI.io. Default: `https://api.twitterapi.io`.
- `SOLANA_RPC_URL`: RPC usado para `--rpc-time` no monitor e para `npm run rpc:creates`.

## Flags

```powershell
npm run watch -- --max=10
npm run watch -- --no-metadata
npm run watch -- --no-frontend
npm run watch -- --no-rpc-time
npm run watch -- --include-incomplete
npm run watch -- --json
```

Flags do detector de jogos/apps:

```powershell
npm run watch:games -- --print-all
npm run watch:games -- --min-score=6
npm run watch:games -- --no-site-inspection
npm run watch:games -- --no-beep
npm run watch:games -- --no-x-check
npm run watch:games -- --no-x-auto-recheck
npm run watch:games -- --x-timeout-ms=4500
npm run watch:games -- --x-include-replies
npm run watch:games -- --x-linked-only-low-score
npm run watch:games -- --x-profile-cache-ttl-ms=60000 --x-pinned-cache-ttl-ms=60000
npm run watch:games -- --beep-mode=windows --beep-count=3
npm run watch:games -- --max=10 --print-all
```

O detector apita quando salva um candidato, exceto com `--no-beep`. No Windows o default usa terminal bell e `[Console]::Beep()`.
O detector de jogos nao usa RPC nem timestamp on-chain; ele usa apenas tempo do evento/frontend para manter o scan rapido e evitar `HTTP 429`.
O detector nao trata `game_likely` como verdade final. `game_confirmed` significa que o site carregou e apresentou evidencia tecnica forte de jogo, como `canvas`, `WebGL`, `Phaser`, `Unity`, `play now` ou `leaderboard`. Evidencias como `itch.io` e paths `/play` aumentam o score, mas ainda sao heuristica.

Status do `x check`:

- `alpha_unposted`: X existe, mas bio/pinado/ultimos 20 posts nao publicaram mint.
- `x_confirmed_current_mint`: X publicou o mesmo mint da chain.
- `x_mismatch_other_mint`: X publicou outro mint e nao publicou o mint da chain; o token atual e tratado como invalido para oportunidade.
- `x_conflict_many_other_mints`: X publicou varios outros mints e nenhum bate com o mint da chain.
- `x_mixed_mints`: X publicou o mint da chain e tambem outros mints; exige revisao.
- `x_mentions_pump_unclear`: X menciona Pump.fun, mas sem mint claro.
- `x_linked_status_no_mint`: o token apontou para um tweet/status especifico, mas esse tweet nao publicou mint.
- `x_profile_unavailable`: a API nao conseguiu resolver o perfil.
- `x_skipped_low_signal`: o token nao passou no filtro game/app; X completo foi pulado para economizar API.

Flags do historico:

```powershell
npm run history -- --since=2026-06-14T00:00:00Z
npm run history -- --days=14 --delay-ms=250
npm run history -- --days=14 --print-tokens
npm run history -- --days=14 --max-pages=10
```

Por padrao, eventos `create` sem `name`, `symbol` ou `uri` no payload do WebSocket sao ignorados. Isso evita confundir launch novo com evento incompleto/enriquecimento errado de mint ja existente.

Historico via `frontend-api-v3.pump.fun` e util, mas nao e contrato oficial. Para garantia forte de completude, use backfill on-chain/indexador como Bitquery ou Geyser/Yellowstone.

Historico via `rpc:creates` usa o programa Pump.fun `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, baixa assinaturas com `getSignaturesForAddress`, transacoes com `getTransaction`, e filtra somente instrucoes `create`/`create_v2` pelo IDL oficial. Isso pega criacao antes de bonding, mas e pesado: RPC publico pode limitar ou demorar muito para 14 dias completos.

O script nao usa wallet, chave privada nem faz broadcast.
