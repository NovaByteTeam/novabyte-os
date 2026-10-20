import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [binaryArg, appDirArg] = process.argv.slice(2);
if (!binaryArg || !appDirArg) {
  throw new Error("Usage: test-nw-node.mjs <NW.js binary> <app package directory>");
}

const binaryPath = path.resolve(binaryArg);
const appDir = path.resolve(appDirArg);
if (!fs.existsSync(binaryPath) || !fs.existsSync(path.join(appDir, "node_modules", "better-sqlite3"))) {
  throw new Error("NW.js binary or better-sqlite3 dependency is missing");
}

const scriptPath = path.join(appDir, `.nbosp-nw-node-test-${process.pid}.cjs`);
fs.writeFileSync(
  scriptPath,
  [
    'const assert = require("node:assert/strict");',
    'const Database = require("better-sqlite3");',
    'const db = new Database(":memory:");',
    'assert.equal(db.prepare("SELECT 42 AS answer").get().answer, 42);',
    "db.close();",
    'console.log("NBOSP_NWJS_NODE_RUNTIME_OK");',
  ].join("\n"),
);

try {
  const result = spawnSync(binaryPath, ["--max-old-space-size=1024", "--expose-gc", scriptPath], {
    cwd: appDir,
    encoding: "utf8",
    timeout: 30_000,
  });

  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /NBOSP_NWJS_NODE_RUNTIME_OK/);
  console.log("NW.js Node mode and better-sqlite3 runtime test passed.");
} finally {
  fs.rmSync(scriptPath, { force: true });
}
