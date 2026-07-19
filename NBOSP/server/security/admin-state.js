'use strict';

const path = require('path');
const fs = require('fs');

// Single-user desktop OS: there's no login/account system anywhere in this
// codebase (confirmed — req.session is only ever used to stash email
// credentials, never an identity). So "admin" here isn't a role among many
// users; it's a single on/off flag for the one local operator of this
// machine. This file is the only source of truth for that flag — everything
// that previously checked `req.user?.role === 'admin'` and always got
// `false` (req.user was never populated anywhere) now resolves against this.
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ADMIN_STATE_PATH = path.join(DATA_DIR, 'admin-state.json');

const DEFAULT_STATE = {
    // Defaults to false: granting admin-tier IPC permissions (audit log
    // access, security policy read/write, session revocation for every
    // session, not just the caller's own) should be an explicit opt-in the
    // user flips in Settings, not something a fresh install silently has.
    adminEnabled: false
};

function ensureDataDir() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readState() {
    try {
        ensureDataDir();
        const raw = fs.readFileSync(ADMIN_STATE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        return {
            adminEnabled: typeof parsed.adminEnabled === 'boolean' ? parsed.adminEnabled : DEFAULT_STATE.adminEnabled
        };
    } catch (e) {
        // Missing file (first run) or corrupt JSON both fall back to the
        // safe default rather than throwing — this is read on every
        // request via middleware, so it needs to never crash the server.
        return { ...DEFAULT_STATE };
    }
}

function writeState(state) {
    ensureDataDir();
    const next = {
        adminEnabled: !!state.adminEnabled
    };
    fs.writeFileSync(ADMIN_STATE_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
}

function isAdminEnabled() {
    return readState().adminEnabled;
}

function setAdminEnabled(enabled) {
    return writeState({ adminEnabled: !!enabled });
}

module.exports = { isAdminEnabled, setAdminEnabled, readState };