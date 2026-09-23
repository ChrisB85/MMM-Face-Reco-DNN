'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const Module = require('module');

// node_helper.js and the front-end module need MagicMirror's runtime; stand in for
// just the pieces the logout path touches.
const shells = [];
class FakeShell extends EventEmitter {
  constructor() {
    super();
    this.childProcess = { killed: false, kill: () => (this.childProcess.killed = true) };
    shells.push(this);
  }
  send() {}
  end() {}
}

function loadHelper() {
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'node_helper') return { create: definition => definition };
    if (request === 'python-shell') return { PythonShell: FakeShell };
    if (request === 'signal-exit') return () => {};
    return load.call(this, request, ...rest);
  };
  try {
    return require('../node_helper');
  } finally {
    Module._load = load;
  }
}

function loadFrontEnd() {
  let definition;
  global.Log = { log() {}, info() {} };
  global.Module = { register: (_name, d) => (definition = d) };
  require('../MMM-Face-Reco-DNN.js');
  return definition;
}

test('restart logs out everyone the old process saw and ignores its late messages', () => {
  const sent = [];
  const helper = Object.assign(Object.create(loadHelper()), {
    name: 'MMM-Face-Reco-DNN',
    config: { resolution: [640, 360], external_trigger_notification: '' },
    sendSocketNotification: (notification, payload) => sent.push([notification, payload]),
  });
  helper.python_start();
  const old = shells[0];
  old.emit('message', { login: { names: ['Krzysiek', 'unknown'] } });
  sent.length = 0;

  helper.python_restart();

  assert.ok(old.childProcess.killed);
  assert.equal(shells.length, 2);
  assert.deepEqual(sent, [
    ['user', { action: 'logout', users: ['Krzysiek'] }],
    ['user', { action: 'logout', users: ['unknown'] }],
  ]);

  sent.length = 0;
  old.emit('message', { login: { names: ['Ola'] } });
  assert.deepEqual(sent, [], 'the killed process may still print its last login');
  shells[1].emit('message', { login: { names: ['Ola'] } });
  assert.deepEqual(sent, [['user', { action: 'login', users: ['Ola'] }]]);
});

test('front end logs out every user of one logout payload, not the last one twice', async () => {
  const definition = loadFrontEnd();
  const loggedOut = [];
  const mod = Object.assign(Object.create(definition), {
    config: Object.assign({}, definition.defaults, { logoutDelay: 5 }),
    users: ['Krzysiek', 'Ola'],
    timouts: {},
    sendNotification() {},
    logout_user: user => loggedOut.push(user),
  });

  mod.socketNotificationReceived('user', { action: 'logout', users: ['Krzysiek', 'Ola'] });
  await new Promise(resolve => setTimeout(resolve, 30));

  assert.deepEqual(loggedOut.sort(), ['Krzysiek', 'Ola']);
});
