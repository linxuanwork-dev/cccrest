#!/usr/bin/env node
/* CC CREST folder watcher
   - watches one folder per company: every new bill file (PDF / JPG / PNG / WEBP) is uploaded to the Purchases Bill inbox of that company,
     then renamed (PREFIX-PURCHASE-YYYY_MM-NNN.ext, the name the system gives) and moved to the company's "uploaded" folder;
   - moves the Excel files the system exports (found in the Downloads folder by their name prefix) to the company's "exports" folder.
   No packages needed: Node 18 or newer.  Usage:  node watcher.js [config.json] [--once]   */
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const once = args.includes('--once');
const cfgPath = args.find((a) => !a.startsWith('--')) || path.join(__dirname, 'config.json');
if (!fs.existsSync(cfgPath)) { console.error('config.json not found: ' + cfgPath + '\nCopy config.example.json to config.json and fill it in.'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const SERVER = String(cfg.server || '').replace(/\/+$/, '');
if (!SERVER || !Array.isArray(cfg.companies) || !cfg.companies.length) { console.error('config.json needs "server" and at least one entry in "companies".'); process.exit(1); }

const LOG = path.join(__dirname, 'watcher.log');
function log(msg) {
  const line = new Date().toLocaleString('sv-SE').slice(0, 19) + '  ' + msg;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* the log is a convenience */ }
}

const OK = /\.(pdf|jpe?g|png|webp)$/i;
const TEMP = /\.(crdownload|tmp|part|download)$|^~\$|^\./i;
const STABLE_MS = 3000;                 // a file is taken when its size has not changed for this long (it may still be copying / downloading)
const seen = new Map();                 // path -> { size, since }
const failures = new Map();             // path -> { n, next }

const mkdirs = (d) => { if (d && !fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); };
function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 1000; i++) { p = path.join(dir, base + '-' + i + ext); if (!fs.existsSync(p)) return p; }
  return path.join(dir, base + '-' + Date.now() + ext);
}
function moveFile(from, to) {   // rename does not work across drives: copy, then delete
  try { fs.renameSync(from, to); } catch (e) { fs.copyFileSync(from, to); fs.unlinkSync(from); }
}
function stable(full) {
  let st; try { st = fs.statSync(full); } catch (e) { return false; }
  if (!st.isFile()) return false;
  const s = seen.get(full), now = Date.now();
  if (!s || s.size !== st.size) { seen.set(full, { size: st.size, since: now }); return once ? true : false; }
  return once || now - s.since >= STABLE_MS;
}

async function upload(co, full) {
  const name = path.basename(full);
  const body = fs.readFileSync(full);
  const res = await fetch(SERVER + '/api/inbox/upload?name=' + encodeURIComponent(name), {
    method: 'POST', headers: { Authorization: 'Bearer ' + co.token, 'Content-Type': 'application/octet-stream' }, body
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((j && j.error) || ('HTTP ' + res.status));
  return j;
}

async function scanInbox(co) {
  mkdirs(co.inbox); mkdirs(co.done);
  for (const f of fs.readdirSync(co.inbox)) {
    if (!OK.test(f) || TEMP.test(f)) continue;
    const full = path.join(co.inbox, f);
    if (!stable(full)) continue;
    const fail = failures.get(full);
    if (fail && Date.now() < fail.next) continue;
    try {
      const j = await upload(co, full);
      const target = uniquePath(co.done, j.name || f);
      moveFile(full, target);
      seen.delete(full); failures.delete(full);
      log('[' + co.name + '] ' + f + ' -> inbox' + (j.duplicate ? ' (already there)' : '') + ' ; saved as ' + path.relative(path.dirname(co.done), target));
    } catch (e) {
      const n = (fail ? fail.n : 0) + 1;
      failures.set(full, { n, next: Date.now() + Math.min(600000, 15000 * n) });
      log('[' + co.name + '] could not upload ' + f + ': ' + e.message + ' (will retry)');
    }
  }
}

function scanDownloads() {
  const dir = cfg.downloads; if (!dir || !fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.xlsx$/i.test(f) || TEMP.test(f)) continue;
    const co = cfg.companies.find((c) => c.exportPrefix && f.toUpperCase().startsWith(String(c.exportPrefix).toUpperCase()) && c.exports);
    if (!co) continue;
    const full = path.join(dir, f);
    if (!stable(full)) continue;
    try {
      mkdirs(co.exports);
      const target = uniquePath(co.exports, f);
      moveFile(full, target); seen.delete(full);
      log('[' + co.name + '] export ' + f + ' -> ' + target);
    } catch (e) { log('[' + co.name + '] could not move ' + f + ': ' + e.message); }
  }
}

async function tick() {
  for (const co of cfg.companies) {
    if (!co.token || !co.inbox || !co.done) { log('[' + (co.name || '?') + '] config needs token, inbox and done'); continue; }
    try { await scanInbox(co); } catch (e) { log('[' + co.name + '] ' + e.message); }
  }
  try { scanDownloads(); } catch (e) { log('downloads: ' + e.message); }
}

(async () => {
  log('Folder watcher started (' + cfg.companies.map((c) => c.name).join(', ') + ')' + (once ? ' - one pass' : ''));
  if (once) { await tick(); await tick(); return; }   // twice: the first pass only notes the file sizes
  await tick();
  setInterval(() => { tick().catch((e) => log('error: ' + e.message)); }, Math.max(2, Number(cfg.intervalSeconds) || 5) * 1000);
})();
