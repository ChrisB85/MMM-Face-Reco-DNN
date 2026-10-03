'use strict';

// Decides whether the mirror says its own greeting for a recognized person,
// given the retained state Home Assistant keeps in mirror/powitanie/<osoba>
// ({stan: 'pending'|'done', do: epoch seconds the state is valid until}).
//   speak  - mirror greets itself (no state, expired state, or no MQTT)
//   silent - Home Assistant already greeted
//   wait   - Home Assistant is about to greet; speak anyway if it does not
function decide(entry, nowMs, connected) {
  if (!connected || !entry || !(entry.do * 1000 > nowMs)) return 'speak';
  return entry.stan === 'done' ? 'silent' : entry.stan === 'pending' ? 'wait' : 'speak';
}

module.exports = { decide };
