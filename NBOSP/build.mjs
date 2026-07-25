import { fileURLToPath } from "url";
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
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  // 1. Clean previous build output and any leftover staging dir
  console.log("Cleaning previous build output...");
  rmrf(outDir);
  rmrf(stageDir);

  // 2. Stage a clean copy of NBOSP (node_modules excluded — installed fresh below)
  console.log("Staging clean copy of NBOSP...");
  copyClean(nbospDir, stageDir);

  // 3. Install dependencies with npm ci for a clean, reproducible install
  console.log("Running npm ci in staged copy...");
  execSync("npm ci", { cwd: stageDir, stdio: "inherit" });

  // 4. Build for each platform — each gets its own subfolder, since
  // nw-builder dumps straight into outDir with no per-platform namespacing
  // and would otherwise overwrite the previous platform's build.
  const { default: nwbuild } = await import("nw-builder");

  // nw-builder requires extra macOS-specific fields for the osx build —
  // it won't fall back to defaults for these, so they must be set explicitly
  // or the osx build throws a validation error.
  // NOTE: LSApplicationCategoryType must be one of Apple's fixed category
  // strings — "developer-tools" is a best guess for an OS/system-shell app.
  // Change if a different category fits better:
  // https://developer.apple.com/documentation/bundleresources/information-property-list/lsapplicationcategorytype
  const macAppConfig = {
    name: "NovaByte",
    icon: path.join(stageDir, "assets", "icon.icns"),
    LSApplicationCategoryType: "public.app-category.developer-tools",
    CFBundleVersion: "3.0.2",
    CFBundleShortVersionString: "3.0.2",
    NSHumanReadableCopyright: "Copyright © 2026 NovaByteOfficial"
  };

  const platforms = [
    {
      platform: "win",
      arch: "x64",
      folder: "win-x64",
      app: {
        name: "NovaByte",
        icon: path.join(stageDir, "assets", "icon.ico"),
        version: "3.0.2"
      }
    },
    {
      platform: "linux",
      arch: "x64",
      folder: "linux-x64",
      app: {
        name: "NovaByte",
        icon: path.join(stageDir, "assets", "icon.png"),
        version: "3.0.2"
      }
    },
    { platform: "osx", arch: "x64", folder: "osx-x64", app: macAppConfig }
  ];

  for (const { platform, arch, folder, app } of platforms) {
    try {
      await nwbuild({
        mode: "build",
        srcDir: stageDir,
        glob: false,
        platform,
        arch,
        outDir: path.join(outDir, folder),
        ...(app ? { app } : {})
      });
      console.log(`Built for ${platform}-${arch} -> build/${folder}`);
    } catch (error) {
      console.error(`Build failed for ${platform}-${arch}:`, error);
    }
  }

  // 5. Clean up staging dir
  rmrf(stageDir);
  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
