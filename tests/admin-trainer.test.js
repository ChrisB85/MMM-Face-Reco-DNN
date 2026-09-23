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
