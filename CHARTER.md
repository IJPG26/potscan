# Project Charter: PotScan

| | |
|---|---|
| **Project** | PotScan (working name). Do not use ToteScan's name, logo, screens or code. |
| **Date** | 2026-10-02 |
| **Owner / developer** | Darren |
| **End user** | Darren's father, a gardener and non-technical user |
| **Target device** | Xiaomi Android phone running Chrome |
| **Budget** | $0 to run. Only cost is waterproof label stock or lamination. |
| **App address (locked)** | `https://ijpg26.github.io/potscan/`, served by GitHub Pages from `github.com/IJPG26/potscan`, branch `main`. Never rename the repo or the account (§6.1). |
| **Label URL format** | `https://ijpg26.github.io/potscan/#/pot/0012` |

---

## 1. Purpose

Build a free, offline-capable phone app that lets a gardener label pots with QR codes and keep searchable records of his plants. It follows ToteScan's loop: **label → scan → record → search**. It is built for one person on one phone, so there are no accounts, no server and no payments.

## 2. Objectives

| # | Objective | Measured by |
|---|---|---|
| O1 | Scan a QR code and open or create the matching pot record within a few taps | Scan to form open: ≤ 2 taps, ≤ 5 s |
| O2 | Store name, description, quantity, location, date planted, care notes, keywords and multiple photos on the device | All fields survive an app restart and a phone reboot |
| O3 | Text search plus a sortable "My Pots" list | Search returns matches as you type; sort by name or date updated |
| O4 | Fully offline after first load, installable to the home screen | Works in airplane mode; launches from its own icon with no browser bar |
| O5 | Export and import all data as one backup file | A fresh install restores every record and photo |
| O6 | Zero running cost | Static hosting only, no backend |
| O7 | Large, simple controls for outdoor use | Tap targets ≥ 56 px; readable in direct sun |
| O8 | Short first-run guide | Shown on first launch and reachable later from a Help button |

## 3. Scope

**In scope (v1)**
- QR-based pot records, with a blank form when an unknown code is scanned
- Scanning with Google Lens (main path), an in-app QR scanner (backup), and manual ID entry (for damaged labels)
- Multiple compressed photos per pot, shown as a dated timeline
- Care notes, date planted, keywords
- Search and a sortable list
- Offline use (service worker) and home-screen install (manifest)
- JSON export/import backup with a "last backup" reminder
- First-run guide
- Built-in QR label printing: one label from a pot's page, or a numbered batch (see §6.4)
- "Add a new pot" button that picks the next free number

**Out of scope**
Accounts and sign-in, label sales, family profiles and sharing, moving records between accounts, voice assistants, mover or organizer tools, multi-device sync.

**Later, if wanted**
Watering log with a "last watered" indicator, optional cloud sync on a free tier, reminders.

## 4. Stakeholders and roles

| Role | Who | Responsibility |
|---|---|---|
| Sponsor / product owner | Darren | Decides scope, accepts the work |
| Developer | Darren, with Claude | Builds, tests, deploys |
| End user | Father | Day-to-day use, feedback after the demo |

---

## 5. Technical decisions

These are fixed unless the charter is revised.

| Decision | Choice | Why |
|---|---|---|
| App type | Static PWA: HTML, CSS, vanilla JS | No build step and no framework. Small enough for one person to maintain. |
| Files | `index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, icons, and `qrcode.js` (vendored [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4, MIT) for labels | Fewest files possible |
| Storage | IndexedDB, with photos stored as `Blob`s | Built in, holds binary data, works offline |
| Routing | Hash routes (`#/pot/0012`, `#/list`, `#/scan`) | Static hosts serve only `index.html`. Hash routes never 404 and need no rewrite rules. |
| Hosting | GitHub Pages (or Netlify) | Free, and HTTPS is required for the camera, the service worker and install |
| Dependencies | None at runtime, except an optional small QR *generator* for label sheets | Lens needs no code. The backup scanner uses the native `BarcodeDetector` API in Chrome on Android. |

### 5.1 Data model

One object store, `pots`, keyed by `id`. Photos sit in their own store so the list and search never load image data.

```js
// store "pots"  (keyPath: "id")
{
  id: "0012",            // string, zero-padded 4 digits, from the QR code. Never changes.
  name: "Calamansi",
  description: "",
  quantity: 1,           // integer ≥ 0
  location: "Back porch",
  datePlanted: "2026-09-14",   // ISO date or "" (<input type="date">)
  careNotes: "",
  keywords: "citrus fruit",    // free text, searched like the other fields
  createdAt: 1727827200000,    // epoch ms
  updatedAt: 1727827200000
}

// store "photos"  (keyPath: "id", index "potId")
{
  id: "p_<random>",
  potId: "0012",
  takenAt: 1727827200000,  // capture time, used for the timeline
  blob: Blob              // compressed JPEG
}

// store "meta": { key: "lastBackupAt", ... }, { key: "seenGuide", ... }
```

- Name the DB `potscan` and start at version `1`. Any schema change bumps the version and adds an `onupgradeneeded` step. Never wipe existing data.
- Pot IDs are **strings** (`"0012"`, not `12`) so leading zeros survive.

### 5.2 Routes and screens

| Route | Screen |
|---|---|
| `#/` | Home: **Scan a label** (backup scanner), **+ Add a new pot**, "Open a pot by number", **Print labels**, "My Pots" list (search box comes in M4) |
| `#/scan` | Backup scanner: camera view using `BarcodeDetector`. On a hit, go to `#/pot/<id>`. |
| `#/new` | Picks the next free number and opens the new-pot form |
| `#/labels`, `#/labels/<id>`, `#/labels/<from>-<to>` | Label sheet with Print button |
| `#/pot/<id>` | Record exists: view/edit. Unknown: new-pot form with the ID filled in. |
| `#/backup` | Export, import, last-backup date |
| `#/help` | First-run guide (also shown automatically on first launch) |

The URL inside the QR code is the route itself: `https://<user>.github.io/<repo>/#/pot/0012`. So anything that opens that link (Lens, a camera app, the backup scanner) lands on the right record with no extra code.

---

## 6. The tricky parts

These are what will break the project if ignored.

### 6.1 The address is permanent
- Every printed label holds the full URL. **Lock the final host, repo name and path before printing any label.** Renaming the GitHub repo, changing username or switching hosts kills every label.
- The browser ties storage to the **origin**. A new domain also means an empty database. Back up before any move.
- Use **static** QR codes only. "Dynamic" codes route through a vendor's server and expire without a subscription.

### 6.2 Scanning paths and which browser opens the link (biggest risk on Xiaomi)
Three ways to open a pot, in order of use:

| Path | Flow | When |
|---|---|---|
| **1. Google Lens (main)** | Open Lens → point at label → tap the link | Everyday use. Nothing to build. |
| **2. In-app Scan button (backup)** | Open PotScan → **Scan** → point | Lens opens the wrong app, misbehaves, or isn't available |
| **3. Enter pot number** | Open PotScan → type `0012` | Label damaged, faded, or unreadable in glare |

**The risk with Lens:** the app's data lives in Chrome's storage. Where Lens opens the link decides whether the records are there:
- **Chrome, a Chrome pop-up tab (Custom Tab), or the installed PotScan app:** fine. They all share Chrome's storage.
- **Mi Browser or another app's built-in browser:** that browser has its **own separate storage**, so all records look like they vanished.

Setup steps that make Lens land in the right place:
1. Set Chrome as the default browser on the phone.
2. Install PotScan from Chrome. On Android, the installed app (WebAPK) catches links in its scope, so a tapped Lens link opens the app.
3. Put a Lens shortcut (Google app widget or quick-settings tile) on the home screen next to PotScan.
4. **Run the Lens test in §9 before printing labels.** If Lens fails it, switch the guide so the in-app Scan button is the main path. No code changes are needed, since both paths already exist.

Backup scanner details:
- It accepts either a full PotScan URL or a bare ID, and extracts the ID with a regex such as `/#\/pot\/([0-9A-Za-z-]+)$/`. Any other QR content shows "Not a PotScan label".
- The URL in the code is parsed, not followed, so the scan always stays inside the right app.
- If `BarcodeDetector` is missing, hide the Scan button and rely on Lens plus manual entry.

Manual entry uses a number keypad (`inputmode="numeric"`) and zero-pads the input (`12` → `0012`).

### 6.3 Data loss
- Records live only on this phone. Clearing Chrome's site data, uninstalling or resetting the phone deletes them.
- Call `navigator.storage.persist()` on first launch so Chrome is less likely to evict data under storage pressure.
- **Backup is a core feature, not an extra:**
  - Export: one `.json` file `{ app: "potscan", version: 1, exportedAt, pots: [...], photos: [{ ..., data: "data:image/jpeg;base64,..." }] }`. Save it with a download link, and offer the Web Share API so it can go straight to Google Drive, WhatsApp or email.
  - Import: check `app` and `version`, then **merge by `id`, keeping whichever `updatedAt` is newer**. Show a summary ("12 added, 3 updated") before writing. Never delete records that aren't in the file.
  - Home shows "Last backup: N days ago" and turns it orange after 14 days.
- Base64 adds about 33% to file size. That's fine for dozens of pots at ~200 KB per photo. ZIP would need a library, so skip it.

### 6.4 Labels
- Pot IDs are sequential, zero-padded (`0001`–`9999`), and never reused.
- Print the **ID in readable text under the code**, so a faded code can still be typed in.
- Code at least **3–4 cm** wide, black on white, error-correction level **Q** (survives dirt and scratches), with a white quiet zone around it.
- Short URL = less dense code = easier scanning in glare.
- Waterproof vinyl or laminated paper, out of direct midday sun where possible.
- **Labels are made inside PotScan, with no outside QR website.** `#/labels/0012` prints one label (linked from each pot's page as **Print label**). `#/labels/0001-0024` prints a batch (up to 100) for labeling pots before recording them. Printing uses `window.print()`, to a printer or "Save as PDF". The QR always encodes the locked address (`LABEL_BASE` in `app.js`), even when the app runs from localhost.
- Two ways to work:
  - **One at a time:** Add a new pot → fill in → Save → Print label → stick it on.
  - **Batch:** Print labels 0001–0012 → stick them on pots → scan each → fill in.
- `#/new` picks the highest saved number + 1. It doesn't know about printed-but-unrecorded labels, so for batch work, scan the labels instead of using Add a new pot.

### 6.5 Photos
- Compress on save. Resize so the long edge is at most **1280 px**, then `canvas.toBlob('image/jpeg', 0.7)`. Target ~150–250 KB per photo.
- Decode with `createImageBitmap(file, { imageOrientation: 'from-image' })` so portrait shots aren't saved sideways.
- Capture with `<input type="file" accept="image/*" capture="environment">`, which opens the rear camera directly. Also allow picking from the gallery.
- Timeline: photos sorted by `takenAt`, newest first, each with its date. The newest photo is the list thumbnail.
- Create thumbnails with `URL.createObjectURL` and revoke them when leaving a screen.

### 6.6 Search and list
- Load all pots (not photos) into memory and filter as the user types. At this scale, no index is needed.
- Match across `id`, `name`, `description`, `location`, `careNotes` and `keywords`.
- Case-insensitive and **accent-insensitive**: `s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()`.
- Sort by name (A–Z, `localeCompare`) or date updated (newest first). Remember the choice in `localStorage`.

### 6.7 Offline and updates
- The service worker pre-caches the app shell under a versioned cache name (`potscan-v1`). Serve cache-first and delete old caches on `activate`.
- **Bump the cache version on every deploy**, or the phone keeps running old code.
- Show a small "Update available, tap to reload" note when a new worker is waiting, rather than reloading in the middle of editing a form.
- The manifest needs `name`, `short_name`, `start_url: "./#/"`, `scope: "./"`, `display: "standalone"`, `theme_color`, and 192 px and 512 px icons (one of them `maskable`).

### 6.8 Outdoor and non-technical use
- Light, high-contrast theme for sunlight. Body text at least 18 px, buttons at least 56 px tall, generous spacing for dirty or gloved hands.
- One main action per screen. On Home, the search box and the Scan and Enter-number buttons are the biggest elements.
- **Save automatically** on field blur, or keep one large Save button that stays visible. Leaving the form must never silently lose input.
- Deletes always ask for confirmation, naming the pot ("Delete Calamansi (0012)?").
- Plain words only. No "IndexedDB", "PWA" or "sync" in the UI.
- Location field offers suggestions from existing locations (`<datalist>`) so spelling stays consistent.

### 6.9 First-run guide
Three or four full-screen cards, skippable, reachable again from Help:
1. "Stick a label on a pot."
2. "Open **Google Lens**, point at the label, and tap the link." (Small print: "Not working? Open PotScan and tap **Scan**.")
3. "Fill in the plant and take a photo."
4. "Tap **Backup** now and then to keep a copy safe."

---

## 7. Assumptions and constraints

- One user, one phone, with Chrome as the default browser.
- The phone has camera permission for Chrome / the installed app.
- Scale is tens to low hundreds of pots, not thousands.
- An internet connection is needed only for the first load, installation and updates.
- No personal data leaves the phone except in backup files the user exports.

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Lens opens links in Mi Browser or another app's built-in browser, so data looks "missing" | Medium | High | Chrome as default browser, PotScan installed, Lens test before printing, in-app scanner as backup (§6.2) |
| Data lost on reset or clear | Medium | High | `storage.persist()`, backup with reminder, share to Drive (§6.3) |
| URL changes after labels are printed | Low | High | Lock host and path before printing (§6.1) |
| Labels fade or peel | High | Medium | Waterproof stock, readable ID, manual entry (§6.4) |
| Glare stops scanning | Medium | Low | Large high-contrast codes, level Q, manual entry |
| Storage fills with photos | Low | Medium | Compression (§6.5) |
| Stale code after deploy | Medium | Low | Versioned cache plus update prompt (§6.7) |

## 9. Milestones

| # | Milestone | Done when |
|---|---|---|
| M1 | Skeleton | Hash router, IndexedDB wrapper, create/view/edit a pot by typing an ID |
| M2 | Scan | Lens test passed on the Xiaomi phone (§9); backup `BarcodeDetector` scanner and manual entry open or create records |
| M3 | Photos | Capture, compress, timeline, thumbnails |
| M4 | Search and list | Live search, both sort orders |
| M5 | Offline and install | Service worker, manifest, icons; works in airplane mode |
| M6 | Backup | Export, share, merge-import, reminder |
| M7 | Polish | First-run guide, outdoor styling, delete confirmations, optional label sheet |
| M8 | Field test | Deployed to the final URL; labels printed; tested on the Xiaomi phone; father demo |

**Lens test (run during M2, before printing labels).** Passed 2026-10-02 on Darren's Xiaomi with Chrome as default browser: Lens opened pot 0001 with its data. Chrome's ⋮ menu shows "Install" (full app install). Repeat on the father's phone during M8.
- [ ] Chrome is the default browser and PotScan is installed from Chrome
- [ ] Create a test pot in PotScan, then scan its label with Lens and tap the link
- [ ] The test pot opens **with its data** (in PotScan or a Chrome tab) → Lens stays the main path
- [ ] It opens Mi Browser or an empty app → make the in-app Scan button the main path in the guide

**On-device test checklist (M8)**
- [ ] Lens scan in shade and in direct sun
- [ ] In-app scan in shade and in direct sun
- [ ] Manual entry: typing `12` opens pot `0012`
- [ ] Scan with the stock Xiaomi camera or scanner: which app opens? Does it show the same data?
- [ ] Airplane mode: open, create, edit, add a photo, search
- [ ] Export → clear site data → import → everything back, photos included
- [ ] Reboot the phone: data is still there
- [ ] Deploy a change: the update prompt appears

## 10. Success criteria (acceptance)

1. A new pot can be labeled, scanned and recorded in **under one minute**.
2. The app opens and works with **no signal**.
3. A backup file restores **every record and photo** on a fresh install.
4. The father can use it **unaided after one demonstration**.

## 11. Approval

| Role | Name | Date |
|---|---|---|
| Product owner | Darren | |
