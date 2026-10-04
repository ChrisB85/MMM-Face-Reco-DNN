'use strict';

// Decides whether the mirror says its own greeting for a recognized person,
// given the retained state Home Assistant keeps in mirror/powitanie/<osoba>
// ({stan: 'pending'|'done', do: epoch seconds the state is valid until}).
//   speak  - mirror greets itself (no state, expired state, or no MQTT)
//   silent - Home Assistant already greeted
//   wait   - Home Assistant is about to greet; speak anyway if it does not
// `ask` is the retained mirror/pytanie/<osoba> ({due, do}): HA is about to ask how the person
// feels instead of greeting, so with no other state the mirror waits for HA's `done` too.
function decide(entry, nowMs, connected, ask) {
  if (!connected) return 'speak';
  if (entry && entry.do * 1000 > nowMs) {
    return entry.stan === 'done' ? 'silent' : entry.stan === 'pending' ? 'wait' : 'speak';
  }
  return ask && ask.due === true && ask.do * 1000 > nowMs ? 'wait' : 'speak';
}

module.exports = { decide };
