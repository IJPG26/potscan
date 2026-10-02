# Project Charter: PotScan

| | |
|---|---|
| **Project** | PotScan (working name; the name shown in the app can change any time). A personal clone of how ToteScan works. Do not use ToteScan's name, logo, screens or code. |
| **Date** | 2026-10-02 (revised the same day: storage totes, not plant pots) |
| **Owner / developer** | Darren |
| **End user** | Darren's father, a non-technical user organizing storage totes |
| **Target device** | Xiaomi Android phone running Chrome |
| **Budget** | $0 to run. Only cost is label stock (waterproof or laminated recommended). |
| **App address (locked)** | `https://ijpg26.github.io/potscan/`, served by GitHub Pages from `github.com/IJPG26/potscan`, branch `main`. Never rename the repo or the account (§6.1). Users never see this address, so it can stay "potscan" even if the app is renamed. |
| **Label URL format** | `https://ijpg26.github.io/potscan/#/tote/0012` |

---

## 1. Purpose

Build a free, offline-capable phone app for labeling storage totes with QR codes, listing what's inside each one, and finding any item quickly. It follows ToteScan's loop: **label → scan → record → search**. It is built for one person on one phone, so there are no accounts, no server and no payments.

The key question it answers: **"Where is my ___?"** Search for an item and the app shows the item, its photo, which tote it's in, and where that tote is kept.

## 2. Objectives

| # | Objective | Measured by |
|---|---|---|
| O1 | Scan a tote's QR code and open or create its record within a few taps | Scan to tote page: ≤ 2 taps, ≤ 5 s |
| O2 | Store each tote (name, location, notes, keywords, photos) and the items inside it (name, quantity, description, photos) on the device | All data survives an app restart and a phone reboot |
| O3 | Text search across totes **and items**, plus a sortable "My Totes" list | Typing an item name shows the item, its tote and the tote's location, as you type |
| O4 | Fully offline after first load, installable to the home screen | Works in airplane mode; launches from its own icon with no browser bar |
| O5 | Export and import all data as one backup file | A fresh install restores every tote, item and photo |
| O6 | Zero running cost | Static hosting only, no backend |
| O7 | Large, simple controls | Tap targets ≥ 56 px; readable in a dim garage or bright sun |
| O8 | Short first-run guide | Shown on first launch and reachable later from a Help button |

## 3. Scope

**In scope (v1)**
- Totes identified by QR labels, with a blank form when an unknown code is scanned
- Items inside each tote: name, quantity, description, multiple photos; fast entry with **Save & add another**
- Scanning with Google Lens (main path), an in-app QR scanner (backup), and manual number entry (for damaged labels)
- Multiple compressed photos per tote and per item
- Search across totes and items; sortable tote list
- Offline use (service worker) and home-screen install (manifest)
- JSON export/import backup with a "last backup" reminder
- First-run guide
- Built-in QR label printing: one label from a tote's page, or a numbered batch (see §6.4)
- "Add a new tote" button that picks the next free number

**Out of scope**
Accounts and sign-in, label sales, family profiles and sharing, moving records between accounts, voice assistants, mover or organizer tools, multi-device sync.

**Later, if wanted**
Moving an item from one tote to another, nested locations (room → shelf), optional cloud sync on a free tier.

## 4. Stakeholders and roles

| Role | Who | Responsibility |
|---|---|---|
| Sponsor / product owner | Darren | Decides scope, accepts the work |
| Developer | Darren, with Claude | Builds, tests, deploys |
| End user | Father | Day-to-day use, feedback after each demo |

---

## 5. Technical decisions

These are fixed unless the charter is revised.

| Decision | Choice | Why |
|---|---|---|
| App type | Static PWA: HTML, CSS, vanilla JS | No build step and no framework. Small enough for one person to maintain. |
| Files | `index.html`, `app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, icons, and `qrcode.js` (vendored [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4, MIT) for labels | Fewest files possible |
| Storage | IndexedDB, with photos stored as `Blob`s | Built in, holds binary data, works offline |
| Routing | Hash routes (`#/tote/0012`, `#/scan`, …) | Static hosts serve only `index.html`. Hash routes never 404 and need no rewrite rules. |
| Hosting | GitHub Pages | Free, and HTTPS is required for the camera, the service worker and install |
| Dependencies | None at runtime except `qrcode.js` for printing labels | Lens needs no code. The backup scanner uses the native `BarcodeDetector` API in Chrome on Android. |

### 5.1 Data model

DB `potscan`, version 2. Photos sit in their own store so lists and search never load image data.

```js
// store "totes"  (keyPath: "id")
{
  id: "0012",            // string, zero-padded 4 digits, from the QR label. Never changes.
  name: "Garage tools",
  location: "Garage, shelf 2",
  description: "",       // shown as "Notes"
  keywords: "power tools",
  createdAt: 1727827200000,    // epoch ms
  updatedAt: 1727827200000     // bumped when the tote, its items or photos change
}

// store "items"  (keyPath: "id", index "toteId")
{
  id: "i_<uuid>",
  toteId: "0012",
  name: "Cordless drill",
  quantity: 1,           // integer ≥ 0
  description: "Blue Makita, with charger",
  createdAt: 1727827200000,
  updatedAt: 1727827200000
}

// store "photos"  (keyPath: "id", index "ownerId")
{
  id: "p_<uuid>",
  ownerId: "0012",       // a tote id ("0012") or an item id ("i_…")
  takenAt: 1727827200000,  // file.lastModified: capture time for camera shots
  blob: Blob,            // compressed JPEG, long edge ≤ 1280 px
  thumb: Blob            // JPEG, long edge ≤ 240 px, for lists
}

// store "meta": { key: "lastBackupAt", ... }, { key: "seenGuide", ... }
```

- Any schema change bumps the DB version and adds an `if (e.oldVersion < N)` step in `onupgradeneeded`. **Never wipe existing data.** (The v1 → v2 step cleared the plant-pot prototype, which held test data only. That's the one exception.)
- Tote IDs are **strings** (`"0012"`, not `12`) so leading zeros survive.
- Deleting an item deletes its photos. Deleting a tote deletes its items and all their photos, in one transaction.

### 5.2 Routes and screens

| Route | Screen |
|---|---|
| `#/` | Home: **Scan a label** (backup scanner), **+ Add a new tote**, "Open a tote by number", **Print labels**, "My Totes" list with thumbnail, location and item count (search box comes in M4) |
| `#/scan` | Backup scanner: camera view using `BarcodeDetector`. On a hit, go to `#/tote/<id>`. |
| `#/new` | Picks the next free number and opens the new-tote form |
| `#/tote/<id>` | Saved tote: location, **Items** list with **+ Add item**, tote details form, tote photos, Print label, Delete. Unknown: new-tote form with the ID filled in. |
| `#/tote/<id>/item/new` | New item form. Photos can be taken before saving; they're saved with the item. **Save** returns to the tote; **Save & add another** clears the form for the next item. |
| `#/tote/<id>/item/<itemId>` | Edit an item, its photos, or delete it |
| `#/labels`, `#/labels/<id>`, `#/labels/<from>-<to>` | Label sheet with Print button |
| `#/backup` | Export, import, last-backup date (M6) |
| `#/help` | First-run guide, also shown automatically on first launch (M7) |

The URL inside the QR code is the route itself, so anything that opens that link (Lens, a camera app, the backup scanner) lands on the right tote with no extra code.

---

## 6. The tricky parts

These are what will break the project if ignored.

### 6.1 The address is permanent
- Every printed label holds the full URL. **The host, repo name and path are locked** (see header). Renaming the GitHub repo, changing username or switching hosts kills every label.
- The browser ties storage to the **origin**. A new domain also means an empty database. Back up before any move.
- Labels are made inside the app (§6.4), so they're always static codes. Never use "dynamic" QR services, which route through a vendor's server and expire without a subscription.

### 6.2 Scanning paths and which browser opens the link
Three ways to open a tote, in order of use:

| Path | Flow | When |
|---|---|---|
| **1. Google Lens (main)** | Open Lens → point at label → tap the link | Everyday use. Nothing to build. |
| **2. In-app Scan button (backup)** | Open PotScan → **Scan** → point | Lens opens the wrong app, misbehaves, or isn't available |
| **3. Enter tote number** | Open PotScan → type `12` | Label damaged, faded, or unreadable |

**The risk with Lens:** the app's data lives in Chrome's storage. Where Lens opens the link decides whether the records are there:
- **Chrome, a Chrome pop-up tab (Custom Tab), or the installed PotScan app:** fine. They all share Chrome's storage.
- **Mi Browser, Opera, or another app's built-in browser:** that browser has its **own separate storage**, so all records look like they vanished.

Setup steps on the father's phone:
1. Set Chrome as the default browser.
2. Install PotScan from Chrome (⋮ → **Install**). The installed app catches links in its scope, so a tapped Lens link opens the app.
3. Put a Lens shortcut (Google app widget or quick-settings tile) on the home screen next to PotScan.
4. Repeat the Lens test (§9) on his phone.

Backup scanner details:
- It accepts either a full label URL (any host, so old labels survive a move) or a bare number. Any other QR content shows "That's not one of your tote labels".
- The URL in the code is parsed, not followed, so the scan always stays inside the right app.
- When it finds a code, the frame freezes with a green "✓ Tote 0012" badge and a short buzz, then it moves to the tote (about 550 ms).
- If `BarcodeDetector` is missing, the Scan button is hidden and Lens plus manual entry remain.

Manual entry uses a number keypad (`inputmode="numeric"`) and zero-pads the input (`12` → `0012`).

### 6.3 Data loss
- Records live only on this phone. Clearing Chrome's site data, uninstalling or resetting the phone deletes them.
- **Seen in testing (2026-10-02):** Darren's test totes vanished after he cleared Chrome's browsing history, because the "Cookies and site data" option deletes PotScan's storage. `storage.persist()` does not protect against this. On the father's phone, never tick "Cookies and site data" in Chrome's Delete browsing data (only "Cached images and files" is safe), and be careful with phone cleaner apps. The first-run guide and backup reminder (M6) should say this in plain words.
- `navigator.storage.persist()` is called on launch so Chrome is less likely to evict data under storage pressure.
- **Backup is a core feature, not an extra (M6, `#/backup`):**
  - Export: one file `potscan-backup-YYYY-MM-DD.json` = `{ app: "potscan", version: 2, exportedAt, totes: [...], items: [...], photos: [{ id, ownerId, takenAt, blob: "data:image/jpeg;base64,...", thumb: "data:..." }] }`. It's built from parts (one per photo), so it never sits in one giant string.
  - **Save backup to Google Drive…** uses the Web Share API with files (the Android share menu: Drive, WhatsApp, email…). The file is shared as **`.txt` (`text/plain`)**, because on Darren's Xiaomi, sharing `.json` failed even though `canShare` said yes. Restore reads `.json` and `.txt`. On failure the message shows the error name. **Download backup file** always works. The file is prepared as soon as the screen opens, because Android only allows sharing within a few seconds of the tap.
  - A backup counts as saved (`meta.lastBackupAt`) when sharing completes or Download is tapped. A cancelled share doesn't count.
  - Restore: the file is a trust boundary. It's refused unless `app === "potscan"` and `version ≤ 2`. Each entry is checked (id formats; photos must be `data:image/jpeg|png|webp;base64`), only known fields are kept, and anything malformed is skipped and counted.
  - **Merge:** add records that are missing; replace a tote or item only if the backup's `updatedAt` is newer; add photos whose id is missing. **Never delete.** A confirm dialog lists the changes ("add 2 items and 2 photos, update 1 tote") before anything is written, in one transaction. Restoring the same file twice changes nothing.
  - Home's **💾 Backup · last: …** button turns orange if there's never been a backup, or it's been more than 14 days (only once there's at least one tote).
  - Tested: export, then wipe every store, then restore came back identical, byte for byte, photos included. Also tested: second restore does nothing; newer phone edits are kept and older ones replaced; non-JSON, other JSON, newer-version and malformed files are refused or skipped.
- Base64 adds about 33% to file size. That's fine at ~130 KB per photo. ZIP would need a library, so skip it.

### 6.4 Labels
- Tote IDs are sequential, zero-padded (`0001`–`9999`), and never reused.
- The **number is printed large under the code**, so a damaged code can still be typed in.
- Code about **4 cm** wide, black on white, error-correction level **Q** (survives scuffs), with a white quiet zone around it.
- Waterproof vinyl or laminated paper lasts longest, especially for totes stored outside or in damp places.
- **Labels are made inside PotScan, with no outside QR website.** `#/labels/0012` prints one label (linked from each tote's page as **Print label**). `#/labels/0001-0024` prints a batch (up to 100). Printing uses `window.print()`, to a printer or "Save as PDF". The QR always encodes the locked address (`LABEL_BASE` in `app.js`), even when the app runs from localhost.
- Two ways to work:
  - **One at a time:** Add a new tote → fill in → Save → Print label → stick it on.
  - **Batch:** Print labels 0001–0012 → stick them on totes → scan each → fill in.
- `#/new` picks the highest saved number + 1. It doesn't know about printed-but-unrecorded labels, so for batch work, scan the labels instead of using Add a new tote.

### 6.5 Photos
- Compressed on save: long edge at most **1280 px**, JPEG quality 0.7, plus a 240 px thumbnail. Measured: a 5.9 MB, 4000×3000 photo was stored at 122 KB plus a 5 KB thumbnail.
- Decoded with `createImageBitmap(file, { imageOrientation: 'from-image' })` so portrait shots aren't saved sideways.
- **📷 Take photo** uses `<input type="file" accept="image/*" capture="environment">` (rear camera). **🖼 From gallery** allows picking several at once.
- Photos show newest first with their date. Tapping one opens it full screen (`<dialog>`) with Delete.
- **Totes:** photos can be added after the first save. Adding photos redraws only the photo area, so unsaved form edits stay.
- **Items:** a new item can take photos before saving. They're held in memory and saved with the item, which suits "photo first, then name it".
- List thumbnails: an item shows its newest photo. A tote shows its own newest photo, or else the newest photo of any of its items.
- Object URLs are created per screen and revoked on every screen change.

### 6.6 Search and list (M4)
- The search box is the first thing on Home. Totes and items (not photos) are loaded into memory and filtered as the user types. At this scale, no index is needed. While searching, results replace the rest of Home.
- Match totes on `id`, `name`, `location`, `description`, `keywords`. Match items on `name` and `description`, plus their tote's fields.
- Rules (function `search` in `app.js`):
  - Case-insensitive and **accent-insensitive** (`normalize('NFD')`, marks removed).
  - **Every search word must match the start of a word**: "cord" finds "Cordless" and "Extension cord", "ill" finds nothing, and "1" doesn't match inside "0001".
  - An item must match at least one word **itself**. So "garage drill" finds drills in garage totes, but "garage" alone lists the garage totes, not every item in them.
- **Item results show the item's thumbnail, name and quantity, plus "in <tote name> #0012 · 📍 <tote location>"**, and open the tote page. Tote results show as in My Totes. Items are listed first.
- The query is kept in the address (`#/?q=drill`, via `replaceState`), so Back from a result returns to the same search.
- Tote list sort: **Recent** (date updated, newest first) or **A–Z** (`localeCompare` with numeric ordering). The choice is remembered in `localStorage`.
- Tested with 15 search cases (single words, multiple words, tote-only words, accents, capitals, punctuation, no results).

### 6.7 Offline and updates (M5)
- `sw.js` pre-caches the 8 app files under a versioned cache name (`const CACHE = 'potscan-vN'`), serves cache-first (ignoring `?query`), and deletes old caches on `activate`.
- Install downloads with `cache: 'reload'`, so GitHub Pages' 10-minute HTTP cache can't put stale files into a new version.
- **Update flow:** a new version installs in the background and **waits**. The page shows a green **"Update ready, tap to refresh"** bar. Tapping it tells the worker to `skipWaiting`, and the page reloads on `controllerchange`. Nothing reloads in the middle of editing, and the first install never reloads.
- The app checks for updates on launch and whenever it comes back to the screen (`visibilitychange` → `reg.update()`), since an installed app can stay open for days.
- **Deploy checklist:** bump `CACHE` in `sw.js` on every deploy that changes app files, and **never reuse a number** (a browser that already has that version keeps its old files).
- Home shows **"Version N · <browser> · installed app / browser tab"** at the bottom. This is for support: if records seem missing, it shows at a glance whether PotScan is running in the browser that holds them (§6.2). A local git `pre-commit` hook (`.git/hooks/pre-commit`, not in the repo) blocks commits that change app files without the bump.
- Tested: the update bar and switch-over (passthrough → v1 and v1 → v2, old cache deleted, data intact); with the server stopped, the app opened, added an item with a photo, searched and printed labels.

### 6.8 Simple use for a non-technical user
- Light, high-contrast theme. Body text at least 18 px, buttons at least 56 px tall.
- One main action per screen. On Home: search, Scan, and Add a new tote are the biggest elements. On a tote: **+ Add item**.
- One large Save button. Leaving a form with unsaved changes asks first, including the phone's back gesture.
- Deletes always ask for confirmation, naming what goes ("Delete Garage tools (#0012), its 3 items and all photos?").
- Plain words only. No "IndexedDB", "PWA" or "sync" in the UI.
- Location field offers suggestions from existing locations (`<datalist>`) so spelling stays consistent.
- Screen changes fade and slide (View Transitions). Turned off when the phone asks for reduced motion.

### 6.9 First-run guide (M7)
Three or four full-screen cards, skippable, reachable again from Help:
1. "Stick a label on a tote."
2. "Open **Google Lens**, point at the label, and tap the link." (Small print: "Not working? Open PotScan and tap **Scan**.")
3. "Add what's inside: tap **+ Add item**, take a photo, type a name."
4. "Lost something? Type it in the search box to see which tote it's in."
5. "Tap **Backup** now and then to keep a copy safe."

---

## 7. Assumptions and constraints

- One user, one phone, with Chrome as the default browser.
- The phone has camera permission for Chrome / the installed app.
- Scale is tens to low hundreds of totes, and up to a few thousand items.
- An internet connection is needed only for the first load, installation and updates.
- No personal data leaves the phone except in backup files the user exports.

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Lens opens links in another browser, so data looks "missing" | Medium | High | Chrome as default browser, PotScan installed, in-app scanner as backup (§6.2) |
| Data lost on reset or clear (happened once in testing from clearing browsing data) | Medium | High | Backup with reminder, share to Drive, warn about "Cookies and site data" (§6.3) |
| URL changes after labels are printed | Low | High | Address locked (§6.1) |
| Labels scuff or peel | Medium | Medium | Waterproof/laminated stock, readable number, manual entry (§6.4) |
| Storage fills with photos | Low | Medium | Compression (§6.5) |
| Stale code after deploy | Medium | Low | Revalidating service worker now; versioned cache plus update prompt in M5 (§6.7) |

## 9. Milestones

| # | Milestone | Status / done when |
|---|---|---|
| M1 | Skeleton | ✅ Hash router, IndexedDB, create/view/edit a record by number |
| M2 | Scan | ✅ Lens test passed; backup scanner with "found" animation; manual entry; built-in label printing |
| M3 | Photos and items | ✅ Tote and item photos, compression, thumbnails; items inside totes with Save & add another. Passed on-phone test. |
| M4 | Search and list | ✅ Search across totes and items as you type; item results show tote and location; Recent / A–Z sort. Passed on-phone test. |
| M5 | Offline and install | ✅ Caching service worker with update bar; works in airplane mode. Passed on-phone test. |
| M6 | Backup | ✅ in code, awaiting on-phone test: export (share to Drive / download), merge-restore, reminder |
| M7 | Polish | First-run guide, wording, any feedback from the father |
| M8 | Field test | Labels printed; tested on the father's phone; father demo |

**Lens test.** Passed 2026-10-02 on Darren's Xiaomi with Chrome as default browser: Lens opened record 0001 with its data. Chrome's ⋮ menu shows "Install" (full app install). With Opera as default, links open in Opera, which has separate storage. Repeat on the father's phone during M8:
- [ ] Chrome is the default browser and PotScan is installed from Chrome
- [ ] Create a test tote, scan its label with Lens and tap the link
- [ ] The test tote opens **with its data** → Lens stays the main path

**On-device test checklist (M3)**: passed
- [x] 📷 Take photo opens the rear camera; the photo saves
- [x] Portrait photos display the right way up
- [x] 🖼 From gallery accepts several photos at once
- [x] New item: take photo first, then name it, Save & add another

**On-device test checklist (M4)**: passed
- [x] Typing an item name shows it with its tote and location
- [x] Tapping a result opens the tote; the back gesture returns to the same search
- [x] Recent / A–Z sort, and the choice is remembered after closing the app

**On-device test checklist (M5)**: passed
- [x] After reloading once online, the green "Update ready" bar appears; tapping it refreshes
- [x] Airplane mode: open PotScan from its icon, open a tote, add an item with a photo, search

**On-device test checklist (M6)**
- [ ] "Save backup to Google Drive…" appears and opens the share menu; saving to Drive works
- [ ] Home's Backup button shows "last: today" afterwards
- [ ] Delete a test item, restore the backup file from Drive → the item and its photo come back
- [ ] Download backup file saves to Downloads

**On-device test checklist (M8)**
- [ ] Lens scan in normal and dim light
- [ ] In-app scan
- [ ] Manual entry: typing `12` opens tote `0012`
- [ ] Airplane mode: open, create, edit, add a photo, search
- [ ] Export → clear site data → import → everything back, photos included
- [ ] Reboot the phone: data is still there
- [ ] Deploy a change: the update prompt appears

## 10. Success criteria (acceptance)

1. A new tote can be labeled, scanned and recorded in **under one minute**; each further item takes **under 20 seconds** with photo.
2. Searching an item name shows **which tote and where** in under 5 seconds.
3. The app opens and works with **no signal**.
4. A backup file restores **every tote, item and photo** on a fresh install.
5. The father can use it **unaided after one demonstration**.

## 11. Approval

| Role | Name | Date |
|---|---|---|
| Product owner | Darren | |
