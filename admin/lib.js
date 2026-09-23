'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Anything encode.py trains on must be listable and deletable, so names are any
// single path segment: no separators or control characters, no leading dot
// (hidden, and ".." escapes), no surrounding spaces.
const NAME_RE = /^(?![.\s])[^/\\\p{Cc}]{1,40}(?<!\s)$/u;
// Extensions from tools/utils/image.py.
const PHOTO_RE = /^(?![.\s])[^/\\\p{Cc}]{1,120}\.(jpe?g|png|bmp|tiff?)$/iu;
// Directories MagicMirror's js/server.js serves statically to every client.
const SERVED_DIRS = ['config', 'css', 'fonts', 'js', 'modules', 'tests', 'translations', 'vendor'];

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function isValidPhoto(file) {
  return typeof file === 'string' && PHOTO_RE.test(file);
}

function isUnder(full, base) {
  return full.startsWith(base + path.sep);
}

function resolveInside(root, ...parts) {
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  return isUnder(full, base) ? full : null;
}

function isServedPath(p, mmRoot) {
  const full = path.resolve(mmRoot, p);
  return SERVED_DIRS.some(dir => {
    const base = path.resolve(mmRoot, dir);
    return full === base || isUnder(full, base);
  });
}

function checkPin(header, pin) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString();
  const given = Buffer.from(decoded.slice(decoded.indexOf(':') + 1));
  const expected = Buffer.from(pin);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function newestMtime(dir) {
  let newest = fs.statSync(dir).mtimeMs;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : fs.statSync(p).mtimeMs);
  }
  return newest;
}

function isStale(dataset, encodings) {
  if (!fs.existsSync(encodings)) return true;
  return newestMtime(dataset) > fs.statSync(encodings).mtimeMs;
}

function listPeople(dataset) {
  return fs
    .readdirSync(dataset, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && isValidName(entry.name))
    .map(entry => ({
      name: entry.name,
      photos: fs.readdirSync(path.join(dataset, entry.name)).filter(isValidPhoto).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function photoFileName(dir, name, now = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  let file = `${name}_${stamp}.jpg`;
  for (let i = 2; fs.existsSync(path.join(dir, file)); i++) file = `${name}_${stamp}_${i}.jpg`;
  return file;
}

module.exports = {
  isValidName,
  isValidPhoto,
  resolveInside,
  isServedPath,
  checkPin,
  isStale,
  listPeople,
  photoFileName,
};
