const express = require('express');
const path = require('path');
const { Bot } = require('../bot');
const { JsonStore } = require('./store');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: '1mb' }));

const dataDir = path.join(__dirname, 'data');
const sessionsDir = path.join(dataDir, 'sessions');
const appStore = new JsonStore(path.join(dataDir, 'app-store.json'));
const bulkStore = new JsonStore(path.join(dataDir, 'bulk-store.json'));

const bot = new Bot({ sessionsDir, dataDir });
const logClients = new Set();

bot.onLog((line) => {
  console.log(line);
  const payload = `data: ${line}\n\n`;
  for (const res of Array.from(logClients)) {
    try { res.write(payload); } catch { logClients.delete(res); }
  }
});

(async () => {
  await bot.init();
  try {
    bot.setSettings(appStore.get('settings') || {});
    bot.setClients(appStore.get('clients') || []);
    bot.setSelectedGroups(appStore.get('selectedGroupIds') || []);
    const cp = bulkStore.get('checkpoint');
    const running = bulkStore.get('running');
    if (cp && running) {
      bulkState.groupId = cp.groupId || null;
      bulkState.messages = Array.isArray(cp.messages) ? cp.messages : [];
      bulkState.total = cp.total || bulkState.messages.length || 0;
      bulkState.index = cp.index || 0;
      bulkState.running = false; // لا نبدأ تلقائياً
    }
  } catch (e) {
    console.error('init preload failed', e);
  }
})();

/* ===== Bulk (إرسال جماعي) ===== */
let bulkState = {
  running: false,
  paused: false,
  groupId: null,
  messages: [],
  index: 0,
  total: 0,
  delaySec: 3,
  rpm: 20,
  lastMinute: { ts: 0, count: 0 }
};

async function bulkSendLoop() {
  if (!bot || !bot.isReady || !bulkState.running) return;

  const resetMinuteIfNeeded = () => {
    const now = Date.now();
    if (now - bulkState.lastMinute.ts > 60_000) {
      bulkState.lastMinute = { ts: now, count: 0 };
    }
  };
  resetMinuteIfNeeded();

  while (bulkState.running) {
    if (bulkState.paused) { await new Promise(r => setTimeout(r, 500)); continue; }
    if (bulkState.index >= bulkState.total) { bulkState.running = false; break; }

    resetMinuteIfNeeded();
    if (bulkState.lastMinute.count >= bulkState.rpm) {
      const toWait = 60_000 - (Date.now() - bulkState.lastMinute.ts);
      await new Promise(r => setTimeout(r, Math.max(500, toWait)));
      continue;
    }

    const text = bulkState.messages[bulkState.index];
    try {
      await bot.sock.sendMessage(bulkState.groupId, { text });
      bulkState.index += 1;
      bulkState.lastMinute.count += 1;

      bulkStore.set('checkpoint', {
        groupId: bulkState.groupId,
        index: bulkState.index,
        total: bulkState.total,
        messages: bulkState.messages
      });

      if (bulkState.delaySec > 0) {
        await new Promise(r => setTimeout(r, bulkState.delaySec * 1000));
      }
    } catch (e) {
      bot.log(`⚠️ bulk send error: ${e.message || e}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  bot.log('✅ bulk finished');
  bulkState.running = false;
  bulkStore.set('running', false);
}

/* ===== Helpers ===== */
function wrap(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) res.json(result || { ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message || 'error' });
    }
  };
}

/* ===== Routes ===== */
app.get('/api/status', wrap(async () => {
  const st = bot.getStatus();
  return { ...st, bulk: { running: bulkState.running, paused: bulkState.paused, index: bulkState.index, total: bulkState.total } };
}));

app.get('/api/qr', wrap(async () => bot.getQR()));

app.get('/api/groups', wrap(async () => bot.fetchGroups()));
app.post('/api/groups/save', wrap(async (req) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  appStore.set('selectedGroupIds', ids);
  bot.setSelectedGroups(ids);
  return { ok: true, count: ids.length };
}));
app.get('/api/groups/saved', wrap(async () => bot.getSelectedGroups()));

app.post('/api/clients', wrap(async (req) => {
  const rawText = String(req.body?.raw || '');
  const settings = appStore.get('settings') || {};
  const fallbackEmoji = settings.emoji || '✅';
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const arr = [];
  const seen = new Set();
  for (const line of lines) {
    const [n, e] = line.split('|');
    const name = (n || '').trim();
    const emoji = (e || '').trim() || fallbackEmoji;
    if (!name) continue;
    const key = name + '|' + emoji;
    if (seen.has(key)) continue;
    seen.add(key);
    arr.push({ name, emoji });
  }
  appStore.set('clients', arr);
  bot.setClients(arr);
  return { ok: true, count: arr.length };
}));
app.get('/api/clients', wrap(async () => appStore.get('clients') || []));

app.post('/api/settings', wrap(async (req) => {
  const merged = Object.assign(
    { emoji: '✅', ratePerMinute: 20, cooldownSec: 3, normalizeArabic: true, mode: 'emoji', replyText: 'تم ✅' },
    appStore.get('settings') || {},
    req.body || {}
  );
  appStore.set('settings', merged);
  bot.setSettings(merged);
  return merged;
}));
app.get('/api/settings', wrap(async () => appStore.get('settings') || { emoji: '✅', ratePerMinute: 20, cooldownSec: 3, normalizeArabic: true, mode: 'emoji', replyText: 'تم ✅' }));

app.post('/api/start', wrap(async () => {
  bot.setSettings(appStore.get('settings') || {});
  bot.setClients(appStore.get('clients') || []);
  bot.setSelectedGroups(appStore.get('selectedGroupIds') || []);
  await bot.start();
  return bot.getStatus();
}));
app.post('/api/stop', wrap(async () => { await bot.stop(); return bot.getStatus(); }));

app.get('/api/last-checked', wrap(async () => bot.getLastCheckedMap()));
app.post('/api/backlog/process', wrap(async (req) => { await bot.processBacklog(req.body || {}); return { ok: true }; }));
app.post('/api/backlog/check', wrap(async (req) => bot.countBacklog(req.body || {})));

// Bulk
app.post('/api/bulk/start', wrap(async (req) => {
  if (!bot || !bot.isReady) throw new Error('WhatsApp not ready');
  const { groupId, messages, delaySec = 3, rpm = 20 } = req.body || {};
  if (!groupId) throw new Error('groupId required');
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages required');

  bulkState = {
    running: true,
    paused: false,
    groupId,
    messages,
    index: 0,
    total: messages.length,
    delaySec: Math.max(0, Number(delaySec)),
    rpm: Math.max(1, Number(rpm)),
    lastMinute: { ts: Date.now(), count: 0 }
  };
  bulkStore.set('running', true);
  bulkStore.set('checkpoint', { groupId, index: 0, total: messages.length, messages });

  bulkSendLoop().catch(() => {});
  return { ok: true };
}));
app.post('/api/bulk/pause', wrap(async () => { bulkState.paused = true; return { ok: true }; }));
app.post('/api/bulk/resume', wrap(async () => { if (!bulkState.running) bulkState.running = true; bulkState.paused = false; bulkSendLoop().catch(() => {}); return { ok: true }; }));
app.post('/api/bulk/cancel', wrap(async () => { bulkState.running = false; bulkState.paused = false; bulkStore.set('running', false); return { ok: true }; }));
app.get('/api/bulk/status', wrap(async () => {
  const status = bot.getStatus();
  return { ...status, bulk: { running: bulkState.running, paused: bulkState.paused, index: bulkState.index, total: bulkState.total } };
}));
app.post('/api/bulk/draft', wrap(async (req) => { bulkStore.set('draft', req.body || null); return { ok: true }; }));
app.get('/api/bulk/draft', wrap(async () => bulkStore.get('draft') || null));
app.post('/api/bulk/settings', wrap(async (req) => { bulkStore.set('settings', req.body || {}); return { ok: true }; }));
app.get('/api/bulk/settings', wrap(async () => bulkStore.get('settings') || { delaySec: 3, rpm: 20 }));

// Logs SSE
app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('\n');
  logClients.add(res);
  req.on('close', () => logClients.delete(res));
});

// Static frontend
app.use('/', express.static(path.join(__dirname, '..')));
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'renderer', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`WhatsApp bot server running on http://0.0.0.0:${PORT}`);
});
