// Regression guards for the package-wide delete confirmation.
//
// Why static instead of rendered: this repo has no jsdom/testing-library
// (see docs/records/HANDOFF_2026-11-13.md, open item E), so the only cheap,
// reliable signal is source-level. These checks fail loudly if someone
// reintroduces `window.confirm()` on a destructive action, drops a screen from
// the migration, or strips the dialog's accessibility contract.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const studioSrc = join(root, 'packages', 'studio', 'src');
const componentsDir = join(studioSrc, 'components');

// Screens that own a destructive action and must use the shared dialog.
// `ImageStudio` shipped first; the rest were migrated in the same pass.
const DESTRUCTIVE_SCREENS = [
    'CinemaStudio.jsx',
    'DrawModal.jsx',
    'ImageStudio.jsx',
    'LipSyncStudio.jsx',
    'MarketingStudio.jsx',
    'MotionControlStudio.jsx',
    'RecastStudio.jsx',
    'VibeMotionStudio.jsx',
    'VideoStudio.jsx',
    'WorkflowStudio.jsx',
];

function read(relativePath) {
    return readFileSync(join(studioSrc, relativePath), 'utf8');
}

// Strip comments before scanning, otherwise the explanatory comments that
// mention `window.confirm()` read as live calls.
function stripComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function jsonKeys(locale) {
    const file = join(studioSrc, 'messages', locale, 'confirmDialog.json');
    return JSON.parse(readFileSync(file, 'utf8'));
}

test('confirmDialog copy bundles expose the same non-empty keys in both locales', () => {
    const en = jsonKeys('en');
    const zh = jsonKeys('zh');

    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
    for (const key of Object.keys(en)) {
        assert.ok(en[key].trim().length > 0, `en.${key} is empty`);
        assert.ok(zh[key].trim().length > 0, `zh.${key} is empty`);
    }

    // The dialog renders these five; `failed` is the generic error fallback.
    for (const key of ['deleteTitle', 'deleteDescription', 'deleteAction', 'deleteCancel', 'deleteBusy', 'failed']) {
        assert.ok(key in en, `missing en.${key}`);
    }
});

test('confirmCopy resolves en by default and zh for Chinese locales without importing JSON in node', () => {
    // The module itself imports JSON, which node cannot load without import
    // attributes, so the resolver is exercised through its source contract:
    // unknown locales must fall back rather than return undefined.
    const source = read('confirmCopy.js');
    assert.match(source, /if \(!locale \|\| locale === "en"\) return en;/);
    assert.match(source, /return BUNDLES\[tag\] \|\| en;/);
    assert.match(source, /tag === "zh" \|\| tag\.startsWith\("zh-"\)/);
});

test('no studio component calls the native confirm() global', () => {
    const offenders = [];
    for (const file of readdirSync(componentsDir)) {
        if (!file.endsWith('.jsx')) continue;
        const code = stripComments(readFileSync(join(componentsDir, file), 'utf8'));
        // Two patterns on purpose:
        // 1. bare `confirm(` — `getConfirmCopy(` and `<ConfirmDialog` do not
        //    match, because the guard requires a lowercase `confirm` preceded
        //    by a non-identifier, non-dot character;
        // 2. `window.confirm(` — the dot would hide it from pattern 1, and it
        //    is exactly the form the host app uses (components/TaskCenter.js).
        if (/(^|[^A-Za-z0-9_$.])confirm\s*\(|window\.confirm\s*\(/.test(code)) offenders.push(file);
    }
    assert.deepEqual(offenders, [], `native confirm() still used in: ${offenders.join(', ')}`);
});

// Host app layer. `components/` and `app/` sit outside `packages/studio`, so
// the studio-only scan above cannot see them — yet the host is the layer that
// actually shipped the last native `confirm()` (components/TaskCenter.js).
const HOST_DIRS = ['components', 'app'];

function walkSourceFiles(dir, acc = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walkSourceFiles(full, acc);
        else if (/\.(js|jsx|mjs)$/.test(entry.name)) acc.push(full);
    }
    return acc;
}

test('no host component or route calls the native confirm() global', () => {
    const scanned = HOST_DIRS.flatMap((dir) => walkSourceFiles(join(root, dir)));
    // Without this the gate would pass vacuously if the walker ever stopped
    // resolving paths (e.g. a renamed directory) — a green result would mean
    // "nothing was scanned", not "nothing is wrong".
    assert.ok(
        scanned.some((file) => file.endsWith(join('components', 'TaskCenter.js'))),
        'host scan did not reach components/TaskCenter.js',
    );
    assert.ok(scanned.length >= 20, `host scan only found ${scanned.length} files`);

    const offenders = [];
    for (const file of scanned) {
        const code = stripComments(readFileSync(file, 'utf8'));
        if (/(^|[^A-Za-z0-9_$.])confirm\s*\(|window\.confirm\s*\(/.test(code)) {
            offenders.push(file.slice(root.length + 1).split('\\').join('/'));
        }
    }
    assert.deepEqual(offenders, [], `native confirm() still used in host layer: ${offenders.join(', ')}`);
});

test('host task cancellation goes through the shared dialog on the subpath entry', () => {
    const code = readFileSync(join(root, 'components', 'TaskCenter.js'), 'utf8');
    // Subpath, not `from 'studio'`: the barrel re-exports all 15 studios, which
    // would drag reactflow / react-markdown / syntax-highlighter into the task
    // panel just to confirm a cancellation.
    assert.match(code, /from 'studio\/ConfirmDialog'/);
    assert.match(code, /<ConfirmDialog/);
    assert.match(code, /onClick=\{\(\) => setPendingCancel\(task\)\}/);
    // The dialog must be driven by the same busy flag that disables the row
    // button, otherwise a double click can POST /cancel twice.
    assert.match(code, /busy=\{Boolean\(pendingCancel\) && busyTaskId === pendingCancel\.id\}/);
});

test('every destructive screen imports the shared dialog and renders it', () => {
    const missing = [];
    for (const file of DESTRUCTIVE_SCREENS) {
        const code = readFileSync(join(componentsDir, file), 'utf8');
        if (!/from "\.\/ui\/ConfirmDialog\.jsx"/.test(code)) missing.push(`${file} (no import)`);
        else if (!/<ConfirmDialog/.test(code)) missing.push(`${file} (imported but not rendered)`);
    }
    assert.deepEqual(missing, [], `screens not using ConfirmDialog: ${missing.join(', ')}`);
});

test('ConfirmDialog keeps its accessibility and focus contract', () => {
    const code = read('components/ui/ConfirmDialog.jsx');
    assert.match(code, /createPortal/);
    assert.match(code, /role="alertdialog"/);
    assert.match(code, /aria-modal="true"/);
    assert.match(code, /aria-labelledby=\{titleId\}/);
    // Cancel must be the element that receives focus on open (safe default).
    assert.match(code, /cancelRef\.current \|\| panelRef\.current/);
    // Busy must block Esc, backdrop clicks and double submit.
    assert.match(code, /if \(busy\) return;/);
    // Reduced motion collapses every duration, including the unmount timer.
    assert.match(code, /reducedMotion \? 0 : EXIT_MS/);
});
