const $ = (id) => document.getElementById(id);
const logBox = $('log');
function log(s){ const tm = new Date().toLocaleTimeString(); logBox.textContent += `[${tm}] ${s}\n`; logBox.scrollTop = logBox.scrollHeight; }

window.api.onLog((line) => log(line));

function fmtTs(ts){
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString(); } catch { return '—'; }
}
function getBacklogStartTs(){
  const v = document.getElementById('backlogDate')?.value || '';
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getTime();
}

async function refreshStatus(){
  const s = await window.api.getStatus();
  $('pill-ready').textContent = s.isReady ? 'متصل' : 'غير متصل';
  $('pill-running').textContent = s.running ? 'شغّال' : 'متوقف';
}

async function showQR(){
  $('qr-box').style.display = 'block';
  $('qr-box').innerHTML = '<div class="muted">جارِ جلب QR…</div>';
  const r = await window.api.getQR();
  if(r.qr){
    const img = new Image();
    img.src = r.qr;
    $('qr-box').innerHTML = '';
    $('qr-box').appendChild(img);
  }else{
    $('qr-box').innerHTML = `<div class="muted">${r.message || r.error || 'QR غير جاهز'}</div>`;
  }
}

async function fetchGroups(){
  $('groups').innerHTML = '<div class="muted">جار جلب المجموعات…</div>';
  try{
    const [list, saved, lastMap] = await Promise.all([
      window.api.fetchGroups(),
      window.api.getSavedGroups(),
      window.api.getLastChecked()
    ]);
    renderGroups(list, new Set(saved), lastMap || {});
    log(`تم جلب المجموعات: ${list.length}`);
  }catch(e){
    $('groups').innerHTML='تعذر الجلب';
    log('تعذر جلب المجموعات','bad');
  }
}

function renderGroups(list, selectedSet, lastMap){
  const box = $('groups'); box.innerHTML = '';
  list.forEach(g=>{
    const row = document.createElement('div');
    row.className = 'group';

    const cb = document.createElement('input');
    cb.type='checkbox'; cb.value = g.id; cb.checked = selectedSet.has(g.id);

    const name = document.createElement('div');
    name.style.flex='1';
    name.innerHTML = `<strong>${g.name}</strong> <span class="muted">(${g.count||0})</span>`;

    const last = document.createElement('div');
    last.className='muted last-col';
    last.textContent = `آخر معالجة: ${fmtTs(lastMap[g.id])}`;

    row.append(cb, name, last);
    box.append(row);
  });
}

async function saveGroups(){
  const ids = [...$('groups').querySelectorAll('input[type=checkbox]:checked')].map(i=>i.value);
  const r = await window.api.saveGroups(ids);
  log(`حُفظت المجموعات: ${r.count}`);
}

async function saveClients(){
  const raw = $('clients').value;
  const r = await window.api.saveClients(raw);
  if(r.ok) log(`حُفظ العملاء: ${r.count}`); else log(`فشل حفظ العملاء: ${r.error}`);
}
async function loadClients(){
  const arr = await window.api.getClients();
  $('clients').value = (arr || []).map(c => (c.emoji ? `${c.name}|${c.emoji}` : c.name)).join('\n');
  log(`تم تحميل العملاء (${arr.length})`);
}

async function saveSettings(){
  const s = await window.api.setSettings({
    emoji: $('emoji').value.trim() || '✅',
    ratePerMinute: Number($('rpm').value || 20),
    cooldownSec: Number($('cooldown').value || 3),
    normalizeArabic: $('normalize').checked,
    mode: $('modeText').checked ? 'text' : 'emoji',
    replyText: 'تم ✅'
  });
  log('حُفظت الإعدادات');
}
async function loadSettings(){
  const s = await window.api.getSettings();
  $('emoji').value = s.emoji || '✅';
  $('rpm').value = s.ratePerMinute ?? 20;
  $('cooldown').value = s.cooldownSec ?? 3;
  $('normalize').checked = !!s.normalizeArabic;
  $('modeText').checked = (s.mode === 'text');
}

$('btn-show-qr').onclick = showQR;
$('btn-fetch-groups').onclick = fetchGroups;
$('btn-save-groups').onclick = saveGroups;
$('btn-save-clients').onclick = saveClients;
$('btn-load-clients').onclick = loadClients;
$('btn-save-settings').onclick = saveSettings;
$('btn-start').onclick = async ()=>{ await window.api.startBot(); await refreshStatus(); log('بدء التفاعل'); };
$('btn-stop').onclick  = async ()=>{ await window.api.stopBot();  await refreshStatus(); log('إيقاف التفاعل'); };

$('btn-check-backlog').onclick = async ()=>{
  const startAtMs = getBacklogStartTs();
  log('جارِ فحص الأرشيف…');
  try{
    const res = await window.api.checkBacklog({ startAtMs, limitPerChat: 800 });
    log(`نتيجة الفحص: المجموع ${res.total} رسالة مرشّحة`);
    (res.byGroup || []).forEach(g=>{
      log(`- ${g.name}: ${g.count}`);
    });
  }catch(e){
    log('فشل فحص الأرشيف: ' + (e.message || e));
  }
};

$('btn-backlog').onclick = async ()=>{
  const startAtMs = getBacklogStartTs(); // null => من آخر نقطة
  log('تشغيل تحليل الأرشيف…');
  await window.api.processBacklog({ startAtMs, limitPerChat: 800 });
  log('✓ تم دفع الأرشيف للطابور — سيُنفَّذ بالترتيب.');
};

(async function init(){
  await refreshStatus();
  await loadSettings();
  try {
    const saved = await window.api.getSavedGroups();
    if(saved && saved.length) {
      const [list, lastMap] = await Promise.all([window.api.fetchGroups(), window.api.getLastChecked()]);
      renderGroups(list, new Set(saved), lastMap || {});
    }
  } catch{}
})();