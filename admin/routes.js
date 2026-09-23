'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

function createAdminRouter({ dataset, encodings, pin, cameraFrameUrl, trainer }) {
  const router = express.Router();
  const fail = (res, status, error) => res.status(status).json({ error });

  // A short PIN falls to a script on the LAN in seconds. After ten wrong PINs within
  // a minute every request waits out that minute, the right PIN included.
  const failures = [];
  router.use((req, res, next) => {
    const now = Date.now();
    while (failures.length > 0 && now - failures[0] > 60000) failures.shift();
    if (failures.length >= 10) return fail(res, 429, 'too many wrong PINs, try again in a minute');
    if (lib.checkPin(req.headers.authorization, pin)) return next();
    // A browser's first request carries no credentials; only wrong PINs count.
    if (req.headers.authorization) failures.push(now);
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
