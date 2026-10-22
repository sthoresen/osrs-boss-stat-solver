import { ITEMS } from './items.js';
import { CONFIG } from './config.js';
import { loadout, dps, drained } from './engine.js';
import { solve, PARAMS } from './solver.js';

const GROUPS = ['melee', 'ranged', 'magic'];
const GROUP_NAME = { melee: 'Melee', ranged: 'Ranged', magic: 'Magic' };
const SETUPS = [...CONFIG.setups].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
const BY_ID = Object.fromEntries(SETUPS.map((s) => [s.id, s]));
const SOLVABLE = new Set(PARAMS.map((p) => p.key));
// shown greyed out with a fixed lock: stats the solver never touches
const UNUSED = new Set(['stab', 'slash', 'hp']);
const STEP = 0.05; // each arrow click asks for 5% more or less DPS
const MAX_CLICKS = 10; // ±50%

// The boss is always large (size 5), so the scythe hits all three times.
const BOSS_SIZE = 5;

// Default boss stats.
const DEFAULT_BOSS = {
  def: 185, magic: 205, hp: 2000, size: BOSS_SIZE,
  stab: 100, slash: 100, crush: 55, mdef: 350, light: 257, standard: 215, heavy: 300,
  severity: 116, defCap: 26, mdefCap: 32,
};

const STAT_GROUPS = [
  { title: 'Levels', rows: [
    { key: 'def', name: 'Defence', icon: 'ui/defence.png' },
    { key: 'magic', name: 'Magic', note: 'Also sets the Twisted bow bonus (max at 250)', icon: 'ui/magic.png' },
  ] },
  { title: 'Defence bonuses', rows: [
    { key: 'crush', name: 'Crush', icon: 'ui/warhammer.png' },
    { key: 'mdef', name: 'Magic', icon: 'ui/magic.png' },
    { key: 'light', name: 'Ranged light', note: 'Darts (blowpipe)', icon: 'ui/ranged_light.webp' },
    { key: 'standard', name: 'Ranged standard', note: 'Arrows (tbow, bowfa)', icon: 'ui/ranged_standard.webp' },
    { key: 'heavy', name: 'Ranged heavy', note: 'Bolts (crossbows)', icon: 'ui/ranged_heavy.webp' },
    { key: 'stab', name: 'Stab', note: 'No setup here uses it', icon: 'ui/dagger.png', lo: -100, hi: 1500 },
    { key: 'slash', name: 'Slash', note: 'No setup here uses it', icon: 'ui/scimitar.png', lo: -100, hi: 1500 },
  ] },
  { title: 'Elemental weakness', rows: [
    { key: 'severity', name: 'Weakness', unit: '%', note: 'Boosts elemental spells (Harm, Twinflame)', icon: 'items/fire-surge.png' },
  ] },
  { title: 'Defence drain', rows: [
    { key: 'defCap', name: 'Defence drain cap', unit: '%', icon: 'ui/Dragon_warhammer.webp', note: (b) => `Defence can drop to ${b.def - Math.floor(b.def * b.defCap / 100)}` },
    { key: 'mdefCap', name: 'Magic def drain cap', unit: '%', icon: 'ui/Eye_of_ayak.png', note: (b) => (b.mdef > 0 ? `Eye of Ayak can drain magic def to ${b.mdef - Math.floor(b.mdef * b.mdefCap / 100)}` : 'Magic def ≤ 0: nothing to drain') },
  ] },
  { title: 'Fight', rows: [
    { key: 'hp', name: 'Hitpoints', note: 'Only matters for ruby bolts (20% of HP, max 100)', icon: 'ui/hitpoints.png', lo: 1, hi: 100000, fixed: true },
  ] },
];
const STAT_ROWS = STAT_GROUPS.flatMap((g) => g.rows);
for (const r of STAT_ROWS) {
  const p = PARAMS.find((x) => x.key === r.key);
  if (p) Object.assign(r, { lo: p.lo, hi: p.hi });
}

/** Keep loaded stats (presets, share links) inside the allowed bounds. */
function clampBoss(b) {
  const out = { ...b, size: BOSS_SIZE };
  for (const r of STAT_ROWS) {
    if (typeof out[r.key] === 'number') out[r.key] = Math.min(r.hi, Math.max(r.lo, Math.round(out[r.key])));
  }
  return out;
}

const state = {
  boss: { ...DEFAULT_BOSS },
  nudges: {}, // setup id -> clicks (+ up, - down), pending until Solve
  enabled: new Set(SETUPS.map((s) => s.id)),
  locked: new Set(['stab', 'slash']),
  mode: 'cap',
  status: 'solved', // 'solved' | 'edited' | 'solving'
  lastResult: null, // [{id, asked, got}] from the last solve
  history: [],
};

let report = null;
let solveCtl = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = (f) => `img/items/${f}`;
const fmt = (v, d = 2) => v.toFixed(d);
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const signedPct = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(0)}%`;
const factor = (clicks) => 1 + STEP * clicks;

// ---------- model ----------
function computeReport() {
  const b = state.boss;
  const r = drained(b, state.mode);
  const rows = {};
  for (const s of SETUPS) {
    const L = loadout(s);
    rows[s.id] = { s, L, base: dps(L, b), red: dps(L, r) };
  }
  return { rows, drainedBoss: r };
}

const enabledSetups = () => SETUPS.filter((s) => state.enabled.has(s.id));
const pendingIds = () => enabledSetups().filter((s) => state.nudges[s.id]).map((s) => s.id);

// ---------- chart ----------
const M = { left: 46, right: 14, top: 30, bottom: 118 };
const COL_W = 54;
const GROUP_GAP = 22;
const PLOT_H = 340;

function niceStep(max) {
  if (max <= 6) return 1;
  if (max <= 14) return 2;
  if (max <= 30) return 5;
  return 10;
}

function chartMax() {
  let m = 0;
  for (const s of enabledSetups()) {
    const row = report.rows[s.id];
    m = Math.max(m, row.red.dps, row.base.dps * factor(state.nudges[s.id] || 0));
  }
  const step = niceStep(m * 1.15);
  return Math.max(step, Math.ceil((m * 1.12) / step) * step);
}

function layoutColumns() {
  const cols = [];
  let x = M.left + 8;
  let prevGroup = null;
  for (const s of enabledSetups()) {
    if (prevGroup && s.group !== prevGroup) x += GROUP_GAP;
    cols.push({ s, cx: x + COL_W / 2, x0: x });
    x += COL_W;
    prevGroup = s.group;
  }
  return { cols, width: x + M.right };
}

function topRoundedRect(x, y, w, h, r) {
  if (h <= 0) return '';
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function splitLabel(text) {
  const words = text.split(' ');
  if (words.length === 1) return [text];
  let best = [text];
  let bestLen = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const len = Math.max(a.length, b.length);
    if (len < bestLen) { bestLen = len; best = [a, b]; }
  }
  return best;
}

function arrowButton(id, dir, x, y, disabled) {
  const up = dir > 0;
  const tri = up ? `M${x - 5},${y + 3} L${x},${y - 3} L${x + 5},${y + 3}Z` : `M${x - 5},${y - 3} L${x},${y + 3} L${x + 5},${y - 3}Z`;
  const label = `${up ? 'More' : 'Less'} DPS for ${BY_ID[id].short}`;
  return `<g class="arrow ${up ? 'up' : 'down'}${disabled ? ' disabled' : ''}" data-id="${id}" data-dir="${dir}" tabindex="0" role="button" aria-label="${esc(label)}"${disabled ? ' aria-disabled="true"' : ''}>`
    + `<title>${esc(label)} (${up ? '+' : '−'}5%)</title>`
    + `<rect x="${x - 15}" y="${y - 10}" width="30" height="20" rx="5"/><path d="${tri}"/></g>`;
}

function renderChart() {
  const svg = $('#chart');
  const ymax = chartMax();
  const { cols, width } = layoutColumns();
  const W = Math.max(width, 320);
  const H = M.top + PLOT_H + M.bottom;
  const plotBottom = M.top + PLOT_H;
  const y = (v) => plotBottom - (v / ymax) * PLOT_H;
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  let out = '';
  const step = niceStep(ymax);
  for (let v = 0; v <= ymax + 1e-9; v += step) {
    out += `<line class="grid-line" x1="${M.left}" x2="${width - M.right}" y1="${y(v)}" y2="${y(v)}"/>`;
    out += `<text class="axis-text" x="${M.left - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  out += `<text class="axis-title" x="12" y="${M.top + PLOT_H / 2}" transform="rotate(-90 12 ${M.top + PLOT_H / 2})" text-anchor="middle">DPS</text>`;

  for (const g of GROUPS) {
    const gc = cols.filter((c) => c.s.group === g);
    if (!gc.length) continue;
    const mid = (gc[0].x0 + gc[gc.length - 1].x0 + COL_W) / 2;
    out += `<circle cx="${mid - GROUP_NAME[g].length * 3.6 - 9}" cy="${M.top - 14}" r="4.5" style="fill:var(--${g})"/>`;
    out += `<text class="group-label" x="${mid + 2}" y="${M.top - 10}" text-anchor="middle">${GROUP_NAME[g]}</text>`;
  }

  for (const c of cols) {
    const { s, cx } = c;
    const row = report.rows[s.id];
    const clicks = state.nudges[s.id] || 0;
    const color = `var(--${s.group})`;
    const yb = y(row.base.dps);
    const yr = y(row.red.dps);
    out += `<g class="col${clicks ? ' pending' : ''}" data-id="${s.id}">`;
    out += `<rect class="col-hit${overlayId === s.id ? ' active' : ''}" x="${c.x0 + 2}" y="${M.top - 4}" width="${COL_W - 4}" height="${PLOT_H + 64}" rx="6"/>`;
    out += `<path d="${topRoundedRect(cx - 10, yb, 20, plotBottom - yb, 4)}" style="fill:${color}"/>`;
    if (yb - yr > 3) out += `<path class="bar-wash" d="${topRoundedRect(cx - 10, yr, 20, yb - yr - 2, 4)}" style="fill:${color}"/>`;

    if (clicks) {
      // requested level: a line at the asked-for DPS, joined to the bar top
      const yq = y(row.base.dps * factor(clicks));
      out += `<line class="req-stem" x1="${cx}" x2="${cx}" y1="${yb}" y2="${yq}"/>`;
      out += `<rect class="req-line" x="${cx - 16}" y="${yq - 2}" width="32" height="4" rx="2"/>`;
      const top = Math.min(yq, yr, yb);
      out += `<text class="req-text" x="${cx}" y="${top - 8}" text-anchor="middle">${signedPct(factor(clicks) - 1)}</text>`;
    } else if (state.lastResult && state.status === 'solved') {
      const r = state.lastResult.find((x) => x.id === s.id && x.asked !== 0);
      if (r) out += `<text class="got-text" x="${cx}" y="${Math.min(yb, yr) - 8}" text-anchor="middle">${signedPct(r.got)}</text>`;
    }

    out += `<image href="${img(row.L.items.weapon.img)}" x="${cx - 14}" y="${plotBottom + 6}" width="28" height="28"/>`;
    splitLabel(s.short).forEach((ln, i) => {
      out += `<text class="col-label" x="${cx}" y="${plotBottom + 46 + i * 12}" text-anchor="middle">${esc(ln)}</text>`;
    });
    out += '</g>';
    out += arrowButton(s.id, 1, cx, plotBottom + 80, clicks >= MAX_CLICKS);
    out += arrowButton(s.id, -1, cx, plotBottom + 103, clicks <= -MAX_CLICKS);
  }
  out += `<line x1="${M.left}" x2="${width - M.right}" y1="${plotBottom}" y2="${plotBottom}" style="stroke:var(--text-2);stroke-width:1"/>`;
  svg.innerHTML = out;
}

function nudge(id, dir) {
  const cur = state.nudges[id] || 0;
  const next = Math.max(-MAX_CLICKS, Math.min(MAX_CLICKS, cur + dir));
  if (next === 0) delete state.nudges[id]; else state.nudges[id] = next;
  renderAll();
}

function initChartEvents() {
  const svg = $('#chart');
  const press = (a) => {
    if (!a.classList.contains('disabled')) nudge(a.dataset.id, Number(a.dataset.dir));
    $(`#chart .arrow[data-id="${a.dataset.id}"][data-dir="${a.dataset.dir}"]`)?.focus({ preventScroll: true });
  };
  svg.addEventListener('click', (e) => {
    const a = e.target.closest('.arrow');
    if (a) press(a);
  });
  svg.addEventListener('keydown', (e) => {
    const a = e.target.closest('.arrow');
    if (a && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      press(a);
    }
  });
  svg.addEventListener('pointerdown', (e) => {
    const col = e.target.closest('.col');
    if (col && e.pointerType !== 'mouse') {
      if (overlayId === col.dataset.id && overlayPinned) hideOverlay(true);
      else showOverlay(col.dataset.id, e, true);
    }
  });
  svg.addEventListener('pointermove', (e) => {
    if (overlayId && !overlayPinned) positionOverlay(e);
  });
  svg.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const col = e.target.closest('.col');
    if (col && col.dataset.id !== overlayId) showOverlay(col.dataset.id, e, false);
  });
  svg.addEventListener('pointerout', (e) => {
    if (e.pointerType !== 'mouse' || overlayPinned) return;
    const to = e.relatedTarget && e.relatedTarget.closest ? e.relatedTarget.closest('.col') : null;
    if (!to) hideOverlay();
  });
  document.addEventListener('pointerdown', (e) => {
    if (overlayPinned && !e.target.closest('#chart') && !e.target.closest('#overlay')) hideOverlay(true);
  });
}

// ---------- gear overlay ----------
let overlayId = null;
let overlayPinned = false;
const INV_LAYOUT = [
  [null, 'head', null],
  ['cape', 'neck', 'ammo'],
  ['weapon', 'body', 'shield'],
  [null, 'legs', null],
  ['hands', 'feet', 'ring'],
];
const DEF_STYLE_NAME = { crush: 'crush', light: 'ranged (light)', standard: 'ranged (standard)', heavy: 'ranged (heavy)', magic: 'magic' };

function maxHitText(row, d) {
  const L = row.L;
  if (L.scythe) {
    return [0, 1, 2].map((i) => Math.trunc(d.max / 2 ** i)).join(' / ');
  }
  if (L.twinflame) return `${d.max} + ${Math.trunc(d.max * 4 / 10)}`;
  if (L.ruby) return `${d.max} (ruby proc ${Math.min(100, Math.trunc(state.boss.hp / 5))})`;
  return String(d.max);
}

function overlayHtml(id) {
  const row = report.rows[id];
  const { s, L, base, red } = row;
  let grid = '';
  for (const r of INV_LAYOUT) {
    for (const slot of r) {
      if (!slot) { grid += '<div class="slot empty"></div>'; continue; }
      const it = L.items[slot];
      const spell = slot === 'weapon' && L.spell && L.spell.img ? `<img class="spell" src="${img(L.spell.img)}" alt="">` : '';
      grid += it
        ? `<div class="slot" title="${esc(it.name)}"><img src="${img(it.img)}" alt="${esc(it.name)}">${spell}</div>`
        : `<div class="slot"><img class="ph" src="img/ui/${slot}.png" alt=""></div>`;
    }
  }
  const defKind = L.kind === 'melee' ? L.type : L.kind === 'ranged' ? L.rangedType : 'magic';
  const items = Object.values(L.items).map((it) => `<div>${esc(it.name)}</div>`).join('')
    + (L.dart ? `<div>${esc(L.dart.name)}s</div>` : '')
    + (L.spell ? `<div>${esc(L.spell.name)} (autocast)</div>` : '');
  const drainNote = L.kind === 'magic'
    ? `Drained: magic def bonus ${state.boss.mdef} → ${report.drainedBoss.mdef} (Eye of Ayak spec)`
    : `Drained: Defence ${state.boss.def} → ${report.drainedBoss.def}`;
  const clicks = state.nudges[id] || 0;
  return `<div class="ov-title"><span class="dot ${s.group}"></span>${esc(s.name)}</div>
  <div class="ov-body">
    <div class="inv">${grid}</div>
    <dl class="ov-stats">
      <dt>DPS</dt><dd>${fmt(base.dps)}</dd>
      <dt>DPS drained</dt><dd>${fmt(red.dps)}</dd>
      ${clicks ? `<dt>Pending</dt><dd>${signedPct(factor(clicks) - 1)}</dd>` : ''}
      <div class="hr"></div>
      <dt>Max hit</dt><dd>${maxHitText(row, base)}</dd>
      <dt>Hit chance</dt><dd>${pct(base.acc)} → ${pct(red.acc)}</dd>
      <dt>Speed</dt><dd>${base.speed}t (${fmt(base.speed * 0.6, 1)}s)</dd>
      <dt>Rolls vs</dt><dd>${DEF_STYLE_NAME[defKind]}</dd>
    </dl>
  </div>
  <div class="ov-items">${items}</div>
  <div class="ov-note">${esc(drainNote)}</div>`;
}

function showOverlay(id, e, pinned) {
  const ov = $('#overlay');
  overlayId = id;
  overlayPinned = pinned;
  ov.innerHTML = overlayHtml(id);
  ov.hidden = false;
  ov.classList.toggle('pinned', pinned);
  positionOverlay(e);
  document.querySelectorAll('#chart .col-hit').forEach((r) => r.classList.toggle('active', r.parentNode.dataset.id === id));
}

function positionOverlay(e) {
  const ov = $('#overlay');
  const pad = 8;
  const w = ov.offsetWidth;
  const h = ov.offsetHeight;
  let x = e.clientX + 18;
  let y = e.clientY + 18;
  if (x + w > window.innerWidth - pad) x = e.clientX - w - 18;
  if (x < pad) x = pad;
  if (y + h > window.innerHeight - pad) y = window.innerHeight - h - pad;
  if (y < pad) y = pad;
  ov.style.left = `${x}px`;
  ov.style.top = `${y}px`;
}

function hideOverlay(force) {
  if (overlayPinned && !force) return;
  overlayId = null;
  overlayPinned = false;
  $('#overlay').hidden = true;
  document.querySelectorAll('#chart .col-hit.active').forEach((r) => r.classList.remove('active'));
}

// ---------- status ----------
const ICON_CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
const ICON_PENDING = '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="4"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 13l1-3.5L11 2.5l2.5 2.5-7 7z"/></svg>';

function resultText() {
  const asked = state.lastResult.filter((r) => r.asked !== 0);
  if (!asked.length) return '';
  const close = asked.filter((r) => Math.abs(r.got - r.asked) <= Math.max(0.02, Math.abs(r.asked) * 0.3)).length;
  return `${close} of ${asked.length} requested change${asked.length > 1 ? 's' : ''} landed close to what you asked. The % over a bar is how much it actually moved.`;
}

function renderStatus() {
  const n = pendingIds().length;
  const el = $('#status');
  let html;
  let cls;
  if (state.status === 'solving') {
    cls = 'solving';
    html = `${ICON_PENDING}<span><b>Solving…</b></span>`;
  } else if (n) {
    cls = 'pending';
    html = `${ICON_PENDING}<span><b>${n} change${n > 1 ? 's' : ''} pending.</b> Press Solve to find boss stats for them.</span>`;
  } else if (state.status === 'edited') {
    cls = 'edited';
    html = `${ICON_EDIT}<span><b>Showing edited stats.</b> Use the arrows under each setup to ask for more or less DPS.</span>`;
  } else {
    cls = 'solved';
    html = `${ICON_CHECK}<span><b>Solved.</b> ${state.lastResult ? resultText() : 'Use the arrows under each setup to ask for more or less DPS.'}</span>`;
  }
  el.className = `status ${cls}`;
  el.innerHTML = html;
  const solveBtn = $('#solve');
  solveBtn.disabled = state.status === 'solving' || n === 0;
  $('#clear').hidden = n === 0;
  $('#undo').hidden = !state.history.length || n > 0;
}

// ---------- stats panel ----------
const LOCK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
const UNLOCK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/></svg>';

function buildStats() {
  let html = '';
  for (const g of STAT_GROUPS) {
    html += `<div class="stat-group"><h3>${g.title}</h3>`;
    for (const r of g.rows) {
      const unused = UNUSED.has(r.key);
      const lockBtn = SOLVABLE.has(r.key) && !unused
        ? `<button class="lock" data-lock="${r.key}" aria-label="Lock ${esc(r.name)}" aria-pressed="false"></button>`
        : `<button class="lock" disabled aria-label="${esc(r.name)} is never changed by the solver" aria-pressed="true">${LOCK_SVG}</button>`;
      html += `<div class="stat-row${unused ? ' unused' : ''}" data-row="${r.key}">
        <img src="img/${r.icon}" alt="">
        <div class="stack"><div class="name">${r.name}${r.unit ? ` (${r.unit})` : ''}<small data-note="${r.key}"></small></div>
        <input type="range" data-key="${r.key}" min="${r.lo}" max="${r.hi}" step="1" aria-label="${esc(r.name)}"></div>
        <input type="number" data-key="${r.key}" min="${r.lo}" max="${r.hi}" step="1" aria-label="${esc(r.name)} value">
        ${lockBtn}
      </div>`;
    }
    html += '</div>';
  }
  $('#stats').innerHTML = html;

  $('#stats').addEventListener('input', (e) => {
    const key = e.target.dataset.key;
    if (!key) return;
    const row = STAT_ROWS.find((r) => r.key === key);
    let v = Math.round(Number(e.target.value));
    if (!Number.isFinite(v)) return;
    v = Math.min(row.hi, Math.max(row.lo, v));
    state.boss[key] = v;
    state.status = 'edited';
    state.lastResult = null;
    $('#bossPreset').value = '';
    $('#presetNote').textContent = '';
    renderAll(e.target);
  });
  $('#stats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lock]');
    if (!b) return;
    const k = b.dataset.lock;
    if (state.locked.has(k)) state.locked.delete(k); else state.locked.add(k);
    renderStats();
    saveHash();
  });

  const sel = $('#bossPreset');
  ITEMS.presets.forEach((p, i) => { sel.insertAdjacentHTML('beforeend', `<option value="${i}">${esc(p.name)}</option>`); });
  sel.addEventListener('change', () => {
    if (sel.value === '') return;
    const p = ITEMS.presets[Number(sel.value)];
    pushHistory();
    state.boss = clampBoss({ ...state.boss, ...p.boss });
    state.status = 'edited';
    state.lastResult = null;
    $('#presetNote').textContent = `${p.note}.`;
    renderAll();
  });
}

function renderStats(skip) {
  const b = state.boss;
  document.querySelectorAll('#stats [data-key]').forEach((el) => {
    if (el !== skip) el.value = b[el.dataset.key];
  });
  for (const r of STAT_ROWS) {
    const n = document.querySelector(`[data-note="${r.key}"]`);
    if (n) n.textContent = typeof r.note === 'function' ? r.note(b) : (r.note || '');
  }
  document.querySelectorAll('#stats [data-lock]').forEach((btn) => {
    const locked = state.locked.has(btn.dataset.lock);
    btn.setAttribute('aria-pressed', locked);
    btn.innerHTML = locked ? LOCK_SVG : UNLOCK_SVG;
    btn.title = locked ? 'Locked: the solver keeps this value' : 'Unlocked: the solver may change this';
  });
}

// ---------- table ----------
function renderTable() {
  let h = '<thead><tr><th>Setup</th><th>DPS</th><th>DPS drained</th><th>Pending</th><th>Max hit</th><th>Hit %</th><th>Hit % drained</th><th>Speed</th></tr></thead><tbody>';
  for (const s of enabledSetups()) {
    const row = report.rows[s.id];
    const clicks = state.nudges[s.id] || 0;
    h += `<tr><td>${esc(s.name)}</td><td>${fmt(row.base.dps)}</td><td>${fmt(row.red.dps)}</td><td>${clicks ? signedPct(factor(clicks) - 1) : '–'}</td>
      <td>${maxHitText(row, row.base)}</td><td>${pct(row.base.acc)}</td><td>${pct(row.red.acc)}</td><td>${row.base.speed}t</td></tr>`;
  }
  $('#table').innerHTML = `${h}</tbody>`;
}

function renderChips() {
  $('#chips').innerHTML = SETUPS.map((s) => `<label class="chip" title="${esc(s.name)}"><input type="checkbox" data-setup="${s.id}" ${state.enabled.has(s.id) ? 'checked' : ''}>
    <img src="${img(ITEMS.items[s.items.weapon].img)}" alt=""><span class="dot ${s.group}"></span>${esc(s.short)}</label>`).join('');
}

// ---------- solve ----------
function pushHistory() {
  state.history.push({ ...state.boss });
  if (state.history.length > 30) state.history.shift();
}

async function runSolve() {
  const setups = enabledSetups();
  if (!setups.length || !pendingIds().length) return;
  solveCtl?.abort();
  const ctl = new AbortController();
  solveCtl = ctl;

  // Targets: nudged setups move by the asked %, everything else should stay where it is.
  const targets = {};
  const before = {};
  for (const s of setups) {
    const row = report.rows[s.id];
    const f = factor(state.nudges[s.id] || 0);
    targets[s.id] = { base: row.base.dps * f, red: row.red.dps * f };
    before[s.id] = row.base.dps;
  }
  state.status = 'solving';
  renderStatus();
  const bar = $('#progress i');
  bar.style.width = '0';
  $('#progress').hidden = false;
  const best = await solve(
    { setups, targets, weights: { base: 1, red: 0.5 }, mode: state.mode, prior: 0.01 },
    state.boss,
    state.locked,
    { signal: ctl.signal, generations: 600, onProgress: (f) => { bar.style.width = `${(f * 100).toFixed(0)}%`; } },
  );
  $('#progress').hidden = true;
  if (ctl.signal.aborted || !best) return;

  pushHistory();
  state.boss = { ...state.boss, ...best.boss };
  report = computeReport();
  state.lastResult = setups.map((s) => ({
    id: s.id,
    asked: factor(state.nudges[s.id] || 0) - 1,
    got: report.rows[s.id].base.dps / before[s.id] - 1,
  }));
  state.nudges = {};
  state.status = 'solved';
  $('#bossPreset').value = '';
  $('#presetNote').textContent = '';
  renderAll();
}

// ---------- share state ----------
function encodeState() {
  const obj = { b: state.boss, n: state.nudges, e: [...state.enabled], l: [...state.locked], m: state.mode };
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeState(str) {
  try {
    const o = JSON.parse(decodeURIComponent(escape(atob(str.replace(/-/g, '+').replace(/_/g, '/')))));
    if (o.b) state.boss = clampBoss({ ...DEFAULT_BOSS, ...o.b });
    if (o.n) state.nudges = Object.fromEntries(Object.entries(o.n).filter(([id, v]) => BY_ID[id] && Number.isInteger(v) && v));
    if (o.e) state.enabled = new Set(o.e.filter((id) => BY_ID[id]));
    if (o.l) state.locked = new Set(o.l);
    if (o.m) state.mode = o.m;
    return true;
  } catch {
    return false;
  }
}

function saveHash() {
  history.replaceState(null, '', `#s=${encodeState()}`);
}

// ---------- wiring ----------
function renderAll(skipInput) {
  report = computeReport();
  renderChart();
  renderStatus();
  renderStats(skipInput);
  renderTable();
  if (overlayId) $('#overlay').innerHTML = overlayHtml(overlayId);
  saveHash();
}

function init() {
  const fromHash = location.hash.startsWith('#s=') && decodeState(location.hash.slice(3));
  if (fromHash) state.status = 'edited';
  buildStats();
  renderChips();
  $('#mode').value = state.mode;

  $('#chips').addEventListener('change', (e) => {
    const id = e.target.dataset.setup;
    if (!id) return;
    if (e.target.checked) state.enabled.add(id); else state.enabled.delete(id);
    renderAll();
  });
  $('#mode').addEventListener('change', (e) => { state.mode = e.target.value; renderAll(); });
  $('#solve').addEventListener('click', runSolve);
  $('#clear').addEventListener('click', () => { state.nudges = {}; renderAll(); });
  $('#undo').addEventListener('click', () => {
    if (!state.history.length) return;
    state.boss = state.history.pop();
    state.status = 'edited';
    state.lastResult = null;
    renderAll();
  });
  $('#share').addEventListener('click', async () => {
    saveHash();
    const btn = $('#share');
    try {
      await navigator.clipboard.writeText(location.href);
      btn.textContent = 'Link copied';
    } catch {
      btn.textContent = 'Copy the address bar';
    }
    setTimeout(() => { btn.textContent = 'Copy share link'; }, 1800);
  });
  window.addEventListener('scroll', () => hideOverlay(true), { passive: true });

  initChartEvents();
  renderAll();
}

try {
  init();
} catch (err) {
  // most likely a typo in data/setups.json, or an item that needs tools/build_data.py
  document.querySelector('main').insertAdjacentHTML('afterbegin', `<div class="card error"><b>Could not load the setups.</b> ${esc(err.message)}</div>`);
  throw err;
}
