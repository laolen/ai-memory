#!/usr/bin/env python3
# v1.8.0 端到端验证：B1 用户纠正学习 + 质量监控(/api/metrics)
# 用法: python3 verify_b1_quality.py  (在 128 /opt/ai-memory 下运行，需服务在 :8765)
import urllib.request, json, sys, urllib.parse

SRV = 'http://localhost:8765'

def post(path, body, timeout=120):
    req = urllib.request.Request(SRV + path, data=json.dumps(body).encode(), method='POST')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())

def get(path, timeout=30):
    with urllib.request.urlopen(SRV + path, timeout=timeout) as r:
        return json.loads(r.read().decode())

def delete(path, timeout=30):
    req = urllib.request.Request(SRV + path, method='DELETE')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status

def fail(msg):
    print('FAIL:', msg); sys.exit(1)

def cleanup_project(proj):
    try:
        rows = get('/api/memories?project=' + urllib.parse.quote(proj) + '&limit=200').get('rows') or []
        for r in rows:
            try: delete(f'/api/memories/{r["id"]}')
            except Exception: pass
        print(f'  (已清理 {len(rows)} 条 {proj} 旧数据)')
    except Exception as e:
        print('  (清理旧数据失败，可忽略):', e)

print('=== B1 用户纠正学习 ===')
cleanup_project('verify_b1')
# 1) 写入一条测试记忆
cap = post('/api/capture', {'text': '我们团队主数据库用的是 MySQL。', 'user': 'verify', 'project': 'verify_b1', 'tags': ['test']})
items = cap.get('items') or []
mid = None
for it in items:
    if it.get('id'):
        mid = it['id']; break
if not mid:
    # 回退：按内容检索定位
    rows = get('/api/memories?q=' + urllib.parse.quote('MySQL') + '&project=verify_b1').get('rows') or []
    mid = rows[0]['id'] if rows else None
if not mid:
    fail('capture 未返回记忆 id 且检索不到')
print('  capture:', json.dumps(cap, ensure_ascii=False)[:200])
print('  测试记忆 id =', mid)

# 2) 纠正前状态
m0 = get(f'/api/memories/{mid}')
cc0 = m0.get('correction_count') or 0
print(f'  纠正前: correction_count={cc0}, confidence={m0.get("confidence")}')

# 3) 应用纠正
cor = post('/api/correct', {'target_id': mid, 'feedback': '不对，我们用的是 PostgreSQL 不是 MySQL。',
                            'user': 'verify', 'project': 'verify_b1'})
print('  correct 返回:', json.dumps(cor, ensure_ascii=False))
if cor.get('corrected') is not True:
    fail('corrected != true: ' + str(cor))
if cor.get('correction_count') != cc0 + 1:
    fail(f'correction_count 未按 +1 增长: {cor.get("correction_count")} vs {cc0}+1')

# 4) 持久化校验
m1 = get(f'/api/memories/{mid}')
print(f'  纠正后: correction_count={m1.get("correction_count")}, corrected_at={m1.get("corrected_at")}, confidence={m1.get("confidence")}')
if m1.get('correction_count') != 1:
    fail('correction_count 未持久化为 1')
if not m1.get('corrected_at'):
    fail('corrected_at 未写入')
if float(m1.get('confidence') or 0) < 0.9 - 1e-6:
    fail('confidence 未达 0.9（设计：仅在原 confidence<0.9 时提升至 0.9）')
if len(m1.get('history') or []) < 1:
    fail('旧版本未进入 history')
print('  PASS: B1 纠正已应用并持久化 (count=1, corrected_at 存在, confidence=0.9, history 保留)')

print('\n=== 质量监控 /api/metrics ===')
met = get('/api/metrics')
if not ('live' in met and 'by_op' in met and 'by_day' in met):
    fail('metrics 结构缺失 live/by_op/by_day')
L = met['live']
print('  live:', json.dumps(L, ensure_ascii=False))
if (L.get('total') or 0) < 2:
    fail('live.total 过小（应至少含 add + update）')
ops = {o['op'] for o in met['by_op']}
print('  by_op:', json.dumps(met['by_op'], ensure_ascii=False))
if 'add' not in ops:
    fail('by_op 缺少 add 操作计数')
if 'update' not in ops:
    fail('by_op 缺少 update 操作计数')
print('  PASS: /api/metrics 返回 live/by_op/by_day，且 add/update 操作已被采集')

# 清理
try:
    delete(f'/api/memories/{mid}')
    print('\n  已清理测试记忆', mid)
except Exception as e:
    print('  清理失败(可忽略):', e)

print('\nALL B1 + QUALITY TESTS PASSED')
