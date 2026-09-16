import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { RecoveryEngine, RecoveryError, atomicWrite } from "./lib/recovery.js";
import { recoveryPage } from "./lib/recovery-page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, "data");
const dbPath = join(dataDir, "ink-stick-testing.json");
const recoveryDir = join(dataDir, "recovery");
const port = Number(process.env.PORT || 3037);

const seed = {
  "items": [
    {
      "code": "IS-001",
      "smokeSource": "黄山松烟",
      "glueRatio": "7.5%",
      "ageYears": 8,
      "storage": "恒湿柜B",
      "status": "已试磨",
      "logs": [
        { "at": "2026-06-11", "step": "试磨", "note": "宣纸20滴水，出墨快，评分86", "score": 86 }
      ]
    },
    {
      "code": "IS-002",
      "smokeSource": "桐油烟",
      "glueRatio": "8%",
      "ageYears": 3,
      "storage": "试样盒C",
      "status": "待试磨",
      "logs": []
    }
  ]
};
const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
const stages = ["待试磨","已试磨","重点观察"];
const statLabels = ["待试磨","已试磨","重点观察"];

class Mutex {
  constructor() { this.queue = Promise.resolve(); }
  run(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => {}, () => {});
    return run;
  }
}

const writeLock = new Mutex();
let db = { items: [] };
let restoreActive = null; // 恢复进行中时保存 restoreId
let idCounter = 0;

const engine = new RecoveryEngine({ dir: recoveryDir });

/* ---------------- 存储 ---------------- */

function normalizeItem(item) {
  if (item.id == null) item.id = item.code;
  return item;
}

async function persist(content) {
  await atomicWrite(dbPath, content);
}

async function loadDbFromDisk() {
  const data = JSON.parse(await readFile(dbPath, "utf8"));
  data.items ||= [];
  data.items.forEach(normalizeItem);
  db = data;
}

async function initStorage() {
  if (!existsSync(dbPath)) {
    await atomicWrite(dbPath, seed);
  }
  await loadDbFromDisk();
}

/**
 * 所有写操作经此入口：恢复期间一律拒绝；否则串行化并原子落盘。
 */
async function mutate(fn) {
  if (restoreActive)
    throw new RecoveryError(409, "restore_in_progress", "数据恢复进行中，期间禁止写入");
  return writeLock.run(async () => {
    if (restoreActive)
      throw new RecoveryError(409, "restore_in_progress", "数据恢复进行中，期间禁止写入");
    const result = await fn();
    await persist({ items: db.items });
    return result;
  });
}

function newId() {
  idCounter += 1;
  return "IS-" + Date.now() + "-" + idCounter.toString(36) + randomUUID().slice(0, 4);
}
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tests || []).reduce((n, t) => n + 1, 0) + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}
function findItem(ref) {
  return db.items.find(x => x.id === ref || x.code === ref);
}

/* ---------------- 恢复 ---------------- */

// 故障注入（仅测试用）：
// RECOVERY_FAULT=after_write 恢复落盘后抛错；RECOVERY_CRASH=after_write 直接退出；
// RECOVERY_ROLLBACK_FAULT=1 让同次恢复的回滚写入也失败；RECOVERY_REPLAY_ROLLBACK_FAULT=1 让启动重演回滚失败
const faultPhase = process.env.RECOVERY_FAULT || null;
const crashPhase = process.env.RECOVERY_CRASH || null;
const rollbackFault = process.env.RECOVERY_ROLLBACK_FAULT === "1";
const replayRollbackFault = process.env.RECOVERY_REPLAY_ROLLBACK_FAULT === "1";
const recoverRollbackFault = process.env.RECOVERY_RECOVER_ROLLBACK_FAULT === "1" || replayRollbackFault;

let inflightRestore = null; // { rid, promise }

async function performRestore(restoreId, pointId) {
  // 同一个恢复请求并发到达：共用同一次执行，重复请求只执行一次
  if (inflightRestore) {
    if (inflightRestore.rid !== restoreId)
      throw new RecoveryError(409, "restore_in_progress", "已有恢复正在进行：" + inflightRestore.rid);
    const result = await inflightRestore.promise;
    return { ...result, deduplicated: true, coalesced: true };
  }
  // 在排队取锁之前同步置位：排空在途写入的同时，新写入立刻失败，不存在漏网窗口
  restoreActive = restoreId;
  const promise = runRestore(restoreId, pointId);
  inflightRestore = { rid: restoreId, promise };
  try {
    return await promise;
  } finally {
    inflightRestore = null;
  }
}

async function runRestore(restoreId, pointId) {
  return writeLock.run(async () => {
    // 取得写锁：在途写入已排空，备份即恢复前一致状态；此后到替换完成期间无其它写入
    try {
      const backupContent = { items: JSON.parse(JSON.stringify(db.items)) };
      let writes = 0;
      const result = await engine.restore({
        restoreId,
        pointId,
        backupContent,
        writeDb: async (content) => {
          writes += 1;
          // 回滚写入（第 2 次写）按注入失败，模拟回滚落盘故障
          if (rollbackFault && writes === 2) throw new Error("注入的回滚写入故障");
          await persist(content);
          await loadDbFromDisk();
        },
        inject: async (phase) => {
          if (crashPhase === phase) process.exit(33);
          if (faultPhase === phase) throw new Error("注入的恢复故障");
          if (process.env.RECOVERY_HOLD === phase)
            await new Promise(r => setTimeout(r, Number(process.env.RECOVERY_HOLD_MS || 800)));
        },
      });
      return result;
    } finally {
      restoreActive = null;
    }
  });
}

async function assertNotRestoring() {
  if (restoreActive)
    throw new RecoveryError(409, "restore_in_progress", "数据恢复进行中，该操作暂不可用");
}

/* ---------------- HTTP 辅助 ---------------- */

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RecoveryError(400, "bad_json", "请求体不是合法 JSON");
  }
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}

/* ---------------- 主页 ---------------- */

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>墨锭试磨室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; }
    html,body { max-width:100%; overflow-x:hidden; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    header > div { min-width:0; }
    h1 { margin:0; font-size:26px; word-break:break-word; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px minmax(0,1fr); gap:22px; padding:22px 28px; }
    section { min-width:0; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; min-width:0; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; max-width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; max-width:100%; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; max-width:100%; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; word-break:break-word; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; word-break:break-word; } .warn { color:var(--warn); font-weight:700; }
    #restoreBanner { display:none; margin:0; padding:10px 28px; background:#f6e3dd; color:var(--warn); font-weight:700; }
    a.navlink { color:var(--accent); font-weight:700; text-decoration:none; border:1px solid var(--accent); border-radius:6px; padding:8px 12px; white-space:nowrap; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:minmax(0,1fr);padding:16px;} .navlink{display:inline-block;margin-top:10px;} #restoreBanner{padding:10px 16px;} .toolbar{flex-direction:column;align-items:stretch;} .toolbar select,.toolbar input{width:100%;min-width:0;} }
  </style>
</head>
<body>
  <header><div><h1>墨锭试磨室</h1><div class="meta">墨锭建档、试磨记录和评分统计</div></div><div style="display:flex;gap:10px;align-items:center"><a class="navlink" href="/recovery">数据恢复台</a><button id="reload">刷新</button></div></header>
  <div id="restoreBanner"></div>
  <main>
    <section>
      <form id="createForm"><h2>新增墨锭</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><p style="margin-top:12px"><button>保存墨锭</button></p></form>
      <form id="actionForm" style="margin-top:14px"><h2>创建试磨记录</h2><label>选择墨锭</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><p style="margin-top:12px"><button>提交记录</button></p></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>选择墨锭后录入试磨记录，系统会保留多次试磨结果并更新评分状态。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","墨锭编号","text"],["smokeSource","烟料来源","text"],["glueRatio","胶料比例","text"],["ageYears","存放年限","number"],["storage","存放位置","text"]];
    const stages = ["待试磨","已试磨","重点观察"];
    const extraFields = [["paper","试磨纸张"],["water","加水量"],["speed","出墨速度"],["colorLayer","墨色层次"],["sediment","沉淀情况"],["score","评分"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const banner = document.querySelector('#restoreBanner');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.smokeSource || item.name || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { try { items = await api('/api/items'); render(); } catch(e){} pollRestore(); }
    async function pollRestore() {
      try {
        const st = await api('/api/recovery/status');
        if (st.restoreActive) { banner.style.display='block'; banner.textContent='⚠ 数据恢复进行中（'+st.restoreActive+'），所有写入已暂停'; }
        else banner.style.display='none';
      } catch {}
    }
    createForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); } catch(e){ alert(e.message); } };
    actionForm.onsubmit = async event => { event.preventDefault(); try { await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); } catch(e){ alert(e.message); } };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load(); setInterval(pollRestore, 3000);
  </script>
</body>
</html>`;
}

/* ---------------- 路由 ---------------- */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/") return html(res, page());
    if (req.method === "GET" && p === "/recovery") return html(res, recoveryPage());

    if (req.method === "GET" && p === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && p === "/api/items") {
      const input = await body(req);
      const item = await mutate(() => {
        const created = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建墨锭" }] };
        normalizeItem(created);
        db.items.unshift(created);
        return created;
      });
      return send(res, 201, item);
    }
    const patch = p.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const ref = decodeURIComponent(patch[1]);
      const input = await body(req);
      delete input.id;
      const item = await mutate(() => {
        const target = findItem(ref);
        if (!target) throw new RecoveryError(404, "item_not_found", "墨锭不存在");
        Object.assign(target, input);
        target.logs ||= [];
        if (input.status) target.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + target.status });
        return target;
      });
      return send(res, 200, item);
    }
    const logRoute = p.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (logRoute && req.method === "POST") {
      const ref = decodeURIComponent(logRoute[1]);
      const input = await body(req);
      const item = await mutate(() => {
        const target = findItem(ref);
        if (!target) throw new RecoveryError(404, "item_not_found", "墨锭不存在");
        target.logs ||= [];
        target.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
        return target;
      });
      return send(res, 201, item);
    }
    const action = p.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const ref = decodeURIComponent(action[1]);
      const input = await body(req);
      const item = await mutate(() => {
        const target = findItem(ref);
        if (!target) throw new RecoveryError(404, "item_not_found", "墨锭不存在");
        target.logs ||= [];
        const score = Number(input.score || 0);
        target.tests ||= [];
        target.tests.push({ at: new Date().toISOString(), ...input, score });
        target.status = score >= 85 ? "已试磨" : "重点观察";
        target.logs.push({ at: new Date().toISOString(), step: "试磨", note: (input.paper || "试纸") + "，评分" + score, score });
        return target;
      });
      return send(res, 201, item);
    }
    if (req.method === "GET" && p === "/api/stats") return send(res, 200, computeStats(db.items));

    /* ---- 数据恢复台 ---- */
    if (req.method === "GET" && p === "/api/recovery/status") {
      const [journals, pendingRollbacks] = await Promise.all([
        engine.listJournals(),
        engine.listPendingRollbacks(),
      ]);
      return send(res, 200, {
        restoreActive,
        journals: journals.slice(0, 10),
        pendingRollbacks,
      });
    }
    if (req.method === "GET" && p === "/api/recovery/overview") {
      const list = await engine.list();
      const pendingRollbacks = await engine.listPendingRollbacks();
      return send(res, 200, { ...list, restoreActive, pendingRollbacks });
    }
    if (req.method === "GET" && p === "/api/recovery/points") {
      const list = await engine.list();
      return send(res, 200, list);
    }
    if (req.method === "POST" && p === "/api/recovery/points") {
      await assertNotRestoring();
      const input = await body(req);
      // 同步抓取当前瞬间快照，随后建点期间业务可继续写
      const snapshot = JSON.parse(JSON.stringify(db.items));
      const result = await engine.createPoint({ kind: input.kind || "auto", note: input.note || "" }, snapshot);
      return send(res, 201, result);
    }
    if (req.method === "POST" && p === "/api/recovery/validate") {
      const report = await engine.inspect();
      return send(res, report.ok ? 200 : 409, report);
    }
    if (req.method === "GET" && p === "/api/recovery/config") {
      return send(res, 200, await engine.getConfig());
    }
    if (req.method === "PUT" && p === "/api/recovery/config") {
      await assertNotRestoring();
      const input = await body(req);
      const cfg = await engine.setConfig(input);
      const retained = await engine.applyRetention();
      return send(res, 200, { config: cfg, retained });
    }
    const pointRoute = p.match(/^\/api\/recovery\/points\/([^/]+)$/);
    if (pointRoute && req.method === "GET") {
      return send(res, 200, await engine.getPoint(decodeURIComponent(pointRoute[1])));
    }
    if (pointRoute && req.method === "DELETE") {
      await assertNotRestoring();
      return send(res, 200, await engine.deletePoint(decodeURIComponent(pointRoute[1])));
    }
    const pinRoute = p.match(/^\/api\/recovery\/points\/([^/]+)\/pin$/);
    if (pinRoute && req.method === "POST") {
      await assertNotRestoring();
      const input = await body(req);
      return send(res, 200, await engine.pin(decodeURIComponent(pinRoute[1]), input.note || ""));
    }
    if (pinRoute && req.method === "DELETE") {
      await assertNotRestoring();
      return send(res, 200, await engine.unpin(decodeURIComponent(pinRoute[1])));
    }
    const previewRoute = p.match(/^\/api\/recovery\/preview\/([^/]+)$/);
    if (previewRoute && req.method === "GET") {
      const current = JSON.parse(JSON.stringify(db.items));
      const result = await engine.preview(decodeURIComponent(previewRoute[1]), current);
      return send(res, 200, result);
    }
    if (req.method === "POST" && p === "/api/recovery/restore") {
      const input = await body(req);
      if (!input.pointId) throw new RecoveryError(400, "point_id_required", "缺少恢复点 ID");
      const restoreId = input.restoreId || randomUUID();
      engine.validateRestoreId(restoreId);
      const result = await performRestore(restoreId, input.pointId);
      return send(res, 200, result);
    }
    const journalRoute = p.match(/^\/api\/recovery\/restore\/([^/]+)$/);
    if (journalRoute && req.method === "GET") {
      const j = await engine.getJournal(decodeURIComponent(journalRoute[1]));
      if (!j) return send(res, 404, { error: "journal_not_found" });
      return send(res, 200, j);
    }
    const retryRollbackRoute = p.match(/^\/api\/recovery\/restore\/([^/]+)\/recover-rollback$/);
    if (retryRollbackRoute && req.method === "POST") {
      const rid = decodeURIComponent(retryRollbackRoute[1]);
      await assertNotRestoring();
      const result = await writeLock.run(() =>
        engine.recoverRollback(rid, {
          writeDb: async (content) => {
            if (recoverRollbackFault) throw new Error("注入的重试回滚写入故障");
            await persist(content);
            await loadDbFromDisk();
          },
        })
      );
      return send(res, 200, result);
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof RecoveryError) return send(res, error.status, { error: error.code, message: error.message, details: error.details });
    send(res, 500, { error: error.message });
  }
});

async function start() {
  await engine.cleanupTemp();
  await initStorage();
  // 启动时重演：上次在恢复中崩溃/中断 → 用备份回到恢复前状态；
  // 若回滚写入也失败（如磁盘未恢复），保留备份并标记 rollback_failed，磁盘恢复后可经重试端点找回
  const replay = await engine.replayJournals({
    writeDb: async (content) => {
      if (replayRollbackFault) throw new Error("注入的启动重演回滚故障");
      await persist(content);
      await loadDbFromDisk();
    },
  });
  for (const r of replay.recovered) console.log("[recovery] 中断恢复处理：", JSON.stringify(r));
  server.listen(port, () => console.log("墨锭试磨室 listening on http://localhost:" + port));
}

start();
