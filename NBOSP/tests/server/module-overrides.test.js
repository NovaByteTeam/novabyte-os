import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { moduleOverrides } = require('../../server/core/module-overrides.js');

describe('module overrides middleware', () => {
  let tmp;
  let app;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbosp-overrides-'));
    // dot-directory in the path, like ~/.local, to prove it is still served
    const root = path.join(tmp, '.local', 'overrides');
    fs.mkdirSync(path.join(root, 'js', 'core'), { recursive: true });
    fs.writeFileSync(path.join(root, 'js', 'core', 'boot.js'), '// overridden boot\n');
    fs.writeFileSync(path.join(root, 'secret.js'), '// outside js/\n');

    app = express();
    app.use(moduleOverrides({ root }));
    app.use((req, res) => res.status(200).send('// shipped file\n'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serves an override ahead of the shipped file, uncached', async () => {
    const res = await request(app).get('/js/core/boot.js');
    expect(res.text).toBe('// overridden boot\n');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('falls through to the shipped file when no override exists', async () => {
    const res = await request(app).get('/js/core/kernel.js');
    expect(res.text).toBe('// shipped file\n');
  });

  it('only overrides .js files under js/', async () => {
    const res = await request(app).get('/secret.js');
    expect(res.text).toBe('// shipped file\n');
  });

  it('does not let a path escape the override folder', async () => {
    const res = await request(app).get('/js/..%2f..%2fsecret.js');
    expect(res.text).toBe('// shipped file\n');
  });
});
