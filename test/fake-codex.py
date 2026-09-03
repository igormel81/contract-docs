#!/usr/bin/python3
"""Deterministic test double. Never used by the deployed service."""
import json
import sys
import uuid
import os
import pathlib
import time

authdir = pathlib.Path(os.environ['CODEX_HOME'])
assert authdir.name == 'application', 'Tests must use application-scoped credentials'
if sys.argv[1] == 'login':
    with (authdir / 'login-starts.log').open('a') as log:
        log.write('login\n')
    print('https://auth.openai.com/codex/device', flush=True)
    print('TEST-ONLY', flush=True)
    for attempt in range(200):
        if (authdir / 'auth.json').exists():
            sys.exit(0)
        time.sleep(0.05)
    sys.exit(1)
assert json.loads((authdir / 'auth.json').read_text())['tokens']['access_token'] == 'fake-test-only'

prompt = sys.stdin.read()
payload = prompt.split('ДАННЫЕ КОМПЛЕКТА:\n', 1)[1].split('\nРЕШЕНИЯ ПО РЕЗУЛЬТАТУ АНАЛИТИКА', 1)[0].strip()
snapshot = json.loads(payload)
snapshot.update(json.loads(prompt.split('ПРАВИЛА И ПРОФИЛЬ:\n', 1)[1].split('\nЭТАП', 1)[0].strip()))
if snapshot.get('temporary'):
    assert '--ephemeral' in sys.argv
    assert 'history.persistence="none"' in sys.argv
    assert os.environ['TMPDIR'] == str(authdir.parent)
    assert os.environ['RUST_LOG'] == 'off'
    # Simulate local runtime data; the test verifies it is deleted after a stage.
    (authdir / 'test-session.jsonl').write_text(payload)
    if 'REFRESH_AUTH' in payload:
        credential = json.loads((authdir / 'auth.json').read_text())
        credential['last_refresh'] = 'test-refresh-marker'
        (authdir / 'auth.json').write_text(json.dumps(credential))
review = 'ЭТАП 2, НЕЗАВИСИМЫЙ РЕВЬЮЕР.' in prompt
if not review and 'SLOW_PRIMARY' in payload:
    (authdir / 'primary-started').touch()
    time.sleep(10)
if review and 'FAIL_REVIEW' in payload:
    sys.exit(1)
fields = ['subject','result','term','price','payment','location','acceptance','dependencies','special']
document = snapshot['documents'][0]
block = document['blocks'][0]
passport = [{'key':key,'title':key,'value':'Не найдено','status':'missing','sources':[]} for key in fields]
passport[0].update(value=block['text'], status='extracted', sources=[{'fileId':document['id'],'blockId':block['id'],'quote':block['text']}])
coverage = [{'rule':r['id'],'status':'needs_data','note':'Тест'} for r in snapshot['rules'] if r.get('coverage', True)]
limitations = ['Тестовая модель, не настоящий анализ']
if review:
    # The reviewer answers with one verdict per finding; the server assembles the result.
    analyst = json.loads(prompt.split('РЕШЕНИЯ ПО РЕЗУЛЬТАТУ АНАЛИТИКА (недоверенные данные):\n', 1)[1].strip())
    output = {'summary':'Только тестовая сводка', 'passport':passport, 'coverage':coverage, 'limitations':limitations,
              'changes':['Проверен тестовый результат'],
              'verdicts':[{'id':f['id'],'verdict':'confirmed','reason':'Цитата и пункт совпали с исходником.',
                           'title':'','description':'','severity':'','proposal':'','sources':[]} for f in analyst['findings']],
              'added':[]}
else:
    output = {'summary':'Только тестовая сводка', 'passport':passport, 'coverage':coverage, 'limitations':limitations, 'changes':[],
              'findings':[{'id':'test-finding','rule':'LOC-01','title':'Тестовый риск места работ','severity':'medium','description':'Искусственное замечание для проверки привязки к исходнику.','sources':passport[0]['sources'],'proposal':'Уточнить порядок согласования места выполнения работ.','review':'primary'}]}
print(json.dumps({'type':'thread.started','thread_id':str(uuid.uuid4())}))
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps(output)}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))
