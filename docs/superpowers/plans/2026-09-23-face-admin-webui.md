# Face Dataset Admin Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PIN-protected phone web UI, served by MagicMirror itself, to add, rename and delete people, take training photos (mirror camera or phone camera), and retrain the face model without restarting MagicMirror.

**Architecture:** Three small CommonJS files in `admin/` (pure helpers, trainer, Express router) plus a static page (`admin.html` + `admin.js`). `node_helper.js` mounts the router on MagicMirror's Express app under `/MMM-Face-Reco-DNN/admin` only when `admin.enabled` is true and a PIN is set. Training runs `tools/encode.py` into a temp file, renames it over the model, then restarts `recognition.py`.

**Tech Stack:** Node 22+ (mirror has v24.2), Express 4.21 (MagicMirror's own), `node:test`, Python 3 with `face_recognition` (mirror only), vanilla HTML/JS.

**Spec:** `docs/superpowers/specs/2026-09-23-face-admin-webui-design.md`

## Global Constraints

- No new dependencies. `express` resolves from `MagicMirror/node_modules`; use global `fetch`.
- Admin is off unless `admin.enabled === true` and `admin.pin` is non-empty; off means no routes at all.
- `dataset` and `encodings` must resolve outside MagicMirror's static dirs: `config`, `css`, `fonts`, `js`, `modules`, `tests`, `translations`, `vendor` — otherwise admin stays off and logs an error.
- Every API route requires HTTP Basic Auth; password = PIN, compared with `crypto.timingSafeEqual`, user name ignored; 401 carries `WWW-Authenticate: Basic realm="Face admin"`.
- Person name: `^[\p{L}\p{N}_-]{1,40}$` (u flag). Photo file: `^[\p{L}\p{N}_ ()-]{1,80}\.(jpe?g|png)$` (iu flags).
- New photo names: `<name>_<YYYYmmdd_HHMMSS>.jpg`, `_2`, `_3`… on collision.
- Upload limit 5 MB, `image/jpeg` only, body must start with `FF D8`.
- Failed training never touches the current model.
- Code, comments, commit messages in English; UI text in Polish.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. Retraining while someone stands at the mirror (the usual case: they just took photos) — the old process is killed before it reports their logout; they must not stay logged in forever after walking away. Owned by Task 6 (manual check in Task 7).
2. A corrupt or non-image file in the dataset (truncated upload, HEIC renamed to `.jpg`) — must be skipped and reported, not crash the whole training. Owned by Task 3 (verified on the mirror).
3. Polish names in URLs (`Łucja`, `Żaneta`) — must round-trip through create, photo upload and rename. Owned by Task 4 tests.
4. Photos placed by hand before this feature (`k01.jpg`, `dowod.jpg`, `IMG 1234.JPG`, `.png`) — must be listed and deletable, since `encode.py` trains on them. Owned by Task 1 tests.
5. Two phones pressing "Przeszkol" at once, or pressing it with an empty dataset — 409 / 400, never two `encode.py` runs writing the same temp file. Owned by Tasks 2 and 4 tests.

---

## File Structure

| File | Responsibility |
|---|---|
| `admin/lib.js` (create) | Pure helpers: validation, path containment, PIN check, stale flag, listing, photo names |
| `admin/trainer.js` (create) | Runs `encode.py`, keeps training state, swaps model atomically |
| `admin/routes.js` (create) | Express router: auth, CRUD, camera proxy, train endpoint |
| `admin/admin.html`, `admin/admin.js` (create) | Phone UI |
| `tools/encode.py` (modify) | Skip photos with ≠ 1 face or unreadable, report `[SKIP]` lines |
| `node_helper.js` (modify) | Mount router when enabled; restart recognition after training |
| `tests/admin-*.test.js` (create) | `node:test` suites |
| `package.json` (modify) | `"test"` script |
| `README.md` (modify) | Admin section + migration |

All paths below are relative to `MagicMirror/modules/MMM-Face-Reco-DNN/` unless stated. Run tests from that directory.

---

### Task 1: Pure helpers (`admin/lib.js`)

**Files:**
- Create: `admin/lib.js`
- Create: `tests/admin-lib.test.js`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces (all exported from `admin/lib.js`):
  - `isValidName(name: any): boolean`
  - `isValidPhoto(file: any): boolean`
  - `resolveInside(root: string, ...parts: string[]): string | null` — absolute path strictly inside `root`, else `null`
  - `isServedPath(p: string, mmRoot: string): boolean`
  - `checkPin(header: string | undefined, pin: string): boolean`
  - `isStale(dataset: string, encodings: string): boolean`
  - `listPeople(dataset: string): Array<{ name: string, photos: string[] }>` — sorted, only valid names/photos
  - `photoFileName(dir: string, name: string, now?: Date): string`

- [ ] **Step 1: Add the test script to `package.json`**

In `"scripts"` add:

```json
    "test": "node --test tests/",
```

- [ ] **Step 2: Write the failing tests**

Create `tests/admin-lib.test.js`:

```js
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../admin/lib'`

- [ ] **Step 4: Write the implementation**

Create `admin/lib.js`:

```js
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[\p{L}\p{N}_-]{1,40}$/u;
const PHOTO_RE = /^[\p{L}\p{N}_ ()-]{1,80}\.(jpe?g|png)$/iu;
// Directories MagicMirror's js/server.js serves statically to every client.
const SERVED_DIRS = ['config', 'css', 'fonts', 'js', 'modules', 'tests', 'translations', 'vendor'];

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function isValidPhoto(file) {
  return typeof file === 'string' && PHOTO_RE.test(file);
}

function isUnder(full, base) {
  return full.startsWith(base + path.sep);
}

function resolveInside(root, ...parts) {
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  return isUnder(full, base) ? full : null;
}

function isServedPath(p, mmRoot) {
  const full = path.resolve(mmRoot, p);
  return SERVED_DIRS.some(dir => {
    const base = path.resolve(mmRoot, dir);
    return full === base || isUnder(full, base);
  });
}

function checkPin(header, pin) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(pin);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function newestMtime(dir) {
  let newest = fs.statSync(dir).mtimeMs;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

function isStale(dataset, encodings) {
  if (!fs.existsSync(encodings)) return true;
  return newestMtime(dataset) > fs.statSync(encodings).mtimeMs;
}

function listPeople(dataset) {
  return fs
    .readdirSync(dataset, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isValidName(entry.name))
    .map(entry => ({
      name: entry.name,
      photos: fs.readdirSync(path.join(dataset, entry.name)).filter(isValidPhoto).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function photoFileName(dir, name, now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  let file = `${name}_${stamp}.jpg`;
  for (let i = 2; fs.existsSync(path.join(dir, file)); i++) file = `${name}_${stamp}_${i}.jpg`;
  return file;
}

module.exports = {
  isValidName,
  isValidPhoto,
  resolveInside,
  isServedPath,
  checkPin,
  isStale,
  listPeople,
  photoFileName,
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all 8 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add admin/lib.js tests/admin-lib.test.js package.json
git commit -m "feat(admin): add validation and dataset helpers for the admin UI

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Trainer (`admin/trainer.js`)

**Files:**
- Create: `admin/trainer.js`
- Create: `tests/admin-trainer.test.js`

**Interfaces:**
- Produces: `createTrainer({ pythonPath, script, dataset, encodings, detectionMethod, onTrained }): { state, start }`
  - `state`: `{ status: 'idle' | 'running' | 'done' | 'error', message: string, skipped: Array<{ photo: string, reason: string }> }` (same object, mutated in place)
  - `start(): false | Promise<void>` — `false` when already running; the promise resolves when the run ends (never rejects)
  - `onTrained()` is called once after a successful model swap
- Consumes: `[SKIP] <person>/<file>: <reason>` lines from `encode.py` (Task 3)

- [ ] **Step 1: Write the failing tests**

Create `tests/admin-trainer.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTrainer } = require('../admin/trainer');

// Stands in for tools/encode.py: same arguments, same [SKIP] output.
const FAKE_ENCODE = `
import sys
args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
print("[INFO] quantifying faces...")
print("[SKIP] Ania/b.jpg: 2 faces")
print("[SKIP] Ania/c.jpg: unreadable")
if args["-i"].endswith("fail"):
    print("Traceback: boom", file=sys.stderr)
    sys.exit(1)
open(args["-e"], "w").write("new model " + args["-d"])
`;

function setup(t, datasetName = 'dataset') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'face-trainer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'encode.py');
  fs.writeFileSync(script, FAKE_ENCODE);
  const encodings = path.join(root, 'encodings.pickle');
  fs.writeFileSync(encodings, 'old model');
  let trained = 0;
  const trainer = createTrainer({
    pythonPath: null,
    script,
    dataset: path.join(root, datasetName),
    encodings,
    detectionMethod: 'hog',
    onTrained: () => trained++,
  });
  return { trainer, encodings, trained: () => trained };
}

test('successful run swaps the model and reports skipped photos', async t => {
  const { trainer, encodings, trained } = setup(t);
  const run = trainer.start();
  assert.equal(trainer.state.status, 'running');
  assert.equal(trainer.start(), false, 'second start while running');
  await run;
  assert.equal(trainer.state.status, 'done');
  assert.deepEqual(trainer.state.skipped, [
    { photo: 'Ania/b.jpg', reason: '2 faces' },
    { photo: 'Ania/c.jpg', reason: 'unreadable' },
  ]);
  assert.equal(fs.readFileSync(encodings, 'utf8'), 'new model hog');
  assert.ok(!fs.existsSync(encodings + '.tmp'));
  assert.equal(trained(), 1);
});

test('failed run keeps the old model and stores the error', async t => {
  const { trainer, encodings, trained } = setup(t, 'fail');
  await trainer.start();
  assert.equal(trainer.state.status, 'error');
  assert.match(trainer.state.message, /boom/);
  assert.equal(fs.readFileSync(encodings, 'utf8'), 'old model');
  assert.equal(trained(), 0);
});

test('missing interpreter ends in error, and a new run can start', async () => {
  const broken = createTrainer({
    pythonPath: '/nonexistent/python3',
    script: 'x.py',
    dataset: '/tmp',
    encodings: '/tmp/never.pickle',
    detectionMethod: 'hog',
    onTrained: () => assert.fail('must not train'),
  });
  await broken.start();
  assert.equal(broken.state.status, 'error');
  const again = broken.start();
  assert.notEqual(again, false, 'not stuck in running');
  await again;
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/admin-trainer.test.js`
Expected: FAIL with `Cannot find module '../admin/trainer'`

- [ ] **Step 3: Write the implementation**

Create `admin/trainer.js`:

```js
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');

const SKIP_RE = /^\[SKIP\] (.+): (.+)$/;

// Runs encode.py into a temporary file and moves it over the model only when the
// run succeeds, so a failed run keeps recognition on the previous model.
function createTrainer({ pythonPath, script, dataset, encodings, detectionMethod, onTrained }) {
  const state = { status: 'idle', message: '', skipped: [] };

  function start() {
    if (state.status === 'running') return false;
    Object.assign(state, { status: 'running', message: '', skipped: [] });
    const tmp = encodings + '.tmp';
    const tail = [];

    return new Promise(resolve => {
      const finish = (status, message) => {
        if (state.status !== 'running') return;
        Object.assign(state, { status, message });
        resolve();
      };
      const child = spawn(pythonPath || 'python3', ['-u', script, '-i', dataset, '-e', tmp, '-d', detectionMethod]);
      const onLine = line => {
        const skip = line.match(SKIP_RE);
        if (skip) state.skipped.push({ photo: skip[1], reason: skip[2] });
        tail.push(line);
        if (tail.length > 10) tail.shift();
        state.message = line;
      };
      readline.createInterface({ input: child.stdout }).on('line', onLine);
      readline.createInterface({ input: child.stderr }).on('line', onLine);

      child.on('error', err => finish('error', err.message));
      child.on('close', code => {
        if (code !== 0) return finish('error', tail.join('\n'));
        try {
          fs.renameSync(tmp, encodings);
        } catch (err) {
          return finish('error', err.message);
        }
        finish('done', 'Model updated');
        onTrained();
      });
    });
  }

  return { state, start };
}

module.exports = { createTrainer };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/trainer.js tests/admin-trainer.test.js
git commit -m "feat(admin): run encode.py and swap the model atomically

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `encode.py` skips bad photos

**Files:**
- Modify: `tools/encode.py` (loop body, around the `cv2.imread` / `face_locations` lines)

**Interfaces:**
- Produces: stdout lines `[SKIP] <person>/<file>: <n> faces` and `[SKIP] <person>/<file>: unreadable` (parsed by Task 2's `SKIP_RE`)

`face_recognition` is only installed on the mirror, so this task is verified there.

- [ ] **Step 1: Change the loop**

In `tools/encode.py` replace:

```python
    image = cv2.imread(imagePath)
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    # detect the (x, y)-coordinates of the bounding boxes
    # corresponding to each face in the input image
    boxes = face_recognition.face_locations(
        rgb, model=Arguments.get("detection_method")
    )
```

with:

```python
    image = cv2.imread(imagePath)
    photo = os.path.join(name, os.path.basename(imagePath))
    if image is None:
        print("[SKIP] {}: unreadable".format(photo))
        continue
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    # detect the (x, y)-coordinates of the bounding boxes
    # corresponding to each face in the input image
    boxes = face_recognition.face_locations(
        rgb, model=Arguments.get("detection_method")
    )

    # Every face in a photo is stored under the person's name, so a photo
    # with no face or with someone else in it would poison the model.
    if len(boxes) != 1:
        print("[SKIP] {}: {} faces".format(photo, len(boxes)))
        continue
```

- [ ] **Step 2: Verify on the mirror against a scratch dataset**

The mirror's module clone is not touched; the script is copied to `/tmp`.

```bash
scp tools/encode.py mirror:/tmp/encode-test.py
ssh mirror 'set -e
T=/tmp/face-enc-test; rm -rf $T; mkdir -p $T/ds/Test
cp ~/MagicMirror/modules/MMM-Face-Reco-DNN/dataset/Krzysiek/k01.jpg $T/ds/Test/one.jpg
curl -s -o $T/ds/Test/empty.jpg "http://127.0.0.1:1984/api/frame.jpeg?src=c925e_face"
echo garbage > $T/ds/Test/broken.jpg
cp -r ~/MagicMirror/modules/MMM-Face-Reco-DNN/tools/utils /tmp/
cd /tmp && python3 -u encode-test.py -i $T/ds -e $T/enc.pickle -d hog
python3 -c "import pickle; d=pickle.load(open(\"$T/enc.pickle\",\"rb\")); print(len(d[\"names\"]), set(d[\"names\"]))"
rm -rf $T /tmp/encode-test.py /tmp/utils'
```

Expected: `[SKIP] Test/broken.jpg: unreadable`; `empty.jpg` gives `[SKIP] Test/empty.jpg: 0 faces` when nobody stands in front of the mirror (1 face is also fine if someone does); the last line is `1 {'Test'}` (or `2 {'Test'}`). No traceback.

- [ ] **Step 3: Commit**

```bash
git add tools/encode.py
git commit -m "feat(encode): skip photos without exactly one face or unreadable ones

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Router (`admin/routes.js`)

**Files:**
- Create: `admin/routes.js`
- Create: `tests/admin-routes.test.js`

**Interfaces:**
- Consumes: everything from `admin/lib.js` (Task 1); a trainer shaped like Task 2's `{ state, start }`
- Produces: `createAdminRouter({ dataset, encodings, pin, cameraFrameUrl, trainer }): express.Router`
- JSON shapes the UI (Task 5) relies on:
  - `GET api/people` → `{ people: [{ name, photos: [file] }], stale: boolean, training: { status, message, skipped: [{ photo, reason }] } }`
  - errors → `{ error: string }`
  - `POST api/people/:name` → 201 `{ name }`; `PATCH` → 200 `{ name }`; `capture`/`photos` → 201 `{ file }`; `DELETE`s → 204; `POST api/train` → 202 `{ status: 'running' }`

- [ ] **Step 1: Write the failing tests**

Create `tests/admin-routes.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/admin-routes.test.js`
Expected: FAIL with `Cannot find module '../admin/routes'`

- [ ] **Step 3: Write the implementation**

Create `admin/routes.js`:

```js
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function createAdminRouter({ dataset, encodings, pin, cameraFrameUrl, trainer }) {
  const router = express.Router();
  const fail = (res, status, error) => res.status(status).json({ error });

  router.use((req, res, next) => {
    if (lib.checkPin(req.headers.authorization, pin)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Face admin"');
    fail(res, 401, 'PIN required');
  });

  // admin.html loads admin.js and the API with relative URLs, which need the trailing slash.
  router.get('/', (req, res) => {
    if (!req.originalUrl.endsWith('/')) return res.redirect(301, req.originalUrl + '/');
    res.sendFile(path.join(__dirname, 'admin.html'));
  });
  router.get('/admin.js', (req, res) => res.sendFile(path.join(__dirname, 'admin.js')));

  async function fetchFrame() {
    const res = await fetch(cameraFrameUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`camera answered HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  function person(req, res, next) {
    req.dir = lib.isValidName(req.params.name) && lib.resolveInside(dataset, req.params.name);
    if (!req.dir) return fail(res, 400, 'invalid name');
    next();
  }

  function existing(req, res, next) {
    if (!fs.existsSync(req.dir)) return fail(res, 404, 'no such person');
    next();
  }

  function photo(req, res, next) {
    if (!lib.isValidPhoto(req.params.file)) return fail(res, 400, 'invalid file name');
    req.photo = path.join(req.dir, req.params.file);
    if (!fs.existsSync(req.photo)) return fail(res, 404, 'no such photo');
    next();
  }

  function save(req, res, buffer) {
    const file = lib.photoFileName(req.dir, req.params.name);
    fs.writeFileSync(path.join(req.dir, file), buffer);
    res.status(201).json({ file });
  }

  router.get('/api/people', (req, res) => {
    res.json({ people: lib.listPeople(dataset), stale: lib.isStale(dataset, encodings), training: trainer.state });
  });

  router.post('/api/people/:name', person, (req, res) => {
    if (fs.existsSync(req.dir)) return fail(res, 409, 'person exists');
    fs.mkdirSync(req.dir);
    res.status(201).json({ name: req.params.name });
  });

  router.patch('/api/people/:name', person, existing, express.json(), (req, res) => {
    const name = req.body && req.body.name;
    const target = lib.isValidName(name) && lib.resolveInside(dataset, name);
    if (!target) return fail(res, 400, 'invalid name');
    if (fs.existsSync(target)) return fail(res, 409, 'person exists');
    fs.renameSync(req.dir, target);
    res.json({ name });
  });

  router.delete('/api/people/:name', person, existing, (req, res) => {
    fs.rmSync(req.dir, { recursive: true });
    res.status(204).end();
  });

  router.get('/api/frame', (req, res) => {
    fetchFrame().then(
      buffer => res.type('image/jpeg').set('Cache-Control', 'no-store').send(buffer),
      err => fail(res, 502, err.message),
    );
  });

  router.post('/api/people/:name/capture', person, existing, (req, res, next) => {
    fetchFrame().then(
      buffer => {
        try {
          save(req, res, buffer);
        } catch (err) {
          next(err);
        }
      },
      err => fail(res, 502, err.message),
    );
  });

  router.post(
    '/api/people/:name/photos',
    person,
    existing,
    express.raw({ type: 'image/jpeg', limit: '5mb' }),
    (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) {
        return fail(res, 400, 'JPEG expected');
      }
      save(req, res, body);
    },
  );

  router.get('/api/people/:name/photos/:file', person, existing, photo, (req, res) => {
    res.set('Cache-Control', 'no-store').sendFile(req.photo);
  });

  router.delete('/api/people/:name/photos/:file', person, existing, photo, (req, res) => {
    fs.unlinkSync(req.photo);
    res.status(204).end();
  });

  router.post('/api/train', (req, res) => {
    if (!lib.listPeople(dataset).some(p => p.photos.length > 0)) return fail(res, 400, 'no photos to train on');
    if (!trainer.start()) return fail(res, 409, 'training already running');
    res.status(202).json({ status: 'running' });
  });

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => fail(res, err.status || 500, err.message));

  return router;
}

module.exports = { createAdminRouter };
```

Note on the 413 test: `express.raw` rejects the oversized body before the handler and its error carries `status: 413`, which the error middleware passes through.

The redirect test needs `admin/admin.html` and `admin/admin.js` to exist. Create empty placeholders now so this task is testable on its own; Task 5 fills them:

```bash
printf '<!doctype html>\n<html lang="pl"></html>\n' > admin/admin.html
printf "'use strict';\n" > admin/admin.js
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add admin/routes.js admin/admin.html admin/admin.js tests/admin-routes.test.js
git commit -m "feat(admin): add PIN-protected dataset API

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Phone UI (`admin/admin.html`, `admin/admin.js`)

**Files:**
- Modify (replace placeholders): `admin/admin.html`, `admin/admin.js`

**Interfaces:**
- Consumes: the JSON shapes listed in Task 4. All URLs relative to `/MMM-Face-Reco-DNN/admin/`.

- [ ] **Step 1: Write `admin/admin.html`**

```html
<!doctype html>
<html lang="pl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Twarze — lustro</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0 auto; max-width: 40rem; padding: 1rem; }
      button { font: inherit; min-height: 44px; padding: 0.5rem 1rem; }
      h1 { font-size: 1.5rem; }
      #bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; padding: 0.75rem; margin-bottom: 1rem; border-radius: 0.5rem; background: #8883; }
      #bar[hidden] { display: none; }
      .note { font-size: 0.9em; opacity: 0.8; }
      .people { list-style: none; padding: 0; }
      .people a { display: flex; gap: 0.75rem; align-items: center; padding: 0.5rem 0; color: inherit; text-decoration: none; }
      .people img, .people .empty { width: 56px; height: 56px; border-radius: 0.25rem; object-fit: cover; background: #8883; }
      #preview { display: block; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 0.5rem; }
      .row { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0.75rem 0; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 0.5rem; }
      .grid figure { margin: 0; display: grid; gap: 0.25rem; }
      .grid img { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 0.25rem; }
      .grid .skipped img { outline: 3px solid #d33; }
      .grid figcaption { font-size: 0.8em; color: #d33; }
    </style>
  </head>
  <body>
    <div id="bar" role="status" hidden></div>
    <main id="view"></main>
    <script src="admin.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `admin/admin.js`**

```js
'use strict';

const view = document.getElementById('view');
const bar = document.getElementById('bar');
const enc = encodeURIComponent;
let data = { people: [], stale: false, training: { status: 'idle', message: '', skipped: [] } };
let pollTimer = null;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function api(method, url, body, type) {
  const res = await fetch(url, { method, body, headers: type ? { 'Content-Type': type } : {} });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function fail(err) {
  alert(err.message);
}

async function refresh(renderView = true) {
  const wasRunning = data.training.status === 'running';
  data = await api('GET', 'api/people');
  renderBar();
  // While training runs only the bar updates, so the camera preview is not rebuilt.
  if (renderView || (wasRunning && data.training.status !== 'running')) render();
  clearTimeout(pollTimer);
  if (data.training.status === 'running') pollTimer = setTimeout(() => refresh(false).catch(fail), 2000);
}

function trainButton() {
  return el('button', {
    textContent: 'Przeszkol',
    onclick: () => api('POST', 'api/train').then(() => refresh(false)).catch(fail),
  });
}

function renderBar() {
  const t = data.training;
  bar.replaceChildren();
  if (t.status === 'running') {
    bar.append('Trwa trenowanie… ', el('span', { className: 'note', textContent: t.message }));
  } else if (t.status === 'error') {
    bar.append(el('span', { textContent: `Trenowanie nie powiodło się: ${t.message}` }), trainButton());
  } else if (data.stale) {
    bar.append('Model nieaktualny', trainButton());
  } else if (t.status === 'done') {
    bar.append(t.skipped.length ? `Model aktualny. Pominięte zdjęcia: ${t.skipped.length} (zaznaczone na czerwono).` : 'Model aktualny.');
  }
  bar.hidden = bar.childNodes.length === 0;
}

function render() {
  const name = location.hash.startsWith('#p/') ? decodeURIComponent(location.hash.slice(3)) : null;
  const person = data.people.find(p => p.name === name);
  if (person) renderPerson(person);
  else renderList();
}

const photoUrl = (name, file) => `api/people/${enc(name)}/photos/${enc(file)}`;

function renderList() {
  const items = data.people.map(p =>
    el(
      'li',
      {},
      el(
        'a',
        { href: `#p/${enc(p.name)}` },
        p.photos.length ? el('img', { src: photoUrl(p.name, p.photos[0]), alt: '', loading: 'lazy' }) : el('span', { className: 'empty' }),
        el('span', { textContent: `${p.name} (${p.photos.length} zdj.)` }),
      ),
    ),
  );
  const add = el('button', {
    textContent: 'Dodaj osobę',
    onclick: () => {
      const name = prompt('Imię (litery, cyfry, - i _):');
      if (!name) return;
      api('POST', `api/people/${enc(name)}`)
        .then(() => {
          location.hash = `#p/${enc(name)}`;
          return refresh();
        })
        .catch(fail);
    },
  });
  view.replaceChildren(el('h1', { textContent: 'Twarze' }), el('ul', { className: 'people' }, ...items), add);
}

async function upload(base, file) {
  // createImageBitmap applies EXIF orientation; scaling keeps HOG fast and the SD card small.
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = el('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return api('POST', `${base}/photos`, blob, 'image/jpeg');
}

function renderPerson(p) {
  const base = `api/people/${enc(p.name)}`;
  const skipped = new Map(data.training.skipped.map(s => [s.photo, s.reason]));

  // Poll one frame at a time; the chain stops once the preview leaves the page.
  const preview = el('img', { id: 'preview', alt: 'Podgląd kamery lustra' });
  const nextFrame = () => {
    if (preview.isConnected) preview.src = `api/frame?t=${Date.now()}`;
  };
  preview.onload = preview.onerror = () => setTimeout(nextFrame, 500);

  const capture = el('button', {
    textContent: 'Zrób zdjęcie',
    onclick: () => api('POST', `${base}/capture`).then(() => refresh()).catch(fail),
  });
  const input = el('input', { type: 'file', accept: 'image/*', hidden: true });
  input.setAttribute('capture', 'user');
  input.onchange = () => {
    if (input.files[0]) upload(base, input.files[0]).then(() => refresh()).catch(fail);
  };
  const fromPhone = el('button', { textContent: 'Z telefonu', onclick: () => input.click() });

  const grid = el(
    'div',
    { className: 'grid' },
    ...p.photos.map(file => {
      const reason = skipped.get(`${p.name}/${file}`);
      return el(
        'figure',
        { className: reason ? 'skipped' : '' },
        el('img', { src: photoUrl(p.name, file), alt: file, loading: 'lazy' }),
        ...(reason ? [el('figcaption', { textContent: `pominięte: ${reason}` })] : []),
        el('button', {
          textContent: 'Usuń',
          onclick: () => {
            if (confirm('Usunąć zdjęcie?')) api('DELETE', photoUrl(p.name, file)).then(() => refresh()).catch(fail);
          },
        }),
      );
    }),
  );

  const rename = el('button', {
    textContent: 'Zmień imię',
    onclick: () => {
      const name = prompt('Nowe imię:', p.name);
      if (!name || name === p.name) return;
      api('PATCH', base, JSON.stringify({ name }), 'application/json')
        .then(() => {
          location.hash = `#p/${enc(name)}`;
          return refresh();
        })
        .catch(fail);
    },
  });
  const remove = el('button', {
    textContent: 'Usuń osobę',
    onclick: () => {
      if (!confirm(`Usunąć ${p.name} i wszystkie zdjęcia?`)) return;
      api('DELETE', base)
        .then(() => {
          location.hash = '';
          return refresh();
        })
        .catch(fail);
    },
  });

  view.replaceChildren(
    el('p', {}, el('a', { href: '#', textContent: '← Wszyscy' })),
    el('h1', { textContent: p.name }),
    preview,
    el('div', { className: 'row' }, capture, fromPhone, input),
    grid,
    el('div', { className: 'row' }, rename, remove),
    el('p', {
      className: 'note',
      textContent: 'Imię to też klucz w classes w config.js lustra — po zmianie imienia lub usunięciu osoby popraw config ręcznie.',
    }),
  );
  nextFrame();
}

window.addEventListener('hashchange', render);
refresh().catch(fail);
```

- [ ] **Step 3: Check the page in a browser against a local dev server**

The dev server mounts the real router with a fake camera frame and a trainer that finishes after 3 s. It lives in the session scratchpad, not the repo.

```bash
SCRATCH=${SCRATCH:-$(mktemp -d)}
cat > "$SCRATCH/dev-admin.js" <<'EOF'
const path = require('path');
const fs = require('fs');
const os = require('os');
const mod = process.argv[2];
const express = require(require.resolve('express', { paths: [mod] }));
const { createAdminRouter } = require(path.join(mod, 'admin/routes'));
const dataset = fs.mkdtempSync(path.join(os.tmpdir(), 'face-dev-'));
fs.mkdirSync(path.join(dataset, 'Łucja'));
const trainer = {
  state: { status: 'idle', message: '', skipped: [] },
  start() {
    if (this.state.status === 'running') return false;
    Object.assign(this.state, { status: 'running', message: 'processing image 1/1', skipped: [] });
    return new Promise(r => setTimeout(() => {
      const first = fs.readdirSync(path.join(dataset, 'Łucja'))[0];
      Object.assign(this.state, { status: 'done', message: 'Model updated', skipped: first ? [{ photo: `Łucja/${first}`, reason: '0 faces' }] : [] });
      fs.writeFileSync(path.join(dataset, '..', path.basename(dataset) + '.pickle'), 'x');
      r();
    }, 3000));
  },
};
const app = express();
app.get('/frame.jpg', (req, res) => res.sendFile(process.argv[3]));
app.use('/MMM-Face-Reco-DNN/admin', createAdminRouter({
  dataset, encodings: dataset + '.pickle', pin: '1234',
  cameraFrameUrl: 'http://127.0.0.1:8099/frame.jpg', trainer,
}));
app.listen(8099, () => console.log('http://127.0.0.1:8099/MMM-Face-Reco-DNN/admin/  PIN 1234  dataset', dataset));
EOF
scp mirror:MagicMirror/modules/MMM-Face-Reco-DNN/dataset/Krzysiek/k01.jpg "$SCRATCH/frame.jpg"
node "$SCRATCH/dev-admin.js" "$PWD" "$SCRATCH/frame.jpg"
```

(Run the last line in the background.) Open the printed URL in Chrome at phone width (≈ 390 px), enter PIN `1234`, and check:
- list shows `Łucja (0 zdj.)`, bar shows "Model nieaktualny";
- person view: preview refreshes; "Zrób zdjęcie" adds a photo to the grid;
- "Z telefonu" with any large JPEG uploads a ≤ 1280 px image (check the file size in the dataset dir);
- "Przeszkol": bar shows "Trwa trenowanie…", after ~3 s "Model aktualny. Pominięte zdjęcia: 1", the first photo has a red outline with "pominięte: 0 faces";
- rename to `Żaneta` keeps the person view open under the new name; delete person returns to the list;
- leaving the person view stops `api/frame` requests (DevTools Network tab).

Stop the dev server afterwards.

- [ ] **Step 4: Commit**

```bash
git add admin/admin.html admin/admin.js
git commit -m "feat(admin): add phone UI for the face dataset

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Wire into `node_helper.js` + README

**Files:**
- Modify: `node_helper.js`
- Modify: `README.md` (new section after the configuration options)

**Interfaces:**
- Consumes: `createAdminRouter` (Task 4), `createTrainer` (Task 2), `isServedPath` (Task 1); MagicMirror's `this.expressApp`, `this.path`, `global.root_path`
- Config read: `this.config.admin` (`{ enabled, pin, cameraFrameUrl }`, partial objects allowed), `this.config.dataset`, `this.config.encodings`, `this.config.pythonPath`, `this.config.detectionMethod`

No automated test: this glue needs a running MagicMirror. Verified in Task 7.

- [ ] **Step 1: Add requires and module state**

After `const onExit = require('signal-exit');` add:

```js
const path = require('path');
const fs = require('fs');
```

After `var pythonStarted = false;` add:

```js
// Users the recognition process has logged in and not yet out; needed to log
// them out when the process is restarted after training.
const loggedIn = new Set();
const ADMIN_DEFAULTS = {
  enabled: false,
  pin: '',
  cameraFrameUrl: 'http://127.0.0.1:1984/api/frame.jpeg?src=c925e_face',
};
```

- [ ] **Step 2: Track logins and stop stacking exit handlers**

In `python_start`, in the `login` branch, after the `console.log(...)` line add:

```js
        message.login.names.forEach(name => loggedIn.add(name));
```

In the `logout` branch, after its `console.log(...)` line add:

```js
        message.logout.names.forEach(name => loggedIn.delete(name));
```

Replace:

```js
    onExit(function (_code, _signal) {
      self.destroy();
    });
```

with:

```js
    // python_start runs again after every training; one exit hook is enough.
    if (!self.exitHooked) {
      self.exitHooked = true;
      onExit(function (_code, _signal) {
        self.destroy();
      });
    }
```

- [ ] **Step 3: Add restart and admin start**

After the `python_stop` function add:

```js
  // The new process starts with nobody logged in and never reports a logout for
  // people the old one saw, so log them out here. Whoever is still in front of
  // the camera gets logged in again by the new process.
  python_restart: function () {
    console.log('[' + this.name + '] Model retrained, restarting recognition');
    if (loggedIn.size > 0) {
      this.sendSocketNotification('user', { action: 'logout', users: [...loggedIn] });
      loggedIn.clear();
    }
    this.pyshell.childProcess.kill();
    this.python_start();
  },

  admin_start: function () {
    const admin = Object.assign({}, ADMIN_DEFAULTS, this.config.admin);
    if (admin.enabled !== true) return;
    if (!admin.pin) {
      console.warn('[' + this.name + '] Admin UI not started: admin.pin is empty');
      return;
    }
    const dataset = path.resolve(global.root_path, this.config.dataset);
    const encodings = path.resolve(global.root_path, this.config.encodings);
    const { isServedPath } = require('./admin/lib');
    if (isServedPath(dataset, global.root_path) || isServedPath(encodings, global.root_path)) {
      console.error('[' + this.name + '] Admin UI not started: dataset and encodings must live outside directories MagicMirror serves (e.g. /home/dietpi/face-reco/)');
      return;
    }
    fs.mkdirSync(dataset, { recursive: true });

    const { createTrainer } = require('./admin/trainer');
    const { createAdminRouter } = require('./admin/routes');
    const trainer = createTrainer({
      pythonPath: this.config.pythonPath,
      script: path.join(this.path, 'tools', 'encode.py'),
      dataset,
      encodings,
      detectionMethod: this.config.detectionMethod,
      onTrained: () => this.python_restart(),
    });
    this.expressApp.use('/' + this.name + '/admin', createAdminRouter({ dataset, encodings, pin: String(admin.pin), cameraFrameUrl: admin.cameraFrameUrl, trainer }));
    console.log('[' + this.name + '] Admin UI at /' + this.name + '/admin/');
  },
```

- [ ] **Step 4: Start admin once with Python**

In `socketNotificationReceived`, inside `if (!pythonStarted) { ... }`, after `this.python_start();` add:

```js
        this.admin_start();
```

(`CONFIG` arrives once per connected browser; the `pythonStarted` guard keeps routes from being mounted twice.)

- [ ] **Step 5: Syntax check and existing tests**

Run: `node --check node_helper.js && npm test`
Expected: no output from `--check`; all tests PASS.

- [ ] **Step 6: README section**

Add to `README.md` after the configuration options table:

````markdown
## Admin web UI

Manage the dataset from a phone: add, rename and delete people, take photos with the
mirror camera or upload them from the phone, and retrain without restarting MagicMirror.

```js
admin: {
  enabled: true,
  pin: "choose-a-pin",
  // one JPEG frame from the camera the recognition uses
  cameraFrameUrl: "http://127.0.0.1:1984/api/frame.jpeg?src=c925e_face",
},
// Both must live outside the directories MagicMirror serves (modules, config, ...),
// otherwise anyone on the network could download the photos and the admin UI stays off.
dataset: "/home/dietpi/face-reco/dataset/",
encodings: "/home/dietpi/face-reco/encodings.pickle",
```

Open `http://<mirror>:8080/MMM-Face-Reco-DNN/admin/` and enter the PIN as the password
(any user name). "Przeszkol" runs `tools/encode.py`; photos without exactly one face are
skipped and marked in red. The person's name is the directory name and the name used in
`classes`, so fix `classes` by hand after renaming or deleting someone.

Moving an existing dataset:

```bash
mkdir -p ~/face-reco
mv ~/MagicMirror/modules/MMM-Face-Reco-DNN/dataset ~/face-reco/dataset
mv ~/MagicMirror/modules/MMM-Face-Reco-DNN/model/encodings.pickle ~/face-reco/
```
````

- [ ] **Step 7: Commit**

```bash
git add node_helper.js README.md
git commit -m "feat(admin): mount the admin UI and restart recognition after training

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Deploy to the mirror and verify end to end

**Files:** none in the repo. On the mirror: `~/MagicMirror/config/config.js` (module entry), `~/face-reco/`.

Every step that changes the mirror or pushes to GitHub needs the user's go-ahead first. The PIN is chosen by the user and never written to the plan, chat or commit.

- [ ] **Step 1: Push the module branch** (ask the user first)

```bash
git push origin HEAD
```

- [ ] **Step 2: Back up and move the dataset on the mirror** (ask the user first)

```bash
ssh mirror 'set -e
cd ~/MagicMirror/modules/MMM-Face-Reco-DNN
tar czf ~/face-reco-backup-$(date +%Y%m%d).tgz dataset model/encodings.pickle
mkdir -p ~/face-reco
mv dataset ~/face-reco/dataset
mv model/encodings.pickle ~/face-reco/encodings.pickle
ls -la ~/face-reco ~/face-reco/dataset'
```

- [ ] **Step 3: Update the mirror config** (ask the user first; do not print the file)

In the `MMM-Face-Reco-DNN` entry of `~/MagicMirror/config/config.js` set `dataset: "/home/dietpi/face-reco/dataset/"`, `encodings: "/home/dietpi/face-reco/encodings.pickle"` and add the `admin` block with the user's PIN. Edit with a targeted `sed`/`python` replacement over SSH that prints nothing, or let the user edit. Then:

```bash
ssh mirror 'cd ~/MagicMirror && git -C modules/MMM-Face-Reco-DNN pull --ff-only && npm run config:check && ./mm_restart.sh'
```

Expected: `config:check` reports no errors. Restart can take up to `TimeoutStopSec` (15 s).

- [ ] **Step 4: Verify the server side**

```bash
ssh mirror 'sudo journalctl -u magicmirror --since "-3 min" | grep -E "MMM-Face-Reco-DNN\] (Admin|Starting|Model)"'
curl -s -o /dev/null -w "%{http_code}\n" http://192.168.0.29:8080/MMM-Face-Reco-DNN/admin/api/people
curl -s -o /dev/null -w "%{http_code}\n" http://192.168.0.29:8080/modules/MMM-Face-Reco-DNN/dataset/Krzysiek/k01.jpg
```

Expected: log line `Admin UI at /MMM-Face-Reco-DNN/admin/`; first curl `401`; second curl `404` (photos no longer public).

- [ ] **Step 5: Full flow from the phone** (user does it, Claude watches the log)

```bash
ssh mirror 'sudo journalctl -u magicmirror -f | grep --line-buffered MMM-Face-Reco-DNN'
```

User, on the phone at `http://192.168.0.29:8080/MMM-Face-Reco-DNN/admin/`:
1. Opens Krzysiek, stands in front of the mirror, taps "Zrób zdjęcie" 3–5 times from slightly different angles.
2. Uploads one photo "Z telefonu".
3. Taps "Przeszkol", stays until "Model aktualny", then walks away from the mirror.

Expected in the log: `Model retrained, restarting recognition`, a new `Starting face recognition loop.`, `Users logging in: Krzysiek` while standing there, and a logout (`USERS_LOGOUT_MODULES` path) within `logoutDelay` after walking away — Review Focus item 1.

- [ ] **Step 6: Check disabled mode is inert**

Temporarily set `admin.enabled: false` (or ask the user whether to skip this), restart, and confirm:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://192.168.0.29:8080/MMM-Face-Reco-DNN/admin/
```

Expected: `404`. Restore `enabled: true` and restart.

- [ ] **Step 7: Update project notes**

In `/home/krzysztof/Development/magic-mirror/CLAUDE.md`, section on `MMM-Face-Reco-DNN`, add one line: admin UI at `:8080/MMM-Face-Reco-DNN/admin/` (PIN in config), dataset and model in `/home/dietpi/face-reco/`, retraining from the UI restarts only `recognition.py`. (CLAUDE.md is not in a git repo; no commit.)
