// ── OpenClaw activity stream ──
// Shows observable runtime activity: sent prompt, tool calls, stream progress,
// and final/idle states. It does not expose private model reasoning text.

const thoughts = [
  'OPENCLAW ACTIVITY FEED READY',
  'WAITING FOR NEXT MESSAGE...',
];

let container = null;
let textArea = null;
let intervalId = null;
let lineIndex = 0;
let currentLine = null;
let charIdx = 0;
let typeTimer = null;
let idleTimer = null;

function timeStamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function createContainer() {
  container = document.createElement('div');
  container.id = 'thought-stream';
  container.setAttribute('aria-label', 'OpenClaw activity feed');
  container.style.cssText = `
    position: fixed;
    bottom: 30px;
    left: 50%;
    transform: translateX(-50%);
    width: 45%;
    max-width: 600px;
    height: 250px;
    pointer-events: none;
    z-index: 2;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.3) 30%, rgba(0,0,0,0.8) 70%, rgba(0,0,0,1) 100%);
    mask-image: linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.3) 30%, rgba(0,0,0,0.8) 70%, rgba(0,0,0,1) 100%);
  `;

  textArea = document.createElement('div');
  textArea.style.cssText = `
    position: absolute;
    bottom: 0;
    left: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 10px;
  `;

  container.appendChild(textArea);
  document.body.appendChild(container);
}

function startNewLine(textOverride = null, kind = 'idle') {
  const text = textOverride || thoughts[lineIndex % thoughts.length];
  lineIndex++;

  const line = document.createElement('div');
  line.className = `activity-line activity-${kind}`;
  line.style.cssText = `
    font-family: "TheGoodMonolith", monospace;
    font-size: 14px;
    letter-spacing: 0.08em;
    line-height: 1.8;
    color: rgba(var(--accent-rgb), 0.45);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
  `;
  line.textContent = '';
  // 新行加到底部，舊的往上推然後頂部漸層消失
  textArea.appendChild(line);

  // 限制行數，移除最頂部（最舊）的
  while (textArea.children.length > 12) {
    textArea.removeChild(textArea.firstChild);
  }

  // 逐字打出
  currentLine = { el: line, text, charIdx: 0 };
  if (typeTimer) clearInterval(typeTimer);
  typeTimer = setInterval(() => {
    if (!currentLine) return;
    if (currentLine.charIdx < currentLine.text.length) {
      currentLine.el.textContent = currentLine.text.substring(0, currentLine.charIdx + 1);
      currentLine.charIdx++;
    } else {
      clearInterval(typeTimer);
      typeTimer = null;
      currentLine = null;
    }
  }, 40);
}

export function addActivityLine(text, kind = 'state') {
  if (!container || !textArea) return;
  const prefix = kind === 'tool'
    ? 'TOOL'
    : kind === 'think'
      ? 'THINK'
      : kind === 'stream'
        ? 'STREAM'
        : 'STATE';
  startNewLine(`[${timeStamp()}] ${prefix}: ${text}`, kind);
}

function describeActivity(activity) {
  if (!activity) return [];
  const lines = [];
  if (activity.thinking) lines.push({ kind: 'think', text: 'OpenClaw is reasoning / planning next action' });
  for (const tool of (activity.tools || [])) {
    const input = tool.input ? ` ${tool.input}` : '';
    lines.push({ kind: 'tool', text: `${tool.name || 'tool'}${input}` });
  }
  return lines;
}

export function initThoughtStream() {
  createContainer();

  window.addEventListener('openclaw-activity', (e) => {
    const detail = e.detail || {};
    if (detail.text) {
      addActivityLine(detail.text, detail.kind || 'state');
    }
    for (const line of describeActivity(detail.activity)) {
      addActivityLine(line.text, line.kind);
    }
  });

  window.addEventListener('agent-state', (e) => {
    const state = e.detail || 'idle';
    if (state === 'thinking') addActivityLine('message sent, waiting for OpenClaw events', 'think');
    if (state === 'responding') addActivityLine('answer stream started', 'stream');
    if (state === 'idle') addActivityLine('turn finished', 'state');
  });

  setTimeout(() => {
    startNewLine();
    idleTimer = setInterval(() => {
      if (textArea?.children.length < 2) startNewLine();
    }, 10000);
  }, 4000);
}

export function stopThoughtStream() {
  if (intervalId) clearInterval(intervalId);
  if (idleTimer) clearInterval(idleTimer);
  if (typeTimer) clearInterval(typeTimer);
}
