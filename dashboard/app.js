const state = {
  date: null,
  records: [],
  selectedKey: null,
  stream: null
};

const els = {
  subtitle: document.querySelector('#subtitle'),
  dateSelect: document.querySelector('#dateSelect'),
  reloadBtn: document.querySelector('#reloadBtn'),
  streamState: document.querySelector('#streamState'),
  searchInput: document.querySelector('#searchInput'),
  xStatusFilter: document.querySelector('#xStatusFilter'),
  classFilter: document.querySelector('#classFilter'),
  candidateOnly: document.querySelector('#candidateOnly'),
  redFlagOnly: document.querySelector('#redFlagOnly'),
  recordsBody: document.querySelector('#recordsBody'),
  emptyState: document.querySelector('#emptyState'),
  detailEmpty: document.querySelector('#detailEmpty'),
  detailBody: document.querySelector('#detailBody'),
  metricTotal: document.querySelector('#metricTotal'),
  metricCandidates: document.querySelector('#metricCandidates'),
  metricAlpha: document.querySelector('#metricAlpha'),
  metricConfirmed: document.querySelector('#metricConfirmed'),
  metricRedFlags: document.querySelector('#metricRedFlags'),
  metricReview: document.querySelector('#metricReview')
};

const X_LABELS = {
  alpha_unposted: 'alpha sem post',
  x_confirmed_current_mint: 'mint confirmado',
  x_mismatch_other_mint: 'outro mint',
  x_conflict_many_other_mints: 'varios outros mints',
  x_mixed_mints: 'mint atual + outros',
  x_mentions_pump_unclear: 'Pump unclear',
  x_linked_status_no_mint: 'status sem mint',
  x_profile_unavailable: 'perfil indisponivel',
  x_no_profile: 'sem perfil X',
  x_skipped_low_signal: 'X pulado',
  x_skipped_no_linked_status: 'sem status linkado',
  x_not_configured: 'X off',
  x_error: 'erro X'
};

const RED_FLAG_STATUSES = new Set(['x_mismatch_other_mint', 'x_conflict_many_other_mints']);
const REVIEW_STATUSES = new Set(['x_mixed_mints', 'x_mentions_pump_unclear', 'x_linked_status_no_mint']);

await init();

async function init() {
  bindEvents();
  await loadDates();
  await loadRecords();
  openStream();
}

function bindEvents() {
  els.reloadBtn.addEventListener('click', () => loadRecords());
  els.dateSelect.addEventListener('change', async () => {
    state.date = els.dateSelect.value;
    state.selectedKey = null;
    closeStream();
    await loadRecords();
    openStream();
  });

  for (const input of [els.searchInput, els.xStatusFilter, els.classFilter, els.candidateOnly, els.redFlagOnly]) {
    input.addEventListener('input', render);
  }
}

async function loadDates() {
  const payload = await fetchJson('/api/dates');
  const dates = payload.dates.length ? payload.dates : [payload.today];
  els.dateSelect.innerHTML = dates.map((date) => `<option value="${escapeHtml(date)}">${escapeHtml(date)}</option>`).join('');
  state.date = dates[0];
  els.dateSelect.value = state.date;
}

async function loadRecords() {
  setStreamState('loading', 'carregando');
  const payload = await fetchJson(`/api/records?date=${encodeURIComponent(state.date)}&limit=5000`);
  state.records = uniqueRecords(payload.records).sort(compareRecords);
  els.subtitle.textContent = `${payload.logPath} - ${state.records.length} registros carregados`;
  renderFilterOptions();
  render();
}

function openStream() {
  if (!window.EventSource || !state.date) {
    setStreamState('error', 'sem stream');
    return;
  }

  const source = new EventSource(`/api/stream?date=${encodeURIComponent(state.date)}`);
  state.stream = source;

  source.addEventListener('ready', () => setStreamState('live', 'ao vivo'));
  source.addEventListener('ping', () => setStreamState('live', 'ao vivo'));
  source.addEventListener('record', (event) => {
    const record = JSON.parse(event.data);
    upsertRecord(record);
    renderFilterOptions();
    render();
  });
  source.addEventListener('error', () => setStreamState('error', 'reconectando'));
}

function closeStream() {
  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
}

function upsertRecord(record) {
  const key = recordKey(record);
  const index = state.records.findIndex((item) => recordKey(item) === key);

  if (index === -1) {
    state.records.unshift(record);
  } else {
    state.records[index] = record;
  }

  state.records = uniqueRecords(state.records).sort(compareRecords);
}

function renderFilterOptions() {
  const currentX = els.xStatusFilter.value;
  const currentClass = els.classFilter.value;
  const statuses = [...new Set(state.records.map((record) => record.xCheck?.status).filter(Boolean))].sort();
  const classes = [...new Set(state.records.map((record) => record.classification).filter(Boolean))].sort();

  els.xStatusFilter.innerHTML = [
    '<option value="">Todos</option>',
    ...statuses.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(labelX(status))}</option>`)
  ].join('');
  els.classFilter.innerHTML = [
    '<option value="">Todas</option>',
    ...classes.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`)
  ].join('');

  els.xStatusFilter.value = statuses.includes(currentX) ? currentX : '';
  els.classFilter.value = classes.includes(currentClass) ? currentClass : '';
}

function render() {
  const filtered = filteredRecords();
  renderMetrics(state.records);
  renderTable(filtered);
  renderDetail(selectedRecord(filtered));
}

function renderMetrics(records) {
  const summary = summarize(records);
  els.metricTotal.textContent = formatInt(summary.total);
  els.metricCandidates.textContent = formatInt(summary.candidates);
  els.metricAlpha.textContent = formatInt(summary.alphaUnposted);
  els.metricConfirmed.textContent = formatInt(summary.xConfirmed);
  els.metricRedFlags.textContent = formatInt(summary.xRedFlags);
  els.metricReview.textContent = formatInt(summary.xNeedsReview);
}

function renderTable(records) {
  els.emptyState.style.display = records.length ? 'none' : 'block';
  els.recordsBody.innerHTML = records.map(renderRow).join('');

  els.recordsBody.querySelectorAll('tr[data-key]').forEach((row) => {
    row.addEventListener('click', () => {
      state.selectedKey = row.dataset.key;
      render();
    });
  });
}

function renderRow(record) {
  const key = recordKey(record);
  const selected = state.selectedKey === key ? ' selected' : '';
  const xStatus = record.xCheck?.status || 'sem_xcheck';
  const tags = record.gameBreakdown?.tags ?? [];
  const site = record.websiteEvidence;
  const links = [
    link('pump', record.pumpUrl),
    link('site', record.website),
    link('X', record.xProfile || record.twitter),
    link('TG', record.telegram)
  ]
    .filter(Boolean)
    .join('');

  return `
    <tr class="${selected}" data-key="${escapeAttr(key)}">
      <td class="seq">#${escapeHtml(record.sequence ?? '-')}</td>
      <td>
        <div class="token-cell">
          ${tokenImage(record)}
          <div>
            <div class="name">${escapeHtml(record.name || 'sem nome')}</div>
            <div class="meta">${escapeHtml(record.symbol || 'sem simbolo')} - <span class="mono">${shortMint(record.mint)}</span></div>
          </div>
        </div>
      </td>
      <td>
        <div class="stack">
          ${pill(`${record.gameScore ?? 0}`, scoreColor(record), record.classification || 'sem classe')}
          ${tags.slice(0, 3).map((tag) => pill(tag, 'gray')).join('')}
        </div>
      </td>
      <td>
        <div class="stack">
          ${pill(labelX(xStatus), xColor(xStatus))}
          <span class="meta">${escapeHtml(xVerificationText(record))}</span>
        </div>
      </td>
      <td>
        <div class="stack">
          ${site ? pill(site.ok ? `HTTP ${site.status}` : site.error || 'falhou', site.ok ? 'green' : 'red') : pill('sem site', 'gray')}
          ${site?.title ? `<span class="meta">${escapeHtml(truncate(site.title, 60))}</span>` : ''}
        </div>
      </td>
      <td>
        <div>${escapeHtml(formatTime(record.launchAt))}</div>
        <div class="meta">${formatMs(record.latencyMs)} latency</div>
      </td>
      <td><div class="links-row">${links}</div></td>
    </tr>
  `;
}

function renderDetail(record) {
  if (!record) {
    els.detailEmpty.classList.remove('hidden');
    els.detailBody.classList.add('hidden');
    els.detailBody.innerHTML = '';
    return;
  }

  els.detailEmpty.classList.add('hidden');
  els.detailBody.classList.remove('hidden');

  const x = record.xCheck;
  const site = record.websiteEvidence;
  const reasons = record.gameBreakdown?.reasons ?? [];
  const evidence = x?.evidence ?? [];
  const links = [
    link('Pump.fun', record.pumpUrl),
    link('Site', record.website),
    link('X profile', record.xProfile),
    link('X link', record.twitter),
    link('Telegram', record.telegram)
  ]
    .filter(Boolean)
    .join('');

  els.detailBody.innerHTML = `
    <div class="detail-head">
      ${tokenImage(record)}
      <div>
        <h2>${escapeHtml(record.name || 'sem nome')}</h2>
        <div class="meta">${escapeHtml(record.symbol || 'sem simbolo')}</div>
        <div class="tags" style="margin-top: 8px">
          ${pill(record.classification || 'sem classe', scoreColor(record))}
          ${x ? pill(labelX(x.status), xColor(x.status)) : pill('sem xCheck', 'gray')}
        </div>
      </div>
    </div>

    <section class="detail-section">
      <h3>Verificacao</h3>
      <dl class="kv">
        <dt>X status</dt><dd>${escapeHtml(x ? `${labelX(x.status)} (${x.status})` : 'sem xCheck')}</dd>
        <dt>O que significa</dt><dd>${escapeHtml(x ? xVerificationText(record) : 'registro antigo ou X check desligado')}</dd>
        <dt>Tweets</dt><dd>${escapeHtml(formatTweetCounts(x))}</dd>
        <dt>Erros X</dt><dd>${renderXErrors(x)}</dd>
        <dt>Mints no X</dt><dd>${renderMintList(x?.mentionedMints)}</dd>
        <dt>Outros mints</dt><dd>${renderMintList(x?.otherMints)}</dd>
      </dl>
    </section>

    <section class="detail-section">
      <h3>Token</h3>
      <dl class="kv">
        <dt>Mint</dt><dd class="mono">${escapeHtml(record.mint || '-')}</dd>
        <dt>Creator</dt><dd class="mono">${escapeHtml(record.creator || '-')}</dd>
        <dt>Launch</dt><dd>${escapeHtml(formatDateTime(record.launchAt))}</dd>
        <dt>Recebido</dt><dd>${escapeHtml(formatDateTime(record.receivedAt))}</dd>
        <dt>Latency</dt><dd>${escapeHtml(formatMs(record.latencyMs))}</dd>
        <dt>Market cap</dt><dd>${escapeHtml(formatMarket(record))}</dd>
        <dt>Links</dt><dd><div class="links-row">${links || '-'}</div></dd>
      </dl>
    </section>

    <section class="detail-section">
      <h3>Site</h3>
      <dl class="kv">
        <dt>Status</dt><dd>${escapeHtml(site ? `${site.ok ? 'ok' : 'falhou'} ${site.status ?? ''} ${site.error ?? ''}` : 'nao checado')}</dd>
        <dt>Titulo</dt><dd>${escapeHtml(site?.title || '-')}</dd>
        <dt>Final URL</dt><dd>${site?.finalUrl ? link(site.finalUrl, site.finalUrl) : '-'}</dd>
        <dt>Sinais</dt><dd>${(site?.signals ?? []).map((signal) => pill(signal.tag, 'blue')).join('') || '-'}</dd>
      </dl>
    </section>

    <section class="detail-section">
      <h3>Evidencia X</h3>
      ${renderEvidence(evidence)}
    </section>

    <section class="detail-section">
      <h3>Score</h3>
      <div class="evidence-list">
        ${reasons.length ? reasons.map(renderReason).join('') : '<div class="meta">Sem razoes de score.</div>'}
      </div>
    </section>

    <section class="detail-section">
      <h3>Descricao</h3>
      <p>${escapeHtml(record.description || '-')}</p>
    </section>

    <section class="detail-section">
      <h3>Raw JSON</h3>
      <details>
        <summary>Abrir payload</summary>
        <pre>${escapeHtml(JSON.stringify(record.raw ?? record, null, 2))}</pre>
      </details>
    </section>
  `;
}

function renderEvidence(evidence) {
  if (!evidence.length) {
    return '<div class="meta">Nenhum mint encontrado nas fontes checadas.</div>';
  }

  return `
    <div class="evidence-list">
      ${evidence
        .map(
          (item) => `
            <div class="evidence-item">
              <div class="mono">${escapeHtml(item.mint || '-')}</div>
              <div class="meta">${escapeHtml([item.source, item.matched, item.tweetId ? `tweet ${item.tweetId}` : null].filter(Boolean).join(' - '))}</div>
              <div style="margin-top: 6px">${escapeHtml(item.text || '')}</div>
              ${item.tweetUrl ? `<div class="meta">${link('abrir tweet', item.tweetUrl)}</div>` : ''}
            </div>
          `
        )
        .join('')}
    </div>
  `;
}

function renderReason(reason) {
  return `
    <div class="evidence-item">
      <div>${pill(`${reason.score} ${reason.tag}`, reason.category === 'game' ? 'blue' : 'gray')}</div>
      <div class="meta">${escapeHtml(reason.reason || '')}</div>
    </div>
  `;
}

function filteredRecords() {
  const query = normalizeText(els.searchInput.value);
  const xStatus = els.xStatusFilter.value;
  const classification = els.classFilter.value;

  return state.records.filter((record) => {
    if (xStatus && record.xCheck?.status !== xStatus) {
      return false;
    }

    if (classification && record.classification !== classification) {
      return false;
    }

    if (els.candidateOnly.checked && !isCandidate(record)) {
      return false;
    }

    if (els.redFlagOnly.checked && !RED_FLAG_STATUSES.has(record.xCheck?.status)) {
      return false;
    }

    if (query) {
      const haystack = normalizeText(
        [
          record.name,
          record.symbol,
          record.mint,
          record.creator,
          record.website,
          record.twitter,
          record.xProfile,
          record.telegram,
          record.xCheck?.status,
          record.classification,
          ...(record.xCheck?.mentionedMints ?? [])
        ].join(' ')
      );
      return haystack.includes(query);
    }

    return true;
  });
}

function selectedRecord(records) {
  if (!state.selectedKey && records.length) {
    state.selectedKey = recordKey(records[0]);
  }

  return records.find((record) => recordKey(record) === state.selectedKey) ?? records[0] ?? null;
}

function summarize(records) {
  const summary = {
    total: records.length,
    candidates: 0,
    alphaUnposted: 0,
    xConfirmed: 0,
    xRedFlags: 0,
    xNeedsReview: 0
  };

  for (const record of records) {
    if (isCandidate(record)) {
      summary.candidates += 1;
    }

    const status = record.xCheck?.status;
    if (status === 'alpha_unposted') {
      summary.alphaUnposted += 1;
    } else if (status === 'x_confirmed_current_mint') {
      summary.xConfirmed += 1;
    } else if (RED_FLAG_STATUSES.has(status)) {
      summary.xRedFlags += 1;
    } else if (REVIEW_STATUSES.has(status)) {
      summary.xNeedsReview += 1;
    }
  }

  return summary;
}

function isCandidate(record) {
  return (
    record.gameScore >= 4 &&
    record.classification &&
    record.classification !== 'not_game' &&
    !RED_FLAG_STATUSES.has(record.xCheck?.status)
  );
}

function xVerificationText(record) {
  const x = record.xCheck;
  if (!x) {
    return 'sem xCheck no registro';
  }

  if (x.status === 'x_no_profile') {
    return record.twitter
      ? 'havia link X, mas nao era perfil/status consultavel'
      : 'sem perfil/status X para consultar';
  }

  if (x.status === 'x_profile_unavailable') {
    return `tentou consultar perfil: ${x.apiMessage || x.error || 'indisponivel'}`;
  }

  if (x.status === 'x_not_configured') {
    return 'TwitterAPI.io desligada ou sem key';
  }

  if (x.status === 'x_skipped_low_signal') {
    return 'baixo score/not_game; X completo pulado para economizar API';
  }

  if (x.status === 'x_skipped_no_linked_status') {
    return 'modo barato pedido, mas nao havia tweet/status direto';
  }

  if (x.status === 'alpha_unposted') {
    return 'perfil/bio/pinados/ultimos tweets checados; nenhum mint postado';
  }

  if (x.status === 'x_confirmed_current_mint') {
    return 'X postou o mesmo mint da chain';
  }

  if (RED_FLAG_STATUSES.has(x.status)) {
    return 'X postou outro mint; nao bate com o mint da chain';
  }

  if (x.status === 'x_linked_status_no_mint') {
    return 'tweet/status linkado foi consultado, mas nao publicou mint';
  }

  if (x.status === 'x_mentions_pump_unclear') {
    return 'X menciona Pump.fun, mas sem mint claro';
  }

  if (x.status === 'x_mixed_mints') {
    return 'X tem mint atual e tambem outros mints; revisar';
  }

  return 'checagem X executada';
}

function formatTweetCounts(x) {
  if (!x) {
    return '-';
  }

  return [
    x.recentTweetsSource ? `fonte=${x.recentTweetsSource}` : null,
    x.recentTweetsChecked !== null ? `ultimos=${x.recentTweetsChecked}` : null,
    x.pinnedTweetsChecked !== null ? `pinados=${x.pinnedTweetsChecked}` : null,
    x.linkedTweetsChecked !== null ? `linkado=${x.linkedTweetsChecked}` : null,
    x.elapsedMs !== null ? `${x.elapsedMs}ms` : null
  ]
    .filter(Boolean)
    .join(' | ');
}

function renderMintList(values) {
  if (!values?.length) {
    return '-';
  }

  return values.map((mint) => `<div class="mono">${escapeHtml(mint)}</div>`).join('');
}

function renderXErrors(x) {
  if (!x?.errors?.length) {
    return '-';
  }

  return x.errors
    .map((error) => escapeHtml([error.endpoint, error.httpStatus, error.apiStatus, error.message].filter(Boolean).join(' | ')))
    .join('<br />');
}

function tokenImage(record) {
  if (!record.image) {
    return `<div class="token-image placeholder">${escapeHtml((record.symbol || '?').slice(0, 2))}</div>`;
  }

  return `<img class="token-image" src="${escapeAttr(record.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
}

function pill(text, color = 'gray', title = '') {
  return `<span class="pill ${escapeAttr(color)}" title="${escapeAttr(title || text)}">${escapeHtml(text)}</span>`;
}

function link(label, url) {
  if (!url) {
    return '';
  }

  return `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function labelX(status) {
  return X_LABELS[status] || status || 'sem xCheck';
}

function xColor(status) {
  if (status === 'x_confirmed_current_mint') {
    return 'green';
  }

  if (status === 'alpha_unposted') {
    return 'blue';
  }

  if (RED_FLAG_STATUSES.has(status)) {
    return 'red';
  }

  if (REVIEW_STATUSES.has(status) || status === 'x_profile_unavailable' || status === 'x_error') {
    return 'amber';
  }

  return 'gray';
}

function scoreColor(record) {
  if (isCandidate(record)) {
    return record.category === 'game' ? 'green' : 'blue';
  }

  if (record.gameScore > 0) {
    return 'amber';
  }

  return 'gray';
}

function uniqueRecords(records) {
  const map = new Map();
  for (const record of records) {
    map.set(recordKey(record), record);
  }
  return [...map.values()];
}

function recordKey(record) {
  return record.signature || record.mint || String(record.sequence);
}

function compareRecords(a, b) {
  const aTime = Date.parse(a.receivedAt || a.launchAt || '') || 0;
  const bTime = Date.parse(b.receivedAt || b.launchAt || '') || 0;
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  return (b.sequence ?? 0) - (a.sequence ?? 0);
}

function shortMint(mint) {
  if (!mint) {
    return '-';
  }
  return `${mint.slice(0, 6)}...${mint.slice(-6)}`;
}

function formatTime(value) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) {
    return '-';
  }

  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    hour12: false
  }).format(new Date(value));
}

function formatMs(value) {
  if (!Number.isFinite(Number(value))) {
    return '-';
  }

  return `${Math.round(Number(value))}ms`;
}

function formatMarket(record) {
  const parts = [];
  if (Number.isFinite(Number(record.marketCapSol))) {
    parts.push(`${Number(record.marketCapSol).toFixed(2)} SOL`);
  }
  if (Number.isFinite(Number(record.usdMarketCap))) {
    parts.push(`$${Number(record.usdMarketCap).toFixed(0)}`);
  }
  return parts.join(' | ') || '-';
}

function formatInt(value) {
  return new Intl.NumberFormat('pt-BR').format(value ?? 0);
}

function truncate(value, length) {
  const text = String(value ?? '');
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '');
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

function setStreamState(kind, text) {
  els.streamState.textContent = text;
  els.streamState.className = `stream-pill ${kind === 'live' ? 'live' : kind === 'error' ? 'error' : ''}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
