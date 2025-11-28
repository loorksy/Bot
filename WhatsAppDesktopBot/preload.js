(function(){
  const jsonHeaders = { 'Content-Type': 'application/json' };
  const apiFetch = async (url, opts = {}) => {
    const res = await fetch(url, Object.assign({ headers: jsonHeaders }, opts));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || 'request failed');
    return data;
  };

  let logSource = null;
  const logListeners = [];
  const ensureLogStream = () => {
    if (logSource) return;
    logSource = new EventSource('/api/logs');
    logSource.onmessage = (ev) => {
      for (const cb of logListeners) { try { cb(ev.data); } catch {} }
    };
    logSource.onerror = () => {};
  };

  const api = {
    getStatus: () => apiFetch('/api/status'),
    getQR: () => apiFetch('/api/qr'),

    fetchGroups: () => apiFetch('/api/groups'),
    saveGroups: (ids) => apiFetch('/api/groups/save', { method: 'POST', body: JSON.stringify({ ids }) }),
    getSavedGroups: () => apiFetch('/api/groups/saved'),

    saveClients: (raw) => apiFetch('/api/clients', { method: 'POST', body: JSON.stringify({ raw }) }),
    getClients: () => apiFetch('/api/clients'),

    setSettings: (s) => apiFetch('/api/settings', { method: 'POST', body: JSON.stringify(s || {}) }),
    getSettings: () => apiFetch('/api/settings'),

    startBot: () => apiFetch('/api/start', { method: 'POST' }),
    stopBot: () => apiFetch('/api/stop', { method: 'POST' }),

    getLastChecked: () => apiFetch('/api/last-checked'),
    processBacklog: (opts) => apiFetch('/api/backlog/process', { method: 'POST', body: JSON.stringify(opts || {}) }),
    checkBacklog:   (opts) => apiFetch('/api/backlog/check', { method: 'POST', body: JSON.stringify(opts || {}) }),

    onLog: (cb) => { if (typeof cb === 'function') { logListeners.push(cb); ensureLogStream(); } },

    // ===== Bulk (إرسال جماعي) =====
    bulkStart:   (opts) => apiFetch('/api/bulk/start', { method: 'POST', body: JSON.stringify(opts || {}) }),
    bulkPause:   () => apiFetch('/api/bulk/pause', { method: 'POST' }),
    bulkResume:  () => apiFetch('/api/bulk/resume', { method: 'POST' }),
    bulkCancel:  () => apiFetch('/api/bulk/cancel', { method: 'POST' }),
    bulkStatus:  () => apiFetch('/api/bulk/status'),
    bulkSaveDraft:   (d) => apiFetch('/api/bulk/draft', { method: 'POST', body: JSON.stringify(d || null) }),
    bulkLoadDraft:   () => apiFetch('/api/bulk/draft'),
    bulkSaveSettings:(s) => apiFetch('/api/bulk/settings', { method: 'POST', body: JSON.stringify(s || {}) }),
    bulkLoadSettings:() => apiFetch('/api/bulk/settings'),
  };

  if (typeof window !== 'undefined') {
    window.api = api;
  }
})();
