const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const packageJsonPath = path.join(root, 'package.json');
const packageLockPath = path.join(root, 'package-lock.json');
const nodeModulesDir = path.join(root, 'node_modules');

function loadPackageJson() {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  } catch (err) {
    console.error('[bootstrap] Failed to read package.json:', err.message);
    process.exit(1);
  }
}

function depsToCheck(pkg) {
  return [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
}

function shouldInstall(pkg) {
  if (!fs.existsSync(nodeModulesDir)) return true;

  // Check declared deps exist in node_modules
  for (const dep of depsToCheck(pkg)) {
    if (!fs.existsSync(path.join(nodeModulesDir, dep))) {
      return true;
    }
  }

  return false;
}

function runNpmInstall() {
  const useCi = fs.existsSync(packageLockPath);
  const args = useCi
    ? ['ci', '--no-audit', '--no-fund']
    : ['install', '--no-audit', '--no-fund'];

  console.log(`[bootstrap] Dependencies missing. Running npm ${args.join(' ')} ...`);

  const npmExecPath = process.env.npm_execpath;

  let result;

  if (npmExecPath && fs.existsSync(npmExecPath)) {
    // Best cross-platform path: run the exact npm entrypoint that launched this script.
    result = spawnSync(process.execPath, [npmExecPath, ...args], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
  } else {
    // Fallback for unusual environments.
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    result = spawnSync(npmBin, args, {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    });
  }

  if (result.error) {
    console.error('[bootstrap] Failed to start npm:', result.error.message);
    process.exit(1);
  }

  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

function main() {
  const pkg = loadPackageJson();

  if (shouldInstall(pkg)) {
    runNpmInstall();
  } else {
    console.log('[bootstrap] Dependencies already installed.');
  }
}

main();