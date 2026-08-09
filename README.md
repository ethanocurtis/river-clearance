# Upper Mississippi Bridge Clearance

**NOT FOR NAVIGATION.** Informational reference only. Bridge clearance
figures were compiled from public secondary sources (not the current USACE
chart book or bridge owner permits) — see "Data provenance" below before
relying on any number here.

A mobile-first tool for checking a vessel's air draft against real Upper
Mississippi River bridges, using live river stage from NOAA NWPS / USGS.

## How it works

- Loads `docs/data/bridges.json` — a seed set of real bridges from Dubuque,
  IA to St. Louis, MO.
- For each bridge, fetches current stage from its assigned NOAA NWPS gauge
  (falling back to a USGS gauge if given, or vice versa).
- Computes `actual_clearance = reference_clearance_ft - stage_ft (+ adjustment_ft)`.
- Compares against a vessel's air draft **plus a safety margin** (both
  configurable, saved in `localStorage`).
- If live data can't be fetched, shows the last cached reading labeled
  `(stale)` with when it was last good — and if there's no cached reading
  either, shows **"Stage unavailable"**. It never fabricates a stage or
  clearance number.
- Movable bridges (swing/lift spans that open for tows) and bridges with no
  known reference clearance get their own status (`Movable — hail bridge`,
  `Needs data`) instead of being forced through the OK/Marginal/Blocked math.
- A basic offline cache (`docs/sw.js`) keeps the app shell and last-fetched
  bridge list available if the boat loses signal; the offline banner makes
  clear when you're looking at cached data.

## Data provenance

The bridges in `bridges.json` were populated during a session where this
environment's network policy blocked direct access to the primary sources
(USACE chart PDFs, the official [USACE Rock Island bridge clearance
calculator](https://rivergages.mvr.usace.army.mil/bridge_clearance/bridge_clearance.cfm),
NOAA nautical charts, Wikipedia, archive.org). The figures currently in the
file came from search-result summaries of secondary sources (bridge
reference articles) instead. Each bridge entry carries:

- `source_note` — where the figure came from and its verification status
- `last_checked` — when it was compiled
- `notes` — a flag like `VERIFY before operational use` or `NEEDS DATA`

**Before using this for real trip planning, cross-check every
`reference_clearance_ft` against the current USACE Upper Mississippi River
Navigation Charts or the bridge clearance calculator above.**

NOAA NWPS gauge IDs referenced or discovered while building this (some not
yet wired to a bridge — useful for extending coverage north of Dubuque):
`stpm5` (St. Paul), `sspm5` (South St. Paul), `redm5`/`rdwm5` (Red Wing),
`wnam5`/`widm5`/`mscm5` (Winona area), `trew3` (Trempealeau), `lcrm5` (La
Crescent), `lacw3` (La Crosse), `dldi4`/`dbqi4` (Dubuque), `rcki2` (Rock
Island), `brli4` (Burlington), `eoki4` (Keokuk), `uini2`/`qldi2` (Quincy),
`hnnm7` (Hannibal), `eadm7` (St. Louis).

## Adding or correcting a bridge

Add an entry to `docs/data/bridges.json` with this shape:

```json
{
  "id": "unique-id",
  "name": "Bridge name",
  "river": "Mississippi",
  "river_mile": 000.0,
  "mile_verified": false,
  "state": "XX",
  "type": "fixed | movable",
  "reference_clearance_ft": 00.0,
  "reference_datum": "flat pool stage",
  "controlling_gauge_id": "NWPS gauge id or null",
  "gauge_source": "NWPS | USGS",
  "usgs_site_no": "USGS site number or null",
  "lat": 00.0,
  "lon": -00.0,
  "source_note": "where this figure came from + verification status",
  "last_checked": "YYYY-MM-DD",
  "notes": "any caveats"
}
```

For a bridge whose clearance you don't have a sourced figure for, set
`reference_clearance_ft` to `null` rather than guessing — the app shows
"Needs data" for those instead of a false number.

## Getting started

1. Enable GitHub Pages for the repository and point it at `/docs` on the
   `main` branch.
2. Visit `https://<your-username>.github.io/<repo-name>/`

No build step — it's a static site.

_Last updated: 2026-08-09_
