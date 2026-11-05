/**
 * NovaByte OS - App Packaging CLI Tool
 * ────────────────────────────────────────────────────────────
 * Command-line tool for creating, packaging, and verifying
 * NovaByte OS applications (.novaapp packages).
 * 
 * Usage:
 *   novaapp-cli.js build ./my-app/ [--out ./dist/]
 *   novaapp-cli.js inspect ./my-app.novaapp [--no-verify]
 *   novaapp-cli.js verify ./my-app.novaapp
 *   novaapp-cli.js list-actions ./my-app.novaapp
 *   novaapp-cli.js create ./my-app/ --template=webapp
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

// Import AppPackage module (browser-compatible version)
const AppPackage = require('./js/app-package.js');

// ─── Optional obfuscator (only required when --obfuscate is used) ───────────

let JavaScriptObfuscator = null;
function requireObfuscator() {
  if (!JavaScriptObfuscator) {
    try {
      JavaScriptObfuscator = require('javascript-obfuscator');
    } catch (e) {
      console.error('\x1b[31m✖\x1b[0m  javascript-obfuscator not installed.');
      console.error('     Run: npm install javascript-obfuscator');
      process.exit(1);
    }
  }
  return JavaScriptObfuscator;
}

// ─── Obfuscation settings ───────────────────────────────────────
// Maximum protection — changes identifier names, encodes strings with RC4,
// flattens control flow, injects dead code, and actively fights debuggers.

const OBFUSCATE_OPTIONS = {
  identifierNamesGenerator:             'hexadecimal',
  renameGlobals:                        false,   // keep window.* stable
  renameProperties:                     false,   // too risky on DOM code

  // Pull every string into a RC4-encrypted lookup table
  stringArray:                          true,
  stringArrayThreshold:                 0.9,
  stringArrayEncoding:                  ['rc4'],
  stringArrayCallsTransform:            true,
  stringArrayCallsTransformThreshold:   0.9,
  stringArrayIndexShift:                true,
  stringArrayRotate:                    true,
  stringArrayWrappersCount:             5,
  stringArrayWrappersChainedCalls:      true,
  stringArrayWrappersParametersMaxCount:5,
  stringArrayWrappersType:              'function',

  // Split string literals into 4-char chunks
  splitStrings:                         true,
  splitStringsChunkLength:              4,

  // Replace if/switch/loop with state-machine dispatchers
  controlFlowFlattening:                true,
  controlFlowFlatteningThreshold:       0.85,

  // Inject unreachable branches to confuse static analysis
  deadCodeInjection:                    true,
  deadCodeInjectionThreshold:           0.4,

  // Continuously polls the debugger — attaching DevTools breaks execution
  debugProtection:                      true,
  debugProtectionInterval:              3000,

  // Detects code reformatting/prettifying and self-breaks
  selfDefending:                        true,

  // e.g. 42  →  (0x6*0x7+...)
  numbersToExpressions:                 true,

  // Rewrite obj.key → obj['key'] via computed properties
  transformObjectKeys:                  true,

  compact:                              true,
  simplify:                             true,
  sourceMap:                            false,
};

// ─── Obfuscation helpers ────────────────────────────────────────

function obfuscateJS(code, filePath) {
  const obf = requireObfuscator();
  try {
    return obf.obfuscate(code, OBFUSCATE_OPTIONS).getObfuscatedCode();
  } catch (e) {
    warn(`Obfuscation failed for ${filePath}, keeping original: ${e.message}`);
    return code;
  }
}

/**
 * Obfuscate every inline <script>…</script> block inside an HTML file.
 * Blocks with src=, type="application/json", or under 80 chars are skipped.
 */
function obfuscateHTML(html, filePath) {
  return html.replace(
    /<script(\s[^>]*)?>[\s\S]*?<\/script>/gi,
    (block) => {
      // Skip external scripts and non-JS blocks
      if (/\bsrc\s*=/i.test(block))                      return block;
      if (/\btype\s*=\s*["'][^"']*json[^"']*["']/i.test(block)) return block;

      const open  = block.match(/^<script(\s[^>]*)?>/)[ 0];
      const inner = block.slice(open.length, block.length - '</script>'.length).trim();

      if (inner.length < 80) return block;   // skip tiny/empty blocks

      inf(`  obfuscating inline <script> (${(inner.length / 1024).toFixed(1)} KB) in ${filePath}`);
      return `${open}${obfuscateJS(inner, filePath)}</script>`;
    }
  );
}

// ─── Package loader (handles plain JSON and obfuscated JS) ──────

function loadPackage(pkgPath) {
  const src = fs.readFileSync(pkgPath, 'utf8');
  // Try plain JSON first (non-obfuscated builds)
  try {
    return JSON.parse(src);
  } catch (_) {}
  // Fall back to executing as obfuscated JS: window.__pkg = {...};
  try {
    const ctx = vm.createContext({ window: {} });
    vm.runInContext(src, ctx);
    if (ctx.window.__pkg) return ctx.window.__pkg;
    if (ctx.__pkg) return ctx.__pkg;  // Fallback for backward compatibility
  } catch (e) {
    err(`Failed to load package: ${e.message}`);
    process.exit(1);
  }
  err('Unrecognised package format (neither JSON nor obfuscated .novaapp)');
  process.exit(1);
}

// ─── CLI arg parsing ────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];
const target = args[1];

// Flags
const outFlagIdx = args.indexOf('--out');
const outDir = outFlagIdx !== -1 ? args[outFlagIdx + 1] : null;
const noVerify = args.includes('--no-verify');
const templateFlagIdx = args.indexOf('--template');
const template = templateFlagIdx !== -1 ? args[templateFlagIdx + 1] : 'blank';
const force = args.includes('--force');
const obfuscate = args.includes('--obfuscate');   // ← new flag

// ─── Colour helpers ─────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  magenta: '\x1b[35m'
};

const ok = (msg) => console.log(`${c.green}✔${c.reset}  ${msg}`);
const err = (msg) => console.error(`${c.red}✖${c.reset}  ${msg}`);
const inf = (msg) => console.log(`${c.cyan}→${c.reset}  ${msg}`);
const warn = (msg) => console.log(`${c.yellow}⚠${c.reset}  ${msg}`);
const info = (msg) => console.log(`${c.dim}ℹ${c.reset}  ${msg}`);

// ─── App Templates ──────────────────────────────────────────────

const TEMPLATES = {
  blank: {
    name: 'Blank App',
    description: 'Empty app shell',
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{APP_NAME}}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    .container { text-align: center; }
    h1 { font-size: 48px; margin-bottom: 16px; }
    p { font-size: 18px; opacity: 0.9; }
  </style>
</head>
<body>
  <div class="container">
    <h1>{{APP_NAME}}</h1>
    <p>{{APP_DESCRIPTION}}</p>
  </div>
</body>
</html>`,
      'app.js': `// App initialization
console.log('{{APP_NAME}} initialized');

// Example: Send message to parent window
window.parent.postMessage({
  type: 'nova:ready',
  appId: '{{APP_ID}}'
}, '*');

// Example: Request permission
// window.parent.postMessage({
//   type: 'nova:request-permission',
//   permission: 'fs:read'
// }, '*');`,
      'style.css': `/* Custom styles */
body {
  margin: 0;
  padding: 20px;
}`
    }
  },

  webapp: {
    name: 'Web App Wrapper',
    description: 'External website wrapper with URL bar',
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{APP_NAME}}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: sans-serif; height: 100vh; display: flex; flex-direction: column; }
    #urlbar {
      background: rgba(0,0,0,0.8);
      color: white;
      padding: 8px 12px;
      font-size: 12px;
      font-family: monospace;
    }
    #webview {
      flex: 1;
      border: none;
      width: 100%;
    }
  </style>
</head>
<body>
  <div id="urlbar">🔒 {{APP_URL}}</div>
  <iframe id="webview" src="{{APP_URL}}"></iframe>
</body>
</html>`,
      'app.js': `// Web app wrapper logic
const url = '{{APP_URL}}';
document.getElementById('urlbar').textContent = '🔒 ' + url;
document.getElementById('webview').src = url;

// Monitor navigation
const webview = document.getElementById('webview');
webview.addEventListener('load', () => {
  try {
    const currentUrl = webview.contentWindow.location.href;
    document.getElementById('urlbar').textContent = '🔒 ' + currentUrl;
  } catch (e) {
    // Cross-origin, can't read URL
  }
});`
    }
  },

  utility: {
    name: 'Utility App',
    description: 'Tool with file system access',
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{APP_NAME}}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      padding: 20px;
      background: #f5f5f5;
    }
    .toolbar { margin-bottom: 20px; }
    button {
      padding: 8px 16px;
      margin-right: 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: white;
      cursor: pointer;
    }
    button:hover { background: #e9e9e9; }
    #output {
      background: white;
      border: 1px solid #ddd;
      border-radius: 4px;
      padding: 15px;
      min-height: 200px;
      font-family: monospace;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <button onclick="listFiles()">List Files</button>
    <button onclick="readFile()">Read File</button>
    <button onclick="writeFile()">Write File</button>
  </div>
  <div id="output">Ready...</div>
  <script src="app.js"></script>
</body>
</html>`,
      'app.js': `// Utility app logic
function log(msg) {
  document.getElementById('output').textContent += '\n' + msg;
}

function listFiles() {
  log('Requesting file list...');
  window.parent.postMessage({
    type: 'nova:fs:list',
    path: '/'
  }, '*');
}

function readFile() {
  const path = prompt('Enter file path:');
  if (path) {
    window.parent.postMessage({
      type: 'nova:fs:read',
      path: path
    }, '*');
  }
}

function writeFile() {
  const path = prompt('Enter file path:');
  const content = prompt('Enter content:');
  if (path && content) {
    window.parent.postMessage({
      type: 'nova:fs:write',
      path: path,
      content: content
    }, '*');
  }
}

// Listen for responses
window.addEventListener('message', (event) => {
  if (event.data.type === 'nova:fs:response') {
    log(JSON.stringify(event.data.result, null, 2));
  }
});`
    }
  },

  game: {
    name: 'Game Template',
    description: 'Canvas-based game template',
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{APP_NAME}}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1a1a2e;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: white;
      font-family: monospace;
    }
    #gameCanvas {
      border: 2px solid #16213e;
      background: #0f3460;
    }
    #score { margin-top: 10px; font-size: 24px; }
  </style>
</head>
<body>
  <canvas id="gameCanvas" width="400" height="400"></canvas>
  <div id="score">Score: 0</div>
  <script src="app.js"></script>
</body>
</html>`,
      'app.js': `// Simple game template
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');

let score = 0;
let gameRunning = true;

// Game state
const player = { x: 200, y: 200, size: 20, color: '#e94560' };
const keys = {};

// Input
window.addEventListener('keydown', (e) => keys[e.key] = true);
window.addEventListener('keyup', (e) => keys[e.key] = false);

// Game loop
function update() {
  if (!gameRunning) return;
  
  // Move player
  if (keys['ArrowLeft'] || keys['a']) player.x -= 3;
  if (keys['ArrowRight'] || keys['d']) player.x += 3;
  if (keys['ArrowUp'] || keys['w']) player.y -= 3;
  if (keys['ArrowDown'] || keys['s']) player.y += 3;
  
  // Keep in bounds
  player.x = Math.max(0, Math.min(canvas.width - player.size, player.x));
  player.y = Math.max(0, Math.min(canvas.height - player.size, player.y));
  
  score++;
  scoreEl.textContent = 'Score: ' + Math.floor(score / 10);
}

function draw() {
  // Clear
  ctx.fillStyle = '#0f3460';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Draw player
  ctx.fillStyle = player.color;
  ctx.fillRect(player.x, player.y, player.size, player.size);
  
  // Draw grid
  ctx.strokeStyle = '#16213e';
  ctx.lineWidth = 1;
  for (let i = 0; i < canvas.width; i += 40) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, canvas.height);
    ctx.stroke();
  }
  for (let i = 0; i < canvas.height; i += 40) {
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(canvas.width, i);
    ctx.stroke();
  }
}

function loop() {
  update();
  draw();
  requestAnimationFrame(loop);
}

loop();`
    }
  },

  dashboard: {
    name: 'Dashboard',
    description: 'Data visualization and widgets',
    files: {
      'index.html': `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{APP_NAME}}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      padding: 20px;
    }
    .dashboard {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
    }
    .widget {
      background: #1e293b;
      border-radius: 12px;
      padding: 20px;
      border: 1px solid #334155;
    }
    .widget h3 {
      color: #94a3b8;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 10px;
    }
    .widget .value {
      font-size: 32px;
      font-weight: bold;
      color: #f8fafc;
    }
    .widget .change {
      font-size: 14px;
      margin-top: 5px;
    }
    .change.positive { color: #10b981; }
    .change.negative { color: #ef4444; }
  </style>
</head>
<body>
  <div class="dashboard">
    <div class="widget">
      <h3>CPU Usage</h3>
      <div class="value" id="cpu">--%</div>
      <div class="change positive">↓ 12% from yesterday</div>
    </div>
    <div class="widget">
      <h3>Memory</h3>
      <div class="value" id="memory">--%</div>
      <div class="change">4.2 GB / 16 GB</div>
    </div>
    <div class="widget">
      <h3>Network</h3>
      <div class="value" id="network">-- MB/s</div>
      <div class="change positive">↑ 23% from yesterday</div>
    </div>
    <div class="widget">
      <h3>Storage</h3>
      <div class="value" id="storage">--%</div>
      <div class="change">256 GB / 512 GB</div>
    </div>
  </div>
  <script src="app.js"></script>
</body>
</html>`,
      'app.js': `// Dashboard with live updates
function randomValue(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function updateDashboard() {
  document.getElementById('cpu').textContent = randomValue(10, 60) + '%';
  document.getElementById('memory').textContent = randomValue(40, 80) + '%';
  document.getElementById('network').textContent = randomValue(10, 100) + ' MB/s';
  document.getElementById('storage').textContent = randomValue(40, 60) + '%';
}

// Update every 2 seconds
updateDashboard();
setInterval(updateDashboard, 2000);

// Simulate real-time data
console.log('Dashboard initialized');`
    }
  }
};

// ─── BUILD: Create package from directory ───────────────────────

function buildDriver(driverDir) {
  const absDir = path.resolve(driverDir);
  if (!fs.existsSync(absDir)) {
    err(`Directory not found: ${absDir}`);
    process.exit(1);
  }

  // Read manifest
  const manifestPath = path.join(absDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    // Check for novaapp.json
    const novaappPath = path.join(absDir, 'novaapp.json');
    if (fs.existsSync(novaappPath)) {
      manifestPath = novaappPath;
    } else {
      err('manifest.json or novaapp.json not found');
      process.exit(1);
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    err(`Invalid manifest: ${e.message}`);
    process.exit(1);
  }

  // Validate required fields
  const required = ['id', 'name', 'version', 'entry'];
  const missing = required.filter(f => !manifest[f]);
  if (missing.length) {
    err(`manifest.json missing: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Validate app ID
  if (!manifest.id.startsWith('webapp_')) {
    if (!/^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/.test(manifest.id)) {
      err(`Invalid app ID "${manifest.id}". Use reverse domain format (e.g., com.example.app)`);
      process.exit(1);
    }
  }

  // Validate permissions
  if (manifest.permissions) {
    const validPerms = Object.values(AppPackage.PERMISSION_TYPES || {});
    const invalid = manifest.permissions.filter(p => !validPerms.includes(p));
    if (invalid.length) {
      warn(`Unknown permissions will be stripped: ${invalid.join(', ')}`);
      manifest.permissions = manifest.permissions.filter(p => validPerms.includes(p));
    }
  }

  // Read entry file
  const entryPath = path.join(absDir, manifest.entry);
  if (!fs.existsSync(entryPath)) {
    err(`Entry file not found: ${manifest.entry}`);
    process.exit(1);
  }

  inf(`Building ${manifest.name} v${manifest.version}...`);

  // Bundle files
  const files = {};
  const walkDir = (dir, base = '') => {
    fs.readdirSync(dir).forEach(f => {
      const full = path.join(dir, f);
      const rel = base ? `${base}/${f}` : f;
      if (fs.statSync(full).isDirectory()) {
        if (f !== 'node_modules' && !f.startsWith('.')) {
          walkDir(full, rel);
        }
      } else if (f !== 'manifest.json' && f !== 'novaapp.json' && !f.startsWith('.')) {
        try {
          let content = fs.readFileSync(full);

          // ── Obfuscation (--obfuscate flag) ───────────────────
          if (obfuscate) {
            const ext = path.extname(f).toLowerCase();
            if (ext === '.js') {
              inf(`  obfuscating ${rel}`);
              const obfuscated = obfuscateJS(content.toString('utf8'), rel);
              content = Buffer.from(obfuscated, 'utf8');
            } else if (ext === '.html' || ext === '.htm') {
              inf(`  scanning ${rel} for inline scripts`);
              const obfuscated = obfuscateHTML(content.toString('utf8'), rel);
              content = Buffer.from(obfuscated, 'utf8');
            }
          }
          // ─────────────────────────────────────────────────────

          files[rel] = content.toString('base64');
        } catch (e) {
          warn(`Skipping ${rel}: ${e.message}`);
        }
      }
    });
  };
  walkDir(absDir);

  inf(`Bundled ${Object.keys(files).length} files`);
  if (obfuscate) ok('Package obfuscated — .novaapp is closed-source JS (not plain JSON)');

  // Create package
  const pkg = {
    novabyte_app: AppPackage.NOVAAPP_FORMAT_VERSION || '1.0',
    manifest: {
      ...manifest,
      packagedAt: new Date().toISOString()
    },
    files: files,
    signature: null,
    compiled_at: new Date().toISOString()
  };

  // Sign package
  const toSign = JSON.stringify({
    novabyte_app: pkg.novabyte_app,
    manifest: pkg.manifest,
    files: pkg.files,
    compiled_at: pkg.compiled_at
  });
  pkg.signature = crypto.createHash('sha256').update(toSign).digest('hex');

  // Determine output path
  let outPath = outDir || absDir;
  if (!fs.existsSync(outPath)) {
    fs.mkdirSync(outPath, { recursive: true });
  }
  const outFile = path.join(outPath, `${manifest.id}.novaapp`);

  // Write package
  let output;
  if (obfuscate) {
    // Wrap the package as a JS variable assignment and obfuscate the whole file.
    // The .novaapp is now obfuscated JS, not plain JSON.
    const pkgJS = `window.__pkg=${JSON.stringify(pkg)};`;
    inf('Obfuscating package...');
    output = obfuscateJS(pkgJS, outFile);
  } else {
    output = JSON.stringify(pkg, null, 2);
  }
  fs.writeFileSync(outFile, output);
  ok(`Package created: ${outFile}`);
  inf(`Size: ${(fs.statSync(outFile).size / 1024).toFixed(2)} KB`);
  inf(`Signature: ${pkg.signature.substring(0, 16)}...`);
}

// ─── INSPECT: Show package info ─────────────────────────────────

function inspectPackage(pkgPath) {
  if (!fs.existsSync(pkgPath)) {
    err(`File not found: ${pkgPath}`);
    process.exit(1);
  }

  const pkg = loadPackage(pkgPath);

  if (pkg.novabyte_app !== '1.0') {
    warn(`Unknown package format version: ${pkg.novabyte_app}`);
  }

  const m = pkg.manifest;
  console.log(`\n${c.bold}${m.name}${c.reset} v${m.version}`);
  console.log(`${c.dim}ID: ${m.id}${c.reset}`);
  console.log(`${c.dim}Author: ${m.author || 'Unknown'}${c.reset}`);
  console.log(`${c.dim}Description: ${m.description || 'N/A'}${c.reset}`);
  console.log(`\n${c.cyan}Files:${c.reset} ${Object.keys(pkg.files).length}`);
  Object.keys(pkg.files).forEach(f => {
    console.log(`  ${f}`);
  });

  console.log(`\n${c.cyan}Permissions:${c.reset}`);
  if (m.permissions && m.permissions.length) {
    m.permissions.forEach(p => console.log(`  ${p}`));
  } else {
    console.log(`  ${c.dim}none${c.reset}`);
  }

  console.log(`\n${c.cyan}Optional Permissions:${c.reset}`);
  if (m.optionalPermissions && m.optionalPermissions.length) {
    m.optionalPermissions.forEach(p => console.log(`  ${p}`));
  } else {
    console.log(`  ${c.dim}none${c.reset}`);
  }

  console.log(`\n${c.cyan}Signature:${c.reset}`);
  if (pkg.signature) {
    console.log(`  ${pkg.signature}`);
    if (!noVerify) {
      const toVerify = JSON.stringify({
        novabyte_app: pkg.novabyte_app,
        manifest: pkg.manifest,
        files: pkg.files,
        compiled_at: pkg.compiled_at
      });
      const computed = crypto.createHash('sha256').update(toVerify).digest('hex');
      if (computed === pkg.signature) {
        console.log(`  ${c.green}✓ Valid signature${c.reset}`);
      } else {
        console.log(`  ${c.red}✗ Invalid signature${c.reset}`);
      }
    }
  } else {
    console.log(`  ${c.yellow}⚠ Unsigned${c.reset}`);
  }

  console.log(`\n${c.dim}Packaged: ${pkg.compiled_at}${c.reset}\n`);
}

// ─── VERIFY: Check package signature ────────────────────────────

function verifyPackage(pkgPath) {
  if (!fs.existsSync(pkgPath)) {
    err(`File not found: ${pkgPath}`);
    process.exit(1);
  }

  const pkg = loadPackage(pkgPath);

  if (!pkg.signature) {
    err('Package is unsigned');
    process.exit(1);
  }

  const toVerify = JSON.stringify({
    novabyte_app: pkg.novabyte_app,
    manifest: pkg.manifest,
    files: pkg.files,
    compiled_at: pkg.compiled_at
  });
  const computed = crypto.createHash('sha256').update(toVerify).digest('hex');

  if (computed === pkg.signature) {
    ok('Signature is valid');
    console.log(`  ${pkg.manifest.name} v${pkg.manifest.version}`);
    console.log(`  ${pkg.manifest.id}`);
  } else {
    err('Signature is invalid');
    process.exit(1);
  }
}

// ─── LIST-ACTIONS: Show package actions ─────────────────────────

function listActions(pkgPath) {
  if (!fs.existsSync(pkgPath)) {
    err(`File not found: ${pkgPath}`);
    process.exit(1);
  }

  const pkg = loadPackage(pkgPath);

  console.log(`\n${c.bold}Available actions for ${pkg.manifest.name}:${c.reset}\n`);
  console.log(`  ${c.cyan}install${c.reset}    Install this app`);
  console.log(`  ${c.cyan}uninstall${c.reset}  Uninstall this app`);
  console.log(`  ${c.cyan}launch${c.reset}     Launch this app`);
  console.log(`  ${c.cyan}info${c.reset}       Show app info`);
  console.log(`  ${c.cyan}permissions${c.reset}  Manage permissions\n`);
}

// ─── CREATE: Create new app from template ───────────────────────

function createApp(targetDir, template) {
  const absDir = path.resolve(targetDir);
  
  if (fs.existsSync(absDir)) {
    err(`Directory already exists: ${absDir}`);
    process.exit(1);
  }

  if (!TEMPLATES[template]) {
    err(`Unknown template: ${template}`);
    console.log(`\nAvailable templates: ${Object.keys(TEMPLATES).join(', ')}`);
    process.exit(1);
  }

  const tpl = TEMPLATES[template];
  const appName = path.basename(absDir);
  const appId = `com.user.${appName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;

  inf(`Creating ${tpl.name} in ${absDir}...`);

  // Create directory
  fs.mkdirSync(absDir, { recursive: true });

  // Create manifest
  const manifest = {
    id: appId,
    name: appName,
    version: '1.0.0',
    description: tpl.description,
    author: 'Developer',
    entry: 'index.html',
    type: template,
    permissions: [],
    optionalPermissions: [],
    defaultSize: [800, 600],
    minSize: [400, 300],
    categories: [template]
  };

  fs.writeFileSync(
    path.join(absDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
  );
  ok('Created manifest.json');

  // Create template files
  for (const [filePath, content] of Object.entries(tpl.files)) {
    const fullPath = path.join(absDir, filePath);
    const dir = path.dirname(fullPath);
    
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let finalContent = content
      .replace(/{{APP_NAME}}/g, appName)
      .replace(/{{APP_ID}}/g, appId)
      .replace(/{{APP_DESCRIPTION}}/g, tpl.description)
      .replace(/{{APP_URL}}/g, 'https://example.com');

    fs.writeFileSync(fullPath, finalContent);
    ok(`Created ${filePath}`);
  }

  console.log(`\n${c.green}Success!${c.reset} Created ${appName} in ${absDir}`);
  console.log(`\nNext steps:`);
  console.log(`  cd ${targetDir}`);
  console.log(`  # Edit manifest.json to customize your app`);
  console.log(`  # Add your code to the template files`);
  console.log(`  # Build: novaapp-cli.js build .`);
  console.log();
}

// ─── Main ───────────────────────────────────────────────────────

if (!command) {
  console.log(`\nNovaByte OS - App Packaging Tool\n`);
  console.log(`Usage:`);
  console.log(`  novaapp-cli.js <command> [options]\n`);
  console.log(`Commands:`);
  console.log(`  build <dir>          Build app from directory`);
  console.log(`  inspect <file>       Inspect package contents`);
  console.log(`  verify <file>        Verify package signature`);
  console.log(`  list-actions <file>  List available actions`);
  console.log(`  create <dir>         Create new app from template\n`);
  console.log(`Options:`);
  console.log(`  --out <dir>          Output directory (for build)`);
  console.log(`  --obfuscate          Obfuscate JS before packaging (closed-source builds)`);
  console.log(`  --no-verify          Skip signature verification (for inspect)`);
  console.log(`  --template <name>    Template name (for create)`);
  console.log(`  --force              Force overwrite (for install)\n`);
  console.log(`Templates: ${Object.keys(TEMPLATES).join(', ')}\n`);
  process.exit(1);
}

switch (command) {
  case 'build':
    if (!target) {
      err('Please specify a directory');
      process.exit(1);
    }
    buildDriver(target);
    break;

  case 'inspect':
    if (!target) {
      err('Please specify a package file');
      process.exit(1);
    }
    inspectPackage(target);
    break;

  case 'verify':
    if (!target) {
      err('Please specify a package file');
      process.exit(1);
    }
    verifyPackage(target);
    break;

  case 'list-actions':
    if (!target) {
      err('Please specify a package file');
      process.exit(1);
    }
    listActions(target);
    break;

  case 'create':
    if (!target) {
      err('Please specify a directory');
      process.exit(1);
    }
    createApp(target, template);
    break;

  default:
    err(`Unknown command: ${command}`);
    process.exit(1);
}