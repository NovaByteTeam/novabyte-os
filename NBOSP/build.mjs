import { fileURLToPath, pathToFileURL } from "url";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// build.mjs lives inside NBOSP itself, so __dirname *is* the source folder.
const nbospDir = __dirname;
// Stage and output go one level up so we never copy the staging/output dirs
// into themselves while walking nbospDir.
const projectRoot = path.dirname(__dirname);
const stageDir = path.join(projectRoot, ".build-stage");
const outDir = path.join(projectRoot, "build");

// Folders/files that must never end up in the packaged output.
// (dev tooling, secrets, caches, logs — this is about what actually ships
// to the end user, not a .gitignore concern)
const EXCLUDE_NAMES = new Set([
  "node_modules",
  ".env",
  "keys",
  ".update-backups",
  ".update-keys",
  "server.log",
  "cache",
  "dist",
  ".zcode",
  ".kilo",
  ".vs",
  "graphify-out",
  ".graphifyignore",
  "data",
  ".git",
  ".github",
  ".cache",
  ".build-stage",
  "build",
  "build.mjs",
  "test"
]);
// Exact relative paths (from NBOSP root) to exclude — for files that share a
// common name and shouldn't be blanket-excluded everywhere, only at this spot.
const EXCLUDE_RELATIVE_PATHS = new Set([
  path.join("js", "purify.min.js"),
  "vitest.config.js"
]);
const EXCLUDE_EXTENSIONS = new Set([".key", ".pem"]);
const EXCLUDE_EXACT_FILES = new Set(["cert.crt", "cert.key", "ca.crt", "ca.trusted"]);

function shouldSkip(name, relativePath) {
  if (EXCLUDE_NAMES.has(name)) return true;
  if (EXCLUDE_EXACT_FILES.has(name)) return true;
  if (EXCLUDE_RELATIVE_PATHS.has(relativePath)) return true;
  const ext = path.extname(name);
  if (EXCLUDE_EXTENSIONS.has(ext)) return true;
  return false;
}

function copyClean(src, dest, relBase = "") {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    const relPath = path.join(relBase, entry.name);
    if (shouldSkip(entry.name, relPath)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyClean(srcPath, destPath, relPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rmrf(dir) {
  if (!fs.existsSync(dir)) return;
  // Windows can throw EPERM/EBUSY if a file handle (antivirus scan, search
  // indexer, lingering npm child process) is still open on something inside
  // dir — Unix doesn't have this problem, deleting while a handle is open
  // just works there. Node's fs.rmSync has built-in retry-with-backoff for
  // exactly this, activated only when recursive is true.
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 300
  });
}

async function main() {
  // Which platform to build — passed by CI matrix (one native OS per
  // platform, so native modules like better-sqlite3 compile correctly for
  // that OS) or defaults to the current host OS for local/manual runs.
  const requestedPlatform =
    process.env.NBOSP_BUILD_PLATFORM || process.argv[2] || null;

  const platformDefs = {
    win: {
      platform: "win",
      arch: "x64",
      folder: "win-x64",
      appExtra: (icon) => ({ name: "NovaByte", icon, version: "3.0.2" })
    },
    linux: {
      platform: "linux",
      arch: "x64",
      folder: "linux-x64",
      appExtra: (icon) => ({ name: "NovaByte", icon, version: "3.0.2" })
    },
    osx: {
      platform: "osx",
      arch: "arm64",
      folder: "osx-arm64",
      appExtra: (icon) => ({
        name: "NovaByte",
        icon,
        LSApplicationCategoryType: "public.app-category.developer-tools",
        CFBundleVersion: "3.0.2",
        CFBundleShortVersionString: "3.0.2",
        NSHumanReadableCopyright: "Copyright © 2026 NovaByteOfficial"
      })
    }
  };

  // Map to native host platform automatically if not specified (local runs)
  const hostPlatform =
    process.platform === "win32" ? "win" : process.platform === "darwin" ? "osx" : "linux";
  const targetKey = requestedPlatform || hostPlatform;

  if (!platformDefs[targetKey]) {
    console.error(
      `Unknown platform "${targetKey}". Expected one of: ${Object.keys(platformDefs).join(", ")}`
    );
    process.exit(1);
  }

  const iconExt = targetKey === "win" ? "ico" : targetKey === "osx" ? "icns" : "png";

  // 1. Clean previous build output and any leftover staging dir
  console.log("Cleaning previous build output...");
  rmrf(outDir);
  rmrf(stageDir);

  // 2. Stage a clean copy of NBOSP (node_modules excluded — installed fresh
  // below, natively on this host, so any native modules like better-sqlite3
  // compile for THIS platform, not whatever OS the script last ran on)
  console.log("Staging clean copy of NBOSP...");
  copyClean(nbospDir, stageDir);

  // 3. Install dependencies with npm ci for a clean, reproducible,
  // platform-native install
  console.log(`Running npm ci in staged copy (native to ${process.platform})...`);
  execSync("npm ci", { cwd: stageDir, stdio: "inherit" });

  // 4. Import nw-builder from the staged copy — that's where npm ci just
  // installed it. Importing bare "nw-builder" here would resolve relative to
  // build.mjs's own location (NBOSP), which has no node_modules on a fresh
  // CI checkout since only the staged copy gets npm ci'd.
  const nwBuilderPkgPath = path.join(stageDir, "node_modules", "nw-builder", "package.json");
  const nwBuilderPkg = JSON.parse(fs.readFileSync(nwBuilderPkgPath, "utf8"));
  const nwBuilderEntry = pathToFileURL(
    path.join(stageDir, "node_modules", "nw-builder", nwBuilderPkg.main)
  ).href;
  const { default: nwbuild } = await import(nwBuilderEntry);

  // 5. Build only the requested platform
  const def = platformDefs[targetKey];
  const icon = path.join(stageDir, "assets", `icon.${iconExt}`);

  console.log(`Building ${def.platform}-${def.arch}...`);
  await nwbuild({
    mode: "build",
    srcDir: stageDir,
    glob: false,
    platform: def.platform,
    arch: def.arch,
    outDir: path.join(outDir, def.folder),
    app: def.appExtra(icon)
  });
  console.log(`Built for ${def.platform}-${def.arch} -> build/${def.folder}`);
  console.log(
    "Done. (.build-stage left in place — cleaned up automatically at the start of the next run)"
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
