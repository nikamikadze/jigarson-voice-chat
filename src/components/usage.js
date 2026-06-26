// ── Usage / cost dashboard panel (compact HUD) ──
// Pulls real spend/token data from /api/usage and renders SVG charts.

function fmtMoney(n) {
  if (n >= 1000) return '$' + (n / 1000).toFixed(2) + 'k';
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(3);
}
function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n | 0);
}

function lineChart(days, key) {
  if (!days.length) return '<div class="usage-empty">no data</div>';
  const vals = days.map((d) => d[key] || 0);
  const max = Math.max(...vals, 0.000001);
  const W = 280, H = 70, pad = 4;
  const stepX = days.length > 1 ? (W - pad * 2) / (days.length - 1) : 0;
  const pts = vals.map((v, i) => {
    const x = pad + i * stepX;
    const y = H - pad - (v / max) * (H - pad * 2);
    return [x, y];
  });
  const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const area = line + ` L ${pts[pts.length - 1][0].toFixed(1)} ${H - pad} L ${pts[0][0].toFixed(1)} ${H - pad} Z`;
  const dots = pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="1.7"/>`).join('');
  return `<svg class="usage-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path class="usage-area" d="${area}"/>
    <path class="usage-line" d="${line}"/>
    <g class="usage-dots">${dots}</g>
  </svg>
  <div class="usage-axis"><span>${days[0].date.slice(5)}</span><span>peak ${key === 'cost' ? fmtMoney(max) : fmtTokens(max)}</span><span>${days[days.length - 1].date.slice(5)}</span></div>`;
}

function modelBars(models) {
  if (!models.length) return '<div class="usage-empty">no data</div>';
  const max = Math.max(...models.map((m) => m.cost), 0.000001);
  return models.slice(0, 7).map((m) => `
    <div class="usage-bar-row">
      <span class="usage-bar-name">${m.model}</span>
      <span class="usage-bar-track"><span class="usage-bar-fill" style="width:${Math.max(2, (m.cost / max) * 100).toFixed(1)}%"></span></span>
      <span class="usage-bar-val">${fmtMoney(m.cost)}</span>
    </div>`).join('');
}

let metric = 'cost';
let lastData = null;


function usageEventRows(events = []) {
  if (!events.length) return '<div class="usage-empty">no action events yet</div>';
  const rows = events.slice(0, 8).map(e => {
    const when = e.time ? new Date(e.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
    const cost = Number.isFinite(Number(e.costUsd)) && Number(e.costUsd) > 0 ? fmtMoney(Number(e.costUsd)) : '—';
    const model = e.model || e.provider || '—';
    const meta = [
      e.inputTokens ? `in ${fmtTokens(e.inputTokens)}` : '',
      e.outputTokens ? `out ${fmtTokens(e.outputTokens)}` : '',
      e.durationSec ? `${Number(e.durationSec).toFixed(1)}s` : '',
      e.audioInBytes ? `${Math.round(e.audioInBytes / 1024)}kb in` : '',
      e.audioOutBytes ? `${Math.round(e.audioOutBytes / 1024)}kb out` : '',
    ].filter(Boolean).join(' · ');

    return `<div class="usage-event-row">
      <div><span class="usage-event-type">${e.type || e.path || 'action'}</span><span class="usage-event-time">${when}</span></div>
      <div class="usage-event-model">${model}</div>
      <div class="usage-event-meta">${meta || e.status || 'tracked'}</div>
      <div class="usage-event-cost">${cost}</div>
    </div>`;
  }).join('');

  return `<div class="usage-section-head"><span>Last actions</span><span>Live tracker</span></div><div class="usage-events">${rows}</div>`;
}

async function refresh(panel) {
  const body = panel.querySelector('.usage-body');
  body.innerHTML = '<div class="usage-empty">loading…</div>';
  try {
    const r = await fetch('/api/usage');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    lastData = d;
    render(panel, d);
  } catch (e) {
    body.innerHTML = `<div class="usage-empty">error: ${e.message}</div>`;
  }
}

function budgetBar(label, pct, text, color) {
  return `<div class="usage-budget-row"><span class="usage-budget-l">${label}</span>
    <span class="usage-budget-track"><span class="usage-budget-fill" style="width:${Math.min(100, (pct || 0) * 100).toFixed(0)}%;background:${color}"></span></span>
    <span class="usage-budget-v">${text}</span></div>`;
}

function render(panel, d) {
  const t = d.totals || {};
  const ct = d.costByType || {};
  const bg = d.budget || {};
  const color = bg.alert ? '#ff5246' : (bg.warn ? '#ffb02e' : 'rgb(var(--accent-rgb,41 211 255))');
  const body = panel.querySelector('.usage-body');
  body.innerHTML = `
    <div class="usage-kpis">
      <div class="usage-kpi"><div class="usage-kpi-v">${fmtMoney(t.totalCost || 0)}</div><div class="usage-kpi-l">Total spend</div></div>
      <div class="usage-kpi"><div class="usage-kpi-v">${fmtTokens(t.totalTokens || 0)}</div><div class="usage-kpi-l">Tokens</div></div>
      <div class="usage-kpi"><div class="usage-kpi-v">${fmtMoney(bg.todayCost || 0)}</div><div class="usage-kpi-l">Today</div></div>
      <div class="usage-kpi"><div class="usage-kpi-v">${d.sessionCount || 0}</div><div class="usage-kpi-l">Sessions</div></div>
    </div>
    ${usageEventRows(d.events || [])}
    <div class="usage-section-head"><span>Budget</span>${bg.alert ? '<span class="usage-tag alert">Over budget</span>' : (bg.warn ? '<span class="usage-tag warn">High</span>' : '<span class="usage-tag ok">On track</span>')}</div>
    <div class="usage-budget">
      ${budgetBar('today', bg.todayPct, `${fmtMoney(bg.todayCost || 0)} / ${fmtMoney(bg.dailyBudget || 0)}`, color)}
      ${budgetBar('proj. mo', bg.monthPct, `${fmtMoney(bg.projectedMonth || 0)} / ${fmtMoney(bg.monthlyBudget || 0)}`, color)}
      <div class="usage-burn">burn rate ≈ ${fmtMoney(bg.avgPerDay || 0)} / day</div>
    </div>
    <div class="usage-section-head">
      <span>${metric === 'cost' ? 'Spend' : 'Tokens'} / day</span>
      <span class="usage-toggle" data-metric>${metric === 'cost' ? '$ to tokens' : 'tokens to $'}</span>
    </div>
    <div class="usage-chart">${lineChart(d.days || [], metric)}</div>
    <div class="usage-section-head"><span>Cost by model</span></div>
    <div class="usage-models">${modelBars(d.models || [])}</div>
    <div class="usage-split">
      <span>in ${fmtMoney(ct.inputCost || 0)}</span>
      <span>out ${fmtMoney(ct.outputCost || 0)}</span>
      <span>cache ${fmtMoney(ct.cacheReadCost || 0)}</span>
    </div>`;
  body.querySelector('[data-metric]')?.addEventListener('click', () => {
    metric = metric === 'cost' ? 'tokens' : 'cost';
    render(panel, lastData);
  });
  applyAlert(bg);
}

// Glow the USAGE button when over/near budget (works even with panel closed).
function applyAlert(bg) {
  const btn = document.getElementById('usage-btn');
  if (!btn) return;
  btn.classList.toggle('alert', !!bg.alert);
  btn.classList.toggle('warn', !!bg.warn && !bg.alert);
}

async function pollAlert() {
  try {
    const r = await fetch('/api/usage');
    if (r.ok) { const d = await r.json(); applyAlert(d.budget || {}); }
  } catch {}
}

export function initUsage() {
  if (document.getElementById('usage-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'usage-btn';
  btn.type = 'button';
  btn.innerHTML = 'Usage';

  const panel = document.createElement('div');
  panel.id = 'usage-panel';
  panel.innerHTML = `
    <div class="usage-head">
      <span>Usage &amp; cost</span>
      <span class="usage-actions"><span class="usage-refresh" title="Refresh">Refresh</span><span class="usage-close" title="Close">Close</span></span>
    </div>
    <div class="usage-body"></div>`;

  const style = document.createElement('style');
  style.textContent = `
    #usage-btn {
      position: fixed;
      left: 18px;
      top: 360px;
      bottom: auto;
      z-index: 60;
      padding: 10px 18px;
      border: 1px solid rgba(var(--accent-rgb,41 211 255),.6);
      background: rgba(255,255,255,.86);
      color: #111827;
      border-radius: 999px;
      font-weight: 700;
      letter-spacing: 0;
      backdrop-filter: blur(12px);
      box-shadow: 0 12px 28px rgba(15,23,42,.12);
    }
    #usage-btn:hover { box-shadow: 0 0 26px rgba(var(--accent-rgb,41 211 255),.5); }
    #usage-panel {
      position: fixed;
      left: 18px;
      top: 420px;
      bottom: auto;
      z-index: 59;
      width: 380px;
      max-width: calc(100vw - 36px);
      display: none;
      background: rgba(255,255,255,.92);
      color:#111827;
      border: 1px solid rgba(17,24,39,.08);
      border-radius: 24px;
      backdrop-filter: blur(24px) saturate(1.25);
      box-shadow: 0 24px 80px rgba(15,23,42,.18);
    }
    #usage-panel.open { display: block; }
    .usage-head { display:flex; justify-content:space-between; align-items:center; padding:11px 14px;
      border-bottom:1px solid rgba(17,24,39,.08); color:#111827;
      font-size:13px; letter-spacing:0; font-weight:700; }
    .usage-actions span { cursor:pointer; margin-left:10px; opacity:.72; font-size:12px; font-weight:650; color:#0a84ff; }
    .usage-actions span:hover { opacity:1; }
    .usage-body { padding: 12px 14px 14px; max-height: 70vh; overflow-y: auto; }
    .usage-kpis { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:12px; }
    .usage-kpi { background:rgba(17,24,39,.045); border:1px solid rgba(17,24,39,.07);
      border-radius:9px; padding:9px 10px; }
    .usage-kpi-v { font-size:19px; font-weight:700; color:#0a84ff; }
    .usage-kpi-l { font-size:10px; letter-spacing:0; opacity:.62; margin-top:2px; }
    .usage-section-head { display:flex; justify-content:space-between; align-items:center; font-size:11px; letter-spacing:0; opacity:.68; margin:10px 0 6px; font-weight:650; }
    .usage-toggle { cursor:pointer; color:#0a84ff; opacity:.9; }
    .usage-spark { width:100%; height:70px; display:block; }
    .usage-area { fill: rgba(var(--accent-rgb,41 211 255),.16); stroke:none; }
    .usage-line { fill:none; stroke:rgb(var(--accent-rgb,41 211 255)); stroke-width:1.6; vector-effect:non-scaling-stroke; }
    .usage-dots circle { fill:rgb(var(--accent-rgb,41 211 255)); }
    .usage-axis { display:flex; justify-content:space-between; font-size:9px; opacity:.5; margin-top:3px; }
    .usage-bar-row { display:flex; align-items:center; gap:8px; margin:5px 0; font-size:11px; }
    .usage-bar-name { width:120px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:.85; }
    .usage-bar-track { flex:1; height:7px; background:rgba(17,24,39,.08); border-radius:4px; overflow:hidden; }
    .usage-bar-fill { display:block; height:100%; background:#0a84ff; border-radius:4px; }
    .usage-bar-val { width:54px; text-align:right; color:#0a84ff; font-variant-numeric:tabular-nums; }
    .usage-split { display:flex; justify-content:space-between; font-size:10px; opacity:.6; margin-top:10px;
      border-top:1px solid rgba(17,24,39,.08); padding-top:8px; }
    .usage-events { border:1px solid rgba(17,24,39,.08); border-radius:10px; overflow:hidden; margin-bottom:10px; }
    .usage-event-row { display:grid; grid-template-columns:1.1fr 1fr auto; gap:6px; padding:8px 9px; border-bottom:1px solid rgba(17,24,39,.06); font-size:10px; }
    .usage-event-row:last-child { border-bottom:0; }
    .usage-event-type { color:#0a84ff; font-weight:700; letter-spacing:.3px; text-transform:none; }
    .usage-event-time { opacity:.45; margin-left:7px; }
    .usage-event-model { opacity:.72; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .usage-event-meta { grid-column:1 / span 2; opacity:.48; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .usage-event-cost { color:#0a84ff; font-variant-numeric:tabular-nums; font-weight:700; text-align:right; }
    .usage-empty { opacity:.5; font-size:11px; padding:18px 0; text-align:center; }
    @media (max-width:768px){ #usage-panel{ width:calc(100vw - 28px); left:14px; bottom:116px; } #usage-btn{ left:14px; bottom:68px; } }
  `;
  document.head.appendChild(style);
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const toggle = () => {
    panel.classList.toggle('open');
    document.body.classList.toggle('usage-panel-open', panel.classList.contains('open'));
    if (panel.classList.contains('open')) refresh(panel);
  };
  btn.addEventListener('click', toggle);
  panel.querySelector('.usage-close').addEventListener('click', () => {
    panel.classList.remove('open');
    document.body.classList.remove('usage-panel-open');
  });
  panel.querySelector('.usage-refresh').addEventListener('click', () => refresh(panel));
}
