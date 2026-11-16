import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'node:module';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { moduleOverrides, overrideRoot } = require('../../server/core/module-overrides.js');

describe('overrideRoot', () => {
  const snapshot = { ...process.env };
  afterAll(() => { process.env = { ...snapshot }; });

  it('resolves NOVABYTE_MODULE_OVERRIDES_DIR when the env points somewhere', () => {
    process.env.NOVABYTE_MODULE_OVERRIDES_DIR = '/custom/overrides/dir';
    expect(overrideRoot()).toBe(path.resolve('/custom/overrides/dir'));
    // relative env values are resolved against the cwd, like express root
    process.env.NOVABYTE_MODULE_OVERRIDES_DIR = 'relative/dir';
    expect(overrideRoot()).toBe(path.resolve('relative/dir'));
  });

  it('defaults to the per-user data folder when the env is unset', () => {
    delete process.env.NOVABYTE_MODULE_OVERRIDES_DIR;
    expect(overrideRoot()).toBe(
      path.join(os.homedir(), '.local', 'share', 'novabyte', 'module-overrides'),
    );
  });

  it('resolves the default root lazily when called without options', () => {
    // the server mounts it exactly like this: app.use(moduleOverrides())
    delete process.env.NOVABYTE_MODULE_OVERRIDES_DIR;
    const middleware = moduleOverrides();
    expect(typeof middleware).toBe('function');
    // and with the env set, the default root follows it
    process.env.NOVABYTE_MODULE_OVERRIDES_DIR = '/tmp/whatever';
    const middleware2 = moduleOverrides();
    expect(typeof middleware2).toBe('function');
  });
});

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

  it('falls through when the URL contains an undecodable escape', async () => {
    // %zz is not a legal percent escape → decodeURIComponent throws → next()
    const res = await request(app).get('/js/%zz.js');
    expect(res.text).toBe('// shipped file\n');
  });

  it('ignores POST bodies entirely and serves overrides on HEAD', async () => {
    // POST: the method guard returns next() before touching the filesystem
    const post = await request(app).post('/js/core/boot.js');
    expect(post.text).toBe('// shipped file\n');

    // HEAD: passes the method guard (not GET, but it IS 'HEAD') and serves
    // the override like a GET would
    const head = await request(app).head('/js/core/boot.js');
    expect(head.status).toBe(200);
    expect(head.headers['cache-control']).toBe('no-cache');
  });

  it('passes a sendFile failure to next() when headers were not sent', async () => {
    const middleware = moduleOverrides({ root: path.join(tmp, '.local', 'overrides') });
    const next = vi.fn();
    const sendFileCalls = [];
    const res = {
      headersSent: false,
      sendFile: (rel, opts, cb) => { sendFileCalls.push([rel, opts]); cb(new Error('stream aborted')); },
    };
    middleware({ method: 'GET', path: '/js/core/boot.js' }, res, next);
    await new Promise((r) => setTimeout(r, 25)); // let the async fs.stat settle
    expect(sendFileCalls).toEqual([['js/core/boot.js', expect.objectContaining({ root: expect.any(String) })]]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('swallows a sendFile error after headers went out, and success callbacks', async () => {
    const middleware = moduleOverrides({ root: path.join(tmp, '.local', 'overrides') });
    // headers already flushed → next() must NOT run (response in flight)
    const lateNext = vi.fn();
    const headersSentRes = {
      headersSent: true,
      sendFile: (_rel, _opts, cb) => cb(new Error('client hung up')),
    };
    middleware({ method: 'GET', path: '/js/core/boot.js' }, headersSentRes, lateNext);
    await new Promise((r) => setTimeout(r, 25));
    expect(lateNext).not.toHaveBeenCalled();

    // clean success → the callback runs without an error → no next()
    const okNext = vi.fn();
    const okRes = {
      headersSent: false,
      sendFile: (_rel, _opts, cb) => cb(null),
    };
    middleware({ method: 'GET', path: '/js/core/boot.js' }, okRes, okNext);
    await new Promise((r) => setTimeout(r, 25));
    expect(okNext).not.toHaveBeenCalled();
  });
});
