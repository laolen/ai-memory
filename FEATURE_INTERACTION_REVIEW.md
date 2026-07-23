# ai-memory 功能交互 / 冲突审查（v1.7.0, server.js）

> 目标：检查各功能模块（去重合并 / 时序衰减 / salience / 自动捕获 / 知识图谱 / 事实抽取 / memory_type / 项目隔离+跨项目借鉴 / 溯源 / 实体链接加权）之间是否关联、互相影响、是否有冲突与 bug。
> 方法：通读 `filters / doAdd / doUpdate / doSearch / doList / searchProject / rerankWithContext / applyRecency / bumpAccess / dedupFind / cleanupExpired` 及 ES mapping 实测。

---

## 一、已确认的真实问题（建议修复）

### ① doList 的跨项目记忆未做 relationDecay 衰减（中）
- **位置**：`doList` 相关分支（约行 1221-1223）对比 `doSearch`（行 1201）。
- **现象**：`doSearch` 对借来的记忆执行 `r.score = (r.score != null ? r.score : 1) * relationDecay(lk.strength)`；`doList` 只打了 `related_project / relation_strength / relation_note` 标签，**没有衰减 score**。
- **后果**：列表视图里弱关联项目的记忆与主项目记忆被同等对待（仅经过 recency / salience / entity 调制），可能排在强相关的主项目记忆之前；与搜索视图行为不一致，违背"关联越弱越靠后"的设计语义。
- **佐证**：上轮 `verify_project_relations.py` 中 `list` 返回 B 的 `score=0.775` 与 A 完全相同（未被衰减），而 `search` 路径本应衰减。
- **修法**：在 `doList` 的相关分支补 `r.score = (r.score != null ? r.score : 1) * relationDecay(lk.strength);`（ES 与 SQLite 两条路径都要补）。

### ② 生命周期清理按 `updated_at` 而非 `expires_at`（中）
- **位置**：`cleanupExpired`（行 301）与 `purgeMemories`（行 313-314）均用 `updated_at < cutoff` 删除。
- **现象**：session / 显式 TTL 记忆由 `doAdd` 设 `expires_at`（行 1047-1049）；`filters()` 已经按 `expires_at` 把它们从检索中隐藏（行 731）。但清理任务按 `updated_at` 删除——一条刚创建、或被 dedup 合并（`updated_at=now`）的过期记忆 `updated_at` 很新，不会被清理。
- **后果**：过期的 session 记忆被隐藏却永不真正删除 → 索引持续膨胀；且过期记忆一旦被合并/更新导致 `updated_at` 变新，会逃过清理。
- **修法**：清理范围改为「`expires_at` 已过期 OR `updated_at` 超过 `expiry_days`」；优先用 `expires_at`。

### ③ 跨项目 `bumpAccess` 耦合（低-中，需定夺）
- **位置**：`doSearch` 的 `finish()`（行 1175）对返回结果——**含跨项目借来的记忆**——调用 `bumpAccess`（行 1113-1129），改写其 `access_count / last_accessed_at`。
- **现象**：在 A 项目检索会"强化"关联项目 B 的记忆，使 B 因被借来而 `last_accessed_at` 常驻为 now，recency 永不衰减。
- **后果**：非预期的跨项目副作用；A 的活动会抬高 B 记忆的 salience 与 recency，反向影响 B 自己项目里的排序。
- **建议**：要么接受（"被用到的记忆保持新鲜"合理），要么把 `bumpAccess` 限定为仅主项目 id（排除 `related_project` 行）。注意 `doList` 不调用 `bumpAccess`，故列表视图不会强化——搜索与列表在此也不对称。

---

## 二、设计张力 / 边界（非崩溃，需知晓）

### ④ recency 基准 `last_accessed_at` + 每次检索都 bump → 仅"从未被搜"的记忆衰减
- `applyRecency` 用 `last_accessed_at`（行 168）；`bumpAccess` 在每次搜索命中后重置为 now（行 1120）。
- 后果：任何被搜过的记忆 recency 恒≈1；只有彻底冷掉（不再被检索）的记忆才衰减。语义上"冷=淡"成立，但热点记忆的 recency 形同失效，且叠加 ③ 使被借来的记忆也常驻新鲜。属设计取舍，非 bug。

### ⑤ dedup 合并的字段语义与空 project 边界
- 合并用新 `content` 覆盖、`updated_at=now`；但 `memory_type / type / category / confidence / source / expires_at / last_accessed_at / history` 均保留旧值（`doUpdate` 仅当 patch 含该字段才改），正确。
- **边界**：`project` 为空时 `dedupFind` 全局搜索（行 740/768 无 project 过滤），可能把新记忆合并进另一项目的相似记忆（`project` 被改写为新值）→ 跨项目污染。建议 `doAdd` 在 merge 时若 `scope.project` 与命中记忆 `project` 不同则跳过合并，保持项目隔离。

### ⑥ salience 与 recency 双重乘性衰减
- `applyRecency`（`score *= recency ≤1`）；`rerankWithContext`（`score *= blend`，`blend = 0.7 + 0.3*sal ≤1`）。两者都 ≤1 相乘，对"老且不重要"的记忆叠加压低，符合直觉。行 263 注释"避免双重加权"略误导（实际乘性叠加），无功能错误。

### ⑦ refreshEntityVocab 每次写入全量扫描（性能）
- 行 1095 / 1319，add/update 后全量扫 1 万条重建实体词表（行 180）。写入放大 O(n)；记忆规模大时成为瓶颈。建议增量维护或限频（如写入后延迟 1s 合并一次）。

### ⑧ doList 行 1226 的 `updated_at` 排序被覆盖（死代码）
- `doList` 先 `rows.sort(...updated_at...)`，紧接着 `applyRecency(rerankWithContext(rows))` 按 score 重排，前一次排序无效。无害，仅冗余。

---

## 三、已确认无问题（澄清此前疑虑）

- **`project` 字段 ES mapping 实测为 `keyword`**（类型 `keyword`，无 `.keyword` 子字段），`term:{project}` 正确，项目隔离有效。此前担心"缺 `.keyword` 回退"是误报——`project` 本就是 keyword；而 `type/category/memory_type` 是 `text`+`.keyword`，才需要 `bool.should [term, term.keyword]` 回退（已正确处理）。
- **dedup 是 project 作用域**（`filters` 带入 `project`，行 740/768），不会跨项目合并（除非 `project` 为空，见 ⑤）。
- **`include_related=false` 覆盖**已在 ES / SQLite 两路径经 `relEnabled(a)` 生效（上轮已修）。
- **salience（行 264-268）/ source_trust（行 220-224）/ entity_boost（行 197-202）** 三者相互独立，仅乘积调制 `score`，无相互覆盖。
- **`bumpAccess` 的 Painless** 已用 `?:` 空合并（行 1120），无类型错误；失败被 `.catch` 静默，不影响主流程。
- **`doUpdate` ES 分支** 合并时保留 `history`（行 1312-1317）与 `last_accessed_at`（仅当 patch 含才改，合并 patch 不含 → 保留），正确。

---

## 四、优先级建议

| 优先级 | 项 | 说明 |
|--------|----|------|
| P1（一致性/正确性） | ① doList 跨项目衰减 | 列表与搜索排序语义统一 |
| P1 | ② 清理按 `expires_at` | 避免过期/session 记忆永久残留 |
| P2（设计定夺） | ③ 跨项目 bump 是否限定主项目 | 决定跨项目耦合是否可接受 |
| P3（优化） | ⑦ 实体词表增量维护 | 规模化的写入性能 |
| P3 | ⑧ 死代码清理 | 可读性 |
| P3 | ⑤ 空 project 合并保护 | 跨项目污染边界 |

---

## 五、修复状态（已修复并端到端验证）

> 用户指令「修复」。三项 P1/P2 已全部修复，提交后推 `origin/main`，128 已重启验证。验证脚本 `verify_fixes.py`（128 直跑）全 PASS。

| 项 | 修复 | 验证结果 |
|----|------|----------|
| ① doList 跨项目衰减 | `doList` 主项目记忆基准分归一为 1、关联记忆 `baseScore(r)*relationDecay(strength)`；因 `bool.filter` 查询 `_score` 恒为 0，原 `0*decay` 是空操作，现已归一化（ES/SQLite 两路径） | `include_related=true` 时 B.score=0.668 = A.score(0.835)×0.8，关联记忆稳定排在后面 ✓ |
| ② 清理按 `expires_at` | `cleanupExpired`/`purgeMemories`（ES + SQLite）删除条件改为 `expires_at<now OR (无 expires_at 且 updated_at<cutoff)`；`purgeMemories` 不再用会隐藏过期项的 `filters()`，改为仅挂 scope 维度 + 过期/陈旧条件 | 写一条 `expires_at=2h前` 的记忆，新 `deleteByQuery` 语义删除它（deleted=1）且保留主/关联记忆 ✓ |
| ③ 跨项目 bump 耦合 | `doSearch` 的 `finish()` 改为 `bumpAccess(res.filter(r => !r.related_project).map(r => r.id))`——只强化主项目记忆，不刷新借来的跨项目记忆 | 检索 fixa 后 A.access_count 0→1、B(fixb 借来) 保持 0 ✓ |

**部署**：128 `systemctl restart ai-memory`，`/api/health` 仍 `version:1.7.0`（本轮为同版本内的功能互查加固，未 bump 版本号，沿用 v1.7.0，与 v1.6.0 细化不 bump 的先例一致）。

**遗留（P3，未动）**：⑤ 空 `project` 全局 dedup 合并、⑦ 实体词表全量刷新 O(n)、⑧ `doList` 行 1226 按 `updated_at` 排序后被 `score` 排序覆盖（死代码）。均为非崩溃优化，留待后续。
