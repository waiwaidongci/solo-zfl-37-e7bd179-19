import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  opendir,
  readdir,
  rm,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";

const DEFAULT_RETENTION = 10;
const FULL = "full";
const INCREMENTAL = "incremental";

export { atomicWrite };

export class RecoveryError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* ------------------------- 基础工具 ------------------------- */

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 规范化序列化：对象键排序，保证摘要与内容比较不受键序影响 */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return (
    "{" +
    keys
      .filter((k) => value[k] !== undefined)
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
      .join(",") +
    "}"
  );
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/** 墨锭稳定键：优先 id，其次编号 code（兼容历史数据） */
export function keyFor(item) {
  return String(item.id ?? item.code);
}

export function itemLabel(item) {
  return item.code || item.id;
}

async function atomicWrite(file, data) {
  if (typeof data !== "string") data = JSON.stringify(data, null, 2);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${counter++}-${randomUUID().slice(0, 8)}`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  try {
    const dir = await opendir(dirname(file));
    try {
      if (typeof dir.sync === "function") await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    /* 目录 fsync 失败不影响正确性 */
  }
}
let counter = 0;
let pointSeq = 0;

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** 简单异步互斥（不可重入；内部方法用下划线版本避免自锁） */
class Mutex {
  constructor() {
    this.queue = Promise.resolve();
  }
  run(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }
}

/* ------------------------- 恢复引擎 ------------------------- */

export class RecoveryEngine {
  /**
   * @param {object} opts
   * @param {string} opts.dir 恢复点目录
   * @param {() => string} [opts.now] 时间戳生成（测试可注入）
   * @param {() => string} [opts.rid] 恢复请求 ID 生成
   */
  constructor({ dir, now, rid } = {}) {
    this.dir = dir;
    this.pointsDir = join(dir, "points");
    this.journalsDir = join(dir, "journals");
    this.pinsFile = join(dir, "pins.json");
    this.configFile = join(dir, "config.json");
    this._now = now || (() => new Date().toISOString());
    this._rid = rid || (() => randomUUID());
    this.mutex = new Mutex();
  }

  now() {
    return this._now();
  }

  pointFile(id) {
    return join(this.pointsDir, `${id}.json`);
  }
  journalFile(restoreId) {
    return join(this.journalsDir, `${restoreId}.json`);
  }
  backupFile(restoreId) {
    return join(this.dir, `backup-${restoreId}.json`);
  }

  /* ---------- 配置 / 钉住 ---------- */

  async getConfig() {
    const cfg = await readJson(this.configFile, {});
    const retention = Math.max(1, Number(cfg.retention) || DEFAULT_RETENTION);
    return { retention };
  }

  async setConfig(input = {}) {
    return this.mutex.run(async () => {
      const retention = Number(input.retention);
      if (!Number.isInteger(retention) || retention < 1)
        throw new RecoveryError(400, "bad_retention", "保留数量必须是不小于 1 的整数");
      const cfg = { retention };
      await atomicWrite(this.configFile, JSON.stringify(cfg, null, 2));
      return cfg;
    });
  }

  async _getPins() {
    const pins = await readJson(this.pinsFile, {});
    return pins && typeof pins === "object" ? pins : {};
  }

  async _savePins(pins) {
    await atomicWrite(this.pinsFile, JSON.stringify(pins, null, 2));
  }

  async pin(id, note) {
    return this.mutex.run(async () => {
      const points = await this._readAll();
      if (!points.some((p) => p.point.id === id))
        throw new RecoveryError(404, "point_not_found", "恢复点不存在");
      const pins = await this._getPins();
      pins[id] = { at: this.now(), note: note || "" };
      await this._savePins(pins);
      return { id, pinned: true };
    });
  }

  async unpin(id) {
    return this.mutex.run(async () => {
      const pins = await this._getPins();
      if (!pins[id]) return { id, pinned: false };
      delete pins[id];
      await this._savePins(pins);
      return { id, pinned: false };
    });
  }

  /* ---------- 摘要与校验 ---------- */

  _headerOf(p) {
    return {
      id: p.id,
      kind: p.kind,
      createdAt: p.createdAt,
      parentId: p.parentId,
      prevDigest: p.prevDigest,
      payloadDigest: p.payloadDigest,
      note: p.note || "",
    };
  }

  _digestOf(point) {
    return sha256(canonical(this._headerOf(point)));
  }

  _payloadDigestOf(payload) {
    return sha256(canonical(payload || {}));
  }

  /** 校验单个恢复点自身的摘要，返回错误列表 */
  _checkPoint(p) {
    const errors = [];
    if (!p || typeof p !== "object" || !p.id) {
      errors.push({ pointId: null, reason: "malformed_point" });
      return errors;
    }
    if (p.kind !== FULL && p.kind !== INCREMENTAL)
      errors.push({ pointId: p.id, reason: "bad_kind" });
    if (this._payloadDigestOf(p.payload) !== p.payloadDigest)
      errors.push({ pointId: p.id, reason: "payload_digest_mismatch" });
    if (this._digestOf(p) !== p.digest)
      errors.push({ pointId: p.id, reason: "digest_mismatch" });
    if (p.kind === FULL) {
      if (p.parentId !== null || p.prevDigest !== null)
        errors.push({ pointId: p.id, reason: "full_must_be_root" });
      if (!p.payload || !Array.isArray(p.payload.items))
        errors.push({ pointId: p.id, reason: "bad_full_payload" });
    } else if (p.kind === INCREMENTAL) {
      if (!p.parentId || !p.prevDigest)
        errors.push({ pointId: p.id, reason: "incremental_must_have_parent" });
      if (!p.payload || typeof p.payload.upserts !== "object" || !Array.isArray(p.payload.deletes))
        errors.push({ pointId: p.id, reason: "bad_incremental_payload" });
    }
    return errors;
  }

  async _readAll() {
    await mkdir(this.pointsDir, { recursive: true });
    const files = (await readdir(this.pointsDir)).filter(
      (f) => f.startsWith("RP-") && f.endsWith(".json")
    );
    const out = [];
    for (const f of files) {
      const id = basename(f, ".json");
      let point = null;
      let readError = null;
      try {
        point = JSON.parse(await readFile(join(this.pointsDir, f), "utf8"));
      } catch (e) {
        readError = e.message;
      }
      out.push({ id, point, file: f, readError });
    }
    out.sort((a, b) => {
      const ta = a.point?.createdAt || "";
      const tb = b.point?.createdAt || "";
      return ta < tb ? -1 : ta > tb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return out;
  }

  /**
   * 全量校验：自摘要 + 链接摘要 + 可达性（链条完整）。
   * 任何摘要不符或链条断裂都会被标记。
   */
  async inspect() {
    return this.mutex.run(() => this._inspect());
  }

  async _inspect() {
    const raw = await this._readAll();
    const pins = await this._getPins();
    const byId = new Map();
    const errors = [];
    for (const entry of raw) {
      const id = entry.point ? entry.point.id : entry.id;
      if (entry.readError || !entry.point) {
        errors.push({ pointId: id, reason: "unreadable", detail: entry.readError });
        byId.set(id, { entry, selfErrors: [{ reason: "unreadable" }] });
        continue;
      }
      const selfErrors = this._checkPoint(entry.point);
      for (const e of selfErrors) errors.push(e);
      byId.set(id, { entry, selfErrors });
    }

    const reachable = new Map(); // id -> { ok, rootId }
    const summaries = [];
    for (const entry0 of raw) {
      const p = entry0.point;
      const id = p ? p.id : entry0.id;
      let ok = false;
      let rootId = null;
      let chainError = null;
      const rec = byId.get(id);
      if (p && (!rec || rec.selfErrors.length === 0)) {
        if (p.kind === FULL) {
          ok = true;
          rootId = p.id;
        } else {
          const parent = byId.get(p.parentId);
          if (!parent || !parent.entry.point) {
            chainError = { pointId: id, reason: "parent_missing" };
          } else {
            const pr = reachable.get(p.parentId);
            if (parent.entry.point.digest !== p.prevDigest) {
              chainError = { pointId: id, reason: "chain_broken", detail: "prevDigest 与父恢复点摘要不符" };
            } else if (!pr || !pr.ok) {
              chainError = { pointId: id, reason: "chain_unreachable" };
            } else {
              ok = true;
              rootId = pr.rootId;
            }
          }
          if (chainError) errors.push(chainError);
        }
      }
      reachable.set(id, { ok, rootId });

      summaries.push({
        id,
        kind: p?.kind || null,
        createdAt: p?.createdAt || null,
        parentId: p?.parentId ?? null,
        note: p?.note || "",
        pinned: Boolean(pins[id]),
        reachable: ok,
        rootId,
        selfValid: Boolean(p && rec && rec.selfErrors.length === 0),
        itemCount:
          p?.kind === FULL
            ? p.payload.items.length
            : p?.kind === INCREMENTAL
              ? Object.keys(p.payload.upserts).length -
                p.payload.deletes.filter((k) => !(k in p.payload.upserts)).length
              : null,
        upserts: p?.kind === INCREMENTAL ? Object.keys(p.payload.upserts).length : null,
        deletes: p?.kind === INCREMENTAL ? p.payload.deletes.length : null,
      });
    }
    return {
      ok: errors.length === 0,
      errors,
      points: summaries,
      config: await this.getConfig(),
    };
  }

  async list() {
    return this.mutex.run(async () => {
      const report = await this._inspect();
      return { points: report.points, errors: report.errors, config: report.config };
    });
  }

  async getPoint(id) {
    return this.mutex.run(async () => {
      const raw = await this._readAll();
      const found = raw.find((r) => r.point?.id === id || r.id === id);
      if (!found) throw new RecoveryError(404, "point_not_found", "恢复点不存在");
      const pins = await this._getPins();
      return { point: found.point, pinned: Boolean(pins[id]) };
    });
  }

  /* ---------- 链式重建 ---------- */

  /**
   * 沿链从根全量点还原目标点的全部墨锭。
   * 过程中再次核对每一环的摘要；任一环不符即抛错，拒绝还原。
   * 返回 { items, chain: [id...root..target] }
   */
  async rebuild(targetId) {
    return this.mutex.run(() => this._rebuild(targetId));
  }

  async _rebuild(targetId) {
    const raw = await this._readAll();
    const byId = new Map(raw.map((r) => [r.point ? r.point.id : r.id, r]));
    const target = byId.get(targetId);
    if (!target) throw new RecoveryError(404, "point_not_found", "恢复点不存在");

    // 从目标回溯到根
    const chainRev = [];
    let cursor = target;
    const guard = new Set();
    while (cursor) {
      const p = cursor.point;
      if (!p)
        throw new RecoveryError(409, "point_unreadable", "恢复点文件无法读取，链条断裂", {
          pointId: cursor.id,
        });
      if (guard.has(p.id))
        throw new RecoveryError(409, "chain_cycle", "恢复点链出现环", { pointId: p.id });
      guard.add(p.id);
      const selfErrors = this._checkPoint(p);
      if (selfErrors.length)
        throw new RecoveryError(409, "corrupt_point", "恢复点摘要校验失败，拒绝恢复", {
          errors: selfErrors,
        });
      chainRev.push(p);
      if (p.kind === FULL) break;
      const parent = byId.get(p.parentId);
      if (!parent || !parent.point)
        throw new RecoveryError(409, "parent_missing", "父恢复点缺失，链条断裂", {
          pointId: p.id,
        });
      if (parent.point.digest !== p.prevDigest)
        throw new RecoveryError(409, "chain_broken", "链接摘要不符，链条断裂", {
          pointId: p.id,
        });
      cursor = parent;
    }
    if (chainRev[chainRev.length - 1].kind !== FULL)
      throw new RecoveryError(409, "no_full_base", "链条缺少全量基点，无法还原");

    const chain = chainRev.reverse();
    const root = chain[0];
    const order = root.payload.items.map(keyFor);
    const map = new Map(root.payload.items.map((item) => [keyFor(item), clone(item)]));

    for (const p of chain.slice(1)) {
      for (const key of p.payload.deletes) {
        if (map.delete(key)) {
          const idx = order.indexOf(key);
          if (idx >= 0) order.splice(idx, 1);
        }
      }
      for (const [key, value] of Object.entries(p.payload.upserts)) {
        if (!map.has(key)) order.push(key);
        map.set(key, clone(value));
      }
    }
    return { items: order.map((k) => map.get(k)), chain: chain.map((p) => p.id) };
  }

  /* ---------- 预览差异 ---------- */

  /**
   * 对比还原结果与当前数据：新增 / 修改 / 丢失（当前有、目标里没有）。
   */
  diff(targetItems, currentItems) {
    const targetMap = new Map(targetItems.map((item) => [keyFor(item), item]));
    const currentMap = new Map(currentItems.map((item) => [keyFor(item), item]));
    const added = [];
    const modified = [];
    const missing = [];
    for (const [key, item] of targetMap) {
      const cur = currentMap.get(key);
      if (!cur) added.push({ key, label: itemLabel(item) });
      else if (canonical(cur) !== canonical(item))
        modified.push({ key, label: itemLabel(item) });
    }
    for (const [key, item] of currentMap) {
      if (!targetMap.has(key)) missing.push({ key, label: itemLabel(item) });
    }
    const countLogsTests = (items) => {
      let logs = 0;
      let tests = 0;
      for (const item of items) {
        logs += (item.logs || []).length;
        tests += (item.tests || []).length;
      }
      return { logs, tests };
    };
    return {
      added,
      modified,
      missing,
      counts: {
        added: added.length,
        modified: modified.length,
        missing: missing.length,
      },
      targetTotals: {
        items: targetItems.length,
        ...countLogsTests(targetItems),
      },
      currentTotals: {
        items: currentItems.length,
        ...countLogsTests(currentItems),
      },
    };
  }

  async preview(targetId, currentItems) {
    return this.mutex.run(async () => {
      const { items, chain } = await this._rebuild(targetId);
      const diff = this.diff(items, currentItems || []);
      const pins = await this._getPins();
      return {
        point: { id: targetId, pinned: Boolean(pins[targetId]) },
        chainLength: chain.length,
        chain,
        diff,
      };
    });
  }

  /* ---------- 创建恢复点 ---------- */

  async createPoint(input = {}, currentItems) {
    return this.mutex.run(() => this._createPoint(input, currentItems));
  }

  async _createPoint(input, currentItems) {
    const kindWanted = input.kind || "auto";
    if (!["full", "incremental", "auto"].includes(kindWanted))
      throw new RecoveryError(400, "bad_kind", "恢复点类型必须是 full、incremental 或 auto");
    const items = clone(currentItems) || [];

    const report = await this._inspect();
    // 增量只能挂在「最新的、自身有效且沿链可达」的点上；损坏链末端的点不能作为父点
    const healthy = report.points.filter(
      (p) => p.selfValid && (p.kind === FULL || p.reachable)
    );
    const tip = healthy.length ? healthy[healthy.length - 1] : null;

    let kind = kindWanted;
    if (kind === "auto") kind = tip ? INCREMENTAL : FULL;
    if (kind === INCREMENTAL && !tip)
      throw new RecoveryError(409, "no_full_base", "不存在可用的全量基点（可能尚无恢复点或现有链条已损坏），请先创建全量点");
    if (report.points.some((p) => !p.selfValid || (p.kind === INCREMENTAL && !p.reachable)) && kind === INCREMENTAL) {
      // 存在损坏点时仍允许挂到最新健康点，但提醒调用方
    }

    let payload;
    let parentId = null;
    let prevDigest = null;
    if (kind === FULL) {
      payload = { items };
    } else {
      const rebuilt = await this._rebuild(tip.id);
      const diff = this._diffRaw(items, rebuilt.items);
      if (Object.keys(diff.upserts).length === 0 && diff.deletes.length === 0)
        throw new RecoveryError(409, "no_changes_since_parent", "与上一个恢复点相比没有变化，未创建增量点");
      payload = diff;
      parentId = tip.id;
      const tipRaw = (await this._readAll()).find((r) => r.point?.id === tip.id);
      prevDigest = tipRaw.point.digest;
    }

    const nowIso = this.now();
    const id =
      input.id ||
      `RP-${nowIso.replace(/[-:T.Z]/g, "").slice(0, 14)}-${String(++pointSeq).padStart(6, "0")}-${randomUUID().slice(0, 6)}`;
    const point = {
      id,
      kind,
      createdAt: nowIso,
      parentId,
      prevDigest,
      note: input.note || "",
      payload: null,
      payloadDigest: this._payloadDigestOf(payload),
      digest: null,
      payload,
    };
    point.digest = this._digestOf(point);

    await atomicWrite(this.pointFile(id), JSON.stringify(point, null, 2));
    let retention = null;
    try {
      retention = await this._applyRetention();
    } catch (e) {
      // 保留策略清理失败不应让建点失败
      retention = { error: e.message };
    }
    return {
      point: this._summaryOf(point),
      retained: retention,
    };
  }

  /** 原始差异：upserts（新增或修改的完整墨锭）+ deletes（键） */
  _diffRaw(currentItems, parentItems) {
    const upserts = {};
    const parentMap = new Map(parentItems.map((item) => [keyFor(item), item]));
    const currentKeys = new Set();
    for (const item of currentItems) {
      const key = keyFor(item);
      currentKeys.add(key);
      const old = parentMap.get(key);
      if (!old || canonical(old) !== canonical(item)) upserts[key] = clone(item);
    }
    const deletes = [];
    for (const key of parentMap.keys()) if (!currentKeys.has(key)) deletes.push(key);
    return { upserts, deletes };
  }

  _summaryOf(p) {
    return {
      id: p.id,
      kind: p.kind,
      createdAt: p.createdAt,
      parentId: p.parentId,
      note: p.note || "",
    };
  }

  /* ---------- 保留策略：按数量清理（见 _applyRetention） ---------- */

  /**
   * 保留策略（按数量，最旧优先）。
   * 线性增量链中除链尾外每个点都被后续增量依赖，无法从中间删除，
   * 因此以「全量基点 + 挂在它上面的全部增量」为一组整体淘汰：
   * 组内任一点被钉住，则整组保留；无法安全成组淘汰时报告 blocked。
   */
  async _applyRetention() {
    const { retention } = await this.getConfig();
    const pins = await this._getPins();
    const report = await this._inspect();
    const summaries = report.points;

    // 损坏/不可达的点不参与自动淘汰（避免误销毁），只报告
    const blocked = [];
    const corrupt = summaries.filter((p) => !p.selfValid || (p.kind === INCREMENTAL && !p.reachable));
    for (const p of corrupt) blocked.push({ reason: "corrupt_or_unreachable_skipped", pointId: p.id });

    const valid = summaries.filter((p) => p.selfValid && (p.kind === FULL || p.reachable));
    const groupsMap = new Map(); // rootId -> 成员（按时间）
    for (const p of valid) {
      const rootId = p.kind === FULL ? p.id : p.rootId;
      if (!groupsMap.has(rootId)) groupsMap.set(rootId, []);
      groupsMap.get(rootId).push(p);
    }
    const groups = [...groupsMap.values()].map((members) => {
      members.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      return { rootId: members[0].rootId || members[0].id, members, firstAt: members[0].createdAt };
    });
    groups.sort((a, b) => (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : 0));

    const removed = [];
    let count = valid.length;
    for (const group of groups) {
      if (count <= retention) break;
      const toRemove = Math.min(group.members.length, count - retention);
      // 只删除该组最末尾的 toRemove 个点（从链尾向基点方向），
      // 这样保留下来的始终是「全量基点 + 最早若干增量」的合法前缀；
      // 整组删除时才包含全量基点。
      const victims = group.members.slice(group.members.length - toRemove);
      const pinnedVictim = victims.find((m) => pins[m.id]);
      if (pinnedVictim) {
        // 待删成员中有钉住点：若本可整组删，则整组保留；否则放弃本次裁剪
        blocked.push({ reason: "group_pinned", pointId: pinnedVictim.id, size: group.members.length });
        continue;
      }
      // 从最新（链尾）向旧删除，保证每一步删的都是当前链尾
      for (const m of victims.reverse()) {
        await rm(this.pointFile(m.id), { force: true });
        removed.push(m.id);
        count -= 1;
      }
    }
    if (count > retention)
      blocked.push({ reason: "all_protected", remaining: count });
    return { retention, removed, blocked };
  }

  async applyRetention() {
    return this.mutex.run(() => this._applyRetention());
  }

  async deletePoint(id) {
    return this.mutex.run(async () => {
      const raw = await this._readAll();
      const target = raw.find((r) => r.point?.id === id);
      if (!target) throw new RecoveryError(404, "point_not_found", "恢复点不存在");
      const pins = await this._getPins();
      if (pins[id]) throw new RecoveryError(409, "point_pinned", "恢复点已钉住，不能删除");
      // 沿 parentId 传递闭包：任何（直接或间接）以该点为祖先的存活增量都依赖它
      const dependents = [];
      const walk = (parentId) => {
        for (const r of raw) {
          if (r.point && r.point.kind === INCREMENTAL && r.point.parentId === parentId) {
            dependents.push(r.point.id);
            walk(r.point.id);
          }
        }
      };
      walk(id);
      if (dependents.length)
        throw new RecoveryError(409, "point_in_use", "仍有增量恢复点沿链依赖该点，不能删除", {
          dependents,
        });
      await rm(this.pointFile(id), { force: true });
      return { id, deleted: true };
    });
  }

  /* ---------- 恢复（带回滚与幂等） ---------- */

  validateRestoreId(restoreId) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(restoreId || ""))
      throw new RecoveryError(400, "bad_restore_id", "恢复请求 ID 非法");
  }

  async getJournal(restoreId) {
    if (!restoreId) return null;
    return readJson(this.journalFile(restoreId), null);
  }

  async listJournals() {
    await mkdir(this.journalsDir, { recursive: true });
    const files = (await readdir(this.journalsDir)).filter((f) => f.endsWith(".json"));
    const journals = [];
    for (const f of files) {
      const j = await readJson(join(this.journalsDir, f), null);
      if (j) journals.push(j);
    }
    journals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return journals;
  }

  /**
   * 执行恢复。
   * @param {object} opts
   * @param {string} opts.restoreId 客户端提供的幂等键
   * @param {string} opts.pointId 目标恢复点
   * @param {object} opts.backupContent 恢复前的完整数据（回滚用）
   * @param {(content:object)=>Promise<void>} opts.writeDb 原子写入数据的回调
   * @param {(phase:string)=>Promise<void>} [opts.inject] 故障注入（测试）
   */
  async restore({ restoreId, pointId, backupContent, writeDb, inject }) {
    return this.mutex.run(async () => {
      this.validateRestoreId(restoreId);

      // 重复请求只执行一次：查恢复日志
      const existing = await this.getJournal(restoreId);
      if (existing) {
        if (existing.status === "done")
          return { deduplicated: true, journal: existing };
        if (existing.status === "in_progress")
          throw new RecoveryError(409, "restore_in_progress", "该恢复请求正在执行中（或曾被中断），请先处理后再重试");
        throw new RecoveryError(
          409,
          "restore_previously_rolled_back",
          "该恢复请求此前已失败并回滚，请用新的请求 ID 重新发起",
          { journal: existing }
        );
      }

      // 恢复前先沿链完整校验+重建；任一摘要不符或断链直接失败（此时尚未改动数据）
      const { items, chain } = await this._rebuild(pointId);
      const targetContent = { items };

      const journal = {
        restoreId,
        pointId,
        createdAt: this.now(),
        status: "in_progress",
        chain,
      };
      await atomicWrite(this.journalFile(restoreId), JSON.stringify(journal, null, 2));
      await atomicWrite(
        this.backupFile(restoreId),
        JSON.stringify(backupContent, null, 2)
      );

      const rollback = async (error, crashed = false) => {
        let rollbackError = null;
        try {
          await writeDb(clone(backupContent));
        } catch (e) {
          rollbackError = e.message;
        }
        const finalJournal = {
          ...journal,
          finishedAt: this.now(),
          status: "rolled_back",
          crashed,
          error: String(error?.message || error),
          rollbackError,
        };
        await atomicWrite(this.journalFile(restoreId), JSON.stringify(finalJournal, null, 2));
        await rm(this.backupFile(restoreId), { force: true });
        return finalJournal;
      };

      try {
        await writeDb(targetContent);
        if (inject) await inject("after_write");
      } catch (error) {
        const finalJournal = await rollback(error);
        throw new RecoveryError(409, "restore_failed_rolled_back", "恢复失败，已回到恢复前状态", {
          journal: finalJournal,
        });
      }

      const done = {
        ...journal,
        finishedAt: this.now(),
        status: "done",
        restoredTotals: {
          items: items.length,
          logs: items.reduce((n, i) => n + (i.logs || []).length, 0),
          tests: items.reduce((n, i) => n + (i.tests || []).length, 0),
        },
      };
      await atomicWrite(this.journalFile(restoreId), JSON.stringify(done, null, 2));
      await rm(this.backupFile(restoreId), { force: true });
      return { deduplicated: false, journal: done, items };
    });
  }

  /**
   * 启动时重演恢复日志：
   * - in_progress：进程在上次恢复中崩溃/被中断 → 用备份回到恢复前状态；
   * - done / rolled_back：仅留存记录。
   */
  async replayJournals({ writeDb }) {
    return this.mutex.run(async () => {
      await mkdir(this.journalsDir, { recursive: true });
      const journals = await this.listJournals();
      const recovered = [];
      for (const j of journals) {
        if (j.status !== "in_progress") continue;
        const backupPath = this.backupFile(j.restoreId);
        if (!existsSync(backupPath)) {
          // 备份还没写就中断：数据未动，仅终结日志
          const done = { ...j, finishedAt: this.now(), status: "rolled_back", crashed: true, error: "interrupted_before_swap" };
          await atomicWrite(this.journalFile(j.restoreId), JSON.stringify(done, null, 2));
          recovered.push({ restoreId: j.restoreId, action: "journal_closed" });
          continue;
        }
        const backup = await readJson(backupPath, null);
        let writeError = null;
        if (backup) {
          try {
            await writeDb(backup);
          } catch (e) {
            writeError = e.message;
          }
        }
        const done = {
          ...j,
          finishedAt: this.now(),
          status: "rolled_back",
          crashed: true,
          error: "interrupted_during_restore",
          rollbackError: writeError,
        };
        await atomicWrite(this.journalFile(j.restoreId), JSON.stringify(done, null, 2));
        await rm(backupPath, { force: true });
        recovered.push({
          restoreId: j.restoreId,
          pointId: j.pointId,
          action: writeError ? "rollback_failed" : "rolled_back",
          writeError,
        });
      }
      return { recovered };
    });
  }

  /** 清理残留临时文件 */
  async cleanupTemp() {
    await mkdir(this.dir, { recursive: true });
    const dirs = [this.dir, this.pointsDir, this.journalsDir];
    for (const d of dirs) {
      if (!existsSync(d)) continue;
      for (const f of await readdir(d)) {
        if (f.includes(".tmp-")) await rm(join(d, f), { force: true });
      }
    }
  }
}
