"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { greetMqttServer } = require("../greeting");

const withServer = (srv) => ({ modules: [{ module: "MMM-Text-To-Speech", config: { mqttServer: srv } }] });

test("MQTT credentials come from the loaded config, where SECRET_ placeholders are already resolved", () => {
  const loaded = withServer({ address: "broker", port: 1883, user: "u", password: "real" });
  const onDisk = () => withServer({ address: "broker", port: 1883, user: "u", password: "${SECRET_TTS_MQTT_PASSWORD}" });
  assert.strictEqual(greetMqttServer(loaded, onDisk).password, "real");
});

test("without a loaded config (MagicMirror before 2.35) config.js is read from disk", () => {
  const onDisk = () => withServer({ address: "broker", port: 1883, user: "u", password: "p" });
  assert.strictEqual(greetMqttServer(undefined, onDisk).password, "p");
});
