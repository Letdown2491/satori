// Polling dev watcher for the Docker bind-mount loop.
//
// `node --watch` relies on inotify (fs.watch). Over the compose bind mount on this
// host, inotify events from host edits do NOT propagate into the container, so the
// daemon silently kept running STALE code (edits appeared on disk but never
// triggered a restart). This polls mtimes instead — stat-based polling works over
// any mount — and restarts the server child when src/ or public/ changes. Zero deps,
// pure Node, in keeping with the no-build setup. The host can still use
// `npm run dev` (native inotify works there); the container uses this.

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';

// Only the server's code graph — restarting on it picks up route/render changes.
// public/ (styles.css, helm.js, hx-ext.js) is static + served no-cache, so a browser
// refresh suffices; restarting on every CSS edit would needlessly drop in-flight
// undo holds. This matches what `node --watch src/server.ts` effectively watched.
const WATCH = ['src'];
const INTERVAL = 700; // ms between polls
const RUN = ['--experimental-strip-types', 'src/server.ts'];

let child = null;

function start() {
  child = spawn(process.execPath, RUN, { stdio: 'inherit' });
}

function restart() {
  if (!child) { start(); return; }
  const prev = child;
  child = null;
  prev.once('exit', start);         // re-bind the port only after the old one frees it
  prev.kill('SIGTERM');
  setTimeout(() => { try { prev.kill('SIGKILL'); } catch {} }, 2000); // hung-child fallback
}

// A signature of every watched file's path+mtime; any add/remove/edit changes it.
function snapshot() {
  let sig = '';
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else { try { sig += `${p}:${statSync(p).mtimeMs};`; } catch { /* vanished */ } }
    }
  };
  for (const d of WATCH) walk(d);
  return sig;
}

let last = snapshot();
start();

setInterval(() => {
  const now = snapshot();
  if (now !== last) {
    last = now;
    console.log('[dev-watch] change detected -> restarting');
    restart();
  }
}, INTERVAL);

// Forward container stop signals so `docker compose stop/restart` exits cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { if (child) try { child.kill(sig); } catch {} ; process.exit(0); });
}
