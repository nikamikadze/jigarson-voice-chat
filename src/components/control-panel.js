// ── Control Panel: STOP (abort all) + BACKUP + live Activity feed ──
// Self-contained: injects its own DOM + CSS and reads /api/events for activity.

let es = null;
const MAX_ROWS = 60;

export function initControlPanel() {
  if (document.getElementById('jarvis-control-panel')) return;
  injectStyles();
  const root = buildDom();
  document.body.appendChild(root);
  wireButtons(root);
  connectActivity(root);
}

function injectStyles() {
  const css = `
  #jarvis-control-panel{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:9000;
    font-family:var(--font-mono,monospace);width:320px;max-width:46vw;
    color:var(--text-primary,#dfefff);pointer-events:none;}
  #jarvis-control-panel *{pointer-events:auto;box-sizing:border-box;}
  .jcp-btns{display:flex;gap:8px;margin-bottom:8px;}
  .jcp-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;
    padding:9px 10px;border-radius:8px;font-size:12px;letter-spacing:.08em;
    text-transform:uppercase;cursor:pointer;border:1px solid var(--panel-border,rgba(120,200,255,.3));
    background:var(--panel-bg,rgba(10,22,34,.82));backdrop-filter:blur(6px);
    transition:box-shadow .15s,transform .08s,background .15s;user-select:none;}
  .jcp-btn:active{transform:translateY(1px);}
  .jcp-stop{color:#ff5a4d;border-color:rgba(255,90,77,.55);}
  .jcp-stop:hover{background:rgba(255,90,77,.16);box-shadow:0 0 18px rgba(255,90,77,.45);}
  .jcp-stop .dot{width:9px;height:9px;border-radius:50%;background:#ff5a4d;box-shadow:0 0 8px #ff5a4d;}
  .jcp-backup{color:var(--accent-primary,#3fd0ff);}
  .jcp-backup:hover{background:rgba(var(--accent-rgb,63 208 255),.14);box-shadow:0 0 18px rgba(var(--accent-rgb,63 208 255),.4);}
  .jcp-feed{border:1px solid var(--panel-border,rgba(120,200,255,.3));border-radius:8px;
    background:var(--panel-bg,rgba(10,22,34,.82));backdrop-filter:blur(6px);overflow:hidden;}
  .jcp-feed-head{display:flex;align-items:center;justify-content:space-between;
    padding:7px 10px;cursor:pointer;font-size:11px;letter-spacing:.1em;
    color:var(--text-secondary,#8fb6cf);border-bottom:1px solid transparent;}
  .jcp-feed.open .jcp-feed-head{border-bottom-color:var(--panel-border,rgba(120,200,255,.25));}
  .jcp-feed-head .live{display:flex;align-items:center;gap:6px;}
  .jcp-live-dot{width:7px;height:7px;border-radius:50%;background:#444;}
  .jcp-feed.active .jcp-live-dot{background:var(--accent-primary,#3fd0ff);
    box-shadow:0 0 8px var(--accent-primary,#3fd0ff);animation:jcpPulse 1s infinite;}
  @keyframes jcpPulse{0%,100%{opacity:.4}50%{opacity:1}}
  .jcp-caret{transition:transform .15s;}
  .jcp-feed.open .jcp-caret{transform:rotate(180deg);}
  .jcp-rows{max-height:0;overflow-y:auto;transition:max-height .2s ease;
    font-size:11px;line-height:1.5;}
  .jcp-feed.open .jcp-rows{max-height:46vh;}
  .jcp-row{padding:4px 10px;border-bottom:1px solid rgba(120,200,255,.07);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .jcp-row .t{color:var(--text-secondary,#6f93ad);margin-right:6px;}
  .jcp-tool{color:var(--accent-primary,#3fd0ff);}
  .jcp-think{color:#c8a3ff;}
  .jcp-state{color:var(--text-secondary,#8fb6cf);}
  .jcp-toast{position:fixed;left:50%;top:96px;z-index:9100;max-width:46vw;white-space:nowrap;
    padding:10px 12px;border-radius:8px;font-family:var(--font-mono,monospace);font-size:12px;
    background:var(--panel-bg,rgba(10,22,34,.92));border:1px solid var(--accent-primary,#3fd0ff);
    color:var(--text-primary,#dfefff);box-shadow:0 0 22px rgba(var(--accent-rgb,63 208 255),.4);
    opacity:0;transform:translate(-50%,8px);transition:opacity .2s,transform .2s;}
  .jcp-toast.show{opacity:1;transform:translate(-50%,0);}
  @media (max-width:768px){#jarvis-control-panel{width:60vw;}}
  `;
  const el = document.createElement('style');
  el.textContent = css;
  document.head.appendChild(el);
}

function buildDom() {
  const root = document.createElement('div');
  root.id = 'jarvis-control-panel';
  root.innerHTML = `
    <div class="jcp-btns">
      <div class="jcp-btn jcp-stop" id="jcp-stop" title="Abort all agent activity (/stop)">
        <span class="dot"></span> STOP
      </div>
      <div class="jcp-btn jcp-backup" id="jcp-backup" title="Back up the whole JARVIS project">
        💾 BACKUP
      </div>
    </div>
    <div class="jcp-feed" id="jcp-feed">
      <div class="jcp-feed-head" id="jcp-feed-head">
        <span class="live"><span class="jcp-live-dot"></span> ACTIVITY</span>
        <span class="jcp-caret">▴</span>
      </div>
      <div class="jcp-rows" id="jcp-rows"></div>
    </div>`;
  return root;
}

function wireButtons(root) {
  const stop = root.querySelector('#jcp-stop');
  const backup = root.querySelector('#jcp-backup');
  const feed = root.querySelector('#jcp-feed');
  const head = root.querySelector('#jcp-feed-head');

  head.addEventListener('click', () => feed.classList.toggle('open'));

  stop.addEventListener('click', async () => {
    addRow(root, 'state', '⏹ STOP requested…');
    try {
      const r = await fetch('/api/stop', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      toast(r.ok ? '⏹ All agent activity aborted' : `Stop failed: ${j.error || r.status}`);
      addRow(root, 'state', r.ok ? '⏹ stopped' : `stop error: ${j.error || r.status}`);
    } catch (e) {
      toast('Stop failed — server unreachable');
    }
  });

  backup.addEventListener('click', async () => {
    backup.style.opacity = '.5';
    toast('💾 Backing up…');
    try {
      const r = await fetch('/api/backup', { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        toast(`💾 Backup saved: ${j.name}`);
        addRow(root, 'state', `💾 backup → ${j.name}`);
      } else {
        toast(`Backup failed: ${j.error || r.status}`);
      }
    } catch (e) {
      toast('Backup failed — server unreachable');
    } finally {
      backup.style.opacity = '';
    }
  });
}

function connectActivity(root) {
  const feed = root.querySelector('#jcp-feed');
  try {
    es = new EventSource('/api/events');
  } catch { return; }

  es.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type) return;                 // connected/system frames — ignore

    // mark "live" while the agent is working
    if (d.state && d.state !== 'final' && d.state !== 'aborted') feed.classList.add('active');
    if (d.done || d.state === 'final' || d.state === 'aborted') feed.classList.remove('active');

    if (d.activity) {
      if (d.activity.thinking) addRow(root, 'think', '🧠 thinking…', true);
      for (const t of (d.activity.tools || [])) {
        addRow(root, 'tool', `🔧 ${t.name}${t.input ? '  ' + t.input : ''}`);
      }
    } else if (d.state === 'final') {
      addRow(root, 'state', '✓ done', true);
    }
  };
  es.onerror = () => feed.classList.remove('active');
}

let lastKey = '';
function addRow(root, kind, text, dedupe) {
  const rows = root.querySelector('#jcp-rows');
  if (!rows) return;
  if (dedupe && lastKey === kind + text) return;   // skip immediate repeats
  lastKey = kind + text;
  const row = document.createElement('div');
  row.className = 'jcp-row';
  const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  row.innerHTML = `<span class="t">${ts}</span><span class="jcp-${kind}">${escapeHtml(text)}</span>`;
  rows.appendChild(row);
  while (rows.children.length > MAX_ROWS) rows.removeChild(rows.firstChild);
  rows.scrollTop = rows.scrollHeight;
}

let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.jcp-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'jcp-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
