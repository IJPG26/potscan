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

// Moves a tote up in "date updated" order after its items or photos change.
async function touchTote(id) {
  const tote = await getTote(id);
  if (tote) await putTote({ ...tote, updatedAt: Date.now() });
}

navigator.storage?.persist?.();
navigator.serviceWorker?.register('sw.js');

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

// Object URLs for the current screen; released on every screen change.
let urls = [];
const blobUrl = blob => { const u = URL.createObjectURL(blob); urls.push(u); return u; };

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
async function renderPhotos(ownerId) {
  const photos = (await photosOf(ownerId)).sort((a, b) => b.takenAt - a.takenAt);
  const box = app.querySelector('#photos');
  if (!box) return; // left the screen meanwhile
  box.innerHTML = photos.length
    ? photos.map(ph => `
        <figure class="photo" data-id="${ph.id}">
          <img src="${blobUrl(ph.blob)}" alt="" loading="lazy">
          <figcaption>${fmtDate(ph.takenAt)}</figcaption>
        </figure>`).join('')
    : '<p class="muted">No photos yet.</p>';

  const viewer = app.querySelector('#viewer');
  for (const fig of box.querySelectorAll('.photo')) fig.onclick = () => {
    const ph = photos.find(p => p.id === fig.dataset.id);
    viewer.querySelector('img').src = fig.querySelector('img').src;
    viewer.querySelector('p').textContent = fmtDate(ph.takenAt);
    viewer.querySelector('#delphoto').onclick = async () => {
      if (!confirm('Delete this photo?')) return;
      await deletePhoto(ph.id);
      viewer.close();
      renderPhotos(ownerId);
    };
    viewer.showModal();
  };
  viewer.querySelector('#closeview').onclick = () => viewer.close();
}

// ---------- Router ----------

let dirty = false;           // unsaved changes on a form
let here = location.hash;
let stopScan = null;         // turns the camera off when leaving the scan screen

function route() {
  urls.forEach(URL.revokeObjectURL);
  urls = [];
  const h = location.hash;
  if (h === '#/scan') return void showScan(); // keeps running while scanning, so don't wait on it
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
  const [totes, items, photos] = await Promise.all([allTotes(), allItems(), allPhotos()]);
  totes.sort((a, b) => b.updatedAt - a.updatedAt);
  const newest = newestPhotos(photos);
  const byTote = {};
  for (const it of items) (byTote[it.toteId] ||= []).push(it);
  // Thumbnail: newest photo of the tote itself, else the newest of its items' photos.
  const thumbFor = t => newest[t.id] ||
    (byTote[t.id] || []).map(it => newest[it.id]).filter(Boolean).sort((a, b) => b.takenAt - a.takenAt)[0];

  app.innerHTML = `
    <h1>PotScan</h1>
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
    <h2>My Totes <span class="muted">(${totes.length})</span></h2>
    ${totes.length ? `<ul class="list">${totes.map(t => `
      <li><a href="#/tote/${esc(t.id)}">
        ${thumbHtml(thumbFor(t))}
        <span><strong>${esc(t.name)}</strong><br>
        <small>#${esc(t.id)}${t.location ? ' · ' + esc(t.location) : ''} · ${plural((byTote[t.id] || []).length, 'item')}</small></span>
      </a></li>`).join('')}</ul>`
      : '<p class="muted">No totes yet. Tap “Add a new tote” to start.</p>'}
  `;
  app.querySelector('#open').onsubmit = e => {
    e.preventDefault();
    const id = padId(app.querySelector('#num').value);
    if (id) location.hash = '#/tote/' + id;
    else alert('Please type the number printed on the label.');
  };
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
  to = Math.min(to, from + 99); // keep a sheet printable

  const ids = Array.from({ length: to - from + 1 }, (_, i) => padId(String(from + i)));
  app.innerHTML = `
    <div class="no-print">
      <a class="btn" href="#/">← Back to My Totes</a>
      <h1>Print labels</h1>
      <form id="range">
        <div class="row">
          <div><label for="from">From</label><input id="from" inputmode="numeric" value="${from}"></div>
          <div><label for="to">To</label><input id="to" inputmode="numeric" value="${to}"></div>
        </div>
        <button>Show labels</button>
      </form>
      <button class="primary" id="print">Print ${plural(ids.length, 'label')}</button>
      <p class="muted">Use waterproof sticker paper, or laminate the labels. Each code prints about 4 cm wide.</p>
    </div>
    <div class="sheet">${ids.map(id => `
      <div class="label">${qrSvg(id)}<div class="num">${id}</div></div>`).join('')}
    </div>
  `;
  app.querySelector('#range').onsubmit = e => {
    e.preventDefault();
    const f = padId(app.querySelector('#from').value), t = padId(app.querySelector('#to').value) || f;
    if (f) location.hash = `#/labels/${f}-${t}`;
  };
  app.querySelector('#print').onclick = () => print();
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
  renderPhotos(id);
  onPhotosPicked(async files => {
    const failed = await savePhotos(id, files);
    await touchTote(id);
    showPhotoResult(failed);
    renderPhotos(id);
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
