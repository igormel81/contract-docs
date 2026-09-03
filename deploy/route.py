"""Add only igoruan.ru/docs; preserve all existing services and secrets on VPS."""
from pathlib import Path
import os
import shutil
import subprocess
import datetime

target = Path('/etc/caddy-naive/Caddyfile')
original = target.read_text()
marker = '# contract-docs route'
if marker in original:
    raise SystemExit('Route already exists; inspect before changing.')
anchor = '\treverse_proxy 127.0.0.1:8099'
if original.count(anchor) != 1 or '/docs' in original:
    raise SystemExit('Unexpected Caddy routes; no changes made.')
route = '''\t# contract-docs route
\t@contract_docs {
\t\thost igoruan.ru
\t\tpath /docs /docs/*
\t}
\thandle @contract_docs {
\t\treverse_proxy 127.0.0.1:3107
\t}

'''
candidate = target.with_name('Caddyfile.contract-docs-candidate')
candidate.write_text(original.replace(anchor, route + anchor))
shutil.copystat(target, candidate)
os.chown(candidate, target.stat().st_uid, target.stat().st_gid)
checked = subprocess.run(['/usr/local/bin/caddy-naive','validate','--config',str(candidate),'--adapter','caddyfile'],capture_output=True)
if checked.returncode:
    raise SystemExit('Caddy validation failed; live configuration unchanged. Inspect candidate on VPS.')
backup_dir = Path('/var/backups/contract-docs')
backup_dir.mkdir(mode=0o700, exist_ok=True)
backup = backup_dir / ('Caddyfile.before-docs-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
shutil.copy2(target, backup)
backup.chmod(0o600)
os.replace(candidate,target)
subprocess.run(['systemctl','kill','--kill-who=main','--signal=SIGUSR1','caddy-naive'],check=True)
print('Validated docs route installed; Caddy reloaded by SIGUSR1. Backup: '+str(backup))
