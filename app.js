'use strict';

// ---------- Storage (IndexedDB) ----------

const DB = new Promise((ok, fail) => {
  const req = indexedDB.open('potscan', 2);
  req.onupgradeneeded = e => {
    const db = req.result;
    if (e.oldVersion < 2) {
      // v1 was the plant-pot prototype (test data only). Start fresh with the tote model.
      for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name);
      db.createObjectStore('totes', { keyPath: 'id' });
      db.createObjectStore('items', { keyPath: 'id' }).createIndex('toteId', 'toteId');
      db.createObjectStore('photos', { keyPath: 'id' }).createIndex('ownerId', 'ownerId'); // owner = tote or item
      db.createObjectStore('meta', { keyPath: 'key' });
    }
  };
  req.onsuccess = () => {
    req.result.onversionchange = () => { req.result.close(); location.reload(); }; // a newer version opened elsewhere
    ok(req.result);
  };
  req.onerror = () => fail(req.error);
});

async function tx(store, mode, fn) {
  const db = await DB;
  return new Promise((ok, fail) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => ok(req.result);
    t.onerror = () => fail(t.error);
  });
}

async function writeTx(stores, fn) {
  const db = await DB;
  return new Promise((ok, fail) => {
    const t = db.transaction(stores, 'readwrite');
    fn(t);
    t.oncomplete = () => ok();
    t.onerror = () => fail(t.error);
  });
}

const getTote = id => tx('totes', 'readonly', s => s.get(id));
const allTotes = () => tx('totes', 'readonly', s => s.getAll());
const putTote = tote => tx('totes', 'readwrite', s => s.put(tote));
const getItem = id => tx('items', 'readonly', s => s.get(id));
const allItems = () => tx('items', 'readonly', s => s.getAll());
const toteItems = toteId => tx('items', 'readonly', s => s.index('toteId').getAll(toteId));
const putItem = item => tx('items', 'readwrite', s => s.put(item));
const allPhotos = () => tx('photos', 'readonly', s => s.getAll());
const photosOf = ownerId => tx('photos', 'readonly', s => s.index('ownerId').getAll(ownerId));
const putPhoto = photo => tx('photos', 'readwrite', s => s.put(photo));
const deletePhoto = id => tx('photos', 'readwrite', s => s.delete(id));

function deletePhotosOf(t, ownerId) {
  const photos = t.objectStore('photos');
  photos.index('ownerId').openKeyCursor(IDBKeyRange.only(ownerId)).onsuccess = e => {
    const c = e.target.result;
    if (c) { photos.delete(c.primaryKey); c.continue(); }
  };
}

const deleteItem = id => writeTx(['items', 'photos'], t => {
  t.objectStore('items').delete(id);
  deletePhotosOf(t, id);
});

// Deletes the tote, its items, and every photo of both, in one transaction.
const deleteTote = id => writeTx(['totes', 'items', 'photos'], t => {
  t.objectStore('totes').delete(id);
  deletePhotosOf(t, id);
  const items = t.objectStore('items');
  items.index('toteId').openKeyCursor(IDBKeyRange.only(id)).onsuccess = e => {
    const c = e.target.result;
    if (c) { items.delete(c.primaryKey); deletePhotosOf(t, c.primaryKey); c.continue(); }
  };
});

const getMeta = async key => (await tx('meta', 'readonly', s => s.get(key)))?.value;
const setMeta = (key, value) => tx('meta', 'readwrite', s => s.put({ key, value }));

// Moves a tote up in "date updated" order after its items or photos change.
async function touchTote(id) {
  const tote = await getTote(id);
  if (tote) await putTote({ ...tote, updatedAt: Date.now() });
}

navigator.storage?.persist?.();

// ---------- Offline + updates ----------

// A new version downloads in the background, then waits. The user taps the bar to switch,
// so nothing reloads in the middle of editing.
let updating = false;
function offerUpdate(worker) {
  if (document.getElementById('update')) return;
  const bar = document.createElement('button');
  bar.id = 'update';
  bar.textContent = 'Update ready, tap to refresh';
  bar.onclick = () => { updating = true; bar.textContent = 'Updating…'; worker.postMessage('skipWaiting'); };
  document.body.append(bar);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (reg.waiting && navigator.serviceWorker.controller) offerUpdate(reg.waiting);
    reg.onupdatefound = () => {
      const w = reg.installing;
      w.onstatechange = () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(w); // not on first install
      };
    };
    // The app can stay open for days; check for a new version whenever it comes back to the screen.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {}); // offline: try later
    });
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (updating) location.reload(); });
}

// ---------- Helpers ----------

const app = document.getElementById('app');

// Printed into every QR label. Must never change once labels exist (CHARTER §6.1).
const LABEL_BASE = 'https://ijpg26.github.io/potscan/';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// "12" -> "0012". Returns null for anything that isn't a number.
function padId(s) {
  s = String(s).trim();
  return /^\d{1,9}$/.test(s) ? s.padStart(4, '0') : null;
}

// QR text -> tote ID. Accepts a label URL (any host, so old labels survive a move) or a bare number.
function toteIdFromCode(text) {
  const m = String(text).trim().match(/#\/tote\/(\d+)$/);
  return padId(m ? m[1] : text);
}

// ponytail: based on saved totes only, so a pre-printed but unrecorded label number can be handed out again.
// Track the highest printed number in "meta" if that becomes a problem.
async function nextId() {
  const max = Math.max(0, ...(await allTotes()).map(t => parseInt(t.id, 10)));
  return padId(String(max + 1));
}

const qrSvg = id => {
  const qr = qrcode(0, 'Q');
  qr.addData(LABEL_BASE + '#/tote/' + id);
  qr.make();
  return qr.createSvgTag({ cellSize: 1, margin: 4, scalable: true });
};

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Lowercase, accents removed: "Café" -> "cafe".
const norm = s => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// localStorage can be blocked; it's only for conveniences, so failures are ignored.
const pref = (key, value) => {
  try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch {}
};

// Text as " word word word" so a search word can be matched at the start of any word.
const words = s => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const hay = parts => ' ' + words(parts.join(' ')).join(' ');

// Every search word must start a word somewhere ("cord" finds "Cordless"; "1" doesn't match "0001").
// An item must also match at least one word itself, so "garage drill" finds drills in garage totes,
// but "garage" alone doesn't list every item there.
function search(query, totes, items) {
  const ws = words(query);
  const has = (text, w) => text.includes(' ' + w);
  const toteText = new Map(totes.map(t =>
    [t.id, hay([t.id, t.name, t.location, t.description, t.keywords])]));
  const byId = new Map(totes.map(t => [t.id, t]));
  return {
    totes: totes.filter(t => ws.every(w => has(toteText.get(t.id), w))),
    items: items.filter(it => {
      const own = hay([it.name, it.description]);
      const both = own + (toteText.get(it.toteId) ?? '');
      return ws.some(w => has(own, w)) && ws.every(w => has(both, w));
    }).map(it => ({ ...it, tote: byId.get(it.toteId) })),
  };
}

// ---------- Photos ----------

// Resize so the long edge is at most `max` px, as JPEG (CHARTER §6.5).
async function toJpeg(bitmap, max, quality) {
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const c = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
  return c.convertToBlob({ type: 'image/jpeg', quality });
}

async function addPhoto(ownerId, file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const [blob, thumb] = await Promise.all([toJpeg(bitmap, 1280, 0.7), toJpeg(bitmap, 240, 0.7)]);
  bitmap.close();
  await putPhoto({
    id: 'p_' + crypto.randomUUID(),
    ownerId,
    takenAt: file.lastModified || Date.now(), // camera shots: now; gallery picks: roughly when taken
    blob,
    thumb,
  });
}

// Saves files one by one, showing progress. Returns how many couldn't be read.
async function savePhotos(ownerId, files) {
  const msg = app.querySelector('#photomsg');
  let failed = 0;
  for (const [i, file] of files.entries()) {
    if (msg) msg.textContent = `Saving photo${files.length > 1 ? ` ${i + 1} of ${files.length}` : ''}…`;
    try { await addPhoto(ownerId, file); } catch { failed++; }
  }
  return failed;
}

const failedText = n => `Couldn't read ${plural(n, 'photo')}. Try another.`;

// ownerId -> newest photo
function newestPhotos(photos) {
  const newest = {};
  for (const ph of photos) if (!newest[ph.ownerId] || ph.takenAt > newest[ph.ownerId].takenAt) newest[ph.ownerId] = ph;
  return newest;
}

// Object URLs for the current screen, one per blob; released on every screen change.
let urls = new Map();
const blobUrl = blob => {
  if (!urls.has(blob)) urls.set(blob, URL.createObjectURL(blob));
  return urls.get(blob);
};

const thumbHtml = photo => photo
  ? `<img class="thumb" src="${blobUrl(photo.thumb)}" alt="">`
  : '<span class="thumb"></span>';

const fmtDate = ms => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const photoSectionHtml = `
  <div class="row">
    <label class="btn primary">📷 Take photo
      <input type="file" accept="image/*" capture="environment" hidden></label>
    <label class="btn">🖼 From gallery
      <input type="file" accept="image/*" multiple hidden></label>
  </div>
  <p class="msg" id="photomsg"></p>
  <div id="photos"></div>
  <dialog id="viewer">
    <img alt="">
    <p class="muted"></p>
    <button type="button" class="danger" id="delphoto">Delete photo</button>
    <button type="button" id="closeview">Close</button>
  </dialog>`;

function onPhotosPicked(handler) {
  for (const input of app.querySelectorAll('input[type=file]')) input.onchange = () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) handler(files);
  };
}

function showPhotoResult(failed) {
  const msg = app.querySelector('#photomsg');
  if (!msg) return;
  msg.classList.toggle('bad', failed > 0);
  msg.textContent = failed ? failedText(failed) : 'Photo saved ✓';
}

// Photos of a tote or item, newest first. Only redraws the photo area, so unsaved form edits stay.
async function renderPhotos(ownerId, emptyText = 'No photos yet.') {
  const photos = (await photosOf(ownerId)).sort((a, b) => b.takenAt - a.takenAt);
  const box = app.querySelector('#photos');
  if (!box) return; // left the screen meanwhile
  box.innerHTML = photos.length
    ? photos.map(ph => `
        <figure class="photo" data-id="${ph.id}">
          <img src="${blobUrl(ph.blob)}" alt="" loading="lazy">
          <figcaption>${fmtDate(ph.takenAt)}</figcaption>
        </figure>`).join('')
    : `<p class="muted">${emptyText}</p>`;

  const viewer = app.querySelector('#viewer');
  for (const fig of box.querySelectorAll('.photo')) fig.onclick = () => {
    const ph = photos.find(p => p.id === fig.dataset.id);
    viewer.querySelector('img').src = fig.querySelector('img').src;
    viewer.querySelector('p').textContent = fmtDate(ph.takenAt);
    viewer.querySelector('#delphoto').onclick = async () => {
      if (!confirm('Delete this photo?')) return;
      await deletePhoto(ph.id);
      viewer.close();
      renderPhotos(ownerId, emptyText);
    };
    viewer.showModal();
  };
  viewer.querySelector('#closeview').onclick = () => viewer.close();
}

// ---------- Backup (CHARTER §6.3) ----------

const BACKUP_VERSION = 2; // matches the DB version; bump if the backup format changes

const toDataUrl = blob => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(r.result);
  r.onerror = () => fail(r.error);
  r.readAsDataURL(blob);
});

// One JSON file with everything. Built from parts so the photos never sit in one giant string.
async function makeBackup() {
  const [totes, items, photos] = await Promise.all([allTotes(), allItems(), allPhotos()]);
  const head = JSON.stringify({ app: 'potscan', version: BACKUP_VERSION, exportedAt: Date.now(), totes, items });
  const parts = [head.slice(0, -1), ',"photos":['];
  for (const [i, ph] of photos.entries()) {
    parts.push((i ? ',' : '') + JSON.stringify({
      id: ph.id, ownerId: ph.ownerId, takenAt: ph.takenAt,
      blob: await toDataUrl(ph.blob), thumb: await toDataUrl(ph.thumb),
    }));
  }
  parts.push(']}');
  return new Blob(parts, { type: 'application/json' });
}

// Reads and checks a backup file. Anything malformed is skipped, never trusted.
async function readBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { data = null; }
  if (data?.app !== 'potscan' || !Array.isArray(data.totes) || !Array.isArray(data.items) || !Array.isArray(data.photos)) {
    throw new Error('That file isn\'t a PotScan backup.');
  }
  if (!(data.version <= BACKUP_VERSION)) throw new Error('This backup is from a newer version of PotScan. Update the app first.');

  const str = v => typeof v === 'string' ? v.slice(0, 5000) : '';
  const time = v => Number.isFinite(v) ? v : 0;
  const isImage = v => typeof v === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(v);
  let skipped = 0;
  const keep = (list, ok, clean) => list.filter(x => ok(x) || (skipped++, false)).map(clean);

  return {
    exportedAt: time(data.exportedAt),
    totes: keep(data.totes, t => /^\d{4,9}$/.test(t?.id), t => ({
      id: t.id, name: str(t.name) || 'Unnamed tote', location: str(t.location), description: str(t.description),
      keywords: str(t.keywords), createdAt: time(t.createdAt), updatedAt: time(t.updatedAt),
    })),
    items: keep(data.items, it => /^i_[\w-]{1,64}$/.test(it?.id) && /^\d{4,9}$/.test(it?.toteId), it => ({
      id: it.id, toteId: it.toteId, name: str(it.name) || 'Unnamed item',
      quantity: Number.isInteger(it.quantity) && it.quantity >= 0 ? it.quantity : 1,
      description: str(it.description), createdAt: time(it.createdAt), updatedAt: time(it.updatedAt),
    })),
    photos: keep(data.photos, ph => /^p_[\w-]{1,64}$/.test(ph?.id) && /^(\d{4,9}|i_[\w-]{1,64})$/.test(ph?.ownerId)
      && isImage(ph.blob) && isImage(ph.thumb), ph => ({ id: ph.id, ownerId: ph.ownerId, takenAt: time(ph.takenAt), blob: ph.blob, thumb: ph.thumb })),
    skipped,
  };
}

// What importing would change: add missing records, replace ones where the backup is newer. Never deletes.
async function planImport(backup) {
  const [totes, items, photos] = await Promise.all([allTotes(), allItems(), allPhotos()]);
  const split = (incoming, local) => {
    const have = new Map(local.map(x => [x.id, x]));
    return {
      add: incoming.filter(x => !have.has(x.id)),
      update: incoming.filter(x => have.has(x.id) && x.updatedAt > have.get(x.id).updatedAt),
    };
  };
  const photoIds = new Set(photos.map(p => p.id));
  return { totes: split(backup.totes, totes), items: split(backup.items, items), photos: backup.photos.filter(p => !photoIds.has(p.id)) };
}

async function applyImport(plan) {
  const dataUrlToBlob = async url => (await fetch(url)).blob();
  // Convert first: a transaction closes if it waits on anything else.
  const photos = await Promise.all(plan.photos.map(async p =>
    ({ ...p, blob: await dataUrlToBlob(p.blob), thumb: await dataUrlToBlob(p.thumb) })));
  await writeTx(['totes', 'items', 'photos'], t => {
    for (const x of [...plan.totes.add, ...plan.totes.update]) t.objectStore('totes').put(x);
    for (const x of [...plan.items.add, ...plan.items.update]) t.objectStore('items').put(x);
    for (const x of photos) t.objectStore('photos').put(x);
  });
}

const daysAgo = ms => {
  const d = Math.floor((Date.now() - ms) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
};
const backupIsStale = last => !last || Date.now() - last > 14 * 864e5;

// ---------- Router ----------

let dirty = false;           // unsaved changes on a form
let here = location.hash;
let stopScan = null;         // turns the camera off when leaving the scan screen

function route() {
  urls.forEach(URL.revokeObjectURL);
  urls = new Map();
  const h = location.hash.split('?')[0]; // "#/?q=drill" is the home screen with a search
  if (h === '#/scan') return void showScan(); // keeps running while scanning, so don't wait on it
  if (h === '#/backup') return showBackup();
  if (h === '#/new') return nextId().then(id => location.replace('#/tote/' + id));
  const l = h.match(/^#\/labels(?:\/(\d+)(?:-(\d+))?)?$/);
  if (l) return showLabels(l[1], l[2] || l[1]);
  const i = h.match(/^#\/tote\/(\d{4,})\/item\/(new|i_[\w-]+)$/);
  if (i) return showItem(i[1], i[2] === 'new' ? null : i[2]);
  const m = h.match(/^#\/tote\/(\d+)$/);
  if (!m) return showHome();
  const id = padId(m[1]);
  if (id !== m[1]) return location.replace('#/tote/' + id);
  return showTote(id);
}

addEventListener('hashchange', () => {
  if (dirty && !confirm('You have unsaved changes. Leave without saving?')) {
    history.pushState(null, '', here); // stay put; pushState doesn't fire hashchange
    return;
  }
  dirty = false;
  here = location.hash;
  stopScan?.();
  if (document.startViewTransition) document.startViewTransition(route); // animated screen change
  else route();
});
addEventListener('beforeunload', e => { if (dirty) e.preventDefault(); });

// ---------- Screens ----------

async function showHome() {
  const [totes, items, photos, lastBackup] = await Promise.all([allTotes(), allItems(), allPhotos(), getMeta('lastBackupAt')]);
  const newest = newestPhotos(photos);
  const byTote = {};
  for (const it of items) (byTote[it.toteId] ||= []).push(it);
  // Thumbnail: newest photo of the tote itself, else the newest of its items' photos.
  const thumbFor = t => newest[t.id] ||
    (byTote[t.id] || []).map(it => newest[it.id]).filter(Boolean).sort((a, b) => b.takenAt - a.takenAt)[0];

  const toteRow = t => `
    <li><a href="#/tote/${esc(t.id)}">
      ${thumbHtml(thumbFor(t))}
      <span><strong>${esc(t.name)}</strong><br>
      <small>#${esc(t.id)}${t.location ? ' · ' + esc(t.location) : ''} · ${plural((byTote[t.id] || []).length, 'item')}</small></span>
    </a></li>`;
  const itemRow = it => `
    <li><a href="#/tote/${esc(it.toteId)}">
      ${thumbHtml(newest[it.id])}
      <span><strong>${esc(it.name)}</strong>${it.quantity !== 1 ? ` <span class="muted">×${esc(it.quantity)}</span>` : ''}<br>
      <small>in ${esc(it.tote?.name ?? '?')} #${esc(it.toteId)}${it.tote?.location ? ' · 📍 ' + esc(it.tote.location) : ''}</small></span>
    </a></li>`;

  const q = new URLSearchParams(location.hash.split('?')[1]).get('q') || '';
  const sort = pref('sort') === 'name' ? 'name' : 'recent';

  app.innerHTML = `
    <h1>PotScan</h1>
    <input type="search" id="q" value="${esc(q)}" placeholder="🔍 Search items or totes"
           enterkeyhint="search" autocomplete="off" aria-label="Search items or totes">
    <div id="results"></div>
    <div id="rest">
    ${'BarcodeDetector' in window ? '<a class="btn primary" href="#/scan">Scan a label</a>' : ''}
    <a class="btn primary" href="#/new">+ Add a new tote</a>
    <form id="open">
      <label for="num">Open a tote by number</label>
      <div class="row">
        <input id="num" inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 12" autocomplete="off">
        <button>Open</button>
      </div>
      <small class="muted">The number printed under the QR code. A new number starts a new tote.</small>
    </form>
    <a class="btn" href="#/labels">Print labels</a>
    <a class="btn ${totes.length && backupIsStale(lastBackup) ? 'warn' : ''}" href="#/backup">
      💾 Backup · last: ${lastBackup ? daysAgo(lastBackup) : 'never'}</a>
    <h2>My Totes <span class="muted">(${totes.length})</span></h2>
    ${totes.length ? `
      <div class="row sort" role="group" aria-label="Sort totes">
        <button type="button" data-sort="recent">Recent</button>
        <button type="button" data-sort="name">A–Z</button>
      </div>
      <ul class="list" id="totes"></ul>`
      : '<p class="muted">No totes yet. Tap “Add a new tote” to start.</p>'}
    <p class="muted about" id="about"></p>
    </div>
  `;
  showAbout();

  const listEl = app.querySelector('#totes');
  const renderList = sort => {
    if (!listEl) return;
    for (const b of app.querySelectorAll('[data-sort]')) b.setAttribute('aria-pressed', b.dataset.sort === sort);
    const sorted = [...totes].sort(sort === 'name'
      ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })
      : (a, b) => b.updatedAt - a.updatedAt);
    listEl.innerHTML = sorted.map(toteRow).join('');
  };
  for (const b of app.querySelectorAll('[data-sort]')) b.onclick = () => { pref('sort', b.dataset.sort); renderList(b.dataset.sort); };
  renderList(sort);

  const input = app.querySelector('#q');
  const resultsEl = app.querySelector('#results');
  const restEl = app.querySelector('#rest');
  const renderResults = () => {
    const query = input.value.trim();
    // Keep the search in the address, so Back from a result returns to it (replaceState fires no hashchange).
    history.replaceState(null, '', query ? '#/?q=' + encodeURIComponent(query) : '#/');
    here = location.hash;
    restEl.hidden = !!query;
    if (!query) return void (resultsEl.innerHTML = '');
    const r = search(query, totes, items);
    resultsEl.innerHTML = !r.items.length && !r.totes.length
      ? `<p class="muted">Nothing found for “${esc(query)}”.</p>`
      : (r.items.length ? `<h2>Items <span class="muted">(${r.items.length})</span></h2>
           <ul class="list">${r.items.map(itemRow).join('')}</ul>` : '') +
        (r.totes.length ? `<h2>Totes <span class="muted">(${r.totes.length})</span></h2>
           <ul class="list">${r.totes.map(toteRow).join('')}</ul>` : '');
  };
  input.oninput = renderResults;
  input.onkeydown = e => { if (e.key === 'Enter') input.blur(); }; // hides the keyboard to show results
  if (q) renderResults();

  app.querySelector('#open').onsubmit = e => {
    e.preventDefault();
    const id = padId(app.querySelector('#num').value);
    if (id) location.hash = '#/tote/' + id;
    else alert('Please type the number printed on the label.');
  };
}

async function showBackup() {
  const [totes, items, photos, lastBackup] = await Promise.all([allTotes(), allItems(), allPhotos(), getMeta('lastBackupAt')]);
  const stamp = new Date().toISOString().slice(0, 10);
  const name = `potscan-backup-${stamp}.json`;
  // Android may refuse to share .json files; .txt with the same contents is the fallback.
  const shareFile = ['application/json', 'text/plain'].map((type, i) =>
    new File([''], i ? name.replace(/\.json$/, '.txt') : name, { type })).find(f => navigator.canShare?.({ files: [f] }));

  app.innerHTML = `
    <a class="btn" href="#/">← Back to My Totes</a>
    <h1>Backup</h1>
    <p>Your totes live <strong>only on this phone</strong>. Save a backup every week or two, somewhere safe like Google Drive.</p>
    <p class="muted">⚠️ Clearing Chrome's “Cookies and site data” or resetting the phone deletes everything that isn't backed up.</p>
    <p class="${totes.length && backupIsStale(lastBackup) ? 'warn-text' : ''}">
      Last backup: <strong>${lastBackup ? `${daysAgo(lastBackup)} (${fmtDate(lastBackup)})` : 'never'}</strong><br>
      <span class="muted">On this phone: ${plural(totes.length, 'tote')} · ${plural(items.length, 'item')} · ${plural(photos.length, 'photo')}</span>
    </p>
    ${shareFile ? '<button class="primary" id="share">Save backup to Google Drive…</button>' : ''}
    <button class="${shareFile ? '' : 'primary'}" id="download">Download backup file</button>
    <p class="msg" id="msg"></p>

    <h2>Restore</h2>
    <p class="muted">Adds what's in a backup file to this phone. Anything already here stays; nothing is deleted.</p>
    <label class="btn">Choose a backup file…
      <input type="file" accept=".json,.txt,application/json,text/plain" hidden id="restore"></label>
    <p class="msg" id="restoremsg"></p>
  `;

  // Prepared as soon as the screen opens: Android only allows sharing within a few seconds of the tap.
  const ready = makeBackup();
  const msg = app.querySelector('#msg');
  const say = (el, text, bad = false) => { el.textContent = text; el.classList.toggle('bad', bad); };
  const done = async () => { await setMeta('lastBackupAt', Date.now()); await showBackup(); say(app.querySelector('#msg'), 'Backup saved ✓'); };

  const shareBtn = app.querySelector('#share');
  if (shareBtn) shareBtn.onclick = async () => {
    say(msg, 'Preparing backup…');
    const file = new File([await ready], shareFile.name, { type: shareFile.type });
    try {
      await navigator.share({ files: [file], title: 'PotScan backup' });
      await done();
    } catch (e) {
      say(msg, e.name === 'AbortError' ? 'Not saved. Try again when ready.' : 'Sharing didn\'t work. Use Download instead.', true);
    }
  };

  app.querySelector('#download').onclick = async () => {
    say(msg, 'Preparing backup…');
    const a = Object.assign(document.createElement('a'), { href: blobUrl(await ready), download: name });
    a.click();
    await done();
  };

  const restoreMsg = app.querySelector('#restoremsg');
  app.querySelector('#restore').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    say(restoreMsg, 'Reading backup…');
    try {
      const backup = await readBackup(file);
      const plan = await planImport(backup);
      // "add 2 totes and 5 items, update 1 tote"
      const and = list => list.length > 1 ? list.slice(0, -1).join(', ') + ' and ' + list.at(-1) : list[0];
      const counted = pairs => pairs.filter(([n]) => n).map(([n, word]) => plural(n, word));
      const adds = counted([[plan.totes.add.length, 'tote'], [plan.items.add.length, 'item'], [plan.photos.length, 'photo']]);
      const updates = counted([[plan.totes.update.length, 'tote'], [plan.items.update.length, 'item']]);
      const changes = [adds.length && 'add ' + and(adds), updates.length && 'update ' + and(updates)].filter(Boolean);
      if (!changes.length) return say(restoreMsg, 'Everything in this backup is already on this phone ✓');
      const from = backup.exportedAt ? ` from ${fmtDate(backup.exportedAt)}` : '';
      const skipped = backup.skipped ? `\n\n${backup.skipped} damaged ${backup.skipped === 1 ? 'entry' : 'entries'} will be skipped.` : '';
      if (!confirm(`Restore this backup${from}?\n\nThis will ${changes.join(', ')}.\nNothing on this phone will be deleted.${skipped}`)) {
        return say(restoreMsg, 'Restore cancelled.');
      }
      say(restoreMsg, 'Restoring…');
      await applyImport(plan);
      await showBackup();
      say(app.querySelector('#restoremsg'), `Restored ✓ (${changes.join(', ')})`);
    } catch (err) {
      say(restoreMsg, err.message || 'Couldn\'t read that file.', true);
    }
  };
}

// "Version 2 · Chrome · installed app". Each browser keeps its own data, so this tells at a glance
// whether PotScan is running where the records are (CHARTER §6.2).
async function showAbout() {
  const ua = navigator.userAgent;
  const browser = /OPR\/|Opera/.test(ua) ? 'Opera' : /MiuiBrowser|XiaoMi/.test(ua) ? 'Mi Browser'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /EdgA?\//.test(ua) ? 'Edge'
    : /Chrome\//.test(ua) ? 'Chrome' : 'another browser';
  const mode = matchMedia('(display-mode: standalone)').matches ? 'installed app' : 'browser tab';
  const keys = await caches?.keys().catch(() => []) ?? [];
  const version = keys.find(k => k.startsWith('potscan-v'))?.slice('potscan-v'.length) ?? '–';
  const el = document.getElementById('about');
  if (el) el.textContent = `Version ${version} · ${browser} · ${mode}`;
}

async function showScan() {
  app.innerHTML = `
    <a class="btn" href="#/">← Back to My Totes</a>
    <h1>Scan a label</h1>
    <div class="cam" id="camwrap">
      <video id="cam" playsinline muted></video>
      <div class="badge" id="badge"></div>
    </div>
    <p class="msg" id="msg">Point the camera at the label.</p>
  `;
  const video = app.querySelector('#cam');
  const msg = app.querySelector('#msg');
  const fail = text => { msg.textContent = text; msg.classList.add('bad'); };

  if (!('BarcodeDetector' in window) ||
      !(await BarcodeDetector.getSupportedFormats()).includes('qr_code')) {
    return fail('This phone can\'t scan here. Use Google Lens, or type the tote number.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    return fail('Camera not available. Allow camera access, or type the tote number.');
  }
  let running = true;
  stopScan = () => { running = false; stream.getTracks().forEach(t => t.stop()); stopScan = null; };
  if (location.hash !== '#/scan') return stopScan(); // left while the camera was starting

  video.srcObject = stream;
  await video.play();
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  while (running) {
    for (const code of await detector.detect(video).catch(() => [])) {
      const id = toteIdFromCode(code.rawValue);
      if (id) {
        // Freeze the frame, show the match and buzz, then move on. hashchange stops the camera.
        video.pause();
        navigator.vibrate?.(60);
        msg.classList.remove('bad');
        msg.textContent = 'Found it!';
        app.querySelector('#badge').textContent = '✓ Tote ' + id;
        app.querySelector('#camwrap').classList.add('found');
        await new Promise(r => setTimeout(r, 550));
        if (location.hash === '#/scan') location.hash = '#/tote/' + id;
        return;
      }
      fail('That\'s not one of your tote labels.');
    }
    await new Promise(r => setTimeout(r, 200));
  }
}

async function showLabels(from, to) {
  from = parseInt(from || await nextId(), 10);
  to = parseInt(to || from, 10);
  if (to < from) [from, to] = [to, from];

  app.innerHTML = `
    <div class="no-print">
      <a class="btn" href="#/">← Back to My Totes</a>
      <h1>Print labels</h1>
      <div class="row">
        <div><label for="from">From</label><input id="from" inputmode="numeric" value="${from}"></div>
        <div><label for="to">To</label><input id="to" inputmode="numeric" value="${to}"></div>
      </div>
      <button class="primary" id="print"></button>
      <p class="muted">Use waterproof sticker paper, or laminate the labels. Each code prints about 4 cm wide.</p>
    </div>
    <div class="sheet" id="sheet"></div>
  `;
  const fromEl = app.querySelector('#from'), toEl = app.querySelector('#to');
  const sheet = app.querySelector('#sheet'), printBtn = app.querySelector('#print');

  // Redraws the sheet as the numbers are typed. replaceState keeps Back pointing at the previous screen.
  const render = () => {
    const f = parseInt(fromEl.value, 10);
    if (!(f >= 1)) return;
    const t = Math.min(Math.max(parseInt(toEl.value, 10) || f, f), f + 99); // at least one, at most 100
    const ids = Array.from({ length: t - f + 1 }, (_, i) => padId(String(f + i)));
    sheet.innerHTML = ids.map(id => `<div class="label">${qrSvg(id)}<div class="num">${id}</div></div>`).join('');
    printBtn.textContent = `Print ${plural(ids.length, 'label')}`;
    history.replaceState(null, '', `#/labels/${ids[0]}-${ids.at(-1)}`);
    here = location.hash;
  };
  fromEl.oninput = toEl.oninput = render;
  printBtn.onclick = () => print();
  render();
}

async function showTote(id) {
  const [tote, totes, items, photos] = await Promise.all([getTote(id), allTotes(), toteItems(id), allPhotos()]);
  const t = tote || { id };
  const locations = [...new Set(totes.map(x => x.location).filter(Boolean))];
  const newest = newestPhotos(photos);
  items.sort((a, b) => a.name.localeCompare(b.name));

  app.innerHTML = `
    <a class="btn" href="#/">← Back to My Totes</a>
    <h1>${tote ? esc(tote.name) : 'New tote'} <span class="muted">#${esc(id)}</span></h1>
    ${tote?.location ? `<p class="muted">📍 ${esc(tote.location)}</p>` : ''}

    ${tote ? `
      <h2>Items <span class="muted">(${items.length})</span></h2>
      <a class="btn primary" href="#/tote/${esc(id)}/item/new">+ Add item</a>
      ${items.length ? `<ul class="list">${items.map(it => `
        <li><a href="#/tote/${esc(id)}/item/${esc(it.id)}">
          ${thumbHtml(newest[it.id])}
          <span><strong>${esc(it.name)}</strong>${it.quantity !== 1 ? ` <span class="muted">×${esc(it.quantity)}</span>` : ''}
          ${it.description ? `<br><small>${esc(it.description.slice(0, 80))}</small>` : ''}</span>
        </a></li>`).join('')}</ul>`
        : '<p class="muted">Nothing in this tote yet.</p>'}
      <h2>Tote details</h2>` : ''}

    <form id="tote">
      <label for="name">Tote name</label>
      <input id="name" name="name" required value="${esc(t.name)}" placeholder="e.g. Christmas lights">

      <label for="location">Where it's kept</label>
      <input id="location" name="location" list="locations" value="${esc(t.location)}" placeholder="e.g. Garage, top shelf">
      <datalist id="locations">${locations.map(l => `<option value="${esc(l)}">`).join('')}</datalist>

      <label for="description">Notes</label>
      <textarea id="description" name="description">${esc(t.description)}</textarea>

      <label for="keywords">Keywords</label>
      <input id="keywords" name="keywords" value="${esc(t.keywords)}" placeholder="e.g. holiday winter">

      <button class="primary">Save</button>
      <p class="msg" id="msg"></p>
    </form>

    ${tote ? `
      <h2>Photos of the tote</h2>
      ${photoSectionHtml}
      <h2>Label and tote</h2>
      <a class="btn" href="#/labels/${esc(id)}">Print label</a>
      <button class="danger" id="del">Delete this tote</button>`
    : '<p class="muted">Save the tote first, then you can add items and photos.</p>'}
  `;

  const form = app.querySelector('#tote');
  form.oninput = () => { dirty = true; app.querySelector('#msg').textContent = ''; };
  form.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const now = Date.now();
    await putTote({
      id,
      name: f.name.trim(),
      location: f.location.trim(),
      description: f.description.trim(),
      keywords: f.keywords.trim(),
      createdAt: tote?.createdAt ?? now,
      updatedAt: now,
    });
    dirty = false;
    await showTote(id); // re-render so title, items and location suggestions are current
    app.querySelector('#msg').textContent = 'Saved ✓';
  };

  if (!tote) return;
  const noTotePhotos = 'No photos of the tote itself yet. Item photos are inside each item.';
  renderPhotos(id, noTotePhotos);
  onPhotosPicked(async files => {
    const failed = await savePhotos(id, files);
    await touchTote(id);
    showPhotoResult(failed);
    renderPhotos(id, noTotePhotos);
  });

  app.querySelector('#del').onclick = async () => {
    if (!confirm(`Delete ${tote.name} (#${id}), its ${plural(items.length, 'item')} and all photos? This can't be undone.`)) return;
    await deleteTote(id);
    dirty = false;
    location.hash = '#/';
  };
}

// itemId null = new item. New items can take photos before saving; they're saved with the item.
async function showItem(toteId, itemId) {
  const [tote, item] = await Promise.all([getTote(toteId), itemId ? getItem(itemId) : null]);
  if (!tote || (itemId && !item)) return location.replace('#/tote/' + toteId);
  const it = item || { quantity: 1 };
  let staged = [];

  app.innerHTML = `
    <a class="btn" href="#/tote/${esc(toteId)}">← Back to ${esc(tote.name)}</a>
    <h1>${item ? esc(item.name) : 'New item'}</h1>
    <p class="muted">In ${esc(tote.name)} · #${esc(toteId)}</p>
    <form id="item">
      <label for="name">Item name</label>
      <input id="name" name="name" required value="${esc(it.name)}" placeholder="e.g. Extension cord">

      <label for="quantity">How many</label>
      <input id="quantity" name="quantity" type="number" min="0" inputmode="numeric" value="${esc(it.quantity)}">

      <label for="description">Description</label>
      <textarea id="description" name="description">${esc(it.description)}</textarea>

      <h2>Photos</h2>
      ${photoSectionHtml}

      <button class="primary" value="done">Save</button>
      ${item ? '' : '<button value="another">Save & add another</button>'}
      <p class="msg" id="msg"></p>
    </form>
    ${item ? '<button class="danger" id="del">Delete this item</button>' : ''}
  `;

  const form = app.querySelector('#item');
  form.oninput = e => { if (e.target.type !== 'file') dirty = true; };

  if (item) {
    renderPhotos(item.id);
    onPhotosPicked(async files => {
      const failed = await savePhotos(item.id, files);
      await touchTote(toteId);
      showPhotoResult(failed);
      renderPhotos(item.id);
    });
  } else {
    onPhotosPicked(files => {
      staged.push(...files);
      dirty = true;
      app.querySelector('#photos').innerHTML = staged.map(f => `
        <figure class="photo"><img src="${blobUrl(f)}" alt=""><figcaption>Saved when you tap Save</figcaption></figure>`).join('');
    });
  }

  form.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const now = Date.now();
    const id = item?.id ?? 'i_' + crypto.randomUUID();
    const name = f.name.trim();
    await putItem({
      id,
      toteId,
      name,
      quantity: Math.max(0, parseInt(f.quantity, 10) || 0),
      description: f.description.trim(),
      createdAt: item?.createdAt ?? now,
      updatedAt: now,
    });
    const failed = staged.length ? await savePhotos(id, staged) : 0;
    await touchTote(toteId);
    dirty = false;
    if (failed) alert(failedText(failed));
    if (e.submitter?.value === 'another') {
      await showItem(toteId, null); // fresh form, same screen
      app.querySelector('#msg').textContent = `Saved “${name}” ✓ Add the next item.`;
      app.querySelector('#name').focus();
    } else {
      location.hash = '#/tote/' + toteId;
    }
  };

  if (item) app.querySelector('#del').onclick = async () => {
    if (!confirm(`Delete ${item.name} from ${tote.name}? This can't be undone.`)) return;
    await deleteItem(item.id);
    await touchTote(toteId);
    dirty = false;
    location.hash = '#/tote/' + toteId;
  };
}

route();
