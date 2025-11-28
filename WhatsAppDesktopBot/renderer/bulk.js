const $ = (id)=>document.getElementById(id);
const logBox = $('log');
const preview = $('preview');
let splitMode = 'blank'; // blank => تقسيم على فراغات/أسطر فارغة, line => كل سطر رسالة
let parsed = [];

function log(s){
  const tm = new Date().toLocaleTimeString();
  logBox.textContent += `[${tm}] ${s}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

function setPills(status){
  $('pill-ready').textContent = status.isReady ? 'متصل' : 'غير متصل';
  $('pill-running').textContent = status.bulk?.running ? 'شغال (Bulk)' : 'متوقف';
}

function renderPreview(items){
  preview.innerHTML = '';
  if (!items.length){ preview.innerHTML = '<div class="muted">المعاينة فارغة</div>'; return; }
  items.forEach((t,i)=>{
    const div = document.createElement('div');
    div.style.borderBottom='1px dashed #1e293b';
    div.style.padding='6px';
    div.innerHTML = `<strong>#${i+1}</strong><br>${t.replace(/\n/g,'<br>')}`;
    preview.appendChild(div);
  });
}

function parseInput(txt){
  txt = (txt||'').replace(/\r/g,'').trim();
  if (!txt) return [];
  if (splitMode === 'line'){
    return txt.split('\n').map(s=>s.trim()).filter(Boolean);
  }
  // تقسيم بالفراغات: كتل تفصلها سطور فارغة
  return txt.split(/\n{2,}/).map(b=>b.trim()).filter(Boolean);
}

function getBulkSettings(){
  return {
    delaySec: Math.max(0, Number($('delaySec').value || 0)),
    rpm: Math.max(1, Number($('rpm').value || 1))
  };
}

$('btn-toggle-split').onclick = ()=>{
  splitMode = (splitMode === 'blank' ? 'line' : 'blank');
  $('splitModeName').textContent = (splitMode === 'blank') ? 'تقسيم بالفراغات' : 'كل سطر رسالة';
  $('btn-parse').click();
};

$('btn-parse').onclick = ()=>{
  parsed = parseInput($('bulkInput').value);
  renderPreview(parsed);
  $('progress').textContent = `0 / ${parsed.length}`;
  log(`تم التحليل: ${parsed.length} رسالة`);
};

$('btn-refresh-groups').onclick = async ()=>{
  try{
    const list = await window.api.fetchGroups();
    const sel = $('groupSelect'); sel.innerHTML='';
    list.forEach(g=>{
      const opt = document.createElement('option');
      opt.value = g.id; opt.textContent = `${g.name} (${g.count||0})`;
      sel.appendChild(opt);
    });
    log(`جُلبت المجموعات (${list.length})`);
  }catch(e){
    log('تعذر جلب المجموعات');
  }
};

$('btn-save-bulk-settings').onclick = async ()=>{
  const s = getBulkSettings();
  await window.api.bulkSaveSettings(s);
  log('حُفظت إعدادات الإرسال الجماعي');
};

$('btn-save-draft').onclick = async ()=>{
  await window.api.bulkSaveDraft({
    groupId: $('groupSelect').value || '',
    raw: $('bulkInput').value || '',
    splitMode
  });
  log('حُفظت المسودة');
};
$('btn-load-draft').onclick = async ()=>{
  const d = await window.api.bulkLoadDraft();
  if (d){
    $('bulkInput').value = d.raw || '';
    splitMode = d.splitMode || 'blank';
    $('splitModeName').textContent = (splitMode === 'blank') ? 'تقسيم بالفراغات' : 'كل سطر رسالة';
    if (d.groupId){
      try{
        const list = await window.api.fetchGroups();
        const sel = $('groupSelect'); sel.innerHTML='';
        list.forEach(g=>{
          const opt = document.createElement('option');
          opt.value = g.id; opt.textContent = `${g.name} (${g.count||0})`;
          if (g.id===d.groupId) opt.selected = true;
          sel.appendChild(opt);
        });
      }catch{}
    }
    $('btn-parse').click();
    log('تم تحميل المسودة');
  } else {
    log('لا توجد مسودة محفوظة');
  }
};

$('btn-start').onclick = async ()=>{
  if (!parsed.length) { $('btn-parse').click(); }
  if (!parsed.length){ log('لا توجد رسائل'); return; }
  const groupId = $('groupSelect').value;
  if (!groupId){ log('اختر مجموعة'); return; }
  const s = getBulkSettings();
  await window.api.bulkStart({ groupId, messages: parsed, ...s });
  log('تم بدء الإرسال…');
  pollStatus();
};
$('btn-pause').onclick  = async ()=>{ await window.api.bulkPause();  log('إيقاف مؤقت'); };
$('btn-resume').onclick = async ()=>{ await window.api.bulkResume(); log('استئناف'); pollStatus(); };
$('btn-cancel').onclick = async ()=>{ await window.api.bulkCancel(); log('تم الإلغاء'); };

async function refreshStatus(){
  const st = await window.api.bulkStatus();
  setPills(st);
  $('progress').textContent = `${st.bulk?.index||0} / ${st.bulk?.total||0}`;
}
async function pollStatus(){
  // سحب الحالة كل 2ث أثناء التشغيل
  for (let i=0;i<300;i++){
    const st = await window.api.bulkStatus();
    setPills(st);
    $('progress').textContent = `${st.bulk?.index||0} / ${st.bulk?.total||0}`;
    if (!st.bulk?.running) break;
    await new Promise(r=>setTimeout(r,2000));
  }
}

(async function init(){
  try {
    const s = await window.api.getStatus();
    setPills(s);
    $('btn-refresh-groups').click();
    // حمّل إعدادات bulk
    const bs = await window.api.bulkLoadSettings();
    if (bs){ $('delaySec').value = bs.delaySec ?? 3; $('rpm').value = bs.rpm ?? 20; }
    // إن كان هناك مهمة جارية، ابدأ الاستطلاع
    const st = await window.api.bulkStatus();
    if (st.bulk?.running) pollStatus();
  } catch {}
})();