'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { once } = require('events');
const express = require('express');
const { createAdminRouter } = require('../admin/routes');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const enc = encodeURIComponent;

async function setup(t, { cameraUp = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'face-routes-'));
  const dataset = path.join(root, 'dataset');
  fs.mkdirSync(dataset);

  const camera = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'image/jpeg');
    res.end(JPEG);
  });
  await once(camera.listen(0, '127.0.0.1'), 'listening');
  const cameraFrameUrl = `http://127.0.0.1:${camera.address().port}/frame.jpeg`;
  if (!cameraUp) camera.close();

  const trainer = {
    state: { status: 'idle', message: '', skipped: [] },
    starts: 0,
    start() {
      if (this.state.status === 'running') return false;
      this.starts++;
      this.state.status = 'running';
      return Promise.resolve();
    },
  };

  const app = express();
  app.use('/admin', createAdminRouter({ dataset, encodings: path.join(root, 'encodings.pickle'), pin: '1234', cameraFrameUrl, trainer }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  t.after(() => {
    server.closeAllConnections();
    server.close();
    if (camera.listening) camera.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}/admin`;
  const call = (method, p, { body, type, pin = '1234' } = {}) => {
    const headers = {};
    if (pin !== null) headers.Authorization = 'Basic ' + Buffer.from(':' + pin).toString('base64');
    if (type) headers['Content-Type'] = type;
    return fetch(base + p, { method, body, headers, redirect: 'manual' });
  };
  return { dataset, trainer, call };
}

test('every route needs the PIN', async t => {
  const { call } = await setup(t);
  for (const pin of [null, '0000']) {
    const res = await call('GET', '/api/people', { pin });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('www-authenticate'), 'Basic realm="Face admin"');
  }
  assert.equal((await call('GET', '/api/people')).status, 200);
});

test('ten wrong PINs in a minute lock everyone out for the rest of it', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const { call } = await setup(t);
  assert.equal((await call('GET', '/api/people', { pin: null })).status, 401, 'no header does not count');
  for (let i = 0; i < 10; i++) assert.equal((await call('GET', '/api/people', { pin: String(i) })).status, 401);
  assert.equal((await call('GET', '/api/people')).status, 429, 'even the right PIN waits');
  t.mock.timers.tick(61_000);
  assert.equal((await call('GET', '/api/people')).status, 200);
});

test('page is served, and the bare prefix redirects to a trailing slash', async t => {
  const { call } = await setup(t);
  const bare = await call('GET', '');
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), '/admin/');
  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  assert.equal((await call('GET', '/admin.js')).status, 200);
});

test('person lifecycle with a Polish name', async t => {
  const { dataset, call } = await setup(t);
  assert.equal((await call('POST', `/api/people/${enc('Łucja')}`)).status, 201);
  assert.equal((await call('POST', `/api/people/${enc('Łucja')}`)).status, 409);
  assert.ok(fs.existsSync(path.join(dataset, 'Łucja')));

  const list = await (await call('GET', '/api/people')).json();
  assert.deepEqual(list.people, [{ name: 'Łucja', photos: [] }]);
  assert.equal(list.stale, true);
  assert.equal(list.training.status, 'idle');

  const renamed = await call('PATCH', `/api/people/${enc('Łucja')}`, { body: JSON.stringify({ name: 'Żaneta' }), type: 'application/json' });
  assert.equal(renamed.status, 200);
  assert.ok(fs.existsSync(path.join(dataset, 'Żaneta')));
  assert.ok(!fs.existsSync(path.join(dataset, 'Łucja')));

  assert.equal((await call('DELETE', `/api/people/${enc('Żaneta')}`)).status, 204);
  assert.deepEqual(fs.readdirSync(dataset), []);
  assert.equal((await call('DELETE', `/api/people/${enc('Żaneta')}`)).status, 404);
});

test('rename rejects bad and taken names', async t => {
  const { call } = await setup(t);
  await call('POST', '/api/people/Ania');
  await call('POST', '/api/people/Ola');
  const patch = name => call('PATCH', '/api/people/Ania', { body: JSON.stringify({ name }), type: 'application/json' });
  assert.equal((await patch('Ola')).status, 409);
  assert.equal((await patch('../x')).status, 400);
  assert.equal((await patch(undefined)).status, 400);
});

test('names and files cannot escape the dataset', async t => {
  const { call } = await setup(t);
  await call('POST', '/api/people/Ania');
  assert.equal((await call('POST', `/api/people/${enc('../evil')}`)).status, 400);
  assert.equal((await call('GET', `/api/people/Ania/photos/${enc('../../x.jpg')}`)).status, 400);
  assert.equal((await call('DELETE', `/api/people/Ania/photos/${enc('..%2Fx.jpg')}`)).status, 400);
});

test('capture saves a camera frame; photos can be listed, read and deleted', async t => {
  const { dataset, call } = await setup(t);
  await call('POST', '/api/people/Ania');
  assert.equal((await call('POST', '/api/people/Nobody/capture')).status, 404);

  const res = await call('POST', '/api/people/Ania/capture');
  assert.equal(res.status, 201);
  const { file } = await res.json();
  assert.match(file, /^Ania_\d{8}_\d{6}\.jpg$/);
  assert.deepEqual(fs.readFileSync(path.join(dataset, 'Ania', file)), JPEG);

  const photo = await call('GET', `/api/people/Ania/photos/${file}`);
  assert.equal(photo.status, 200);
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), JPEG);

  assert.equal((await call('DELETE', `/api/people/Ania/photos/${file}`)).status, 204);
  assert.equal((await call('DELETE', `/api/people/Ania/photos/${file}`)).status, 404);
});

test('upload accepts JPEG only, up to 5 MB', async t => {
  const { call } = await setup(t);
  await call('POST', '/api/people/Ania');
  const up = (body, type = 'image/jpeg') => call('POST', '/api/people/Ania/photos', { body, type });
  assert.equal((await up(JPEG)).status, 201);
  assert.equal((await up(Buffer.from('not a jpeg'))).status, 400);
  assert.equal((await up(JPEG, 'image/png')).status, 400);
  const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
  assert.equal((await up(big)).status, 413);
});

test('camera down gives 502', async t => {
  const { call } = await setup(t, { cameraUp: false });
  await call('POST', '/api/people/Ania');
  assert.equal((await call('GET', '/api/frame')).status, 502);
  assert.equal((await call('POST', '/api/people/Ania/capture')).status, 502);
});

test('frame proxy returns the camera JPEG', async t => {
  const { call } = await setup(t);
  const res = await call('GET', '/api/frame');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('train needs photos and runs once at a time', async t => {
  const { trainer, call } = await setup(t);
  await call('POST', '/api/people/Ania');
  assert.equal((await call('POST', '/api/train')).status, 400);
  await call('POST', '/api/people/Ania/photos', { body: JPEG, type: 'image/jpeg' });
  assert.equal((await call('POST', '/api/train')).status, 202);
  assert.equal((await call('POST', '/api/train')).status, 409);
  assert.equal(trainer.starts, 1);
});
