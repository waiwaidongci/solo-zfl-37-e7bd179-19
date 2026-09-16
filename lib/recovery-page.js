export function recoveryPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>数据恢复台 · 墨锭试磨室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --ok:#3d7a4a; }
    * { box-sizing:border-box; }
    html,body { max-width:100%; overflow-x:hidden; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:12px; align-items:center; }
    header > div { min-width:0; }
    h1 { margin:0; font-size:23px; word-break:break-word; } h2 { margin:0 0 10px; font-size:17px; }
    /* minmax(0,1fr) 防止 grid 项被表格/表单的最小内容宽度撑破，导致整页横向溢出 */
    main { padding:20px 28px; display:grid; grid-template-columns:minmax(0,1fr); gap:16px; }
    a.navlink { color:var(--accent); font-weight:700; text-decoration:none; border:1px solid var(--accent); border-radius:6px; padding:8px 12px; white-space:nowrap; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; min-width:0; max-width:100%; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; align-items:end; }
    .field { display:grid; gap:4px; min-width:0; }
    .field label { color:var(--muted); font-size:12px; }
    input,select,button { font:inherit; }
    input[type=text],input[type=number],select { border:1px solid var(--line); border-radius:6px; padding:9px; background:#fff; max-width:100%; min-width:0; }
    input[type=number]{ width:90px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 14px; font-weight:700; cursor:pointer; max-width:100%; }
    button.secondary { background:#69736a; }
    button.danger { background:var(--warn); }
    button.ghost { background:#fff; color:var(--accent); border:1px solid var(--accent); padding:6px 10px; font-size:13px; }
    button:disabled { opacity:.5; cursor:not-allowed; }
    .tablewrap { min-width:0; max-width:100%; overflow-x:auto; -webkit-overflow-scrolling:touch; }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th,td { text-align:left; padding:9px 8px; border-bottom:1px solid var(--line); vertical-align:middle; }
    th { color:var(--muted); font-weight:700; font-size:12px; white-space:nowrap; }
    td { word-break:break-word; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
    .pill.full { background:#eef4ea; } .pill.inc { background:#fdf3e3; }
    .bad { color:var(--warn); font-weight:700; } .good { color:var(--ok); font-weight:700; }
    .meta { color:var(--muted); font-size:12px; word-break:break-word; }
    .tag-pin { color:#8a6d1d; font-weight:700; font-size:12px; }
    .row-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
    #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#20241f; color:#fff; padding:11px 18px; border-radius:8px; font-size:14px; opacity:0; transition:opacity .2s; pointer-events:none; max-width:90vw; }
    #toast.show { opacity:.95; }
    #toast.err { background:var(--warn); }
    .banner { display:none; padding:12px 28px; background:#f6e3dd; color:var(--warn); font-weight:700; }
    /* 弹窗 */
    #modalMask { position:fixed; inset:0; background:rgba(20,24,18,.45); display:none; align-items:center; justify-content:center; padding:16px; z-index:20; }
    #modalMask.show { display:flex; }
    .modal { background:#fff; border-radius:10px; padding:20px; width:min(560px,100%); max-width:100%; max-height:88vh; overflow:auto; }
    .modal h2 { margin-top:0; word-break:break-word; }
    .counts { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; margin:14px 0; }
    .count { border:1px solid var(--line); border-radius:8px; padding:12px; text-align:center; min-width:0; }
    .count strong { display:block; font-size:26px; }
    .count.add strong { color:var(--accent); } .count.mod strong { color:#8a6d1d; } .count.del strong { color:var(--warn); }
    .changelist { max-height:180px; overflow:auto; border:1px solid var(--line); border-radius:6px; padding:8px 12px; margin:6px 0; font-size:13px; word-break:break-word; }
    .changelist .empty { color:var(--muted); }
    .warnbox { background:#f6e3dd; border:1px solid #e0b3a6; border-radius:8px; padding:10px 12px; margin:12px 0; color:var(--warn); font-size:13px; word-break:break-word; }
    .modal-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:16px; flex-wrap:wrap; }
    .spinner { display:inline-block; width:14px; height:14px; border:2px solid #fff8; border-top-color:#fff; border-radius:50%; animation:spin .7s linear infinite; vertical-align:-2px; margin-right:6px; }
    @keyframes spin { to { transform:rotate(360deg); } }
    /* 手机窄屏：表格在自身区域内不撑开页面；每行转为一张卡片，按钮与状态始终留在屏内 */
    @media (max-width:760px){
      header{ padding:14px 16px; flex-wrap:wrap; }
      main{ padding:14px; }
      .banner{ padding:10px 16px; }
      .toolbar { flex-direction:column; align-items:stretch; }
      .toolbar .field { width:100%; }
      .toolbar .field select, .toolbar .field input { width:100%; }
      .toolbar button { width:100%; }
      table,thead,tbody,th,td,tr { display:block; }
      thead { display:none; }
      .tablewrap { overflow-x:visible; }
      tbody tr { border:1px solid var(--line); border-radius:8px; padding:6px 10px; margin-bottom:10px; background:#fff; }
      tbody td { border-bottom:1px dashed var(--line); padding:8px 2px; display:flex; justify-content:space-between; gap:12px; align-items:flex-start; text-align:right; }
      tbody td:last-child { border-bottom:0; }
      tbody td::before { content:attr(data-label); color:var(--muted); font-size:12px; flex:0 0 auto; text-align:left; }
      tbody td .row-actions { justify-content:flex-end; width:100%; }
      .row-actions button { flex:1 1 auto; }
    }
  </style>
</head>
<body>
  <header>
    <div><h1>数据恢复台</h1><div class="meta">墨锭、试磨、日志与统计的全量 / 增量恢复点</div></div>
    <a class="navlink" href="/">返回试磨室</a>
  </header>
  <div class="banner" id="restoreBanner"></div>
  <main>
    <section class="panel" id="pendingBox" style="display:none;border-color:#e0b3a6;background:#fdf4f1">
      <h2 class="bad">存在未完成的回滚</h2>
      <p class="meta" style="color:var(--warn)">上次恢复失败且自动回滚也未成功（如磁盘故障）。恢复前数据仍安全保留在备份中；磁盘恢复后请重试回滚以找回数据。重试成功前，相关恢复不可再发起。</p>
      <div id="pendingList" style="display:grid;gap:10px;margin-top:10px"></div>
    </section>

    <section class="panel">
      <h2>生成恢复点</h2>
      <div class="toolbar">
        <div class="field"><label>类型</label>
          <select id="pointKind">
            <option value="auto">自动（无点建全量，否则增量）</option>
            <option value="full">全量</option>
            <option value="incremental">增量</option>
          </select>
        </div>
        <div class="field" style="flex:1;min-width:180px"><label>备注（可选）</label><input type="text" id="pointNote" placeholder="如：第七批试磨完成"></div>
        <button id="createBtn">生成恢复点</button>
        <button class="secondary" id="validateBtn">校验全部</button>
        <button class="ghost" id="refreshBtn">刷新</button>
      </div>
      <p class="meta" style="margin-bottom:0">生成恢复点期间可以继续录入；若与上一点没有变化，增量点不会创建。</p>
    </section>

    <section class="panel">
      <h2>保留策略</h2>
      <div class="toolbar">
        <div class="field"><label>按数量保留（最旧的优先清理）</label><input type="number" id="retention" min="1" step="1"></div>
        <button id="saveRetention">保存并立即清理</button>
      </div>
      <p class="meta" style="margin-bottom:0">被钉住、或仍被增量恢复点沿链依赖的恢复点不会被删除。</p>
    </section>

    <section class="panel">
      <h2>恢复点</h2>
      <div id="validateSummary" class="meta"></div>
      <div class="tablewrap">
        <table>
          <thead><tr><th>时间</th><th>类型</th><th>链条</th><th>状态</th><th>内容</th><th style="text-align:right">操作</th></tr></thead>
          <tbody id="rows"><tr><td colspan="6" class="meta">加载中…</td></tr></tbody>
        </table>
      </div>
    </section>
  </main>

  <div id="modalMask">
    <div class="modal" id="modal"></div>
  </div>
  <div id="toast"></div>

<script>
const $ = s => document.querySelector(s);
const rowsEl = $('#rows');
const mask = $('#modalMask'), modal = $('#modal');
const toast = $('#toast');
let overview = null;
let busy = false;

function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
let toastTimer;
function showToast(msg, isErr){
  toast.textContent = msg;
  toast.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.className = '', 3200);
}
async function api(path, options){
  const res = await fetch(path, options && options.body ? { ...options, headers:{'Content-Type':'application/json'} } : options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || data.error || '请求失败'); e.code = data.error; e.details = data.details; throw e; }
  return data;
}
function fmtTime(iso){ if(!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString('zh-CN', { hour12:false }); }
function kindPill(p){ return p.kind === 'full' ? '<span class="pill full">全量</span>' : p.kind === 'incremental' ? '<span class="pill inc">增量</span>' : '<span class="pill">未知</span>'; }

function closeModal(){ mask.classList.remove('show'); modal.innerHTML=''; }
mask.addEventListener('click', e => { if (e.target === mask) closeModal(); });

async function load(){
  try {
    overview = await api('/api/recovery/overview');
    render();
    renderPending(overview.pendingRollbacks || []);
  } catch(e){ rowsEl.innerHTML = '<tr><td colspan="6" class="bad">加载失败：'+esc(e.message)+'</td></tr>'; }
  pollBanner();
}
function renderPending(list){
  const box = $('#pendingBox');
  if (!list.length){ box.style.display = 'none'; $('#pendingList').innerHTML = ''; return; }
  box.style.display = '';
  $('#pendingList').innerHTML = list.map(j =>
    '<div class="panel" style="padding:12px;display:grid;gap:8px;min-width:0">'
    + '<div><b>'+esc(j.restoreId)+'</b> <span class="meta">（目标点 '+esc(j.pointId || '—')+'，中断于 '+fmtTime(j.finishedAt || j.createdAt)+'）</span></div>'
    + '<div class="meta" style="color:var(--warn)">回滚写入失败：'+esc(j.rollbackError || j.error || '未知错误')+'；备份仍保留，可重试找回恢复前数据。</div>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap"><button data-recover-rollback="'+esc(j.restoreId)+'">重试回滚找回数据</button>'
    + '<button class="ghost" data-view-journal="'+esc(j.restoreId)+'">查看日志</button></div>'
    + '</div>'
  ).join('');
}
function pollBanner(){
  api('/api/recovery/status').then(st => {
    const b = $('#restoreBanner');
    if (st.restoreActive){ b.style.display='block'; b.textContent='⚠ 数据恢复进行中（'+st.restoreActive+'），所有写入将失败'; }
    else b.style.display='none';
  }).catch(()=>{});
}

function render(){
  const pts = overview.points || [];
  $('#retention').value = overview.config?.retention ?? 10;
  const errs = overview.errors || [];
  if (!pts.length){
    $('#validateSummary').innerHTML = '尚无恢复点。点击「生成恢复点」创建第一个全量点。';
  } else if (!errs.length){
    $('#validateSummary').innerHTML = '<span class="good">✓ 校验通过</span>：'+pts.length+' 个恢复点，全部摘要与链条完整。';
  } else {
    $('#validateSummary').innerHTML = '<span class="bad">✗ 发现 '+errs.length+' 处问题</span>（摘要不符或链条断裂），相关恢复点不可用于恢复。';
  }
  rowsEl.innerHTML = pts.slice().reverse().map(p => {
    const bad = !p.selfValid || (p.kind === 'incremental' && !p.reachable);
    const status = p.kind === 'full'
      ? (p.selfValid ? '<span class="good">完整</span>' : '<span class="bad">损坏</span>')
      : (p.selfValid ? (p.reachable ? '<span class="good">链路完整</span>' : '<span class="bad">断链</span>') : '<span class="bad">损坏</span>');
    const chain = p.kind === 'full' ? '基点（'+esc(p.id.slice(-6))+'）' : '← '+(p.parentId ? esc(p.parentId.slice(-6)) : '—');
    const content = p.kind === 'full'
      ? '含 '+p.itemCount+' 锭'
      : '改/增 '+p.upserts+' · 删 '+p.deletes;
    const actions = '<div class="row-actions">'
      + (p.pinned
          ? '<button class="ghost" data-unpin="'+esc(p.id)+'">取消钉住</button>'
          : '<button class="ghost" data-pin="'+esc(p.id)+'">钉住</button>')
      + '<button class="ghost" data-preview="'+esc(p.id)+'"'+(bad?' disabled':'')+'>预览</button>'
      + '<button class="danger" data-restore="'+esc(p.id)+'"'+(bad?' disabled':'')+'>恢复</button>'
      + '<button class="ghost" data-del="'+esc(p.id)+'"'+(p.pinned?' disabled':'')+'>删除</button>'
      + '</div>';
    return '<tr>'
      + '<td data-label="时间"><div>'+fmtTime(p.createdAt)+'</div><div class="meta">'+esc(p.id)+(p.note?' · '+esc(p.note):'')+'</div></td>'
      + '<td data-label="类型">'+kindPill(p)+(p.pinned?' <span class="tag-pin">📌</span>':'')+'</td>'
      + '<td data-label="链条" class="meta">'+chain+'</td>'
      + '<td data-label="状态">'+status+'</td>'
      + '<td data-label="内容" class="meta">'+content+'</td>'
      + '<td data-label="操作">'+actions+'</td>'
      + '</tr>';
  }).join('') || '<tr><td colspan="6" class="meta">尚无恢复点</td></tr>';
}

/* ---------- 生成 / 校验 / 保留 ---------- */

$('#createBtn').onclick = async () => {
  if (busy) return; busy = true;
  const btn = $('#createBtn'); btn.disabled = true;
  try {
    const r = await api('/api/recovery/points', { method:'POST', body: JSON.stringify({ kind: $('#pointKind').value, note: $('#pointNote').value }) });
    $('#pointNote').value = '';
    showToast('已生成'+(r.point.kind === 'full' ? '全量' : '增量')+'恢复点 '+r.point.id);
    await load();
  } catch(e){ showToast(e.message, true); }
  finally { btn.disabled = false; busy = false; }
};
$('#validateBtn').onclick = async () => {
  const btn = $('#validateBtn'); btn.disabled = true;
  try {
    const r = await api('/api/recovery/validate', { method:'POST' });
    showToast('校验通过：'+r.points.length+' 个恢复点全部有效');
  } catch(e){
    showToast('校验未通过：恢复点存在摘要不符或断链，不能用于恢复', true);
  }
  btn.disabled = false;
  await load();
  // 展开问题明细
  if (overview && overview.errors && overview.errors.length){
    openModal('<h2>校验结果：发现问题</h2><p class="bad">共 '+overview.errors.length+' 处，任一摘要不符或链条断裂都会阻止恢复。</p>'
      + '<div class="changelist">' + overview.errors.map(x => '<div>恢复点 <b>'+esc(x.pointId || '?')+'</b>：'+reasonText(x.reason)+(x.detail?'（'+esc(x.detail)+'）':'')+'</div>').join('') + '</div>'
      + '<div class="modal-actions"><button id="mClose">关闭</button></div>');
  }
};
function reasonText(r){
  return ({
    payload_digest_mismatch:'内容摘要不符（内容可能已损坏或被篡改）',
    digest_mismatch:'恢复点摘要不符',
    chain_broken:'链条断裂：链接摘要与父点不符',
    parent_missing:'链条断裂：父恢复点缺失',
    chain_unreachable:'链条不可达：上游存在损坏',
    unreadable:'恢复点文件无法读取',
    malformed_point:'恢复点格式损坏',
    bad_kind:'类型字段非法',
    bad_full_payload:'全量内容格式错误',
    bad_incremental_payload:'增量内容格式错误',
    full_must_be_root:'全量点不应有父点',
    incremental_must_have_parent:'增量点缺少父点',
  })[r] || r;
}
$('#refreshBtn').onclick = load;
$('#saveRetention').onclick = async () => {
  const n = Number($('#retention').value);
  if (!Number.isInteger(n) || n < 1) return showToast('保留数量必须是不小于 1 的整数', true);
  try {
    const r = await api('/api/recovery/config', { method:'PUT', body: JSON.stringify({ retention:n }) });
    const removed = r.retained?.removed || [];
    showToast(removed.length ? '已清理 '+removed.length+' 个最旧恢复点' : '没有需要清理的恢复点');
    await load();
  } catch(e){ showToast(e.message, true); }
};

/* ---------- 行内操作（恢复点表格 + 待重试回滚卡片） ---------- */

document.addEventListener('click', async e => {
  const t = e.target;
  // 待重试回滚：重试找回恢复前数据
  if (t.dataset.recoverRollback) {
    const rid = t.dataset.recoverRollback;
    openConfirm('重试回滚？', '将把备份中的恢复前数据重新写回。成功前备份会一直保留；若磁盘仍故障可稍后再试。', async () => {
      try {
        await api('/api/recovery/restore/'+encodeURIComponent(rid)+'/recover-rollback', { method:'POST', body:'{}' });
        showToast('回滚成功，已找回恢复前数据');
        closeModal(); await load();
      } catch(err){ showToast(err.message, true); }
    }, '重试回滚');
    return;
  }
  if (t.dataset.viewJournal) {
    const rid = t.dataset.viewJournal;
    try {
      const j = await api('/api/recovery/restore/'+encodeURIComponent(rid));
      openModal('<h2>恢复日志 '+esc(rid)+'</h2><pre class="changelist" style="white-space:pre-wrap;max-height:50vh">'+esc(JSON.stringify(j, null, 2))+'</pre>'
        + '<div class="modal-actions"><button id="mClose">关闭</button></div>');
    } catch(err){ showToast(err.message, true); }
    return;
  }
  const id = t.dataset.pin || t.dataset.unpin || t.dataset.preview || t.dataset.restore || t.dataset.del;
  if (!id) return;
  try {
    if (t.dataset.pin) { await api('/api/recovery/points/'+encodeURIComponent(id)+'/pin', { method:'POST', body:'{}' }); showToast('已钉住'); await load(); }
    else if (t.dataset.unpin) { await api('/api/recovery/points/'+encodeURIComponent(id)+'/pin', { method:'DELETE' }); showToast('已取消钉住'); await load(); }
    else if (t.dataset.del) {
      openConfirm('删除恢复点 '+id+'？', '删除后不可恢复。被钉住或仍被增量依赖的点会被拒绝。', async () => {
        await api('/api/recovery/points/'+encodeURIComponent(id), { method:'DELETE' });
        showToast('已删除'); closeModal(); await load();
      }, '确认删除');
    }
    else if (t.dataset.preview) await openPreview(id);
    else if (t.dataset.restore) await askRestore(id);
  } catch(err){ showToast(err.message, true); }
});

function openModal(html){ modal.innerHTML = html; mask.classList.add('show'); modal.querySelector('#mClose')?.addEventListener('click', closeModal); }
function openConfirm(title, text, onOk, okText){
  openModal('<h2>'+esc(title)+'</h2><p>'+esc(text)+'</p><div class="modal-actions"><button class="secondary" id="mClose">取消</button><button class="danger" id="mOk">'+esc(okText||'确定')+'</button></div>');
  modal.querySelector('#mOk').onclick = () => onOk();
}

/* ---------- 预览与恢复 ---------- */

async function openPreview(id){
  openModal('<h2>预览恢复差异</h2><p class="meta">正在沿链校验并重建…</p>');
  try {
    const r = await api('/api/recovery/preview/'+encodeURIComponent(id));
    const d = r.diff;
    const list = (title, arr, cls) =>
      '<div><b>'+title+'（'+arr.length+'）</b><div class="changelist">'+
      (arr.length ? arr.map(x => '<div class="'+cls+'">'+esc(x.label || x.key)+'</div>').join('') : '<div class="empty">无</div>') + '</div></div>';
    openModal(
      '<h2>恢复预览 · '+esc(id)+'</h2>'
      + '<p class="meta">链条长度 '+r.chainLength+'（从全量基点到该点）。恢复将同时还原全部墨锭、试磨记录、日志与统计。</p>'
      + '<div class="counts">'
      +   '<div class="count add"><span>将新增</span><strong>'+d.counts.added+'</strong></div>'
      +   '<div class="count mod"><span>将修改</span><strong>'+d.counts.modified+'</strong></div>'
      +   '<div class="count del"><span>将丢失</span><strong>'+d.counts.missing+'</strong></div>'
      + '</div>'
      + '<p class="meta">目标版本：'+d.targetTotals.items+' 锭 · '+d.targetTotals.logs+' 条日志 · '+d.targetTotals.tests+' 次试磨；当前：'+d.currentTotals.items+' 锭 · '+d.currentTotals.logs+' 条日志 · '+d.currentTotals.tests+' 次试磨。</p>'
      + list('将新增的墨锭', d.added, 'good')
      + list('将被修改的墨锭', d.modified, '')
      + list('将丢失的墨锭', d.missing, 'bad')
      + '<div class="modal-actions"><button class="secondary" id="mClose">关闭</button><button class="danger" id="mGo">确认并恢复</button></div>'
    );
    modal.querySelector('#mGo').onclick = () => askRestore(id);
  } catch(e){
    openModal('<h2 class="bad">无法预览</h2><p class="bad">'+esc(e.message)+'</p>'
      + (e.details?.errors ? '<div class="changelist">'+e.details.errors.map(x => '<div>'+esc(x.pointId||'')+'：'+reasonText(x.reason)+'</div>').join('')+'</div>' : '')
      + '<div class="modal-actions"><button id="mClose">关闭</button></div>');
  }
}

async function askRestore(id){
  let preview;
  try { preview = await api('/api/recovery/preview/'+encodeURIComponent(id)); }
  catch(e){ return openModal('<h2 class="bad">不能恢复</h2><p class="bad">'+esc(e.message)+'</p><div class="modal-actions"><button id="mClose">关闭</button></div>'); }
  const d = preview.diff;
  const restoreId = cryptoRandomId();
  openModal(
    '<h2>确认恢复到 '+esc(id)+'</h2>'
    + '<div class="counts">'
    +   '<div class="count add"><span>新增</span><strong>'+d.counts.added+'</strong></div>'
    +   '<div class="count mod"><span>修改</span><strong>'+d.counts.modified+'</strong></div>'
    +   '<div class="count del"><span>丢失</span><strong>'+d.counts.missing+'</strong></div>'
    + '</div>'
    + '<div class="warnbox">恢复期间所有新写入都会失败，不会混入被回滚的版本。失败或中断会自动回到恢复前状态；请勿关闭页面。</div>'
    + '<div class="modal-actions"><button class="secondary" id="mClose">取消</button><button class="danger" id="mOk"><span id="mOkLabel">确认恢复</span></button></div>'
  );
  const okBtn = modal.querySelector('#mOk');
  okBtn.onclick = async () => {
    okBtn.disabled = true;
    modal.querySelector('#mClose').disabled = true;
    modal.querySelector('#mOkLabel').innerHTML = '<span class="spinner"></span>恢复中…';
    try {
      const r = await api('/api/recovery/restore', { method:'POST', body: JSON.stringify({ pointId:id, restoreId }) });
      closeModal();
      const t = r.journal?.restoredTotals;
      showToast((r.deduplicated ? '该恢复请求已执行过（幂等返回）' : '恢复完成') + (t ? '：'+t.items+' 锭、'+t.logs+' 日志、'+t.tests+' 试磨' : ''));
      await load();
    } catch(e){
      const again = e.code === 'restore_previously_rolled_back' || e.code === 'restore_in_progress';
      openModal(
        '<h2 class="bad">恢复未完成</h2>'
        + '<p>'+esc(e.message)+'</p>'
        + (again ? '<p class="meta">这是同一个恢复请求（'+esc(restoreId)+'）。确认后将以<b>新的请求</b>重新执行；此前任何写入都不会混入。</p>' : '')
        + '<div class="modal-actions"><button class="secondary" id="mClose">关闭</button>'+(again?'<button class="danger" id="mRetry">用新请求重试</button>':'')+'</div>'
      );
      modal.querySelector('#mRetry')?.addEventListener('click', () => askRestore(id));
    }
  };
}
function cryptoRandomId(){
  if (window.crypto?.randomUUID) return crypto.randomUUID();
  return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

load();
setInterval(() => { if (!mask.classList.contains('show')) load(); }, 8000);
</script>
</body>
</html>`;
}
