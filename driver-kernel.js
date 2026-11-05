/**
 * NovaByte Driver Kernel
 * ──────────────────────
 * Manages .drv packages: install, load, execute, sandbox, permissions.
 * Plug into server.js with:
 *   const driverKernel = require('./driver-kernel');
 *   app.use('/api/drivers', driverKernel);
 *
 * Auth: set DRIVER_API_KEY env var. All mutating routes require
 *   Authorization: Bearer <key>
 */

'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const os      = require('os');
const vm      = require('vm');                          // FIX #1 — real sandbox

const { DRV_FORMAT_VERSION, ALLOWED_PERMISSIONS, DANGEROUS_PERMISSIONS } =
    require('./drv-constants');                         // FIX #11 — shared constants

const router = express.Router();

// ─── Config ───────────────────────────────────────────────────────────────────

const DRIVERS_DIR   = path.join(__dirname, 'drivers');
const REGISTRY_FILE = path.join(DRIVERS_DIR, 'registry.json');
const BUILTIN_DIR   = path.join(DRIVERS_DIR, 'built-in');
const API_KEY       = process.env.DRIVER_API_KEY || null;

[DRIVERS_DIR, BUILTIN_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ─── Auth middleware ──────────────────────────────────────────────────────────
// FIX #4 — bearer-token auth on all mutating routes

function requireAuth(req, res, next) {
    if (!API_KEY) return next();   // no key configured → open (dev mode)
    const auth  = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    try {
        if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(API_KEY))) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
    } catch {
        return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    next();
}

// ─── Registry (atomic writes + simple async mutex) ───────────────────────────
// FIX #8 — prevent concurrent write corruption via queued exclusive access

let _registryLock = false;
const _registryQueue = [];

function loadRegistry() {
    try {
        return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveRegistry(reg) {
    // Atomic write: temp file then rename so a crash mid-write never corrupts
    const tmp = REGISTRY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
    fs.renameSync(tmp, REGISTRY_FILE);
}

function withRegistry(fn) {
    return new Promise((resolve, reject) => {
        const run = async () => {
            _registryLock = true;
            try {
                const reg    = loadRegistry();
                const result = await fn(reg);
                resolve(result);
            } catch (e) {
                reject(e);
            } finally {
                _registryLock = false;
                if (_registryQueue.length) _registryQueue.shift()();
            }
        };
        if (_registryLock) {
            _registryQueue.push(run);
        } else {
            run();
        }
    });
}

// ─── .drv Parser ─────────────────────────────────────────────────────────────

function parseDrv(raw) {
    let pkg;
    try {
        pkg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
        const preview = typeof raw === 'string' ? raw.substring(0, 100) : JSON.stringify(raw).substring(0, 100);
        throw new Error(`Invalid .drv: not valid JSON. Received (first 100 chars): ${preview}`);
    }

    if (pkg.novabyte_drv !== DRV_FORMAT_VERSION) {
        throw new Error('Invalid .drv: wrong format version');
    }

    const { manifest, files, signature } = pkg;

    if (!manifest?.id || !manifest?.name || !manifest?.version) {
        throw new Error('Invalid .drv: missing required manifest fields');
    }

    if (!files || typeof files !== 'object') {
        throw new Error('Invalid .drv: missing files bundle');
    }

    if (!files[manifest.entry || 'driver.js']) {
        throw new Error('Invalid .drv: entry file not in bundle');
    }

    // FIX #2 — verify signature every time a .drv is parsed
    const expected = crypto
        .createHash('sha256')
        .update(JSON.stringify(files))
        .digest('hex');

    if (expected !== signature) {
        throw new Error(
            `Invalid .drv: signature mismatch — package may have been tampered with\n` +
            `  expected: ${expected}\n` +
            `  got:      ${signature}`
        );
    }

    return pkg;
}

// ─── Permission helpers ───────────────────────────────────────────────────────

function validatePermissions(permissions) {
    if (!Array.isArray(permissions)) return [];
    return permissions.filter(p => ALLOWED_PERMISSIONS.includes(p));
}

// ─── Driver Sandbox (vm-based) ────────────────────────────────────────────────
// FIX #1 — replace eval/new Function with vm.runInContext
// Drivers have no access to process, the real require, __dirname, Buffer, etc.

function createSandbox(manifest, permissions) {
    const allowed = new Set(validatePermissions(permissions));
    const SAFE_MODULES = new Set(['path', 'url', 'querystring', 'crypto', 'util', 'os']);

    const safeRequire = (mod) => {
        if (SAFE_MODULES.has(mod)) return require(mod);
        throw new Error(`[Driver sandbox] require('${mod}') not permitted`);
    };

    const ctx = {
        driver:  { id: manifest.id, name: manifest.name, version: manifest.version },
        log:     (...args) => console.log(`[Driver:${manifest.id}]`, ...args),
        system:  allowed.has('system')  ? { platform: os.platform(), arch: os.arch(),
                     cpus: os.cpus().length, totalMem: os.totalmem(), freeMem: os.freemem() } : null,
        network: allowed.has('network') ? { interfaces: os.networkInterfaces() } : null,
        safeRequire,
    };

    return vm.createContext({
        module:   { exports: {} },
        exports:  {},
        console:  { log: ctx.log, warn: ctx.log, error: ctx.log },
        require:  safeRequire,
        context:  ctx,
        log:      ctx.log,
        system:   ctx.system,
        network:  ctx.network,
        // Safe globals
        JSON, Math, Date, parseInt, parseFloat,
        isNaN, isFinite, encodeURIComponent, decodeURIComponent,
        setTimeout:    () => { throw new Error('setTimeout not permitted in driver sandbox'); },
        setInterval:   () => { throw new Error('setInterval not permitted in driver sandbox'); },
        clearTimeout:  () => {},
        clearInterval: () => {},
    });
}

// ─── Driver Executor ──────────────────────────────────────────────────────────

const loadedDrivers = {};

function loadDriver(drvPath) {
    const raw  = fs.readFileSync(drvPath, 'utf8');
    const pkg  = parseDrv(raw);                // signature verified here
    const { manifest, files } = pkg;

    const entryName = manifest.entry || 'driver.js';
    const entryCode = Buffer.from(files[entryName], 'base64').toString('utf8');
    const sandbox   = createSandbox(manifest, manifest.permissions || []);

    try {
        vm.runInContext(entryCode, sandbox, {
            filename:      `${manifest.id}/${entryName}`,
            timeout:       2000,
            microtaskMode: 'afterEvaluate'
        });
    } catch (e) {
        throw new Error(`[Driver:${manifest.id}] Load error: ${e.message}`);
    }

    const driverModule = Object.keys(sandbox.module.exports).length
        ? sandbox.module.exports
        : sandbox.exports;

    return { manifest, module: driverModule, ctx: sandbox.context, pkg };
}

// ─── Utility: extract exported action names ───────────────────────────────────
// FIX #6 — shared helper used by GET /:id and list-actions

function extractActions(files, entryName) {
    try {
        const code    = Buffer.from(files[entryName], 'base64').toString('utf8');
        const actions = [];

        const block = code.match(/module\.exports\s*=\s*\{([^}]+)\}/s);
        if (block) {
            (block[1].match(/(\w+)\s*:/g) || [])
                .forEach(k => actions.push(k.replace(':', '').trim()));
        }

        let m;
        const re = /exports\.(\w+)\s*=/g;
        while ((m = re.exec(code)) !== null) {
            if (!actions.includes(m[1])) actions.push(m[1]);
        }

        return actions;
    } catch {
        return [];
    }
}

// ─── API Routes ───────────────────────────────────────────────────────────────

/** GET /api/drivers — list all installed drivers */
router.get('/', (req, res) => {
    try {
        const registry = loadRegistry();
        const drivers  = Object.values(registry).map(entry => ({
            id:          entry.manifest.id,
            name:        entry.manifest.name,
            version:     entry.manifest.version,
            description: entry.manifest.description || '',
            permissions: entry.manifest.permissions || [],
            targets:     entry.manifest.targets || [],
            platform:    entry.manifest.platform || [],
            enabled:     entry.enabled,
            builtin:     entry.builtin || false,
            installedAt: entry.installedAt,
            updatedAt:   entry.updatedAt || null,
            status:      loadedDrivers[entry.manifest.id] ? 'active' : 'installed'
        }));
        res.json({ ok: true, count: drivers.length, drivers });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/**
 * GET /api/drivers/detect — detect host env and recommend drivers
 * FIX #3 — hostname removed from response
 */
router.get('/detect', (req, res) => {
    try {
        const ua       = req.headers['user-agent'] || '';
        const platform = os.platform();
        const arch     = os.arch();

        let browser = 'unknown';
        if      (/Edg\//i.test(ua))     browser = 'edge';
        else if (/OPR\//i.test(ua))     browser = 'opera';
        else if (/Chrome\//i.test(ua))  browser = 'chrome';
        else if (/Firefox\//i.test(ua)) browser = 'firefox';
        else if (/Safari\//i.test(ua))  browser = 'safari';

        const verMatch       = ua.match(/(Chrome|Firefox|Safari|Edg|OPR)\/(\d+)/i);
        const browserVersion = verMatch ? parseInt(verMatch[2]) : null;

        let hostOS = platform;
        if (platform === 'win32')  hostOS = 'windows';
        if (platform === 'darwin') hostOS = 'mac';

        const capabilities = {
            webUSB:            browser === 'chrome' || browser === 'edge',
            webSerial:         browser === 'chrome' || browser === 'edge',
            webGPU:            browser === 'chrome' || browser === 'edge',
            webBluetooth:      browser === 'chrome' || browser === 'edge',
            offscreenCanvas:   browser !== 'firefox',
            sharedArrayBuffer: true
        };

        const registry    = loadRegistry();
        const recommended = Object.values(registry)
            .filter(e => e.enabled)
            .filter(e => {
                const t = e.manifest.targets  || [];
                const p = e.manifest.platform || [];
                return (t.length === 0 || t.includes(browser) || t.includes('*')) &&
                       (p.length === 0 || p.includes(hostOS)  || p.includes('*'));
            })
            .map(e => e.manifest.id);

        res.json({
            ok: true,
            environment: { browser, browserVersion, os: hostOS, arch, platform, ua },
            capabilities,
            recommended,
            system: {              // hostname intentionally omitted (FIX #3)
                cpus:     os.cpus().length,
                totalMem: os.totalmem(),
                freeMem:  os.freemem()
            }
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/**
 * POST /api/drivers/install — install a .drv package
 * FIX #2  signature verified in parseDrv
 * FIX #4  requireAuth
 * FIX #7  evict stale cache on reinstall
 * FIX #13 version downgrade warning + update log
 */
router.post('/install', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
    try {
        // Extract raw .drv payload - could be { drv: "..." } or direct object
        let raw = req.body?.drv;
        
        // If not wrapped, check if body itself is a .drv object
        if (!raw && req.body?.novabyte_drv) {
            raw = req.body;
        }
        
        if (!raw) return res.status(400).json({ ok: false, error: 'Missing drv payload' });

        // Ensure raw is a string for parsing
        if (typeof raw === 'object') {
            raw = JSON.stringify(raw);
        }

        // Debug: log the type and length of raw
        const rawLen = raw.length;
        console.log(`[DriverKernel] /install: raw length=${rawLen}`);

        const pkg      = parseDrv(raw);    // throws on bad/missing signature
        const manifest = pkg.manifest;

        const safe      = validatePermissions(manifest.permissions || []);
        const dangerous = safe.filter(p => DANGEROUS_PERMISSIONS.includes(p));
        manifest.permissions = safe;

        const hash     = crypto.createHash('sha256').update(JSON.stringify(pkg.files)).digest('hex');
        const warnings = dangerous.length
            ? [`Dangerous permissions requested: ${dangerous.join(', ')}`]
            : [];

        await withRegistry(reg => {
            const existing = reg[manifest.id];

            // FIX #13 — detect and warn on version downgrade
            if (existing) {
                const [eMaj, eMin = 0] = existing.manifest.version.split('.').map(Number);
                const [nMaj, nMin = 0] = manifest.version.split('.').map(Number);
                if (eMaj > nMaj || (eMaj === nMaj && eMin > nMin)) {
                    warnings.push(`Version downgrade: ${existing.manifest.version} → ${manifest.version}`);
                }
                console.log(`[DriverKernel] Updating: ${manifest.name} ${existing.manifest.version} → ${manifest.version}`);
            } else {
                console.log(`[DriverKernel] Installing: ${manifest.name} v${manifest.version}`);
            }

            const drvPath = path.join(DRIVERS_DIR, `${manifest.id}.drv`);
            fs.writeFileSync(drvPath, typeof raw === 'string' ? raw : JSON.stringify(pkg));

            reg[manifest.id] = {
                manifest,
                installedAt: existing?.installedAt || new Date().toISOString(),
                updatedAt:   new Date().toISOString(),
                enabled:     existing?.enabled ?? true,
                builtin:     false,
                path:        drvPath,
                hash
            };
            saveRegistry(reg);

            // FIX #7 — evict stale in-memory module so next execute reloads fresh
            delete loadedDrivers[manifest.id];
        });

        res.json({ ok: true, id: manifest.id, name: manifest.name, version: manifest.version, hash, warnings });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

/**
 * DELETE /api/drivers/:id — uninstall a driver
 * FIX #4 requireAuth
 */
router.delete('/:id', requireAuth, async (req, res) => {
    try {
        const id = req.params.id;
        await withRegistry(reg => {
            const entry = reg[id];
            if (!entry)       throw Object.assign(new Error('Driver not found'),              { status: 404 });
            if (entry.builtin) throw Object.assign(new Error('Cannot uninstall built-in driver'), { status: 403 });
            try { fs.unlinkSync(entry.path); } catch {}
            delete reg[id];
            saveRegistry(reg);
            delete loadedDrivers[id];
            console.log(`[DriverKernel] Uninstalled: ${id}`);
        });
        res.json({ ok: true, id, message: 'Driver uninstalled' });
    } catch (e) {
        res.status(e.status || 500).json({ ok: false, error: e.message });
    }
});

/**
 * POST /api/drivers/:id/enable — enable or disable a driver
 * FIX #4 requireAuth
 */
router.post('/:id/enable', requireAuth, express.json(), async (req, res) => {
    try {
        const id      = req.params.id;
        const enabled = req.body?.enabled !== false;
        await withRegistry(reg => {
            if (!reg[id]) throw Object.assign(new Error('Driver not found'), { status: 404 });
            reg[id].enabled = enabled;
            saveRegistry(reg);
            if (!enabled) delete loadedDrivers[id];
        });
        res.json({ ok: true, id, enabled });
    } catch (e) {
        res.status(e.status || 500).json({ ok: false, error: e.message });
    }
});

/**
 * POST /api/drivers/:id/execute — execute a driver action
 * FIX #4 requireAuth
 * FIX #5 await async actions
 */
router.post('/:id/execute', requireAuth, express.json(), async (req, res) => {
    try {
        const id                                 = req.params.id;
        const { action = 'onLoad', params = {} } = req.body || {};
        const registry                           = loadRegistry();
        const entry                              = registry[id];

        if (!entry)         return res.status(404).json({ ok: false, error: 'Driver not found' });
        if (!entry.enabled) return res.status(403).json({ ok: false, error: 'Driver is disabled' });

        if (!loadedDrivers[id]) loadedDrivers[id] = loadDriver(entry.path);

        const driver = loadedDrivers[id];
        const fn     = driver.module[action];

        if (typeof fn !== 'function') {
            return res.status(400).json({ ok: false, error: `Action '${action}' not found in driver` });
        }

        // FIX #5 — properly await async driver actions
        const result = await Promise.resolve(fn({ ...params, context: driver.ctx }));

        res.json({ ok: true, id, action, result });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

/**
 * GET /api/drivers/:id — get driver details
 * FIX #6 — returns actual exported action names, not file list
 */
router.get('/:id', (req, res) => {
    try {
        const id    = req.params.id;
        const entry = loadRegistry()[id];
        if (!entry) return res.status(404).json({ ok: false, error: 'Driver not found' });

        const drvRaw  = JSON.parse(fs.readFileSync(entry.path, 'utf8'));
        const actions = extractActions(drvRaw.files, drvRaw.manifest.entry || 'driver.js'); // FIX #6

        res.json({
            ok:         true,
            manifest:   entry.manifest,
            enabled:    entry.enabled,
            builtin:    entry.builtin || false,
            installedAt: entry.installedAt,
            updatedAt:  entry.updatedAt || null,
            hash:       entry.hash,
            actions
        });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ─── Seed built-in drivers on startup ────────────────────────────────────────
// FIX #9 — skip already-seeded drivers to preserve installedAt

function seedBuiltins() {
    if (!fs.existsSync(BUILTIN_DIR)) return;

    const registry = loadRegistry();
    const files    = fs.readdirSync(BUILTIN_DIR).filter(f => f.endsWith('.drv'));
    let changed    = false;

    files.forEach(file => {
        try {
            const drvPath = path.join(BUILTIN_DIR, file);
            const raw     = fs.readFileSync(drvPath, 'utf8');
            const pkg     = parseDrv(raw);
            const { manifest } = pkg;

            // FIX #9 — only register once; don't reset installedAt on each restart
            if (registry[manifest.id]?.builtin) return;

            const hash = crypto
                .createHash('sha256')
                .update(JSON.stringify(pkg.files))
                .digest('hex');

            registry[manifest.id] = {
                manifest,
                installedAt: new Date().toISOString(),
                enabled:     true,
                builtin:     true,
                path:        drvPath,
                hash
            };
            changed = true;
            console.log(`[DriverKernel] Loaded built-in: ${manifest.name}`);
        } catch (e) {
            console.warn(`[DriverKernel] Failed to load built-in ${file}:`, e.message);
        }
    });

    if (changed) saveRegistry(registry);
}

seedBuiltins();

console.log('[DriverKernel] Ready — plug in with: app.use(\'/api/drivers\', require(\'./driver-kernel\'))');
if (!API_KEY) {
    console.warn('[DriverKernel] WARNING: DRIVER_API_KEY not set — mutating routes are unprotected (set for production)');
}

module.exports = router;