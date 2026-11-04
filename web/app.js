'use strict';

// ---- 定数 -------------------------------------------------------------------
const JST = 9 * 3600;
const DAY = 86400;
// 業種群ごとに色相を寄せる（ディフェンシブ=緑, 景気敏感=橙〜赤, 金融=青, ハイテク=紫〜マゼンタ）
const PALETTE = {
  defensive: ['#2b9348', '#55c47a', '#16867a', '#3fbfae', '#8ab83a'],
  cyclical: ['#f76707', '#e03131', '#f59f00', '#a0522d', '#ff8787', '#c2410c', '#d4a017'],
  financial: ['#1c7ed6', '#74c0fc', '#3b5bdb'],
  tech: ['#ae3ec9', '#e64980', '#7048e8', '#f783ac'],
};
const STORE_KEY = 'sector-rotation-chart:v1';

// ---- 状態 -------------------------------------------------------------------
const state = {
  root: '',            // data/ と config/ の置き場所（Pages では ''、ローカルで web/ を開くと '../'）
  config: null,
  tickers: [],         // {code,name,group,semi,color}
  cache: {},           // interval -> data json
  interval: '30m',
  mode: 'rs',
  base: 0,             // 基準足のインデックス
  end: null,           // 終点インデックス（null = 最新に追従）
  requested: null,     // ユーザーが指定した基準時刻（unix秒）。足とずれた時に表示する
  visible: new Set(),
  semiBold: true,
  slopeN: 3,
  clickBase: false,
};
let chart = null;

// ---- 小物 -------------------------------------------------------------------
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
function jst(t) {
  const d = new Date((t + JST) * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes() };
}
const dayKey = (t) => Math.floor((t + JST) / DAY);
function fmt(t, withTime = state.interval !== '1d') {
  const j = jst(t);
  const s = `${j.y}/${pad(j.m)}/${pad(j.d)}`;
  return withTime ? `${s} ${pad(j.H)}:${pad(j.M)}` : s;
}
function toInput(t) {
  const j = jst(t);
  return `${j.y}-${pad(j.m)}-${pad(j.d)}T${pad(j.H)}:${pad(j.M)}`;
}
function fromInput(v) {
  const m = /^(\d+)-(\d+)-(\d+)T(\d+):(\d+)/.exec(v);
  if (!m) return null;
  return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) / 1000 - JST;
}
// t 以前で直近の足（無ければ先頭）
function idxAtOrBefore(T, t) {
  let lo = 0, hi = T.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (T[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const signed = (v, d = 2) => (v > 0 ? '+' : '') + v.toFixed(d);

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      interval: state.interval, mode: state.mode, visible: [...state.visible],
      semiBold: state.semiBold, slopeN: state.slopeN, clickBase: state.clickBase,
    }));
  } catch (_) { /* プライベートブラウズ等 */ }
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s) return null;
    Object.assign(state, {
      interval: s.interval || state.interval, mode: s.mode || state.mode,
      semiBold: s.semiBold ?? true, slopeN: s.slopeN || 3, clickBase: !!s.clickBase,
    });
    return s;
  } catch (_) { return null; }
}

// ---- データ -----------------------------------------------------------------
async function fetchJson(path) {
  const r = await fetch(state.root + path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
async function detectRoot() {
  for (const root of ['', '../']) {
    try {
      const r = await fetch(root + 'config/tickers.json', { cache: 'no-cache' });
      if (r.ok) { state.root = root; return r.json(); }
    } catch (_) { /* 次を試す */ }
  }
  throw new Error('config/tickers.json が見つかりません');
}
async function loadInterval(iv, force = false) {
  if (!state.cache[iv] || force) state.cache[iv] = await fetchJson(`data/${iv}.json`);
  return state.cache[iv];
}
const data = () => state.cache[state.interval];
const endIdx = () => (state.end == null ? data().t.length - 1 : state.end);

// ---- 計算 -------------------------------------------------------------------
function benchCode() { return state.config.benchmark.code; }

// 基準 base から終点までの値（%）。基準時点で価格が無い銘柄は null
function series(code) {
  const d = data(), b = d.tickers[benchCode()], p = d.tickers[code];
  const i0 = state.base, i1 = endIdx();
  if (!p) return null;
  const P0 = p.c[i0], B0 = b.c[i0];
  if (P0 == null || B0 == null) return null;
  const out = new Array(i1 - i0 + 1);
  for (let i = i0; i <= i1; i++) {
    const P = p.c[i], B = b.c[i];
    if (P == null || B == null) { out[i - i0] = null; continue; }
    const v = state.mode === 'rs' ? (P / P0) / (B / B0) - 1 : P / P0 - 1;
    out[i - i0] = +(v * 100).toFixed(3);
  }
  return out;
}

function computeAll() {
  const rows = [];
  for (const t of state.tickers) {
    const s = series(t.code);
    if (!s) continue;
    const last = s[s.length - 1];
    const prev = s[Math.max(0, s.length - 1 - state.slopeN)];
    rows.push({ ...t, s, last, slope: last != null && prev != null ? last - prev : null });
  }
  return rows;
}

// ---- 基準点の設定 -----------------------------------------------------------
function setBaseTime(t, requested = t) {
  const T = data().t;
  let i = idxAtOrBefore(T, t);
  state.requested = requested;
  if (i < 0) i = 0;
  const e = endIdx();
  if (i >= e) i = Math.max(0, e - 1);
  state.base = i;
}

function preset(p) {
  const T = data().t, e = endIdx(), last = T[e];
  // 終点以前の取引日（JSTの日付）一覧
  const lastDay = dayKey(last);
  if (p === 'open' || p === 'prevclose') {
    let i = e;
    while (i > 0 && dayKey(T[i - 1]) === lastDay) i--;     // i = 当日最初の足
    if (state.interval === '1d') { setBaseTime(T[Math.max(0, e - 1)]); return; }
    if (p === 'open') { setBaseTime(T[i]); return; }
    setBaseTime(T[Math.max(0, i - 1)]);                       // 前日の最終足
    return;
  }
  const d = new Date(last * 1000);
  if (p === '1w') d.setUTCDate(d.getUTCDate() - 7);
  if (p === '1m') d.setUTCMonth(d.getUTCMonth() - 1);
  if (p === '3m') d.setUTCMonth(d.getUTCMonth() - 3);
  setBaseTime(Math.floor(d.getTime() / 1000));
}

// ---- 描画 -------------------------------------------------------------------
function initChart() {
  if (chart) chart.dispose();
  chart = echarts.init($('#chart'), null, { renderer: 'canvas' });
  chart.getZr().on('click', (ev) => {
    if (!state.clickBase) return;
    const p = [ev.offsetX, ev.offsetY];
    if (!chart.containPixel({ gridIndex: 0 }, p)) return;
    const k = chart.convertFromPixel({ gridIndex: 0 }, p)[0];
    if (k == null || k <= 0) return;
    setBaseTime(data().t[state.base + Math.round(k)]);
    render();
  });
}

function labelsFor(i0, i1) {
  const T = data().t, out = [];
  for (let i = i0; i <= i1; i++) out.push(T[i]);
  return out;
}

function render() {
  const d = data();
  const T = d.t, i0 = state.base, i1 = endIdx();
  const rows = computeAll();
  const narrow = window.innerWidth <= 820;
  const text = cssVar('--text'), muted = cssVar('--muted'), grid = cssVar('--grid');

  const visRows = rows.filter((r) => state.visible.has(r.code));
  const seriesOpt = visRows.map((r) => {
    const bold = state.semiBold && r.semi;
    return {
      id: r.code, name: r.name, type: 'line', data: r.s,
      showSymbol: false, symbol: 'circle', symbolSize: 5,
      connectNulls: false, color: r.color,
      lineStyle: { width: bold ? 3.2 : 1.6 },
      z: bold ? 3 : 2,
      emphasis: { focus: 'series', lineStyle: { width: bold ? 4 : 3 } },
      endLabel: {
        show: true, color: r.color, fontSize: narrow ? 10 : 11, fontWeight: bold ? 'bold' : 'normal',
        formatter: (p) => narrow ? r.name.slice(0, 4) : `${r.name} ${signed(p.value ?? 0, 1)}`,
      },
      labelLayout: { moveOverlap: 'shiftY' },
    };
  });
  // 単純変化率モードではベンチマーク自身も描く（TOPIX比モードでは常に0なので不要）
  if (state.mode === 'pct') {
    const b = d.tickers[benchCode()];
    const B0 = b.c[i0];
    seriesOpt.push({
      id: '__bench', name: 'TOPIX(1306)', type: 'line', showSymbol: false, color: muted,
      lineStyle: { width: 2, type: 'dashed' },
      data: b.c.slice(i0, i1 + 1).map((v) => (v == null ? null : +((v / B0 - 1) * 100).toFixed(3))),
      endLabel: { show: !narrow, color: muted, formatter: 'TOPIX' },
    });
  }
  // 0% の基準線
  seriesOpt.push({
    id: '__zero', type: 'line', data: [], silent: true,
    markLine: { silent: true, symbol: 'none', label: { show: false },
      lineStyle: { color: muted, width: 1, type: 'solid' }, data: [{ yAxis: 0 }] },
  });

  const xs = labelsFor(i0, i1);
  const intraday = state.interval !== '1d';
  chart.setOption({
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { color: text },
    grid: { left: 44, right: narrow ? 64 : 150, top: 16, bottom: 56 },
    tooltip: {
      trigger: 'axis', confine: true, order: 'valueDesc',
      backgroundColor: cssVar('--panel'), borderColor: cssVar('--border'), textStyle: { color: text, fontSize: 12 },
      axisPointer: { type: 'line', lineStyle: { color: muted } },
      formatter: (ps) => {
        if (!ps.length) return '';
        const k = ps[0].dataIndex, idx = i0 + k;
        const lines = ps
          .filter((p) => p.seriesId !== '__zero' && p.value != null)
          .sort((a, b) => b.value - a.value)
          .map((p) => {
            const tk = d.tickers[p.seriesId];
            const nofill = tk && tk.filled[idx] ? ' <span style="color:#e8590c">約定なし</span>' : '';
            const cls = p.value >= 0 ? cssVar('--pos') : cssVar('--neg');
            return `<div style="display:flex;gap:8px;justify-content:space-between">
              <span>${p.marker}${p.seriesName}${nofill}</span>
              <b style="color:${cls}">${signed(p.value)}%</b></div>`;
          });
        return `<div style="margin-bottom:4px"><b>${fmt(T[idx])}</b></div>${lines.join('')}`;
      },
    },
    xAxis: {
      type: 'category', data: xs, boundaryGap: false,
      axisLine: { lineStyle: { color: muted } },
      axisLabel: {
        color: muted, hideOverlap: true,
        formatter: (v, k) => {
          const j = jst(+v);
          if (!intraday) return `${pad(j.m)}/${pad(j.d)}` + (j.m === 1 && j.d <= 7 ? `\n${j.y}` : '');
          const newDay = k === 0 || dayKey(+v) !== dayKey(xs[k - 1]);
          return newDay ? `${j.m}/${j.d}` : `${pad(j.H)}:${pad(j.M)}`;
        },
      },
      axisPointer: { label: { formatter: (p) => fmt(+p.value) } },
    },
    yAxis: {
      type: 'value', scale: true,
      axisLabel: { color: muted, formatter: '{value}%' },
      splitLine: { lineStyle: { color: grid } },
    },
    dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'none' }],
    series: seriesOpt,
  }, { notMerge: true });

  renderInfo();
  renderRanking(rows);
  renderLegend();
  save();
}

function renderInfo() {
  const T = data().t, i0 = state.base, i1 = endIdx();
  let html = `基準 <b>${fmt(T[i0])}</b> の足（終値）〜 <b>${fmt(T[i1])}</b>　${i1 - i0} 本`;
  if (state.requested != null && state.requested < T[0]) {
    html += ` <span class="warn">※指定日時 ${fmt(state.requested, true)} はこの足種のデータ範囲外のため先頭に合わせました</span>`;
  } else if (state.requested != null && Math.abs(state.requested - T[i0]) > 60 && state.interval !== '1d') {
    html += ` <span class="muted">（指定 ${fmt(state.requested, true)} 以前の直近足）</span>`;
  }
  $('#base-info').innerHTML = html;
  $('#base-input').value = toInput(T[i0]);
  $('#end-input').value = toInput(T[i1]);
  $('#updated').textContent = `データ更新: ${data().updated_at.replace('T', ' ').slice(0, 16)} JST`;
}

function renderRanking(rows) {
  const sorted = rows.filter((r) => r.last != null).sort((a, b) => b.last - a.last);
  const maxAbs = Math.max(0.01, ...sorted.map((r) => Math.abs(r.last)));
  const pos = cssVar('--pos'), neg = cssVar('--neg');
  $('#rank-list').innerHTML = sorted.map((r) => {
    const w = (Math.abs(r.last) / maxAbs) * 50;
    const fill = r.last >= 0
      ? `left:50%;width:${w}%;background:${pos}`
      : `left:${50 - w}%;width:${w}%;background:${neg}`;
    const sl = r.slope == null ? '' : `<span class="${r.slope >= 0 ? 'pos' : 'neg'}">${r.slope >= 0 ? '▲' : '▼'}${Math.abs(r.slope).toFixed(2)}</span>`;
    return `<div class="rank-row${state.visible.has(r.code) ? '' : ' off'}" data-code="${r.code}" title="${r.code} ${r.name}">
      <span class="dot" style="background:${r.color}"></span>
      <span class="name${r.semi ? ' semi' : ''}">${r.name}</span>
      <span class="val ${r.last >= 0 ? 'pos' : 'neg'}">${signed(r.last)}%</span>
      <span class="bar"><span class="axis"></span><span class="fill" style="${fill}"></span></span>
      <span class="slope">${sl}</span>
    </div>`;
  }).join('');
}

function renderLegend() {
  const groups = state.config.groups;
  $('#legend').innerHTML = Object.keys(groups).map((g) => {
    const chips = state.tickers.filter((t) => t.group === g).map((t) =>
      `<button class="chip${state.visible.has(t.code) ? '' : ' off'}" data-code="${t.code}" title="${t.code}">
        <i style="background:${t.color}${t.semi ? ';height:5px' : ''}"></i>${t.name}</button>`).join('');
    return `<div class="lg-group"><span>${groups[g]}</span>${chips}</div>`;
  }).join('');
}

function syncButtons() {
  for (const b of document.querySelectorAll('#interval button')) b.classList.toggle('on', b.dataset.v === state.interval);
  for (const b of document.querySelectorAll('#mode button')) b.classList.toggle('on', b.dataset.v === state.mode);
  $('#slope-n').value = String(state.slopeN);
  $('#semi-bold').checked = state.semiBold;
  $('#click-base').checked = state.clickBase;
}

function toggle(code) {
  if (state.visible.has(code)) state.visible.delete(code); else state.visible.add(code);
  render();
}

// ---- イベント ---------------------------------------------------------------
async function switchInterval(iv) {
  const prevBase = data() ? data().t[state.base] : null;
  const prevEnd = data() && state.end != null ? data().t[state.end] : null;
  state.interval = iv;
  syncButtons();
  await loadInterval(iv);
  state.end = prevEnd == null ? null : Math.max(1, idxAtOrBefore(data().t, prevEnd));
  if (prevBase == null) preset(iv === '1d' ? '3m' : 'prevclose');
  else setBaseTime(prevBase, state.requested ?? prevBase);
  render();
}

function bind() {
  $('#interval').addEventListener('click', (e) => {
    const v = e.target.dataset.v;
    if (v && v !== state.interval) switchInterval(v).catch(showError);
  });
  $('#mode').addEventListener('click', (e) => {
    const v = e.target.dataset.v;
    if (v) { state.mode = v; syncButtons(); render(); }
  });
  $('#presets').addEventListener('click', (e) => {
    const p = e.target.dataset.p;
    if (p) { preset(p); render(); }
  });
  $('#base-input').addEventListener('change', (e) => {
    const t = fromInput(e.target.value);
    if (t != null) { setBaseTime(t); render(); }
  });
  $('#end-input').addEventListener('change', (e) => {
    const t = fromInput(e.target.value);
    if (t == null) return;
    const T = data().t;
    const i = idxAtOrBefore(T, t);
    state.end = i >= T.length - 1 ? null : Math.max(state.base + 1, i);
    render();
  });
  $('#end-latest').addEventListener('click', () => { state.end = null; render(); });
  $('#click-base').addEventListener('change', (e) => { state.clickBase = e.target.checked; save(); });
  $('#semi-bold').addEventListener('change', (e) => { state.semiBold = e.target.checked; render(); });
  $('#slope-n').addEventListener('change', (e) => { state.slopeN = +e.target.value; render(); });
  $('#legend').addEventListener('click', (e) => {
    const c = e.target.closest('[data-code]');
    if (c) toggle(c.dataset.code);
  });
  $('#rank-list').addEventListener('click', (e) => {
    const c = e.target.closest('[data-code]');
    if (c) toggle(c.dataset.code);
  });
  $('#show-all').addEventListener('click', () => { state.visible = new Set(state.tickers.map((t) => t.code)); render(); });
  $('#show-none').addEventListener('click', () => { state.visible = new Set(); render(); });
  $('#show-top').addEventListener('click', () => {
    const rows = computeAll().filter((r) => r.last != null).sort((a, b) => b.last - a.last);
    const pick = [...rows.slice(0, 5), ...rows.slice(-5)].map((r) => r.code);
    if (state.semiBold) for (const t of state.tickers) if (t.semi) pick.push(t.code);
    state.visible = new Set(pick);
    render();
  });

  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { chart.resize(); render(); }, 150); });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { initChart(); render(); });

  // 10分ごとに最新データを再取得（基準時刻は維持、終点が「最新」なら追従）
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const baseT = data().t[state.base];
      await loadInterval(state.interval, true);
      setBaseTime(baseT, state.requested ?? baseT);
      render();
    } catch (e) { console.warn(e); }
  }, 10 * 60 * 1000);
}

function showError(e) {
  console.error(e);
  $('#base-info').innerHTML = `<span class="warn">読み込みエラー: ${e.message}</span>`;
}

// ---- 起動 -------------------------------------------------------------------
async function main() {
  state.config = await detectRoot();
  const counters = {};
  state.tickers = state.config.tickers.map((t) => {
    const pal = PALETTE[t.group] || PALETTE.cyclical;
    const k = counters[t.group] = (counters[t.group] ?? -1) + 1;
    return { ...t, semi: !!t.semi, color: t.color || pal[k % pal.length] };
  });
  const saved = restore();
  // ?interval=1d&mode=pct で初期表示を指定できる（ブックマーク用）
  const q = new URLSearchParams(location.search);
  if (['30m', '60m', '1d'].includes(q.get('interval'))) state.interval = q.get('interval');
  if (['rs', 'pct'].includes(q.get('mode'))) state.mode = q.get('mode');
  const codes = new Set(state.tickers.map((t) => t.code));
  state.visible = saved && Array.isArray(saved.visible)
    ? new Set(saved.visible.filter((c) => codes.has(c)))
    : new Set(codes);
  if (window.innerWidth <= 820) $('#legend-box').removeAttribute('open');

  syncButtons();
  initChart();
  bind();
  await loadInterval(state.interval);
  preset(state.interval === '1d' ? '3m' : 'prevclose');
  render();
}

main().catch(showError);
