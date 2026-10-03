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
console.log('greeting ok');
