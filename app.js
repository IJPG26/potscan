'use strict';

// ---------- Storage (IndexedDB) ----------

const DB = new Promise((ok, fail) => {
  const req = indexedDB.open('potscan', 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore('pots', { keyPath: 'id' });
    db.createObjectStore('photos', { keyPath: 'id' }).createIndex('potId', 'potId');
    db.createObjectStore('meta', { keyPath: 'key' });
  };
  req.onsuccess = () => ok(req.result);
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

const getPot = id => tx('pots', 'readonly', s => s.get(id));
const allPots = () => tx('pots', 'readonly', s => s.getAll());
const putPot = pot => tx('pots', 'readwrite', s => s.put(pot));
const deletePot = id => tx('pots', 'readwrite', s => s.delete(id)); // M3: also delete the pot's photos

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

// QR text -> pot ID. Accepts a PotScan URL (any host, so old labels survive a move) or a bare number.
function potIdFromCode(text) {
  const m = String(text).trim().match(/#\/pot\/(\d+)$/);
  return padId(m ? m[1] : text);
}

// ponytail: based on saved pots only, so a pre-printed but unrecorded label number can be handed out again.
// Track the highest printed number in "meta" if that becomes a problem.
async function nextId() {
  const max = Math.max(0, ...(await allPots()).map(p => parseInt(p.id, 10)));
  return padId(String(max + 1));
}

const qrSvg = id => {
  const qr = qrcode(0, 'Q');
  qr.addData(LABEL_BASE + '#/pot/' + id);
  qr.make();
  return qr.createSvgTag({ cellSize: 1, margin: 4, scalable: true });
};

// ---------- Router ----------

let dirty = false;           // unsaved changes on the pot form
let here = location.hash;
let stopScan = null;         // turns the camera off when leaving the scan screen

function route() {
  if (location.hash === '#/scan') return void showScan(); // keeps running while scanning, so don't wait on it
  if (location.hash === '#/new') return nextId().then(id => location.replace('#/pot/' + id));
  const l = location.hash.match(/^#\/labels(?:\/(\d+)(?:-(\d+))?)?$/);
  if (l) return showLabels(l[1], l[2] || l[1]);
  const m = location.hash.match(/^#\/pot\/(\d+)$/);
  if (!m) return showHome();
  const id = padId(m[1]);
  if (id !== m[1]) return location.replace('#/pot/' + id);
  showPot(id);
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
  const pots = (await allPots()).sort((a, b) => b.updatedAt - a.updatedAt);
  app.innerHTML = `
    <h1>PotScan</h1>
    ${'BarcodeDetector' in window ? '<a class="btn primary" href="#/scan">Scan a label</a>' : ''}
    <a class="btn primary" href="#/new">+ Add a new pot</a>
    <form id="open">
      <label for="num">Open a pot by number</label>
      <div class="row">
        <input id="num" inputmode="numeric" pattern="[0-9]*" placeholder="e.g. 12" autocomplete="off">
        <button>Open</button>
      </div>
      <small class="muted">The number printed under the QR code. A new number starts a new pot.</small>
    </form>
    <a class="btn" href="#/labels">Print labels</a>
    <h2>My Pots <span class="muted">(${pots.length})</span></h2>
    ${pots.length ? `<ul class="list">${pots.map(p => `
      <li><a href="#/pot/${esc(p.id)}">
        <strong>${esc(p.name)}</strong><br>
        <small>#${esc(p.id)}${p.location ? ' · ' + esc(p.location) : ''}</small>
      </a></li>`).join('')}</ul>`
      : '<p class="muted">No pots yet. Tap “Add a new pot” to start.</p>'}
  `;
  app.querySelector('#open').onsubmit = e => {
    e.preventDefault();
    const id = padId(app.querySelector('#num').value);
    if (id) location.hash = '#/pot/' + id;
    else alert('Please type the number printed on the label.');
  };
}

async function showScan() {
  app.innerHTML = `
    <a class="btn" href="#/">← Back to My Pots</a>
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
    return fail('This phone can\'t scan here. Use Google Lens, or type the pot number.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    return fail('Camera not available. Allow camera access, or type the pot number.');
  }
  let running = true;
  stopScan = () => { running = false; stream.getTracks().forEach(t => t.stop()); stopScan = null; };
  if (location.hash !== '#/scan') return stopScan(); // left while the camera was starting

  video.srcObject = stream;
  await video.play();
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  while (running) {
    for (const code of await detector.detect(video).catch(() => [])) {
      const id = potIdFromCode(code.rawValue);
      if (id) {
        // Freeze the frame, show the match and buzz, then move on. hashchange stops the camera.
        video.pause();
        navigator.vibrate?.(60);
        msg.classList.remove('bad');
        msg.textContent = 'Found it!';
        app.querySelector('#badge').textContent = '✓ Pot ' + id;
        app.querySelector('#camwrap').classList.add('found');
        await new Promise(r => setTimeout(r, 550));
        if (location.hash === '#/scan') location.hash = '#/pot/' + id;
        return;
      }
      fail('That\'s not a PotScan label.');
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
      <a class="btn" href="#/">← Back to My Pots</a>
      <h1>Print labels</h1>
      <form id="range">
        <div class="row">
          <div><label for="from">From</label><input id="from" inputmode="numeric" value="${from}"></div>
          <div><label for="to">To</label><input id="to" inputmode="numeric" value="${to}"></div>
        </div>
        <button>Show labels</button>
      </form>
      <button class="primary" id="print">Print ${ids.length} label${ids.length > 1 ? 's' : ''}</button>
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

async function showPot(id) {
  const [pot, pots] = await Promise.all([getPot(id), allPots()]);
  const p = pot || { id, quantity: 1 };
  const locations = [...new Set(pots.map(x => x.location).filter(Boolean))];

  app.innerHTML = `
    <a class="btn" href="#/">← Back to My Pots</a>
    <h1>${pot ? esc(pot.name) : 'New pot'} <span class="muted">#${esc(id)}</span></h1>
    <form id="pot">
      <label for="name">Plant name</label>
      <input id="name" name="name" required value="${esc(p.name)}">

      <label for="description">Description</label>
      <textarea id="description" name="description">${esc(p.description)}</textarea>

      <label for="quantity">How many</label>
      <input id="quantity" name="quantity" type="number" min="0" inputmode="numeric" value="${esc(p.quantity)}">

      <label for="location">Location</label>
      <input id="location" name="location" list="locations" value="${esc(p.location)}">
      <datalist id="locations">${locations.map(l => `<option value="${esc(l)}">`).join('')}</datalist>

      <label for="datePlanted">Date planted</label>
      <input id="datePlanted" name="datePlanted" type="date" value="${esc(p.datePlanted)}">

      <label for="careNotes">Care notes</label>
      <textarea id="careNotes" name="careNotes">${esc(p.careNotes)}</textarea>

      <label for="keywords">Keywords</label>
      <input id="keywords" name="keywords" value="${esc(p.keywords)}" placeholder="e.g. citrus fruit">

      <button class="primary">Save</button>
      <p class="msg" id="msg"></p>
    </form>
    ${pot ? `<a class="btn" href="#/labels/${esc(id)}">Print label</a>
             <button class="danger" id="del">Delete this pot</button>` : ''}
  `;

  const form = app.querySelector('#pot');
  form.oninput = () => { dirty = true; app.querySelector('#msg').textContent = ''; };

  form.onsubmit = async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const now = Date.now();
    await putPot({
      id,
      name: f.name.trim(),
      description: f.description.trim(),
      quantity: Math.max(0, parseInt(f.quantity, 10) || 0),
      location: f.location.trim(),
      datePlanted: f.datePlanted,
      careNotes: f.careNotes.trim(),
      keywords: f.keywords.trim(),
      createdAt: pot?.createdAt ?? now,
      updatedAt: now,
    });
    dirty = false;
    await showPot(id); // re-render so title, Delete button and location suggestions are current
    app.querySelector('#msg').textContent = 'Saved ✓';
  };

  const del = app.querySelector('#del');
  if (del) del.onclick = async () => {
    if (!confirm(`Delete ${pot.name} (#${id})? This can't be undone.`)) return;
    await deletePot(id);
    dirty = false;
    location.hash = '#/';
  };
}

route();
