'use strict';
const assert = require('assert');
const { decide } = require('../greeting');
const now = 1000000;
const live = s => ({ stan: s, do: now / 1000 + 60 });
assert.strictEqual(decide(undefined, now, true), 'speak');
assert.strictEqual(decide(live('done'), now, false), 'speak'); // no MQTT: never silent
assert.strictEqual(decide({ stan: 'done', do: now / 1000 - 1 }, now, true), 'speak'); // expired
assert.strictEqual(decide(live('done'), now, true), 'silent');
assert.strictEqual(decide(live('pending'), now, true), 'wait');
assert.strictEqual(decide(live('???'), now, true), 'speak');
// question due (HA will ask instead of greeting): wait for HA's `done`, never speak straight away
const due = { due: true, do: now / 1000 + 60 };
assert.strictEqual(decide(undefined, now, true, due), 'wait');
assert.strictEqual(decide({ stan: 'done', do: now / 1000 - 1 }, now, true, due), 'wait'); // expired state
assert.strictEqual(decide(live('done'), now, true, due), 'silent'); // someone already greeted
assert.strictEqual(decide(live('pending'), now, true, due), 'wait');
assert.strictEqual(decide(undefined, now, false, due), 'speak'); // no MQTT: greet
assert.strictEqual(decide(undefined, now, true, { due: true, do: now / 1000 - 1 }), 'speak'); // stale flag (HA down)
assert.strictEqual(decide(undefined, now, true, { due: false, do: now / 1000 + 60 }), 'speak');
console.log('greeting ok');
