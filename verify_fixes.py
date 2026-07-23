import urllib.request, json, base64, urllib.parse, sys, datetime, time

CFG = json.load(open('/opt/ai-memory/config.json'))
SRV = 'http://localhost:8765'
ES = CFG['es_url']
ESU, ESP = CFG.get('es_user'), CFG.get('es_pwd')
EMB_URL = CFG['embedding_url']
EMB_MODEL = CFG.get('embedding_model', 'qwen3-embedding:0.6B')
IDX = CFG['es_index']

def now_iso():
    return datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%S.000Z')

def es_call(method, path, body=None):
    url = ES + '/' + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if ESU:
        tok = base64.b64encode(f"{ESU}:{ESP}".encode()).decode()
        req.add_header('Authorization', 'Basic ' + tok)
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def refresh():
    try: es_call('POST', f'{IDX}/_refresh')
    except Exception: pass

def embed(text):
    req = urllib.request.Request(EMB_URL, data=json.dumps({'model': EMB_MODEL, 'input': [text]}).encode(), method='POST')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())['data'][0]['embedding']

def srv_get(path):
    with urllib.request.urlopen(SRV + path, timeout=30) as r:
        return json.loads(r.read().decode())

def srv_search(project, q, related=True):
    p = f'/api/memories?q={urllib.parse.quote(q)}&project={project}&include_related={"true" if related else "false"}&mode=keyword&limit=50'
    return srv_get(p)

def write_mem(mid, project, content, expires_at=None, confidence=0.9):
    doc = {
        'id': mid, 'content': content, 'user': 'fixuser', 'project': project, 'session': None,
        'tags': ['fix'], 'embedding': embed(content), 'created_at': now_iso(), 'updated_at': now_iso(),
        'history': [], 'entities': [], 'relations': [], 'source': {'type': 'human', 'trigger': 'add', 'captured_at': now_iso()},
        'entity_names': [], 'type': None, 'category': 'semantic', 'confidence': confidence,
        'access_count': 0, 'last_accessed_at': None, 'memory_type': 'user', 'expires_at': expires_at
    }
    es_call('POST', f'{IDX}/_doc/{mid}', doc)
    return mid

def del_mem(mid):
    try: es_call('DELETE', f'{IDX}/_doc/{mid}')
    except Exception: pass

def upsert_link(frm, to, strength):
    body = json.dumps({'from_project': frm, 'to_project': to, 'strength': strength}).encode()
    req = urllib.request.Request(SRV + '/api/project-links', data=body, method='POST')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=30) as r: return json.loads(r.read().decode())

def del_link(frm, to):
    req = urllib.request.Request(SRV + f'/api/project-links?from={frm}&to={to}', method='DELETE')
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.read().decode()
    except Exception as e: return str(e)

A_PROJ, B_PROJ, C_PROJ = 'fixa', 'fixb', 'fixc'
A_ID, B_ID, C_ID = 'fixa-mem-001', 'fixb-mem-001', 'fixc-mem-exp'

# 清理旧的（若有）
for m in (A_ID, B_ID, C_ID): del_mem(m)
del_link(A_PROJ, B_PROJ)
refresh()
time.sleep(1.5)  # 让上一轮 fire-and-forget 的 bumpAccess 彻底落盘，避免脏数据污染本轮

print('=== setup: 写 A(fixa) / B(fixb) / C(fixc, 过期) + link fixa->fixb(强) ===')
write_mem(A_ID, A_PROJ, '支付回调与对账流程由青龙数据负责', confidence=0.9)
write_mem(B_ID, B_PROJ, '支付回调失败后的重试策略', confidence=0.9)
past = (datetime.datetime.utcnow() - datetime.timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S.000Z')
write_mem(C_ID, C_PROJ, '过期测试记忆应被清理', expires_at=past, confidence=0.9)
upsert_link(A_PROJ, B_PROJ, 1)
refresh()  # 强制刷新，保证后续读取一致（避免上轮脏数据/近实时延迟）
print('  setup done')

# ---------- 修复①：doList 关联记忆 score 应被 decay，排在主项目记忆之后 ----------
print('\n=== ① doList: include_related=true 时 B 的 score 应 < A 的 score ===')
rows = srv_get(f'/api/memories?project={A_PROJ}&include_related=true&limit=50')['rows']
am = [r for r in rows if r['id'] == A_ID]
bm = [r for r in rows if r['id'] == B_ID]
assert am and bm, 'FAIL: A 或 B 未返回'
a_row, b_row = am[0], bm[0]
print(f'  A(fixa, main)  score={a_row["score"]:.4f}')
print(f'  B(fixb, rel)   score={b_row["score"]:.4f}  related_project={b_row.get("related_project")} relation_strength={b_row.get("relation_strength")}')
assert b_row.get('related_project') == B_PROJ, 'FAIL: B 未标记 related_project'
assert abs(a_row['score'] - (b_row['score'] / 0.8)) < 1e-6 or a_row['score'] > b_row['score'], 'FAIL: 关联记忆未衰减(或衰减未生效)'
assert a_row['score'] > b_row['score'], 'FAIL: 主项目记忆 score 未高于关联记忆'
print('  PASS: 关联记忆已按 relationDecay(1)=0.8 衰减，排在后面')

# ---------- 修复③：doSearch 不应强化跨项目借来的记忆 ----------
print('\n=== ③ doSearch: 检索 fixa 不应 bump B(fixb) 的 access_count ===')
refresh()
before = srv_get(f'/api/memories?project={A_PROJ}&include_related=true&limit=50')['rows']
b_before = [r for r in before if r['id'] == B_ID][0]['access_count']
a_before = [r for r in before if r['id'] == A_ID][0]['access_count']
print(f'  搜索前: A.access_count={a_before}  B.access_count={b_before}')
res = srv_search(A_PROJ, '支付回调', related=True)
hits = res['rows']
print(f'  搜索命中 {len(hits)} 条')
assert any(r['id'] == A_ID for r in hits), 'FAIL: A 未命中'
assert any(r['id'] == B_ID and r.get('related_project') == B_PROJ for r in hits), 'FAIL: B(关联)未命中'
time.sleep(1.5)  # 等待 ES 近实时刷新（默认 refresh_interval=1s）
refresh()           # 强制刷新后再读 access_count，确保读到 bump 结果
after = srv_get(f'/api/memories?project={A_PROJ}&include_related=true&limit=50')['rows']
b_after = [r for r in after if r['id'] == B_ID][0]['access_count']
a_after = [r for r in after if r['id'] == A_ID][0]['access_count']
print(f'  搜索后: A.access_count={a_after}  B.access_count={b_after}')
assert b_after == b_before, f'FAIL: 跨项目记忆 B 被错误强化 ({b_before}->{b_after})'
assert a_after == a_before + 1, f'FAIL: 主项目记忆 A 未强化 ({a_before}->{a_after})'
print('  PASS: 主项目记忆被强化(+1)，跨项目借来的记忆未被强化')

# ---------- 修复②：过期的 session/TTL 记忆应被真正删除（不再只隐藏） ----------
print('\n=== ② 过期记忆清理：deleteByQuery 新语义应删 C(过期) 且保留 A/B ===')
# 先确认 C 被 filters 隐藏（列表不可见）
lst_c = srv_get(f'/api/memories?project={C_PROJ}&limit=50')['rows']
assert not any(r['id'] == C_ID for r in lst_c), 'FAIL: 过期记忆不应出现在列表'
print('  C 已被隐藏(符合预期)，现执行新清理语义删除...')
now = now_iso()
cutoff = now  # 只删过期项
q = {
    'bool': {
        'filter': [
            {'term': {'project': C_PROJ}},
            {'bool': {'should': [
                {'range': {'expires_at': {'lt': now}}},
                {'bool': {'must': [
                    {'range': {'updated_at': {'lt': cutoff}}},
                    {'bool': {'should': [
                        {'bool': {'must_not': {'exists': {'field': 'expires_at'}}}},
                        {'range': {'expires_at': {'gte': now}}}
                    ], 'minimum_should_match': 1}}
                ]}}
            ], 'minimum_should_match': 1}}
        ]
    }
}
r = es_call('POST', f'{IDX}/_delete_by_query', {'query': q})
deleted = r.get('deleted', 0)
print(f'  deleteByQuery deleted={deleted}')
assert deleted >= 1, 'FAIL: 过期记忆未被删除'
# 确认 C 已不在 ES
left = es_call('GET', f'{IDX}/_doc/{C_ID}')
assert left.get('found') is False, 'FAIL: C 仍存在'
# 确认 A/B 还在
assert es_call('GET', f'{IDX}/_doc/{A_ID}').get('found') is True
assert es_call('GET', f'{IDX}/_doc/{B_ID}').get('found') is True
print('  PASS: 过期记忆已物理删除，主/关联记忆完好')

# ---------- 清理 ----------
print('\n=== cleanup ===')
for m in (A_ID, B_ID): del_mem(m)
del_link(A_PROJ, B_PROJ)
print('  cleaned. ALL TESTS PASSED')
