// bot.js — FIFO صارم + lastChecked per group + backlog + منع تكرار + تطبيع عربي قوي (إصدار VPS / Baileys)

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode');
const P = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeInMemoryStore,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const { JsonStore } = require('./server/store');

class Bot {
  constructor({ sessionsDir, dataDir }) {
    this.emitter = new EventEmitter();
    this.sessionsDir = sessionsDir;
    this.dataDir = dataDir;
    this.sock = null;
    this.store = null;

    this.qrDataUrl = null;
    this.isReady = false;
    this.running = false;

    this.selectedGroupIds = [];
    this.clients = []; // [{name, emoji, _norm, _rx}]
    this.settings = {
      emoji: '✅',
      replyText: 'تم ✅',
      mode: 'emoji',                 // 'emoji' | 'text'
      ratePerMinute: 20,             // حد عام/دقيقة
      cooldownSec: 3,                // مهلة لكل جروب (ثواني)
      normalizeArabic: true
    };

    // تخزين دائم
    const statePath = path.join(this.dataDir, 'wbot-state.json');
    this.state = new JsonStore(statePath);

    this.queue = [];
    this.workerRunning = false;

    this.minuteCount = 0;
    setInterval(() => (this.minuteCount = 0), 60_000);

    this.groupCache = new Map();
  }

  // ========= Utilities =========
  onLog(cb) { this.emitter.on('log', cb); }
  log(line) { try { this.emitter.emit('log', line); } catch {} }
  wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  normalizeArabic(s = '') {
    if (!s) return '';
    let t = s;
    t = t.replace(/[\u200c\u200d\u200e\u200f\u202a-\u202e]/g, ''); // محارف خفية/اتجاه
    t = t.replace(/[\u064B-\u0652\u0670]/g, '').replace(/\u0640/g, ''); // تشكيل+ألف خنجرية+تطويل
    t = t.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي');
    const ar = '٠١٢٣٤٥٦٧٨٩', en = '0123456789';
    t = t.replace(/[٠-٩]/g, d => en[ar.indexOf(d)]);
    t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ');
    t = t.replace(/\s+/g, ' ').trim().toLowerCase();
    return t;
  }
  escapeRegex(s=''){ return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  buildNameRegex(normName) {
    const tokens = (normName || '').split(' ').filter(w => w.length >= 2);
    if (!tokens.length) return null;
    const pattern = tokens.map(tok => this.escapeRegex(tok)).join('[\\s\\p{P}]*');
    try { return new RegExp(`(?:^|\\s)${pattern}(?:\\s|$)`, 'u'); } catch { return null; }
  }

  _msgId(m){
    try {
      const { id, remoteJid, participant } = m?.key || {};
      return [id, remoteJid, participant].filter(Boolean).join('::') || null;
    } catch { return null; }
  }
  _isDone(msgId){ return !!(msgId && this.state.get(`done.${msgId}`)); }
  _markDone(msgId){ if (msgId) this.state.set(`done.${msgId}`, Date.now()); }

  setClients(arr = []) {
    const list = Array.isArray(arr) ? arr : [];
    this.clients = list.map(c => {
      const name = typeof c === 'string' ? c : (c.name || '');
      const emoji = typeof c === 'string' ? '✅' : (c.emoji || '✅');
      const norm = this.settings.normalizeArabic ? this.normalizeArabic(name) : (name || '').toLowerCase();
      const rx = this.buildNameRegex(norm);
      return { name, emoji, _norm: norm, _rx: rx };
    }).filter(x => x.name && x._rx);
    this.log(`clients loaded: ${this.clients.length}`);
  }

  setSettings(s = {}) {
    this.settings = Object.assign({}, this.settings, s);
    this.log(`[settings] mode=${this.settings.mode} rpm=${this.settings.ratePerMinute} cooldown=${this.settings.cooldownSec}s normalize=${!!this.settings.normalizeArabic}`);
    const raw = this.clients.map(({name, emoji}) => ({name, emoji}));
    this.setClients(raw); // إعادة بناء Regex لو تغيّر normalize
  }

  setSelectedGroups(ids = []) { this.selectedGroupIds = Array.isArray(ids) ? ids : []; }
  getSelectedGroups() { return this.selectedGroupIds; }

  getLastChecked(chatId) { return this.state.get(`lastChecked.${chatId}`, 0); }
  setLastChecked(chatId, tsMs) {
    const prev = this.getLastChecked(chatId) || 0;
    if (tsMs > prev) this.state.set(`lastChecked.${chatId}`, tsMs);
  }
  getLastCheckedMap() {
    const out = {};
    const all = this.state.store?.lastChecked || {};
    for (const [chatId, ts] of Object.entries(all)) out[chatId] = ts;
    return out;
  }

  async _ensureStore() {
    if (this.store) return;
    this.store = makeInMemoryStore({ logger: P({ level: 'silent' }) });
  }

  async init() {
    if (!fs.existsSync(this.sessionsDir)) fs.mkdirSync(this.sessionsDir, { recursive: true });
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

    await this._ensureStore();

    const { state, saveCreds } = await useMultiFileAuthState(path.join(this.sessionsDir, 'auth'));
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['VPS', 'Chrome', '1.0'],
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, P({ level: 'silent' }))
      }
    });

    this.store.bind(this.sock.ev);
    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        this.qrDataUrl = await qrcode.toDataURL(qr);
        this.isReady = false;
        this.log('[QR] جاهز — امسحه من WhatsApp');
      }

      if (connection === 'open') {
        this.isReady = true;
        this.qrDataUrl = null;
        this.log('✅ WhatsApp جاهز');
        try {
          const groups = await this.sock.groupFetchAllParticipating();
          this.groupCache.clear();
          for (const [id, meta] of Object.entries(groups || {})) {
            this.groupCache.set(id, meta?.subject || id);
          }
        } catch {}
      }

      if (connection === 'close') {
        this.isReady = false;
        this.running = false;
        const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
        this.log('❌ تم قطع الاتصال: ' + (lastDisconnect?.error?.message || 'unknown'));
        if (shouldReconnect) {
          setTimeout(() => this.init().catch(() => {}), 2000);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages || []) {
        try {
          if (!this.running) continue;
          if (!msg?.message) continue;
          const chatId = msg.key?.remoteJid;
          if (!chatId || !chatId.endsWith('@g.us')) continue; // مجموعات فقط
          if (msg.key?.fromMe) continue;

          if (this.selectedGroupIds.length && !this.selectedGroupIds.includes(chatId)) continue;

          const tsSec = Number(msg.messageTimestamp || 0) || Math.floor(Date.now() / 1000);
          const tsMs = tsSec * 1000;
          const text = (this._extractText(msg) || '').trim();
          const mid  = this._msgId(msg);
          const chatName = await this._getGroupName(chatId);

          if (this._isDone(mid)) {
            this.setLastChecked(chatId, tsMs);
            continue;
          }

          this.queue.push({
            kind: 'live',
            chatId,
            chatName,
            tsMs,
            exec: async () => {
              await this._processOneMessage({ msgObj: msg, chatId, chatName, tsMs, text, mid });
            }
          });
        } catch (e) {
          this.log('⚠️ live message error: ' + (e.message || e));
        }
      }

      this._runWorker();
    });
  }

  async _getGroupName(chatId) {
    if (this.groupCache.has(chatId)) return this.groupCache.get(chatId);
    try {
      const meta = await this.sock.groupMetadata(chatId);
      if (meta?.subject) this.groupCache.set(chatId, meta.subject);
      return meta?.subject || chatId;
    } catch {
      return chatId;
    }
  }

  _extractText(msg) {
    const m = msg?.message || {};
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    return '';
  }

  // ========= العامل: يضمن FIFO صارم =========
  async _runWorker() {
    if (this.workerRunning) return;
    this.workerRunning = true;

    while (this.running && this.queue.length > 0) {
      const item = this.queue.shift();
      try {
        await item.exec();
      } catch (e) {
        this.log(`[worker-error] ${e.message || e}`);
      }
    }

    this.workerRunning = false;
  }

  async _sendReaction(chatId, msgObj, emoji) {
    try {
      await this.sock.sendMessage(chatId, { react: { text: emoji, key: msgObj.key } });
    } catch (e) {
      this.log('⚠️ react error: ' + (e.message || e));
    }
  }

  async _sendReply(chatId, msgObj, text) {
    try {
      await this.sock.sendMessage(chatId, { text }, { quoted: msgObj });
    } catch (e) {
      this.log('⚠️ reply error: ' + (e.message || e));
    }
  }

  async _processOneMessage({ msgObj, chatId, chatName, tsMs, text, mid }) {
    // كوول داون لكل جروب
    const cd = Math.max(0, Number(this.settings.cooldownSec || 0));
    const lastCool = this.state.get(`cool.${chatId}`, 0);
    const since = Date.now() - lastCool;
    if (cd > 0 && since < cd * 1000) {
      await this.wait(cd * 1000 - since);
    }

    // حد/دقيقة عام
    const rpm = Math.max(1, Number(this.settings.ratePerMinute || 1));
    if (this.minuteCount >= rpm) {
      this.log('⏳ امتلأ حد الرد بالدقيقة — انتظار قصير…');
      await this.wait(4000);
    }

    // مطابقة اسم عميل
    const normBody = this.settings.normalizeArabic ? this.normalizeArabic(text) : (text || '').toLowerCase();
    let matched = null;
    for (const c of this.clients) { if (c._rx && c._rx.test(normBody)) { matched = c; break; } }

    if (matched) {
      try {
        if (this.settings.mode === 'text' && this.settings.replyText) {
          await this._sendReply(chatId, msgObj, this.settings.replyText);
        } else {
          await this._sendReaction(chatId, msgObj, matched.emoji || this.settings.emoji || '✅');
        }
        this.minuteCount += 1;
        this.state.set(`cool.${chatId}`, Date.now());
        this._markDone(mid);
        this.log(`↩️ ${chatName} → ${matched.name}`);
      } catch (e) {
        this.log('⚠️ react/reply error: ' + (e.message || e));
      }
    }

    // ✅ دوّن آخر نقطة دائماً
    this.setLastChecked(chatId, tsMs);
  }

  // ========= API =========
  async start() {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    this.running = true;
    this.log('🚀 بدأ التفاعل');
    this._runWorker();
  }
  async stop() {
    this.running = false;
    this.log('🛑 تم الإيقاف');
  }

  getStatus() {
    return {
      isReady: this.isReady,
      running: this.running,
      selectedGroupIds: this.selectedGroupIds,
      clients: this.clients.map(({name, emoji}) => ({name, emoji})),
      settings: this.settings,
      queueSize: this.queue.length
    };
  }
  async getQR() {
    if (this.qrDataUrl) return { qr: this.qrDataUrl };
    if (this.isReady) return { message: 'Already connected' };
    return { error: 'QR not available yet' };
  }
  async fetchGroups() {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    const groups = await this.sock.groupFetchAllParticipating();
    const list = Object.values(groups || {}).map(c => ({
      id: c.id,
      name: c.subject,
      count: Array.isArray(c.participants) ? c.participants.length : 0
    }));
    list.forEach(g => this.groupCache.set(g.id, g.name));
    this.log(`📥 تم جلب المجموعات: ${list.length}`);
    return list;
  }

  async _fetchMessages(chatId, limit, cursor) {
    try {
      const msgs = await this.sock.fetchMessagesFromWA(chatId, limit, cursor);
      return Array.isArray(msgs) ? msgs : [];
    } catch (e) {
      this.log('⚠️ fetchMessages error: ' + (e.message || e));
      return [];
    }
  }

  // أرشيف: نحترم since + نتجنب الرسائل المعالجة سابقاً + FIFO
  async processBacklog({ startAtMs = null, limitPerChat = 800 } = {}) {
    if (!this.sock || !this.isReady) throw new Error('WhatsApp not ready');

    const groups = await this.fetchGroups();
    const selected = this.selectedGroupIds.length ? new Set(this.selectedGroupIds) : null;
    const targets = groups.filter(g => !selected || selected.has(g.id));

    for (const chat of targets) {
      const chatId = chat.id;
      const since = startAtMs ?? this.getLastChecked(chatId) ?? 0;
      this.log(`[backlog] ${chat.name} since ${since ? new Date(since).toLocaleString() : '—'}`);

      let fetched = 0;
      let cursor = null;
      const batch = 200;

      while (fetched < limitPerChat) {
        const msgs = await this._fetchMessages(chatId, Math.min(batch, limitPerChat - fetched), cursor);
        if (!msgs.length) break;

        const ordered = msgs.slice().reverse(); // أقدم → أحدث
        for (const m of ordered) {
          const tsMs = (Number(m.messageTimestamp) || 0) * 1000;
          if (tsMs <= since) continue;
          if (m.key?.fromMe) continue;
          const mid = this._msgId(m);
          if (this._isDone(mid)) { this.setLastChecked(chatId, tsMs); continue; }

          const text = (this._extractText(m) || '').trim();
          this.queue.push({
            kind: 'backlog',
            chatId,
            chatName: chat.name,
            tsMs,
            exec: async () => {
              await this._processOneMessage({ msgObj: m, chatId, chatName: chat.name, tsMs, text, mid });
            }
          });
        }

        fetched += msgs.length;
        const last = msgs[msgs.length - 1];
        cursor = last ? { id: last.key?.id, fromMe: last.key?.fromMe, participant: last.key?.participant } : null;
        if (msgs.length < batch) break;
      }
    }

    this._runWorker();
  }

  // فحص الأرشيف: عدد الرسائل "المطابقة" فقط (إن ما في عملاء، يرجّع 0)
  async countBacklog({ startAtMs = null, limitPerChat = 800 } = {}) {
    if (!this.sock || !this.isReady) throw new Error('WhatsApp not ready');

    const groups = await this.fetchGroups();
    const selected = this.selectedGroupIds.length ? new Set(this.selectedGroupIds) : null;
    const targets = groups.filter(g => !selected || selected.has(g.id));

    let total = 0;
    const byGroup = [];

    for (const chat of targets) {
      const chatId = chat.id;
      const since = startAtMs ?? this.getLastChecked(chatId) ?? 0;

      let fetched = 0;
      let cursor = null;
      const batch = 200;
      let count = 0;

      while (fetched < limitPerChat) {
        const msgs = await this._fetchMessages(chatId, Math.min(batch, limitPerChat - fetched), cursor);
        if (!msgs.length) break;

        const ordered = msgs.slice().reverse(); // أقدم → أحدث
        for (const m of ordered) {
          const tsMs = (Number(m.messageTimestamp) || 0) * 1000;
          if (tsMs <= since) continue;
          if (m.key?.fromMe) continue;

          const mid = this._msgId(m);
          if (this._isDone(mid)) continue;

          const text = (this._extractText(m) || '').trim();
          if (!text) continue;

          if (this.clients && this.clients.length) {
            const normBody = this.settings.normalizeArabic ? this.normalizeArabic(text) : text.toLowerCase();
            const match = this.clients.some(c => c._rx && c._rx.test(normBody));
            if (match) count++;
          }
        }

        fetched += msgs.length;
        const last = msgs[msgs.length - 1];
        cursor = last ? { id: last.key?.id, fromMe: last.key?.fromMe, participant: last.key?.participant } : null;
        if (msgs.length < batch) break;
      }

      byGroup.push({ id: chatId, name: chat.name, count });
      total += count;
    }

    return { total, byGroup };
  }
}

module.exports = { Bot };
