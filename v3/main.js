'use strict';

const { app, BrowserWindow, session, shell, dialog } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// ─── Config ───────────────────────────────────────────────────────────────────
const SERVER_PORT = process.env.PORT || 3002;
const SERVER_URL  = `http://localhost:${SERVER_PORT}`;
const STARTUP_TIMEOUT_MS = 20000;

let mainWindow = null;

// ─── Debug log ────────────────────────────────────────────────────────────────
const logPath = path.join(app.getPath('userData'), 'debug.log');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    logStream.write(line);
    console.log(msg);
}

// ─── Start NovaByte Bridge Server (in-process) ────────────────────────────────
function startServer() {
    return new Promise((resolve, reject) => {
        const appRoot    = app.getAppPath();

        // server.js and all sibling route files are unpacked from app.asar into
        // app.asar.unpacked/ so that real fs operations (readFile, readdir, etc.)
        // work correctly. Always load from the unpacked path.
        const unpackedRoot = appRoot.replace('app.asar', 'app.asar.unpacked');
        const serverPath   = path.join(unpackedRoot, 'server.js');

        log(`App root: ${appRoot}`);
        log(`Server path (unpacked): ${serverPath}`);
        log(`Server exists: ${fs.existsSync(serverPath)}`);

        if (!fs.existsSync(serverPath)) {
            return reject(new Error(`server.js not found at: ${serverPath}`));
        }

        // Set env vars before requiring so server.js picks them up
        process.env.NODE_ENV   = 'production';
        process.env.PORT       = String(SERVER_PORT);
        process.env.CORS_ORIGIN = SERVER_URL;

        try {
            // Run server.js inside the main process — avoids all spawn/ASAR issues.
            // Electron's require() fully supports paths inside app.asar.
            require(serverPath);
            log('[Main] server.js loaded in-process');
        } catch (err) {
            return reject(new Error(`Failed to load server.js: ${err.message}`));
        }

        // Poll until the server accepts connections
        const deadline = Date.now() + STARTUP_TIMEOUT_MS;
        const check = () => {
            http.get(SERVER_URL, (res) => {
                log(`[Main] Server responded with ${res.statusCode} — ready`);
                resolve();
            }).on('error', retry);
        };
        const retry = () => {
            if (Date.now() > deadline) {
                reject(new Error('Server failed to start within timeout — check debug.log'));
            } else {
                setTimeout(check, 400);
            }
        };
        setTimeout(check, 800);
    });
}

// ─── Create Main Window ────────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: 'NovaByte OS',
        icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webviewTag: true,
            allowRunningInsecureContent: false,
        },
        backgroundColor: '#0a0a0a',
        show: false,
    });

    session.fromPartition('persist:novabyte-webview');

    mainWindow.loadURL(SERVER_URL);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        mainWindow.focus();
    });

    mainWindow.webContents.on('did-fail-load', (event, code, desc, url) => {
        log(`[Main] Page failed to load: ${desc} (${code}) — ${url}`);
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (!url.startsWith(SERVER_URL)) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        return { action: 'allow' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ─── App Lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    log('[Main] App ready, starting server...');
    try {
        await startServer();
        log('[Main] Server started, creating window...');
        createWindow();
    } catch (err) {
        log(`[Main] FATAL: ${err.message}`);
        dialog.showErrorBox(
            'NovaByte OS — Startup Failed',
            `The server failed to start.\n\n${err.message}\n\nCheck debug log at:\n${logPath}`
        );
        app.quit();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});