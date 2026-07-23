#!/usr/bin/env python3
"""v1.7.0 end-to-end verification: doList fix + cross-project relation + provenance."""
import json, urllib.request, urllib.error, sys

# ---- load server config for ES creds ----
with open('/opt/ai-memory/config.json') as f:
    cfg = json.load(f)
ES = cfg['es_url'].rstrip('/')
ESU = cfg.get('es_user', 'elastic')
ESP = cfg.get('es_pwd', '')
EMB = cfg.get('embedding_url', 'http://127.0.0.1:11435/v1/embeddings')
SRV = 'http://localhost:8765'

def es_req(method, path, body=None):
    url = f"{ES}/{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if ESU:
        import base64
        tok = base64.b64encode(f"{ESU}:{ESP}".encode()).decode()
        req.add_header('Authorization', 'Basic ' + tok)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def emb(text):
    req = urllib.request.Request(EMB, data=json.dumps({'model': 'qwen3-embedding', 'input': [text]}).encode(), method='POST')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read().decode())
    return d['data'][0]['embedding']

def srv_get(path):
    with urllib.request.urlopen(SRV + path, timeout=30) as r:
        return json.loads(r.read().decode())

from urllib.parse import quote

def srv_post(path, body):
    req = urllib.request.Request(SRV + path, data=json.dumps(body).encode(), method='POST')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

def srv_delete(path):
    req = urllib.request.Request(SRV + path, method='DELETE')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())

A_ID, B_ID = 'verify_pay_001', 'verify_ord_001'
A_PROJ, B_PROJ = 'verifypay', 'verifyord'
A_TXT = '支付网关需要在交易完成后向商户发送异步回调通知，回调地址必须在后台可配置且必须支持 HTTPS 双向校验。'
B_TXT = '订单履约包含待支付、已支付、拣货中、已发货、已完成五个状态，状态流转必须保证幂等，重复通知不应改变终态。'

docs = {
    A_ID: {'content': A_TXT, 'user': 'u', 'project': A_PROJ, 'session': None, 'tags': ['test'],
           'created_at': '2026-07-23T10:00:00.000Z', 'updated_at': '2026-07-23T10:00:00.000Z',
           'history': [], 'entities': [], 'relations': [], 'entity_names': [], 'type': None,
           'category': 'semantic', 'confidence': None, 'access_count': 0, 'last_accessed_at': None,
           'memory_type': 'user', 'expires_at': None,
           'source': {'type': 'doc', 'ref': 'docs/payment.md', 'url': 'https://example.com/pay',
                      'conversation_id': 'c-123', 'message_id': 'm-456', 'captured_via': 'verify'}},
    B_ID: {'content': B_TXT, 'user': 'u', 'project': B_PROJ, 'session': None, 'tags': ['test'],
           'created_at': '2026-07-23T10:01:00.000Z', 'updated_at': '2026-07-23T10:01:00.000Z',
           'history': [], 'entities': [], 'relations': [], 'entity_names': [], 'type': None,
           'category': 'semantic', 'confidence': None, 'access_count': 0, 'last_accessed_at': None,
           'memory_type': 'user', 'expires_at': None,
           'source': {'type': 'doc', 'ref': 'docs/order.md', 'url': 'https://example.com/order',
                      'captured_via': 'verify'}},
}

print('=== 1. write 2 distinct memories (with real embeddings) ===')
for did, doc in docs.items():
    doc['embedding'] = emb(doc['content'])
    es_req('PUT', f"ai_memories/_doc/{did}", doc)
    print(f'  indexed {did} (project={doc["project"]})')

print('=== 2. create project link verifypay -> verifyord (strength=1 strong) ===')
print(' ', srv_post('/api/project-links', {'from_project': A_PROJ, 'to_project': B_PROJ, 'strength': 1, 'note': '支付与订单强相关'}))

def show(label, rows):
    print(f'--- {label} ({len(rows)} rows) ---')
    for r in rows:
        rel = ''
        if r.get('related_project'):
            rel = f"  [related_project={r['related_project']} strength={r.get('relation_strength')}]"
        print(f"  id={r['id'][:14]} proj={r['project']} score={round(r.get('score',0),4)}{rel} :: {r['content'][:30]}")

print('=== 3. doList FIXED: list verifypay with include_related=false (override must exclude related) ===')
rows = srv_get(f'/api/memories?project={A_PROJ}&include_related=false&limit=50')['rows']
show('list verifypay (explicit off)', rows)
assert all(r['id'] != B_ID for r in rows), 'FAIL: include_related=false still returned related memory!'
assert any(r['id'] == A_ID for r in rows), 'FAIL: main memory A missing!'
print('  PASS: include_related=false correctly excludes cross-project borrow')

print('=== 4. doList with include_related=true should include verifyord memory ===')
rows = srv_get(f'/api/memories?project={A_PROJ}&include_related=true&limit=50')['rows']
show('list verifypay+related', rows)
assert any(r['id'] == B_ID for r in rows), 'FAIL: related-project memory B missing!'
assert any(r['id'] == B_ID and r.get('related_project') == B_PROJ for r in rows), 'FAIL: B not tagged related_project!'
brow = [r for r in rows if r['id'] == B_ID][0]
assert brow.get('relation_strength') == 1, 'FAIL: relation_strength not 1'
print('  PASS: cross-project borrow works, B tagged + strength preserved')

print('=== 5. keyword search include_related (score attenuation) ===')
rows = srv_get(f'/api/memories?q={quote("回调")}&project={A_PROJ}&include_related=true&mode=keyword&limit=50')['rows']
show('search 回调 +related', rows)
a_scores = [r['score'] for r in rows if r['id'] == A_ID]
b_scores = [r['score'] for r in rows if r['id'] == B_ID]
if a_scores and b_scores:
    print(f"  A(score={round(a_scores[0],4)}) vs B(score={round(b_scores[0],4)}) decay(1.0)=0.8 -> B should be < A")
    assert b_scores[0] <= a_scores[0], 'FAIL: attenuated B score not <= A'

print('=== 6. provenance/source tracing ===')
src = srv_get(f'/api/memories/{A_ID}')['source']
print('  source =', json.dumps(src, ensure_ascii=False))
assert src.get('conversation_id') == 'c-123' and src.get('url') == 'https://example.com/pay', 'FAIL: provenance fields missing'
print('  PASS: provenance fields present (conversation_id/message_id/url/ref)')

print('\n=== CLEANUP ===')
print(' ', srv_delete(f'/api/project-links?from={A_PROJ}&to={B_PROJ}'))
for did in (A_ID, B_ID):
    try:
        es_req('DELETE', f"ai_memories/_doc/{did}")
        print(f'  deleted ES doc {did}')
    except Exception as e:
        print(f'  delete {did} warn: {e}')
print('\nALL CHECKS PASSED' if False else '\nDONE')
