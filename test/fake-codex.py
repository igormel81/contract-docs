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
payload = prompt.split('ДАННЫЕ КОМПЛЕКТА:\n', 1)[1].split('\nРЕЗУЛЬТАТ АНАЛИТИКА', 1)[0].strip()
snapshot = json.loads(payload)
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
output = {'summary':'Только тестовая сводка', 'passport':passport, 'findings':[], 'coverage':[{'rule':r['id'],'status':'needs_data','note':'Тест'} for r in snapshot['rules']], 'limitations':['Тестовая модель, не настоящий анализ'], 'changes':['Проверен тестовый результат'] if review else []}
print(json.dumps({'type':'thread.started','thread_id':str(uuid.uuid4())}))
print(json.dumps({'type':'item.completed','item':{'type':'agent_message','text':json.dumps(output)}}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':1,'output_tokens':1}}))
