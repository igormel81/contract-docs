#!/usr/bin/python3
"""Deterministic test double. Never used by the deployed service."""
import json
import sys
import uuid

prompt = sys.stdin.read()
payload = prompt.split('ДАННЫЕ КОМПЛЕКТА:\n', 1)[1].split('\nРЕЗУЛЬТАТ АНАЛИТИКА', 1)[0].strip()
snapshot = json.loads(payload)
review = 'ЭТАП 2, НЕЗАВИСИМЫЙ РЕВЬЮЕР.' in prompt
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
