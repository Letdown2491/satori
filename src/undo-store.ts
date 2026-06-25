// On-disk persistence for undo-window holds, mirroring store.ts. A signed-but-not-
// yet-published event survives a server restart, so a crash/reload inside the brief
// undo window doesn't silently drop the post - resumeHolds() (undo.ts) re-arms the
// auto-commit on boot. Held events are already signed and bound for public relays
// (no new trust concern); the file is written 0600 and lives under the gitignored
// .data/ (bind-mounted in docker, so it survives the --watch reloads that bit us).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Held } from './undo.ts';

const FILE = process.env.SATORI_HOLDS_FILE || join(process.cwd(), '.data', 'holds.json');

function readAll(): Record<string, Held> {
    try { return JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, Held>; }
    catch { return {}; }
}

function writeAll(all: Record<string, Held>): void {
    try {
        mkdirSync(dirname(FILE), { recursive: true });
        writeFileSync(FILE, JSON.stringify(all), { mode: 0o600 });
    } catch (e) {
        console.warn('[undo-store] could not persist holds:', (e as Error)?.message ?? e);
    }
}

export function loadHolds(): Record<string, Held> { return readAll(); }

export function saveHold(token: string, h: Held): void {
    const all = readAll();
    all[token] = h;
    writeAll(all);
}

export function removeHold(token: string): void {
    const all = readAll();
    if (token in all) { delete all[token]; writeAll(all); }
}
