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
