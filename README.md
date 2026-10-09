# rsvp_wed_tab — Wedding Table / Floor-Plan Manager

Visual table manager for the Jess & Ara wedding RSVP (12.19.2026).
Pairs with the RSVP projects from last week (`wedding-rsvp` / `wedding-rsvp-v2`).

- **Source of truth for guests:** same Google Sheet tab `GuestList`
  (`CODE | NAME | PAX | SIDE | TABLE | STATUS | COMPANIONS | CONTACT | MESSAGE`)
  via the same Apps Script web app (`GAS_URL` in `config.js`).
- **Source of truth for table layout** (positions, shapes, capacities):
  browser `localStorage` (auto-save). Guest → table assignments stay local;
  only check-ins sync to the Sheet `CHECKIN` column.

## Pages

- `index.html` — password gate (`12192026`) → stats → floor plan + seating panels.

## Features (full floor plan)

- Floor-plan canvas with draggable tables (round / rectangle / banquet shapes)
- Table CRUD: name, seats (capacity), shape, notes — auto-generates Table N names
- Capacity bars: `seatsUsed` (1 + companions when Attending) vs table seats,
  over-capacity warning
- Unseated panel: attending + pending guests with no valid table, search,
  one-click assign to selected table
- Table detail: guest list per table, remove back to unseated, move between tables
- Live Sheet sync: `list` on load, `upsert` per TABLE change (same backend as v2)
- Offline fallback: seed guests + localStorage when Sheet unreachable
- Layout persistence: auto-save positions to localStorage

## Run locally

```powershell
cd "C:\Users\johnf\Documents\rsvp_wed_tab"
npx serve .
# or
python -m http.server 3000
```

Open http://localhost:3000 — password `12192026`.

## Deploy to Vercel

1. Push this folder as its own repo (or import it).
2. vercel.com → Add New Project → Import `rsvp_wed_tab`
3. Framework: Other, no build command → Deploy

## Backend notes

- No `Code.gs` change needed: guest TABLE assignment uses the existing
  `upsert` action (`{ action: "upsert", guest: { ...guest, table } }`).
- If you want table layouts in the Sheet too, create a tab `Tables` with
  `ID | NAME | SHAPE | SEATS | X | Y | NOTES` and copy values over,
  or extend `apps-script` later. Layout-in-Sheet is intentionally out of
  scope for v1 so the RSVP backend stays untouched.
