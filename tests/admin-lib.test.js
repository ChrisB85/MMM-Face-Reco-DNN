'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../admin/lib');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'face-lib-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touch(file, seconds) {
  fs.utimesSync(file, seconds, seconds);
}

test('isValidName accepts Polish names and rejects separators', () => {
  for (const ok of ['Krzysiek', 'Łucja', 'Żaneta', 'Ania_2', 'jan-kowalski']) {
    assert.ok(lib.isValidName(ok), ok);
  }
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a b', 'a.b', 'x'.repeat(41), undefined, null, 42]) {
    assert.ok(!lib.isValidName(bad), String(bad));
  }
});

test('isValidPhoto accepts hand-placed photos and rejects traversal', () => {
  for (const ok of ['k01.jpg', 'dowod.jpg', 'IMG 1234 (1).JPG', 'a.jpeg', 'Łucja_20260923_101010.jpg', 'x.png']) {
    assert.ok(lib.isValidPhoto(ok), ok);
  }
  for (const bad of ['.jpg', 'a.gif', '../a.jpg', 'a/b.jpg', 'a.jpg.sh', 'a..jpg', '', undefined]) {
    assert.ok(!lib.isValidPhoto(bad), String(bad));
  }
});

test('resolveInside keeps paths strictly inside the root', () => {
  assert.equal(lib.resolveInside('/data/set', 'Ania'), '/data/set/Ania');
  assert.equal(lib.resolveInside('/data/set', 'Ania', 'a.jpg'), '/data/set/Ania/a.jpg');
  assert.equal(lib.resolveInside('/data/set', '..'), null);
  assert.equal(lib.resolveInside('/data/set', '../set2'), null);
  assert.equal(lib.resolveInside('/data/set', ''), null);
});

test('isServedPath flags anything MagicMirror serves statically', () => {
  const root = '/home/dietpi/MagicMirror';
  assert.ok(lib.isServedPath('modules/MMM-Face-Reco-DNN/dataset/', root));
  assert.ok(lib.isServedPath('config', root));
  assert.ok(lib.isServedPath('/home/dietpi/MagicMirror/css/x', root));
  assert.ok(!lib.isServedPath('/home/dietpi/face-reco/dataset/', root));
  assert.ok(!lib.isServedPath('../face-reco/encodings.pickle', root));
  assert.ok(!lib.isServedPath('face-data/dataset', root));
});

test('checkPin compares the Basic Auth password and ignores the user', () => {
  const basic = s => 'Basic ' + Buffer.from(s).toString('base64');
  assert.ok(lib.checkPin(basic(':1234'), '1234'));
  assert.ok(lib.checkPin(basic('anyone:1234'), '1234'));
  assert.ok(!lib.checkPin(basic(':1235'), '1234'));
  assert.ok(!lib.checkPin(basic(':12345'), '1234'));
  assert.ok(!lib.checkPin(undefined, '1234'));
  assert.ok(!lib.checkPin('Bearer 1234', '1234'));
});

test('isStale compares the newest dataset mtime with the model', t => {
  const root = tmpDir(t);
  const dataset = path.join(root, 'dataset');
  const person = path.join(dataset, 'Ania');
  const encodings = path.join(root, 'encodings.pickle');
  fs.mkdirSync(person, { recursive: true });
  fs.writeFileSync(path.join(person, 'a.jpg'), 'x');
  for (const p of [path.join(person, 'a.jpg'), person, dataset]) touch(p, 1000);

  assert.ok(lib.isStale(dataset, encodings), 'missing model is stale');

  fs.writeFileSync(encodings, 'model');
  touch(encodings, 2000);
  assert.ok(!lib.isStale(dataset, encodings), 'model newer than photos');

  fs.writeFileSync(path.join(person, 'b.jpg'), 'x');
  touch(path.join(person, 'b.jpg'), 3000);
  assert.ok(lib.isStale(dataset, encodings), 'new photo');

  fs.rmSync(path.join(person, 'b.jpg'));
  touch(person, 1500);
  assert.ok(!lib.isStale(dataset, encodings));
  touch(person, 3000);
  assert.ok(lib.isStale(dataset, encodings), 'deletion bumps the directory mtime');
});

test('listPeople lists valid people and photos, sorted', t => {
  const dataset = tmpDir(t);
  fs.mkdirSync(path.join(dataset, 'Zosia'));
  fs.mkdirSync(path.join(dataset, 'Ania'));
  fs.mkdirSync(path.join(dataset, 'bad name'));
  fs.writeFileSync(path.join(dataset, 'loose.jpg'), 'x');
  fs.writeFileSync(path.join(dataset, 'Ania', 'k02.jpg'), 'x');
  fs.writeFileSync(path.join(dataset, 'Ania', 'k01.jpg'), 'x');
  fs.writeFileSync(path.join(dataset, 'Ania', 'notes.txt'), 'x');

  assert.deepEqual(lib.listPeople(dataset), [
    { name: 'Ania', photos: ['k01.jpg', 'k02.jpg'] },
    { name: 'Zosia', photos: [] },
  ]);
});

test('photoFileName uses a timestamp and avoids collisions', t => {
  const dir = tmpDir(t);
  const now = new Date(2026, 8, 23, 8, 15, 2);
  assert.equal(lib.photoFileName(dir, 'Ania', now), 'Ania_20260923_081502.jpg');
  fs.writeFileSync(path.join(dir, 'Ania_20260923_081502.jpg'), 'x');
  assert.equal(lib.photoFileName(dir, 'Ania', now), 'Ania_20260923_081502_2.jpg');
});
