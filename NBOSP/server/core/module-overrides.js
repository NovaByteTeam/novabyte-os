const path = require('path');
const fs = require('fs');
const os = require('os');

// The installed image (/opt/nbosp/package.nw) is root-owned, so the Modules
// editor can't write there. Edits go to a per-user folder that mirrors the
// served js/ tree, and this middleware serves them ahead of the shipped files.
// The editor in js/apps/modules/app.js builds the same path; keep them in sync.
const OVERRIDABLE = /^js\/.+\.m?js$/;

function overrideRoot() {
    const fromEnv = process.env.NOVABYTE_MODULE_OVERRIDES_DIR;
    if (fromEnv) return path.resolve(fromEnv);
    return path.join(os.homedir(), '.local', 'share', 'novabyte', 'module-overrides');
}

function moduleOverrides({ root = overrideRoot() } = {}) {
    const base = path.resolve(root);
    return (req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let rel;
        try {
            rel = decodeURIComponent(req.path).replace(/^\/+/, '');
        } catch (_) {
            return next();
        }
        if (!OVERRIDABLE.test(rel)) return next();
        const file = path.resolve(base, rel);
        if (!file.startsWith(base + path.sep)) return next();
        fs.stat(file, (err, stat) => {
            if (err || !stat.isFile()) return next();
            // Passing `root` (instead of the absolute path) keeps express from
            // rejecting the dot-directory in ~/.local as a hidden file.
            res.sendFile(rel, { root: base, headers: { 'Cache-Control': 'no-cache' } }, (sendErr) => {
                if (sendErr && !res.headersSent) next();
            });
        });
    };
}

module.exports = { moduleOverrides, overrideRoot };
