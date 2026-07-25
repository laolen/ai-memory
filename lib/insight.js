// 智能深化分析层（T9）：重复/冲突检测、标签聚类、遗忘曲线。
// 只读分析，依赖 qdrant(向量主存储) 与 backend(SQLite 降级)。
// 设计原则：向量可用时用语义余弦相似度；否则回退内容 jaccard 重叠；均不可用时返回空分析而非报错。
const config = require('./config');
const qdrant = require('./qdrant');
const backend = require('./backend');

// ---- 相似度原语 ----
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
function tokenize(s) {
  return new Set(String(s || '').toLowerCase().split(/[,\s。，！？；;：:\n\t]+/).map(w => w.trim()).filter(Boolean));
}
function jaccard(a, b) {
  const sa = tokenize(a), sb = tokenize(b);
  if (!sa.size || !sb.size) return 0;
  let inter = 0; sa.forEach(w => { if (sb.has(w)) inter++; });
  const uni = sa.size + sb.size - inter;
  return uni ? inter / uni : 0;
}

// ---- 统一读取全部记忆（带向量或内容）----
// 注意：qdrant.scrollAll 硬编码 with_vector=false，故此处用 qdrant.scroll 自行分页拉向量。
async function scrollAllVec() {
  let offset = null, out = [];
  while (true) {
    const j = await qdrant.scroll({ limit: 256, withVector: true, offset });
    const pts = (j && j.points) || [];
    out = out.concat(pts);
    offset = j && j.nextOffset;
    if (!offset || pts.length === 0) break;
  }
  return out;
}

async function loadAll() {
  if (qdrant.useQdrant() && config.CONFIG.embedding_url) {
    const pts = await scrollAllVec();
    return pts.map(p => ({
      id: p.id,
      vector: p.vector || null,
      content: (p.payload && p.payload.content) || '',
      tags: Array.isArray(p.payload && p.payload.tags) ? p.payload.tags : [],
      project: (p.payload && p.payload.project) || null,
      user: (p.payload && p.payload.user) || null,
      created_at: (p.payload && p.payload.created_at) || null,
      updated_at: (p.payload && p.payload.updated_at) || null,
      last_accessed_at: (p.payload && p.payload.last_accessed_at) || null,
      next_review_at: (p.payload && p.payload.next_review_at) || null,
      access_count: Number((p.payload && p.payload.access_count) || 0),
      confidence: (p.payload && p.payload.confidence) != null ? Number(p.payload.confidence) : null,
      content_hash: (p.payload && p.payload.content_hash) || null,
      source: 'qdrant',
    }));
  }
  // SQLite 兜底
  const d = backend.sqliteInit();
  const rows = d.prepare('SELECT id, content, tags, project, user, created_at, updated_at, last_accessed_at, next_review_at, access_count, confidence, content_hash, embedding FROM memories').all();
  return rows.map(r => {
    let tags = []; try { tags = r.tags ? JSON.parse(r.tags) : []; } catch (e) { tags = []; }
    let vector = null; try { vector = r.embedding ? JSON.parse(r.embedding) : null; } catch (e) { vector = null; }
    return {
      id: r.id, vector, content: r.content || '', tags: Array.isArray(tags) ? tags : [],
      project: r.project || null, user: r.user || null,
      created_at: r.created_at || null, updated_at: r.updated_at || null,
      last_accessed_at: r.last_accessed_at || null, next_review_at: r.next_review_at || null,
      access_count: Number(r.access_count || 0),
      confidence: r.confidence != null ? Number(r.confidence) : null,
      content_hash: r.content_hash || null, source: 'sqlite',
    };
  });
}

// ---- 1) 重复 / 冲突检测 ----
async function findDuplicates(threshold, limit) {
  const thr = (typeof threshold === 'number' && !isNaN(threshold)) ? threshold : (config.CONFIG.dedup_threshold || 0.92);
  const lim = (typeof limit === 'number' && limit > 0) ? limit : 50;
  const mems = await loadAll();
  const withVec = mems.filter(m => Array.isArray(m.vector) && m.vector.length);
  const useVector = withVec.length >= 2 && withVec.length === mems.length;
  // 内容 jaccard 的判重阈值应远低于向量余弦，避免误报
  const eff = useVector ? thr : Math.min(thr, 0.6);
  const method = useVector ? 'vector' : 'content';
  const pairs = [];
  const n = mems.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = mems[i], b = mems[j];
      if (a.id === b.id) continue; // 跳过同一逻辑记忆的重复点位（存储层去重问题，非语义冲突）
      let sim = 0, exact = false;
      if (a.content_hash && b.content_hash && a.content_hash === b.content_hash) { exact = true; sim = 1; }
      else if (useVector && a.vector && b.vector) sim = cosine(a.vector, b.vector);
      else sim = jaccard(a.content, b.content);
      if (exact || sim >= eff) {
        pairs.push({
          a: { id: a.id, content: a.content, project: a.project },
          b: { id: b.id, content: b.content, project: b.project },
          similarity: +sim.toFixed(4), exact,
        });
      }
    }
  }
  pairs.sort((x, y) => ((y.exact ? 1 : 0) - (x.exact ? 1 : 0)) || (y.similarity - x.similarity));
  return { ok: true, threshold: +eff.toFixed(4), method, count: pairs.length, total_memories: n, pairs: pairs.slice(0, lim) };
}

// ---- 2) 标签聚类 ----
function clusterTags(mems) {
  const tagCount = new Map();
  const cooc = new Map();
  for (const m of mems) {
    const ts = (m.tags || []).map(String).filter(Boolean);
    const uniq = [...new Set(ts)];
    for (const t of uniq) tagCount.set(t, (tagCount.get(t) || 0) + 1);
    for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
      const k = [uniq[i], uniq[j]].sort().join('|');
      cooc.set(k, (cooc.get(k) || 0) + 1);
    }
  }
  const tag_counts = [...tagCount.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);
  // 并查集：共现次数 >=2 的标签连边，提取连通分量作为聚类
  const parent = {};
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const allTags = [...tagCount.keys()];
  allTags.forEach(t => parent[t] = t);
  for (const [k, c] of cooc) { if (c >= 2) { const [x, y] = k.split('|'); parent[find(x)] = find(y); } }
  const comp = new Map();
  for (const t of allTags) { const r = find(t); if (!comp.has(r)) comp.set(r, []); comp.get(r).push(t); }
  const clusters = [...comp.values()].filter(g => g.length > 1)
    .map(g => ({ size: g.length, tags: g })).sort((a, b) => b.size - a.size);
  const cooccurrence = [...cooc.entries()].map(([k, c]) => { const [a, b] = k.split('|'); return { tags: [a, b], count: c }; })
    .sort((a, b) => b.count - a.count).slice(0, 30);
  return { ok: true, total_memories: mems.length, unique_tags: tagCount.size, tag_counts, cooccurrence, clusters };
}

// ---- 3) 遗忘曲线（间隔重复，Ebbinghaus 指数衰减）----
function forgettingCurve(mems) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  let due = 0, scheduled = 0;
  const stability = [];
  const buckets = new Array(10).fill(0);
  const valid = [];
  for (const m of mems) {
    const anchor = m.last_accessed_at || m.updated_at || m.created_at;
    const at = anchor ? new Date(anchor).getTime() : null;
    if (at == null || isNaN(at)) continue;
    let nra = m.next_review_at ? new Date(m.next_review_at).getTime() : null;
    let S;
    if (nra != null && !isNaN(nra) && nra > at) {
      S = (nra - at) / 3600000; // 真实间隔重复稳定性
    } else {
      // 遗留记忆无 next_review_at：用访问次数派生稳定性（SM-2 风格间隔 2^access·2h，封顶 720h）
      const ac = Number(m.access_count) || 0;
      const intervalHours = Math.min(720, Math.max(4, Math.pow(2, ac) * 2));
      S = intervalHours;
      nra = at + intervalHours * 3600000; // 仅用于 due 判定
    }
    if (!(S > 0)) S = 24;
    if (nra <= now) due++; else scheduled++;
    valid.push({ nra, at });
    stability.push(S);
    const elapsed = (now - at) / 3600000;
    const ret = Math.max(0, Math.min(1, Math.exp(-elapsed / S)));
    const bi = Math.min(9, Math.floor(Math.max(0, Math.min(1, ret)) * 10));
    buckets[bi]++;
  }
  // 未来 30 天平均留存衰减（假设不再复习）
  const curve = [];
  for (let d = 0; d <= 30; d++) {
    let sum = 0, cnt = 0;
    for (const v of valid) {
      let S = (v.nra - v.at) / 3600000; if (!(S > 0)) S = 24;
      const elapsed = (now - v.at) / 3600000 + d * 24;
      sum += Math.max(0, Math.min(1, Math.exp(-elapsed / S))); cnt++;
    }
    curve.push({ day: d, retention: cnt ? +(sum / cnt).toFixed(4) : 0 });
  }
  const meanS = stability.length ? stability.reduce((a, b) => a + b, 0) / stability.length : 0;
  const medianS = stability.length ? stability.slice().sort((a, b) => a - b)[Math.floor(stability.length / 2)] : 0;
  return {
    ok: true, now: nowIso, total_memories: mems.length, with_schedule: valid.length,
    due_count: due, scheduled_count: scheduled,
    mean_stability_hours: +meanS.toFixed(1), median_stability_hours: +medianS.toFixed(1),
    retention_buckets: buckets.map((c, i) => ({ range: (i * 10) + '%-' + (i * 10 + 10) + '%', count: c })),
    curve,
  };
}

module.exports = { loadAll, findDuplicates, clusterTags, forgettingCurve, cosine, jaccard };
