import fs from "node:fs";
import path from "node:path";

const appDir = path.resolve(process.argv[2] ?? "");
const manifestPath = path.join(appDir, "package.nw", "package.json");

if (!process.argv[2] || !fs.existsSync(manifestPath)) {
  throw new Error(`NW.js app manifest not found: ${manifestPath}`);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.window = {
  ...manifest.window,
  frame: false,
  fullscreen: true,
  kiosk: true,
  "chromium-args": [
    "--no-first-run",
    "--disable-devtools",
    "--enable-features=UseOzonePlatform",
    "--ozone-platform=wayland",
    "--user-data-dir=/home/nbosp/.config/novabyte",
  ].join(" "),
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
