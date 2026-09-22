import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway loopback TLS pair for the cloud-vendor fixtures, generated per
// test run. A committed key — even a synthetic one — is a private key in Git:
// the publication guard (scripts/publication.mjs) refuses to package it, and
// the repository rule forbids it outright.
let pair = null;
export function selfSignedPair() {
  if (pair) return pair;
  const dir = mkdtempSync(join(tmpdir(), 'docs-tls-fixture-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'),
      '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' });
    pair = { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') };
    return pair;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The fixture certificate is self-signed and in no trust store; every server
// in these files is our own loopback fixture, never a real vendor endpoint.
export function acceptFixtureCertificates() { process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; }
