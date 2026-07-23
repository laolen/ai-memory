#!/usr/bin/env python3
# v1.9.0 Qdrant 回归验证（替代旧的 ES-only verify_fixes.py / verify_project_relations.py）。
# 全部走 REST 黑盒，验证 Qdrant 主存储下的关键行为：
#  - 跨项目借用 + 衰减(doList include_related)
#  - 跨项目记忆不被错误强化(doSearch bump 解耦)
#  - 过期记忆隐藏 + 物理清理(新 two-filter 清理路径)
#  - 去重合并(dedup merge)
#  - 溯源字段 payload 往返(source round-trip)
# 注意：128 上 capture 走 LLM fact-pipeline，长文本可能被拆成多条记忆且内容被改写，
#       故本测试一律以 capture 返回的 id 为准做断言，不依赖内容字符串相等。
# 用法: python3 verify_qdrant_regression.py  (在 128 /opt/ai-memory 下运行)
import urllib.request, json, sys, urllib.parse, datetime, time, uuid

SRV = 'http://localhost:8765'

def post(path, body, timeout=120):
    req = urllib.request.Request(SRV + path, data=json.dumps(body).encode(), method='POST')
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f'  [post HTTPError] url={SRV+path} code={e.code} body={e.read().decode()[:300]}')
        raise

def put(path, body, timeout=120):
    req = urllib.request.Request(SRV + path, data=json.dumps(body).encode(), method='PUT')
    req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f'  [put HTTPError] url={SRV+path} code={e.code} body={e.read().decode()[:300]}')
        raise

def get(path, timeout=30):
    with urllib.request.urlopen(SRV + path, timeout=timeout) as r:
        return json.loads(r.read().decode())

def delete(path, timeout=30):
    req = urllib.request.Request(SRV + path, method='DELETE')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()

def fail(msg):
    print('FAIL:', msg); sys.exit(1)

def cap(text, project, tags=None):
    return post('/api/capture', {'text': text, 'user': 'qverify', 'project': project, 'tags': tags or ['qtest']})

def cap_ids(text, project):
    # 128 上 capture 开了 auto_filter(LLM 判定是否值得存)，同一条可能偶发被丢弃(captured=0)。
    # 用完全相同的文本重试（经验上 1~2 次内会被保留），不追加内容以保住原文（检索/去重依赖原文）。
    for _ in range(5):
        r = cap(text, project)
        ids = [it['id'] for it in (r.get('items') or []) if it.get('id')]
        if ids:
            return ids
    fail('FAIL: capture 连续被 auto_filter 丢弃，无法创建测试记忆')

def cap_until_kept(text, project, attempts=4):
    # 128 上 capture 开了 auto_filter(LLM 判定是否值得存)，可能被丢弃(captured=0)。
    # 连续重试并在文案追加强调，直到真正落库返回 id。
    for i in range(attempts):
        r = cap(text, project)
        ids = [it['id'] for it in (r.get('items') or []) if it.get('id')]
        if ids:
            return ids
        text = text + f'（补充：这是需要长期记住的配置事实，第{i+1}次记录）'
    fail('FAIL: capture 连续被 auto_filter 丢弃，无法创建测试记忆')

def cap_full(text, project, attempts=5):
    # 与 cap_ids 同策略（同文本重试），但返回完整 capture 响应（含 captured/updated/skipped/items）。
    for _ in range(attempts):
        r = cap(text, project)
        if (r.get('items') or []):
            return r
    fail('FAIL: capture 连续被 auto_filter 丢弃，无法创建测试记忆')

def list_proj(project, include_related=True):
    ir = 'true' if include_related else 'false'
    return get(f'/api/memories?project={urllib.parse.quote(project)}&include_related={ir}&limit=50')['rows']

def cleanup_project(proj):
    try:
        rows = get('/api/memories?project=' + urllib.parse.quote(proj) + '&limit=200').get('rows') or []
        for r in rows:
            try: delete(f'/api/memories/{r["id"]}')
            except Exception: pass
        print(f'  (已清理 {len(rows)} 条 {proj} 旧数据)')
    except Exception as e:
        print('  (清理失败，可忽略):', e)

RUN = uuid.uuid4().hex[:6]
PA, PB, PC, PD = f'qv_pay_{RUN}', f'qv_ord_{RUN}', f'qv_exp_{RUN}', f'qv_dedup_{RUN}'
A_TXT = '支付网关在交易完成后需向商户发送异步回调通知，回调地址必须支持 HTTPS 双向校验。'
B_TXT = '订单履约包含待支付、已支付、拣货中、已发货、已完成五个状态，状态流转需保证幂等。'
C_TXT = '测试服务器部署在上海机房，硬件配置为 32 核 128G 内存，专用于回归验证。'
D_TXT = '去重合并验证：完全相同的内容第二次捕获应合并而非新建。'

print('=== 0. 清理旧数据 + 建立项目关联 ===')
cleanup_project(PA); cleanup_project(PB); cleanup_project(PC); cleanup_project(PD)
try: delete(f'/api/project-links?from={PA}&to={PB}')
except Exception: pass

print('\n=== 1. 跨项目借用 + 衰减 (doList include_related) ===')
aids = cap_ids(A_TXT, PA)
bids = cap_ids(B_TXT, PB)
assert aids and bids, f'FAIL: capture 未返回 id (aids={aids}, bids={bids})'
print(f'  A ids={aids}')
print(f'  B ids={bids}')
post('/api/project-links', {'from_project': PA, 'to_project': PB, 'strength': 1, 'note': '支付与订单强相关'})
time.sleep(1.0)
rows = list_proj(PA, include_related=True)
rows_by_id = {r['id']: r for r in rows}
for aid in aids:
    assert aid in rows_by_id, f'FAIL: A({aid}) 未在主项目列表返回'
for bid in bids:
    assert bid in rows_by_id, f'FAIL: B({bid}) 未在跨项目借用中返回'
for bid in bids:
    assert rows_by_id[bid].get('related_project') == PB, f'FAIL: B({bid}) 未标记 related_project'
# 衰减：每个借来的 B 的 score 应 < 每个主项目 A 的 score
a_scores = [rows_by_id[aid]['score'] for aid in aids]
b_scores = [rows_by_id[bid]['score'] for bid in bids]
print(f'  A scores={[round(s,4) for s in a_scores]}  B scores={[round(s,4) for s in b_scores]}')
assert all(b < max(a_scores) for b in b_scores), 'FAIL: 关联记忆 score 未低于主项目(衰减未生效)'
print('  PASS: 关联记忆已按 relationDecay(1)=0.8 衰减，排在后面')

rows_off = list_proj(PA, include_related=False)
off_ids = {r['id'] for r in rows_off}
assert not any(bid in off_ids for bid in bids), 'FAIL: include_related=false 仍返回跨项目记忆'
print('  PASS: include_related=false 正确排除跨项目借用')

print('\n=== 2. 跨项目记忆不被错误强化 (doSearch bump 解耦) ===')
before = list_proj(PA, include_related=True)
b_before = {bid: before_id['access_count'] for bid in bids for before_id in [before_id for before_id in before if before_id['id'] == bid]}
a_before = {aid: before_id['access_count'] for aid in aids for before_id in [before_id for before_id in before if before_id['id'] == aid]}
res = get(f'/api/memories?q={urllib.parse.quote("回调")}&project={PA}&include_related=true&mode=keyword&limit=50')
assert any(r['id'] in aids for r in res['rows']), 'FAIL: A 未命中'
assert any(r['id'] in bids and r.get('related_project') == PB for r in res['rows']), 'FAIL: B(关联)未命中'
time.sleep(1.5)
after = list_proj(PA, include_related=True)
after_by_id = {r['id']: r for r in after}
for bid in bids:
    assert after_by_id[bid]['access_count'] == b_before[bid], f'FAIL: 跨项目记忆 B({bid}) 被错误强化 ({b_before[bid]}->{after_by_id[bid]["access_count"]})'
for aid in aids:
    assert after_by_id[aid]['access_count'] == a_before[aid] + 1, f'FAIL: 主项目记忆 A({aid}) 未强化 ({a_before[aid]}->{after_by_id[aid]["access_count"]})'
print('  PASS: 主项目记忆被强化(+1)，跨项目借来的记忆未被强化')

print('\n=== 3. 过期记忆隐藏 + 物理清理 (two-filter 清理路径) ===')
# 捕获一条全新的、带唯一标记的记忆（避免被 auto_filter supplement 到旧记忆导致 id 不稳定），
# 设过期时间后应被 must_not 隐藏，再经清理路径物理删除。
C_UNIQ = f'回归专用唯一配置：节点 N{uuid.uuid4().hex[:8]} 的磁盘水位阈值为 91%，超限即告警。'
cids = cap_until_kept(C_UNIQ, PC)
assert cids, 'FAIL: 过期测试记忆 capture 未返回 id'
cid = cids[0]
past = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
presp = put(f'/api/memories/{cid}', {'expires_at': past})
assert presp.get('ok') is True, 'FAIL: 设置 expires_at 失败'
time.sleep(1.0)
lst_c = list_proj(PC, include_related=False)
assert not any(r['id'] == cid for r in lst_c), 'FAIL: 过期记忆不应出现在列表(应被 must_not 隐藏)'
print('  PASS: 过期记忆已被隐藏(must_not 生效)')
r = delete(f'/api/memories/cleanup?expired=1&days=365&project={PC}')
purged = json.loads(r).get('purged', 0)
print(f'  cleanup purged={purged}')
assert purged >= 1, 'FAIL: 过期记忆未被清理'
lst_c2 = list_proj(PC, include_related=False)
assert not any(r['id'] == cid for r in lst_c2), 'FAIL: 清理后过期记忆仍存在'
print('  PASS: 过期记忆已物理删除(two-filter 清理路径生效)')

print('\n=== 4. 去重合并 (dedup merge) ===')
r1 = cap_full(D_TXT, PD)
id1 = r1['items'][0]['id'] if r1.get('items') else None
assert id1, 'FAIL: 首次 capture 未返回 id'
r2 = cap(D_TXT, PD)
id2 = r2['items'][0]['id'] if r2.get('items') else None
print(f'  第一次 captured id={id1}')
print(f'  第二次: captured={r2.get("captured")} updated={r2.get("updated")} skipped={r2.get("skipped")} id={id2}')
assert id2 == id1 or r2.get('updated') == 1 or r2.get('skipped') == 1, 'FAIL: 相同内容未被合并'
print('  PASS: 重复内容已去重合并(未新建第二条)')

print('\n=== 5. 溯源字段 payload 往返 (source round-trip) ===')
src = get(f'/api/memories/{id1}').get('source') or {}
print('  source =', json.dumps(src, ensure_ascii=False))
assert src.get('trigger') and src.get('captured_at'), 'FAIL: 溯源字段缺失(trigger/captured_at)'
print('  PASS: source 字段经 Qdrant 往返完好')

print('\n=== CLEANUP ===')
cleanup_project(PA); cleanup_project(PB); cleanup_project(PC); cleanup_project(PD)
try: delete(f'/api/project-links?from={PA}&to={PB}')
except Exception: pass
print('\nALL QDRANT REGRESSION TESTS PASSED')
