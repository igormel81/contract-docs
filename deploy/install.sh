#!/bin/sh
set -eu
release=/opt/contract-docs/releases/20260903-01
test -f "$release/package-lock.json"
test ! -e /opt/contract-docs/current
if ! id contract-docs >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/contract-docs --shell /usr/sbin/nologin contract-docs
fi
install -d -m 0700 -o contract-docs -g contract-docs /var/lib/contract-docs
cd "$release"
npm ci --omit=dev --ignore-scripts
node --check server/main.mjs
ln -s "$release" /opt/contract-docs/current
install -m 0644 deploy/contract-docs.service /etc/systemd/system/contract-docs.service
systemctl daemon-reload
systemctl enable --now contract-docs
echo 'Contract service installed; public route not changed yet.'
