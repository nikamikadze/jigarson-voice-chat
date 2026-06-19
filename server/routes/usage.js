// ── Usage / cost dashboard data: /api/usage ──
// Reads OpenClaw's usage-cost cache and aggregates real spend + token stats.

import { Router } from 'express';
import { readFile } from 'fs/promises';
import os from 'os';
import path from 'path';

const router = Router();

const CACHE_PATH = process.env.USAGE_CACHE_PATH
  || path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', '.usage-cost-cache.json');

let cache = null;
let cacheAt = 0;
const TTL = 30_000;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// Attach budget + burn-rate + alert flags (from config, computed fresh each call).
function withBudget(d, req) {
  const cfg = (req.app.locals && req.app.locals.usage) || {};
  const dailyBudget = cfg.dailyBudget || 20;
  const monthlyBudget = cfg.monthlyBudget || 300;
  const recent = (d.days || []).slice(-7);
  const avgPerDay = recent.length ? recent.reduce((s, x) => s + x.cost, 0) / recent.length : 0;
  const projectedMonth = avgPerDay * 30;
  const todayCost = (d.today || {}).cost || 0;
  const todayPct = dailyBudget ? todayCost / dailyBudget : 0;
  const monthPct = monthlyBudget ? projectedMonth / monthlyBudget : 0;
  return {
    ...d,
    budget: {
      dailyBudget, monthlyBudget, avgPerDay, projectedMonth, todayCost,
      todayPct, monthPct,
      alert: todayPct >= 1 || monthPct >= 1,
      warn: todayPct >= 0.8 || monthPct >= 0.8,
    },
  };
}

router.get('/usage', async (req, res) => {
  try {
    if (cache && Date.now() - cacheAt < TTL) return res.json(withBudget(cache, req));

    const raw = JSON.parse(await readFile(CACHE_PATH, 'utf8'));
    const files = raw.files || {};

    const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, totalCost: 0 };
    const costByType = { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0 };
    const byModel = {};
    const byDay = {};
    const sessions = [];

    // Only count canonical live session files (<uuid>.jsonl). Skip .reset /
    // .trajectory / backup snapshots — they double-count the same usage.
    const isClean = (k) =>
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/.test(k) &&
      !k.includes('.reset') && !k.includes('trajectory') && !k.includes('backup');

    for (const [key, f] of Object.entries(files)) {
      if (!isClean(key)) continue;
      const t = f.totals || {};
      for (const k of Object.keys(totals)) totals[k] += t[k] || 0;
      if ((t.totalCost || 0) > 0 || (t.totalTokens || 0) > 0) {
        sessions.push({ id: (f.sessionId || '').slice(0, 8), cost: t.totalCost || 0, tokens: t.totalTokens || 0, mtime: f.mtimeMs || 0 });
      }
      for (const e of (f.usageEntries || [])) {
        for (const c of Object.keys(costByType)) costByType[c] += e[c] || 0;
        const m = e.model || 'unknown';
        (byModel[m] ||= { cost: 0, tokens: 0 });
        byModel[m].cost += e.totalCost || 0;
        byModel[m].tokens += e.totalTokens || 0;
        if (e.timestamp) {
          const dk = dayKey(e.timestamp);
          (byDay[dk] ||= { cost: 0, tokens: 0 });
          byDay[dk].cost += e.totalCost || 0;
          byDay[dk].tokens += e.totalTokens || 0;
        }
      }
    }

    const days = Object.entries(byDay)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-30)
      .map(([date, v]) => ({ date, cost: v.cost, tokens: v.tokens }));

    const models = Object.entries(byModel)
      .map(([model, v]) => ({ model, cost: v.cost, tokens: v.tokens }))
      .filter((m) => m.cost > 0 || m.tokens > 0)
      .sort((a, b) => b.cost - a.cost);

    const topSessions = sessions.sort((a, b) => b.cost - a.cost).slice(0, 8);
    const today = byDay[dayKey(Date.now())] || { cost: 0, tokens: 0 };

    cache = {
      totals,
      costByType,
      models,
      days,
      topSessions,
      today,
      sessionCount: sessions.length,
      updatedAt: raw.updatedAt || Date.now(),
    };
    cacheAt = Date.now();
    res.json(withBudget(cache, req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

// ── JARVIS live per-action tracker ──
// Tracks recent frontend/backend actions without storing message content.
if (!globalThis.__jarvisUsageEvents) globalThis.__jarvisUsageEvents = [];

function __num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function __usageFromBody(body) {
  if (!body || typeof body !== 'object') return null;
  return body.usage || body.message?.usage || body.data?.usage || body.result?.usage || null;
}

function __costFromUsage(usage, body) {
  return __num(
    usage?.costUsd ??
    usage?.costUSD ??
    usage?.cost ??
    usage?.usd ??
    body?.costUsd ??
    body?.cost
  );
}

function __recordJarvisUsageEvent(e) {
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    time: new Date().toISOString(),
    ...e,
  };
  globalThis.__jarvisUsageEvents.unshift(event);
  globalThis.__jarvisUsageEvents = globalThis.__jarvisUsageEvents.slice(0, 200);
  return event;
}

globalThis.__recordJarvisUsageEvent = __recordJarvisUsageEvent;

router.get('/usage/events', (req, res) => {
  res.json({ events: globalThis.__jarvisUsageEvents.slice(0, 80) });
});

router.use((req, res, next) => {
  const tracked = ['/chat', '/chat/upload', '/voice', '/tts'];
  if (!tracked.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();

  const started = Date.now();
  let done = false;

  function capture(body, kind = 'response') {
    if (done) return;
    done = true;

    let parsed = body;
    if (typeof body === 'string') {
      try { parsed = JSON.parse(body); } catch {}
    }

    const usage = __usageFromBody(parsed);
    const path = req.path;
    const type =
      path.startsWith('/chat/upload') ? 'file-chat' :
      path.startsWith('/chat') ? 'text-chat' :
      path.startsWith('/voice') ? 'voice-transcribe' :
      path.startsWith('/tts') ? 'tts' :
      path;

    __recordJarvisUsageEvent({
      type,
      path,
      method: req.method,
      status: res.statusCode >= 400 ? 'error' : 'success',
      provider: parsed?.provider || parsed?.engine || parsed?.ttsEngine || null,
      model: parsed?.model || parsed?.message?.model || usage?.model || null,
      inputTokens: __num(usage?.input ?? usage?.inputTokens ?? usage?.promptTokens ?? usage?.promptTokenCount),
      outputTokens: __num(usage?.output ?? usage?.outputTokens ?? usage?.completionTokens ?? usage?.candidatesTokenCount),
      totalTokens: __num(usage?.total ?? usage?.totalTokens ?? usage?.totalTokenCount),
      costUsd: __costFromUsage(usage, parsed),
      durationMs: Date.now() - started,
      responseKind: kind,
      audioInBytes: req.file?.size || 0,
      audioOutBytes: Number(res.getHeader('content-length')) || 0,
    });
  }

  const oldJson = res.json.bind(res);
  res.json = (body) => {
    capture(body, 'json');
    return oldJson(body);
  };

  const oldSend = res.send.bind(res);
  res.send = (body) => {
    capture(body, Buffer.isBuffer(body) ? 'binary' : 'send');
    return oldSend(body);
  };

  next();
});
