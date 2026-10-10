"use strict";
const test = require("node:test");
const assert = require("node:assert");

function loadFrontEnd() {
  let definition;
  global.Log = { log() {}, info() {} };
  global.Module = { register: (_name, d) => (definition = d) };
  delete require.cache[require.resolve("../MMM-Face-Reco-DNN.js")];
  require("../MMM-Face-Reco-DNN.js");
  return definition;
}

function frontEnd() {
  const definition = loadFrontEnd();
  const sent = [];
  const socket = [];
  const mod = Object.assign(Object.create(definition), {
    config: Object.assign({}, definition.defaults),
    users: ["alice"],
    lastVoiceMessageTime: {},
    pendingWelcome: {},
    deferredWelcome: {},
    awaitingSound: {},
    translate: k => k,
    sendNotification: (n, p) => sent.push([n, p]),
    sendSocketNotification: (n, p) => socket.push([n, p]),
  });
  const spoken = () => sent.filter(([n]) => n === "MMM-Text-To-Speech").map(([, p]) => p.person);
  const greeted = () => socket.filter(([n]) => n === "GREETED").map(([, p]) => p);
  return { mod, spoken, greeted };
}

test("greeting during a voice conversation waits for it and is not marked greeted", () => {
  const { mod, spoken, greeted } = frontEnd();
  mod.notificationReceived("VOICE_ASSISTANT_STATE", "listening");
  mod.speak_welcome("alice", "Hi alice");
  assert.deepEqual(spoken(), []);
  assert.deepEqual(greeted(), []);

  mod.notificationReceived("VOICE_ASSISTANT_STATE", "idle");
  assert.deepEqual(spoken(), ["alice"]);
  mod.notificationReceived("SOUND_STARTED", "tts/x.mp3");
  assert.deepEqual(greeted(), ["alice"]);
});

test("greeting skipped because the conversation started during TTS download is said afterwards", () => {
  const { mod, spoken, greeted } = frontEnd();
  mod.speak_welcome("alice", "Hi alice");
  mod.notificationReceived("VOICE_ASSISTANT_STATE", "listening");
  assert.deepEqual(greeted(), []);
  mod.notificationReceived("VOICE_ASSISTANT_STATE", "idle");
  assert.deepEqual(spoken(), ["alice", "alice"]);
});

test("deferred greeting is dropped when the person left before the conversation ended", () => {
  const { mod, spoken } = frontEnd();
  mod.notificationReceived("VOICE_ASSISTANT_STATE", "listening");
  mod.speak_welcome("alice", "Hi alice");
  mod.users = [];
  mod.notificationReceived("VOICE_ASSISTANT_STATE", "idle");
  assert.deepEqual(spoken(), []);
});
