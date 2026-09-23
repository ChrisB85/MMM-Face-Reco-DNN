'use strict';

const view = document.getElementById('view');
const bar = document.getElementById('bar');
const enc = encodeURIComponent;
let data = { people: [], stale: false, training: { status: 'idle', message: '', skipped: [] } };
let pollTimer = null;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function api(method, url, body, type) {
  const res = await fetch(url, { method, body, headers: type ? { 'Content-Type': type } : {} });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function fail(err) {
  alert(err.message);
}

async function refresh(renderView = true) {
  const wasRunning = data.training.status === 'running';
  data = await api('GET', 'api/people');
  renderBar();
  // While training runs only the bar updates, so the camera preview is not rebuilt.
  if (renderView || (wasRunning && data.training.status !== 'running')) render();
  clearTimeout(pollTimer);
  if (data.training.status === 'running') pollTimer = setTimeout(() => refresh(false).catch(fail), 2000);
}

function trainButton() {
  return el('button', {
    textContent: 'Przeszkol',
    onclick: () => api('POST', 'api/train').then(() => refresh(false)).catch(fail),
  });
}

function renderBar() {
  const t = data.training;
  bar.replaceChildren();
  if (t.status === 'running') {
    bar.append('Trwa trenowanie… ', el('span', { className: 'note', textContent: t.message }));
  } else if (t.status === 'error') {
    bar.append(el('span', { textContent: `Trenowanie nie powiodło się: ${t.message}` }), trainButton());
  } else if (data.stale) {
    bar.append('Model nieaktualny', trainButton());
  } else if (t.status === 'done') {
    bar.append(t.skipped.length ? `Model aktualny. Pominięte zdjęcia: ${t.skipped.length} (zaznaczone na czerwono).` : 'Model aktualny.');
  }
  bar.hidden = bar.childNodes.length === 0;
}

function render() {
  const name = location.hash.startsWith('#p/') ? decodeURIComponent(location.hash.slice(3)) : null;
  const person = data.people.find(p => p.name === name);
  if (person) renderPerson(person);
  else renderList();
}

const photoUrl = (name, file) => `api/people/${enc(name)}/photos/${enc(file)}`;

function renderList() {
  const items = data.people.map(p =>
    el(
      'li',
      {},
      el(
        'a',
        { href: `#p/${enc(p.name)}` },
        p.photos.length ? el('img', { src: photoUrl(p.name, p.photos[0]), alt: '', loading: 'lazy' }) : el('span', { className: 'empty' }),
        el('span', { textContent: `${p.name} (${p.photos.length} zdj.)` }),
      ),
    ),
  );
  const add = el('button', {
    textContent: 'Dodaj osobę',
    onclick: () => {
      const name = prompt('Imię (litery, cyfry, - i _):');
      if (!name) return;
      api('POST', `api/people/${enc(name)}`)
        .then(() => {
          location.hash = `#p/${enc(name)}`;
          return refresh();
        })
        .catch(fail);
    },
  });
  view.replaceChildren(el('h1', { textContent: 'Twarze' }), el('ul', { className: 'people' }, ...items), add);
}

async function upload(base, file) {
  // createImageBitmap applies EXIF orientation; scaling keeps HOG fast and the SD card small.
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
  const canvas = el('canvas', { width: Math.round(bitmap.width * scale), height: Math.round(bitmap.height * scale) });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return api('POST', `${base}/photos`, blob, 'image/jpeg');
}

function renderPerson(p) {
  const base = `api/people/${enc(p.name)}`;
  const skipped = new Map(data.training.skipped.map(s => [s.photo, s.reason]));

  // Poll one frame at a time; the chain stops once the preview leaves the page.
  const preview = el('img', { id: 'preview', alt: 'Podgląd kamery lustra' });
  const nextFrame = () => {
    if (preview.isConnected) preview.src = `api/frame?t=${Date.now()}`;
  };
  preview.onload = preview.onerror = () => setTimeout(nextFrame, 500);

  const capture = el('button', {
    textContent: 'Zrób zdjęcie',
    onclick: () => api('POST', `${base}/capture`).then(() => refresh()).catch(fail),
  });
  const input = el('input', { type: 'file', accept: 'image/*', hidden: true });
  input.setAttribute('capture', 'user');
  input.onchange = () => {
    if (input.files[0]) upload(base, input.files[0]).then(() => refresh()).catch(fail);
  };
  const fromPhone = el('button', { textContent: 'Z telefonu', onclick: () => input.click() });

  const grid = el(
    'div',
    { className: 'grid' },
    ...p.photos.map(file => {
      const reason = skipped.get(`${p.name}/${file}`);
      return el(
        'figure',
        { className: reason ? 'skipped' : '' },
        el('img', { src: photoUrl(p.name, file), alt: file, loading: 'lazy' }),
        ...(reason ? [el('figcaption', { textContent: `pominięte: ${reason}` })] : []),
        el('button', {
          textContent: 'Usuń',
          onclick: () => {
            if (confirm('Usunąć zdjęcie?')) api('DELETE', photoUrl(p.name, file)).then(() => refresh()).catch(fail);
          },
        }),
      );
    }),
  );

  const rename = el('button', {
    textContent: 'Zmień imię',
    onclick: () => {
      const name = prompt('Nowe imię:', p.name);
      if (!name || name === p.name) return;
      api('PATCH', base, JSON.stringify({ name }), 'application/json')
        .then(() => {
          location.hash = `#p/${enc(name)}`;
          return refresh();
        })
        .catch(fail);
    },
  });
  const remove = el('button', {
    textContent: 'Usuń osobę',
    onclick: () => {
      if (!confirm(`Usunąć ${p.name} i wszystkie zdjęcia?`)) return;
      api('DELETE', base)
        .then(() => {
          location.hash = '';
          return refresh();
        })
        .catch(fail);
    },
  });

  view.replaceChildren(
    el('p', {}, el('a', { href: '#', textContent: '← Wszyscy' })),
    el('h1', { textContent: p.name }),
    preview,
    el('div', { className: 'row' }, capture, fromPhone, input),
    grid,
    el('div', { className: 'row' }, rename, remove),
    el('p', {
      className: 'note',
      textContent: 'Imię to też klucz w classes w config.js lustra — po zmianie imienia lub usunięciu osoby popraw config ręcznie.',
    }),
  );
  nextFrame();
}

window.addEventListener('hashchange', render);
refresh().catch(fail);
