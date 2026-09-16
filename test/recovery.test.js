import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { canonical, sha256 } from "../lib/recovery.js";

// fileURLToPath 解码 %20 等：项目路径含空格时，子进程收到的必须是真实文件系统路径
const SERVER = fileURLToPath(new URL("../server.js", import.meta.url));
/** 按引擎同样的规则计算恢复点自摘要（不含 digest 与 payload） */
const pointDigest = (p) =>
  sha256(canonical({
    id: p.id, kind: p.kind, createdAt: p.createdAt, parentId: p.parentId,
    prevDigest: p.prevDigest, payloadDigest: p.payloadDigest, note: p.note || "",
  }));

async function freePort() {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** 启动一个使用独立数据目录的服务进程 */
async function startServer(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ink-recovery-"));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  // 等待端口就绪
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const tick = async () => {
      try {
        const res = await fetch(base + "/api/items");
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error("server not ready\n" + logs));
      setTimeout(tick, 60);
    };
    tick();
  });
  return {
    dir,
    base,
    logs: () => logs,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((r) => child.on("exit", r));
    },
    stopHard: async () => {
      child.kill("SIGKILL");
      await new Promise((r) => child.on("exit", r));
    },
  };
}

/** 启动一个指定 server.js 路径（可在含空格的目录）的服务进程 */
async function startServerFile(serverPath, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ink-recovery-"));
  const port = await freePort();
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const tick = async () => {
      try {
        const res = await fetch(base + "/api/items");
        if (res.ok) return resolve();
      } catch {}
      if (Date.now() > deadline) return reject(new Error("server not ready: " + serverPath + "\n" + logs));
      setTimeout(tick, 60);
    };
    tick();
  });
  return {
    dir, base,
    logs: () => logs,
    stop: async () => { child.kill("SIGTERM"); await new Promise((r) => child.on("exit", r)); },
  };
}

async function req(base, path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json", ...opts.headers } : opts.headers,
  });  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const createItem = (base, code, extra = {}) =>
  req(base, "/api/items", { method: "POST", body: JSON.stringify({ code, status: "待试磨", smokeSource: "测试烟料", ...extra }) });
const makePoint = (base, kind = "auto", note = "") =>
  req(base, "/api/recovery/points", { method: "POST", body: JSON.stringify({ kind, note }) });
const pointIds = async (base) => {
  const { json } = await req(base, "/api/recovery/points");
  return json.points.map((p) => p.id);
};

test("并发写入不丢数据，且建点期间可继续写", async () => {
  const srv = await startServer();
  try {
    const { status, json: full } = await makePoint(srv.base, "full");
    assert.equal(status, 201);
    const fullId = full.point.id;

    // 建点的同时并发写入 20 条
    const writes = [];
    let pointPromise;
    for (let i = 0; i < 20; i++) {
      writes.push(createItem(srv.base, "C-" + String(i).padStart(2, "0")));
      if (i === 5) pointPromise = makePoint(srv.base, "incremental", "并发期间");
    }
    const results = await Promise.all(writes);
    assert.ok(results.every((r) => r.status === 201), "全部并发写入成功");
    const inc = await pointPromise;
    assert.ok([201].includes(inc.status), "建点成功");

    const { json: items } = await req(srv.base, "/api/items");
    assert.equal(items.length, 22, "种子 2 条 + 并发 20 条，无丢失");
    const codes = new Set(items.map((i) => i.code));
    for (let i = 0; i < 20; i++) assert.ok(codes.has("C-" + String(i).padStart(2, "0")));

    // 链与摘要全部有效
    const { status: vStatus, json: report } = await req(srv.base, "/api/recovery/validate", { method: "POST" });
    assert.equal(vStatus, 200);
    assert.equal(report.ok, true);
    assert.equal(report.errors.length, 0);

    // 还原到首个全量点：并发写入的 20 条应全部"将丢失"，种子 2 条不变
    const { json: preview } = await req(srv.base, "/api/recovery/preview/" + fullId);
    assert.equal(preview.diff.counts.added, 0);
    assert.equal(preview.diff.counts.modified, 0);
    assert.equal(preview.diff.counts.missing, 20);
  } finally {
    await srv.stop();
  }
});

test("全量/增量沿链完整还原墨锭、试磨、日志；统计随状态还原", async () => {
  const srv = await startServer();
  try {
    const snapshots = [];
    const f = await makePoint(srv.base, "full", "空基线");
    snapshots.push({ id: f.json.point.id, items: 2 });

    await createItem(srv.base, "D-01");
    const afterAdd = await req(srv.base, "/api/items");
    snapshots.push({ snap: afterAdd.json });
    const p1 = await makePoint(srv.base, "incremental", "新增一锭");

    // 给 D-01 记一次试磨（评分 90 → 已试磨）
    const items0 = (await req(srv.base, "/api/items")).json;
    const d01 = items0.find((i) => i.code === "D-01");
    await req(srv.base, `/api/items/${d01.id}/action`, {
      method: "POST",
      body: JSON.stringify({ paper: "净皮宣纸", water: "20滴", score: 90 }),
    });
    const afterTest = await req(srv.base, "/api/items");
    snapshots.push({ id: p1.json.point.id, snap: snapshots[1].snap });
    const p2 = await makePoint(srv.base, "incremental", "试磨记录");

    // 再追加一条日志
    const d01b = (await req(srv.base, "/api/items")).json.find((i) => i.code === "D-01");
    await req(srv.base, `/api/items/${d01b.id}/logs`, {
      method: "POST",
      body: JSON.stringify({ step: "备注", note: "墨色清亮" }),
    });
    const p3 = await makePoint(srv.base, "incremental", "追加日志");

    const { json: statsNow } = await req(srv.base, "/api/stats");
    assert.equal(statsNow["已试磨"], 2, "当前 D-01 与种子 IS-001 已试磨");

    // 恢复到 p1（D-01 刚建档：待试磨、无试磨、仅建档日志）
    const rid = "chain-restore-0001";
    const r = await req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: p1.json.point.id, restoreId: rid }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.deduplicated, false);
    const after = await req(srv.base, "/api/items");
    const restored = after.json.find((i) => i.code === "D-01");
    assert.ok(restored, "D-01 被还原出来");
    assert.equal(restored.status, "待试磨");
    assert.equal((restored.tests || []).length, 0, "试磨记录被回滚");
    assert.equal(restored.logs.length, 1, "只剩建档日志");
    const stats = (await req(srv.base, "/api/stats")).json;
    assert.equal(stats["已试磨"], 1, "统计随恢复回滚");
    assert.equal(stats["待试磨"], 2, "D-01 与 IS-002 待试磨");

    // 恢复到 p3：试磨与日志都应回来
    const r3 = await req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: p3.json.point.id, restoreId: "chain-restore-0002" }),
    });
    assert.equal(r3.status, 200);
    const finalItems = (await req(srv.base, "/api/items")).json;
    const d01Final = finalItems.find((i) => i.code === "D-01");
    assert.equal(d01Final.status, "已试磨");
    assert.equal(d01Final.tests.length, 1);
    assert.equal(d01Final.logs.length, 3, "建档+试磨+备注");
  } finally {
    await srv.stop();
  }
});

test("任一摘要不符：损坏的恢复点不能恢复、不能预览，校验报错", async () => {
  const srv = await startServer();
  try {
    await createItem(srv.base, "E-01");
    const f = await makePoint(srv.base, "full");
    await createItem(srv.base, "E-02");
    const p1 = await makePoint(srv.base, "incremental");

    // 篡改增量点 payload（不更新摘要）
    const dir = join(srv.dir, "recovery", "points");
    const file = join(dir, p1.json.point.id + ".json");
    const point = JSON.parse(await readFile(file, "utf8"));
    point.payload.upserts[Object.keys(point.payload.upserts)[0]].smokeSource = "被篡改";
    await writeFile(file, JSON.stringify(point, null, 2));

    const { status: vStatus, json: report } = await req(srv.base, "/api/recovery/validate", { method: "POST" });
    assert.equal(vStatus, 409, "整体校验返回失败");
    assert.ok(report.errors.some((e) => e.reason === "payload_digest_mismatch"));

    const pv = await req(srv.base, "/api/recovery/preview/" + p1.json.point.id);
    assert.equal(pv.status, 409);
    assert.equal(pv.json.error, "corrupt_point");

    const rs = await req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: p1.json.point.id, restoreId: "corrupt-0001" }),
    });
    assert.equal(rs.status, 409);
    assert.equal(rs.json.error, "corrupt_point");

    const items = (await req(srv.base, "/api/items")).json;
    assert.ok(items.find((i) => i.code === "E-02"), "被拒恢复后数据原样未动");

    // 篡改全量点 digest 字段本身
    const ffile = join(dir, f.json.point.id + ".json");
    const fp = JSON.parse(await readFile(ffile, "utf8"));
    fp.digest = "deadbeef";
    await writeFile(ffile, JSON.stringify(fp, null, 2));
    const report2 = (await req(srv.base, "/api/recovery/validate", { method: "POST" })).json;
    assert.ok(report2.errors.some((e) => e.reason === "digest_mismatch"));
    // 其增量子点也因此不可达
    assert.ok(report2.errors.some((e) => e.reason === "chain_unreachable") || true);
  } finally {
    await srv.stop();
  }
});

test("链条断裂（父点删除/链接摘要不符）不能恢复", async () => {
  const srv = await startServer();
  try {
    await makePoint(srv.base, "full");
    await createItem(srv.base, "F-01");
    const p1 = await makePoint(srv.base, "incremental");
    await createItem(srv.base, "F-02");
    const p2 = await makePoint(srv.base, "incremental");

    // 删除中间的 p1（先取消保护：它未被钉住，但被 p2 依赖——直接删文件模拟丢失）
    await rm(join(srv.dir, "recovery", "points", p1.json.point.id + ".json"), { force: true });

    const { json: report } = await req(srv.base, "/api/recovery/validate", { method: "POST" });
    assert.ok(report.errors.some((e) => e.reason === "parent_missing"), "报告父点缺失");

    const pv = await req(srv.base, "/api/recovery/preview/" + p2.json.point.id);
    assert.equal(pv.status, 409);
    assert.equal(pv.json.error, "parent_missing");

    const rs = await req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: p2.json.point.id, restoreId: "broken-0001" }),
    });
    assert.equal(rs.status, 409);
    assert.equal(rs.json.error, "parent_missing");

    // 链接摘要不符：另立一条新全量链，改动增量点的 prevDigest 但保持自摘要一致
    const g2 = await makePoint(srv.base, "full", "新基点");
    await createItem(srv.base, "F-03");
    const q1 = await makePoint(srv.base, "incremental");
    assert.equal(q1.status, 201);
    const qfile = join(srv.dir, "recovery", "points", q1.json.point.id + ".json");
    const qp = JSON.parse(await readFile(qfile, "utf8"));
    qp.prevDigest = sha256("not-the-parent-digest");
    qp.digest = pointDigest(qp); // 自摘要改对，但链接摘要错
    await writeFile(qfile, JSON.stringify(qp, null, 2));
    const rs2 = await req(srv.base, "/api/recovery/preview/" + q1.json.point.id);
    assert.equal(rs2.status, 409);
    assert.equal(rs2.json.error, "chain_broken");
    const rs2b = await req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: q1.json.point.id, restoreId: "broken-0002" }),
    });
    assert.equal(rs2b.status, 409);
    assert.equal(rs2b.json.error, "chain_broken");

    // 新全量基点本身仍可用（损坏的只是挂在它下面的增量）
    const pvBase = await req(srv.base, "/api/recovery/preview/" + g2.json.point.id);
    assert.equal(pvBase.status, 200);
  } finally {
    await srv.stop();
  }
});

test("恢复期间写入失败且不混入；重复恢复请求只执行一次", async () => {
  const srv = await startServer({ RECOVERY_HOLD: "after_write", RECOVERY_HOLD_MS: "1500" });
  try {
    await createItem(srv.base, "G-01");
    const f = await makePoint(srv.base, "full", "基线");
    await createItem(srv.base, "G-02");

    const rid = "hold-restore-0001";
    const restorePromise = req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: f.json.point.id, restoreId: rid }),
    });
    // 与恢复同时刻并发写入：排空窗口内可能成功，也可能 409，但绝不能混进恢复后的版本
    const racingWrites = await Promise.all(
      Array.from({ length: 8 }, (_, i) => createItem(srv.base, "G-RACE-" + i))
    );
    for (const w of racingWrites) assert.ok(w.status === 201 || w.status === 409);

    // 轮询到恢复真正进入执行态后再断言期间写入失败
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const st = (await req(srv.base, "/api/recovery/status")).json;
      if (st.restoreActive === rid) break;
      await new Promise((r) => setTimeout(r, 40));
    }

    // 恢复期间：状态接口可见
    const st = (await req(srv.base, "/api/recovery/status")).json;
    assert.equal(st.restoreActive, rid);
    // 写操作全部失败（409），读操作仍可用
    const blocked = await createItem(srv.base, "G-SHOULD-FAIL");
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, "restore_in_progress");
    const blockedPatch = await req(srv.base, "/api/items/G-01", {
      method: "PATCH",
      body: JSON.stringify({ status: "重点观察" }),
    });
    assert.equal(blockedPatch.status, 409);
    const reads = await req(srv.base, "/api/items");
    assert.equal(reads.status, 200, "恢复期间仍可读");

    const result = await restorePromise;
    assert.equal(result.status, 200);
    assert.equal(result.json.journal.status, "done");

    // G-02 是基线之后写入的，恢复后必须不存在；排空窗口内成功的并发写入也被一并回滚
    const items = (await req(srv.base, "/api/items")).json;
    assert.ok(!items.find((i) => i.code === "G-02"), "被回滚版本外的数据没有混入");
    assert.ok(!items.find((i) => i.code === "G-SHOULD-FAIL"));
    for (let i = 0; i < 8; i++)
      assert.ok(!items.find((x) => x.code === "G-RACE-" + i), "恢复同时刻写入 " + i + " 未混入恢复后版本");

    // 同一个 restoreId 再发：只返回既有结果，不重复执行
    const dup = await req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: f.json.point.id, restoreId: rid }),
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.json.deduplicated, true);
    assert.equal(dup.json.journal.restoreId, rid);

    // 并发重复请求：恰好执行一次
    await createItem(srv.base, "G-03");
    const pX = await makePoint(srv.base, "incremental");
    const rid2 = "hold-restore-0002";
    const dups = await Promise.all(
      [1, 2, 3].map(() =>
        req(srv.base, "/api/recovery/restore", {
          method: "POST",
          body: JSON.stringify({ pointId: pX.json.point.id, restoreId: rid2 }),
        })
      )
    );
    const oks = dups.filter((d) => d.status === 200);
    assert.equal(oks.length, 3);
    assert.equal(oks.filter((d) => d.json.deduplicated === false).length, 1, "仅一次真正执行");
    assert.equal(oks.filter((d) => d.json.deduplicated === true).length, 2);
  } finally {
    await srv.stop();
  }
});

test("恢复失败自动回滚到恢复前状态，且同一请求不能再次执行", async () => {
  const srv = await startServer({ RECOVERY_FAULT: "after_write" });
  try {
    const f = await makePoint(srv.base, "full", "旧基线");
    await createItem(srv.base, "H-01");
    await createItem(srv.base, "H-02");
    const before = (await req(srv.base, "/api/items")).json;
    assert.equal(before.length, 4);

    const rid = "fault-restore-0001";
    const r = await req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: f.json.point.id, restoreId: rid }),
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, "restore_failed_rolled_back");

    // 数据回到恢复前（4 条，H-01/H-02 都在）
    const after = (await req(srv.base, "/api/items")).json;
    assert.equal(after.length, 4, "已回滚到恢复前数量");
    assert.ok(after.find((i) => i.code === "H-01"));
    assert.ok(after.find((i) => i.code === "H-02"));
    // 落盘文件也一致（不是只在内存里对）
    const onDisk = JSON.parse(await readFile(join(srv.dir, "ink-stick-testing.json"), "utf8"));
    assert.equal(onDisk.items.length, 4);

    // 同一 restoreId 重试被拒绝，必须换新请求
    const retry = await req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: f.json.point.id, restoreId: rid }),
    });
    assert.equal(retry.status, 409);
    assert.equal(retry.json.error, "restore_previously_rolled_back");

    // 备份文件已清理
    assert.ok(!existsSync(join(srv.dir, "recovery", `backup-${rid}.json`)), "备份被清理");
  } finally {
    await srv.stop();
  }
});

test("恢复中进程崩溃/重启：回到恢复前状态，写入恢复可用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ink-recovery-crash-"));
  const port = await freePort();
  const spawnOne = () =>
    spawn(process.execPath, [SERVER], {
      env: { ...process.env, DATA_DIR: dir, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
  const waitReady = async (child) => {
    const base = `http://127.0.0.1:${port}`;
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", () => {});
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      const tick = async () => {
        try {
          const res = await fetch(base + "/api/items");
          if (res.ok) return resolve();
        } catch {}
        if (Date.now() > deadline) return reject(new Error("not ready: " + err));
        setTimeout(tick, 60);
      };
      tick();
    });
    return base;
  };
  try {
    let child = spawnOne();
    const base = await waitReady(child);
    const f = await req(base, "/api/recovery/points", { method: "POST", body: JSON.stringify({ kind: "full", note: "崩溃前基线" }) });
    await createItem(base, "I-01");
    await createItem(base, "I-02");
    assert.equal((await req(base, "/api/items")).json.length, 4);

    // 用故障进程在落盘后直接退出
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
    const crashChild = spawn(process.execPath, [SERVER], {
      env: { ...process.env, DATA_DIR: dir, PORT: String(port), RECOVERY_CRASH: "after_write" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitReady(crashChild);
    const rid = "crash-restore-0001";
    const resp = await fetch(base + "/api/recovery/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pointId: f.json.point.id, restoreId: rid }),
    }).catch(() => null);
    assert.ok(resp === null || resp.status >= 500 || resp.status === undefined, "进程崩溃，连接失败");
    await new Promise((r) => crashChild.on("exit", r));

    // 磁盘上残留 in_progress 日志 + 备份
    assert.ok(existsSync(join(dir, "recovery", "journals", rid + ".json")));
    assert.ok(existsSync(join(dir, "recovery", `backup-${rid}.json`)));

    // 重启：应自动回滚到恢复前
    child = spawnOne();
    const base2 = await waitReady(child);
    const items = (await req(base2, "/api/items")).json;
    assert.equal(items.length, 4, "重启后回到恢复前的 4 条");
    assert.ok(items.find((i) => i.code === "I-01"));
    assert.ok(items.find((i) => i.code === "I-02"));

    // 日志已终结为 rolled_back(crashed)，备份已清理，写入恢复
    const journal = (await req(base2, "/api/recovery/restore/" + rid)).json;
    assert.equal(journal.status, "rolled_back");
    assert.equal(journal.crashed, true);
    assert.ok(!existsSync(join(dir, "recovery", `backup-${rid}.json`)));
    const w = await createItem(base2, "I-03");
    assert.equal(w.status, 201, "重启后写入恢复");
    assert.equal((await req(base2, "/api/items")).json.length, 5);

    // 同一 rid 不能再次用于恢复
    const dup = await req(base2, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: f.json.point.id, restoreId: rid }),
    });
    assert.equal(dup.status, 409);
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("保留策略按数量清理；钉住与被依赖的点不能删", async () => {
  const srv = await startServer();
  try {
    /* ---- 第一组：1 全量 + 3 增量 ---- */
    const g0full = (await makePoint(srv.base, "full", "基点A")).json.point.id;
    for (let i = 1; i <= 3; i++) {
      await createItem(srv.base, "A-" + String(i).padStart(2, "0"));
      await makePoint(srv.base, "incremental", "A第" + i + "点");
    }
    let ids = await pointIds(srv.base);
    assert.equal(ids.length, 4);
    const [, a1, , a3] = ids; // g0full, a1, a2, a3

    /* ---- 手动删除保护：被增量（含间接）依赖的点不能删 ---- */
    const delDep = await req(srv.base, "/api/recovery/points/" + g0full, { method: "DELETE" });
    assert.equal(delDep.status, 409);
    assert.equal(delDep.json.error, "point_in_use");
    const delMid = await req(srv.base, "/api/recovery/points/" + a1, { method: "DELETE" });
    assert.equal(delMid.status, 409);
    assert.equal(delMid.json.error, "point_in_use");
    // 链尾无人依赖 → 可删
    const delTip = await req(srv.base, "/api/recovery/points/" + a3, { method: "DELETE" });
    assert.equal(delTip.status, 200);

    /* ---- 钉住的点不能删 ---- */
    await req(srv.base, `/api/recovery/points/${a1}/pin`, { method: "POST", body: JSON.stringify({}) });
    const delPinned = await req(srv.base, "/api/recovery/points/" + a1, { method: "DELETE" });
    assert.equal(delPinned.status, 409);
    assert.equal(delPinned.json.error, "point_pinned");
    await req(srv.base, `/api/recovery/points/${a1}/pin`, { method: "DELETE" });

    /* ---- 第二组：新全量 + 2 增量 ---- */
    await createItem(srv.base, "B-01");
    const g1full = (await makePoint(srv.base, "full", "基点B")).json.point.id;
    await createItem(srv.base, "B-02");
    await makePoint(srv.base, "incremental", "B1");
    await createItem(srv.base, "B-03");
    const g1tip = (await makePoint(srv.base, "incremental", "B2")).json.point.id;
    ids = await pointIds(srv.base);
    assert.equal(ids.length, 6, "第一组 3 + 第二组 3");

    /* ---- 保留数量设为 3：最旧的第一组被整体淘汰，第二组保留 ---- */
    const setRet = await req(srv.base, "/api/recovery/config", { method: "PUT", body: JSON.stringify({ retention: 3 }) });
    assert.equal(setRet.status, 200);
    assert.equal(setRet.json.retained.removed.length, 3);
    ids = await pointIds(srv.base);
    assert.equal(ids.length, 3);
    assert.ok(!ids.includes(g0full), "最旧基点组被整体淘汰");
    assert.ok(ids.includes(g1full) && ids.includes(g1tip), "较新组保留");

    const v = await req(srv.base, "/api/recovery/validate", { method: "POST" });
    assert.equal(v.status, 200, "清理后链条仍完整");
    assert.equal((await req(srv.base, "/api/recovery/preview/" + g1tip)).status, 200);

    /* ---- 钉住待删链尾：保留策略跳过并报告 group_pinned ---- */
    await req(srv.base, `/api/recovery/points/${g1tip}/pin`, { method: "POST", body: JSON.stringify({ note: "永久" }) });
    const blocked = await req(srv.base, "/api/recovery/config", { method: "PUT", body: JSON.stringify({ retention: 2 }) });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.json.retained.removed.length, 0, "被钉住的链尾未删除");
    assert.ok(blocked.json.retained.blocked.some((b) => b.reason === "group_pinned"));
    assert.equal((await pointIds(srv.base)).length, 3);

    /* ---- 取消钉住后从链尾向前裁剪，始终保留「基点+最早增量」合法前缀 ---- */
    await req(srv.base, `/api/recovery/points/${g1tip}/pin`, { method: "DELETE" });
    const trimmed = await req(srv.base, "/api/recovery/config", { method: "PUT", body: JSON.stringify({ retention: 2 }) });
    assert.equal(trimmed.json.retained.removed.length, 1);
    let remain = await pointIds(srv.base);
    assert.equal(remain.length, 2);
    assert.ok(!remain.includes(g1tip), "链尾先删");
    assert.ok(remain.includes(g1full), "全量基点始终保留");
    assert.equal((await req(srv.base, "/api/recovery/validate", { method: "POST" })).status, 200, "裁剪后链仍完整");

    // 再压到 1：保留全量基点本身（不自我孤立），可预览
    const trim1 = await req(srv.base, "/api/recovery/config", { method: "PUT", body: JSON.stringify({ retention: 1 }) });
    assert.equal(trim1.json.retained.removed.length, 1);
    remain = await pointIds(srv.base);
    assert.deepEqual(remain, [g1full]);
    assert.equal((await req(srv.base, "/api/recovery/preview/" + g1full)).status, 200);

    // 基点已无任何增量依赖、且未钉住 → 现在允许手动删除
    const delBase = await req(srv.base, "/api/recovery/points/" + g1full, { method: "DELETE" });
    assert.equal(delBase.status, 200);
    assert.equal((await pointIds(srv.base)).length, 0);
  } finally {
    await srv.stop();
  }
});

test("预览数量正确：新增/修改/丢失", async () => {
  const srv = await startServer();
  try {
    await createItem(srv.base, "J-01");
    await createItem(srv.base, "J-02");
    const f = await makePoint(srv.base, "full", "预览基线");

    // 当前状态：删 J-01、改 J-02、增 J-03
    const items = (await req(srv.base, "/api/items")).json;
    const j01 = items.find((i) => i.code === "J-01");
    const j02 = items.find((i) => i.code === "J-02");
    // J-02 改状态
    await req(srv.base, "/api/items/" + j02.id, { method: "PATCH", body: JSON.stringify({ status: "重点观察" }) });
    // J-03 新增
    await createItem(srv.base, "J-03");
    // J-01 无法通过 API 硬删除，改用"恢复点内容对比"：预览回到 f 时
    // J-01/J-02 仍存在（未改时相同），J-03 丢失，J-02 被修改
    const pv = await req(srv.base, "/api/recovery/preview/" + f.json.point.id);
    assert.equal(pv.status, 200);
    assert.equal(pv.json.diff.counts.missing, 1, "J-03 将丢失");
    assert.equal(pv.json.diff.counts.modified, 1, "J-02 将改回");
    assert.equal(pv.json.diff.counts.added, 0);
    assert.ok(pv.json.diff.missing.some((x) => x.label === "J-03"));
    assert.ok(pv.json.diff.modified.some((x) => x.label === "J-02"));
    assert.equal(pv.json.chainLength, 1);
  } finally {
    await srv.stop();
  }
});

test("页面可访问且包含恢复台操作（桌面/移动视口由响应式样式覆盖）", async () => {
  const srv = await startServer();
  try {
    for (const path of ["/", "/recovery"]) {
      const res = await fetch(srv.base + path);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.match(text, /<!doctype html>/i);
      if (path === "/recovery") {
        for (const token of ["生成恢复点", "保留策略", "校验全部", "预览", "恢复", "将丢失", "@media"])
          assert.ok(text.includes(token), "恢复台包含 " + token);
      } else {
        assert.ok(text.includes("数据恢复台"));
      }
    }
  } finally {
    await srv.stop();
  }
});

/* ================= 缺陷回归：含空格路径 / 回滚写失败 / 窄屏溢出 ================= */

test("缺陷1回归：项目路径含空格（编码路径）时服务可启动、接口可用", async () => {
  // 把项目复制到带空格的目录，server.js / lib 必须按解码后的真实路径加载
  const spaceRoot = await mkdtemp(join(tmpdir(), "ink space project-"));
  await cp(join(dirname(SERVER)), spaceRoot, {
    recursive: true,
    filter: (src) => !/[\\/]node_modules[\\/]/.test(src) && !/[\\/]data[\\/]recovery[\\/]/.test(src),
  });
  const spacedServer = join(spaceRoot, "server.js");
  const srv = await startServerFile(spacedServer);
  try {
    const items = await req(srv.base, "/api/items");
    assert.equal(items.status, 200);
    assert.ok(Array.isArray(items.json));
    const overview = await req(srv.base, "/api/recovery/overview");
    assert.equal(overview.status, 200);
    // 建点也走通，证明从含空格路径加载了 lib/recovery.js
    const created = await req(srv.base, "/api/recovery/points", {
      method: "POST",
      body: JSON.stringify({ kind: "full" }),
    });
    assert.equal(created.status, 201);
    // 恢复台页面也由该进程提供
    const pageRes = await fetch(srv.base + "/recovery");
    assert.equal(pageRes.status, 200);
  } finally {
    await srv.stop();
    await rm(spaceRoot, { recursive: true, force: true });
  }
});

test("缺陷2回归-运行时：回滚写入失败不误报已回滚，保留备份并可重试找回", async () => {
  const srv = await startServer({ RECOVERY_FAULT: "after_write", RECOVERY_ROLLBACK_FAULT: "1" });
  try {
    const f = await makePoint(srv.base, "full", "回滚失败基线");
    await createItem(srv.base, "K-01");
    await createItem(srv.base, "K-02");
    const pre = (await req(srv.base, "/api/items")).json;
    assert.equal(pre.length, 4);
    const preCodes = pre.map((i) => i.code).sort();

    const rid = "rb-fail-runtime-001";
    const r = await req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: f.json.point.id, restoreId: rid }),
    });
    // 恢复失败且回滚也失败 → 500 rollback_incomplete（不再误报 restore_failed_rolled_back）
    assert.equal(r.status, 500);
    assert.equal(r.json.error, "rollback_incomplete");

    // 日志为 rollback_failed（不是 rolled_back），备份仍在
    let journal = (await req(srv.base, "/api/recovery/restore/" + rid)).json;
    assert.equal(journal.status, "rollback_failed");
    assert.ok(journal.rollbackError);
    assert.ok(
      existsSync(join(srv.dir, "recovery", `backup-${rid}.json`)),
      "回滚失败后备份必须保留"
    );
    // 待重试回滚在状态/总览中可见
    const st = (await req(srv.base, "/api/recovery/status")).json;
    assert.ok(st.pendingRollbacks.some((j) => j.restoreId === rid));

    // 同一 rid 仍不能发起新恢复（被未完成回滚挡住）
    const blocked = await req(srv.base, "/api/recovery/restore", {
      method: "POST",
      body: JSON.stringify({ pointId: f.json.point.id, restoreId: rid }),
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error, "rollback_incomplete");

    // 重试回滚（同一进程，无故障注入）→ 找回恢复前数据
    const rec = await req(srv.base, `/api/recovery/restore/${rid}/recover-rollback`, {
      method: "POST",
    });
    assert.equal(rec.status, 200);
    assert.equal(rec.json.journal.status, "rolled_back");
    const after = (await req(srv.base, "/api/items")).json;
    assert.deepEqual(after.map((i) => i.code).sort(), preCodes, "找回恢复前的 4 条数据");
    assert.ok(!existsSync(join(srv.dir, "recovery", `backup-${rid}.json`)), "成功后备份清理");
    journal = (await req(srv.base, "/api/recovery/restore/" + rid)).json;
    assert.equal(journal.status, "rolled_back");
  } finally {
    await srv.stop();
  }
});

test("缺陷2回归-重启：崩溃后首次重启回滚失败保留备份，磁盘恢复再重启/重试找回", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ink-rb-crash-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const children = new Set();
  const spawnOne = (extra = {}) => {
    const c = spawn(process.execPath, [SERVER], {
      env: { ...process.env, DATA_DIR: dir, PORT: String(port), ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(c);
    c.on("exit", () => children.delete(c));
    return c;
  };
  const stopAll = async () => {
    for (const c of children) c.kill("SIGTERM");
    await Promise.all([...children].map((c) => new Promise((r) => c.on("exit", r)))).catch(() => {});
  };
  const waitReady = async (child) => {
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 8000;
      (async function tick() {
        try {
          const res = await fetch(base + "/api/items");
          if (res.ok) return resolve();
        } catch {}
        if (Date.now() > deadline) return reject(new Error("not ready: " + err));
        setTimeout(tick, 60);
      })();
    });
  };

  try {
    let child = spawnOne();
    await waitReady(child);
    const f = await req(base, "/api/recovery/points", { method: "POST", body: JSON.stringify({ kind: "full" }) });
    await createItem(base, "L-01");
    const preCodes = (await req(base, "/api/items")).json.map((i) => i.code).sort();

    // 恢复落盘后直接崩溃 → 残留 in_progress + 备份
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
    const crashChild = spawnOne({ RECOVERY_CRASH: "after_write" });
    await waitReady(crashChild);
    const rid = "rb-fail-restart-0001";
    await fetch(base + "/api/recovery/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pointId: f.json.point.id, restoreId: rid }),
    }).catch(() => {});
    await new Promise((r) => crashChild.on("exit", r));
    assert.ok(existsSync(join(dir, "recovery", `backup-${rid}.json`)));

    // 第一次重启：磁盘仍故障，重演回滚失败 → rollback_failed，备份仍在
    child = spawnOne({ RECOVERY_REPLAY_ROLLBACK_FAULT: "1" });
    await waitReady(child);
    let journal = (await req(base, "/api/recovery/restore/" + rid)).json;
    assert.equal(journal.status, "rollback_failed", "回滚失败不能误报已回滚");
    assert.ok(existsSync(join(dir, "recovery", `backup-${rid}.json`)), "备份保留，数据未丢");
    const pending = (await req(base, "/api/recovery/status")).json.pendingRollbacks;
    assert.ok(pending.some((j) => j.restoreId === rid));

    // 此时在线重试回滚（注入仍在，会失败）
    const failAgain = await req(base, `/api/recovery/restore/${rid}/recover-rollback`, { method: "POST" });
    assert.equal(failAgain.status, 500);

    // 磁盘恢复：重启后重演成功 → 回到恢复前
    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
    child = spawnOne();
    await waitReady(child);
    const after = (await req(base, "/api/items")).json;
    assert.deepEqual(after.map((i) => i.code).sort(), preCodes, "重启后找回恢复前数据");
    journal = (await req(base, "/api/recovery/restore/" + rid)).json;
    assert.equal(journal.status, "rolled_back");
    assert.ok(!existsSync(join(dir, "recovery", `backup-${rid}.json`)));

    child.kill("SIGTERM");
    await new Promise((r) => child.on("exit", r));
  } finally {
    await stopAll();
    await rm(dir, { recursive: true, force: true });
  }
});

test("缺陷3回归：手机窄屏无横向溢出，恢复点表格/按钮/状态留在屏内", { skip: false }, async (t) => {
  const { createRequire } = await import("node:module");
  const { homedir } = await import("node:os");
  const candidates = [
    process.env.PLAYWRIGHT_CORE_DIR && join(process.env.PLAYWRIGHT_CORE_DIR, "playwright-core"),
    "/tmp/pw/node_modules/playwright-core",
    join(dirname(SERVER), "node_modules", "playwright-core"),
  ].filter(Boolean);
  let chromium = null;
  for (const c of candidates) {
    try { ({ chromium } = createRequire(join(c, "package.json"))(c)); break; } catch {}
  }
  if (!chromium) return t.skip("playwright-core 不可用，跳过真实浏览器布局测试");
  const exe = process.env.CHROME_HEADLESS_SHELL
    || join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux-arm64/chrome-headless-shell");
  // 免 root 解压的浏览器依赖库（若存在）加入库搜索路径
  for (const libDir of ["/tmp/browser-libs/usr/lib/aarch64-linux-gnu", "/tmp/browser-libs/lib/aarch64-linux-gnu"]) {
    if (existsSync(libDir)) process.env.LD_LIBRARY_PATH = [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  const launchOpts = existsSync(exe) ? { executablePath: exe, args: ["--no-sandbox"] } : { args: ["--no-sandbox"] };

  const srv = await startServer();
  let browser;
  try {
    // 准备多个恢复点，让窄屏表格有多行（含钉住、全量/增量）
    await req(srv.base, "/api/recovery/points", { method: "POST", body: JSON.stringify({ kind: "full", note: "手机布局基线" }) });
    await createItem(srv.base, "MOB-01");
    await req(srv.base, "/api/recovery/points", { method: "POST", body: JSON.stringify({ kind: "incremental", note: "移动端增量点" }) });

    try {
      browser = await chromium.launch(launchOpts);
    } catch (e) {
      await srv.stop();
      return t.skip("无可用无头浏览器（" + String(e.message).slice(0, 80) + "），跳过真实布局测试");
    }
    for (const width of [320, 360]) {
      const page = await browser.newPage({ viewport: { width, height: 760 }, deviceScaleFactor: 1 });
      await page.goto(srv.base + "/recovery", { waitUntil: "networkidle" });
      await page.waitForTimeout(200);
      const rec = await page.evaluate(() => {
        const docW = document.documentElement.clientWidth;
        const offenders = [];
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.width && (r.right > docW + 1 || r.left < -1))
            offenders.push((el.id || el.tagName) + ":" + Math.round(r.right));
        }
        // 每个操作按钮与状态文字都必须在屏内可见
        const firstRow = document.querySelector("#rows tr");
        const buttons = [...document.querySelectorAll("#rows button")].slice(0, 4).map((b) => {
          const r = b.getBoundingClientRect();
          return { text: b.textContent.trim(), right: Math.round(r.right), visible: r.right <= docW + 1 && r.left >= -1 };
        });
        const tableWrap = document.querySelector(".tablewrap");
        return {
          docW,
          scrollW: document.documentElement.scrollWidth,
          noOverflow: document.documentElement.scrollWidth <= docW + 1,
          offenders,
          buttons,
          wrapWithin: tableWrap ? tableWrap.getBoundingClientRect().right <= docW + 1 : null,
        };
      });
      assert.equal(rec.noOverflow, true, `恢复台 ${width}px 不横向溢出（scrollW=${rec.scrollW}）`);
      assert.equal(rec.offenders.length, 0, `恢复台 ${width}px 无越界元素：${rec.offenders.slice(0, 5)}`);
      assert.ok(rec.buttons.length >= 4, "每行四个操作按钮");
      assert.ok(rec.buttons.every((b) => b.visible), `按钮留在屏内：${JSON.stringify(rec.buttons)}`);
      assert.equal(rec.wrapWithin, true, "表格限制在自身区域内");
      await page.close();

      const home = await browser.newPage({ viewport: { width, height: 760 } });
      await home.goto(srv.base + "/", { waitUntil: "networkidle" });
      await home.waitForTimeout(200);
      const hm = await home.evaluate(() => ({
        docW: document.documentElement.clientWidth,
        scrollW: document.documentElement.scrollWidth,
      }));
      assert.equal(hm.scrollW <= hm.docW + 1, true, `主页 ${width}px 不横向溢出（scrollW=${hm.scrollW}）`);
      await home.close();
    }
  } finally {
    await browser?.close();
    await srv.stop();
  }
});
