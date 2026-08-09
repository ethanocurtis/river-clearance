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
- Computes `actual_clearance = reference_clearance_ft - stage_ft (+ adjustment_ft)`
  — the bridge's own number, same for every vessel.
- Then computes **your margin** = `actual_clearance - your_air_draft` — how
  much room *your* vessel actually has (negative means it won't fit right
  now). This is the big number shown on each card/row, not the raw bridge
  clearance, since that's what actually answers "can I get under this."
  OK/Marginal/Blocked status additionally factors in a **safety margin**
  buffer (both air draft and safety margin configurable per vessel, saved in
  `localStorage`).
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
- Loads `docs/data/gauges.json` — every real NOAA NWPS gauge found from St.
  Paul down to St. Louis (29 gauges), not just the ones assigned to a
  bridge. Shown in its own collapsible "NOAA Gauges Along the Route" list
  and as plain blue dots on the map (bridges are colored circles matching
  their status). This is reference context for the whole stretch; it does
  **not** change how a given bridge's clearance is computed — that still
  comes from that bridge's own `controlling_gauge_id`/`usgs_site_no` in
  `bridges.json`, same as before.
- Bridges and gauges that share the same NWPS gauge ID (e.g. Rock Island,
  Dubuque, La Crosse, St. Louis appear both as a bridge's gauge and as their
  own row in the gauges list) only fetch that gauge once per refresh —
  `app.js` memoizes in-flight NWPS requests for the duration of a render.

### NWPS response shape — confirmed

This project was originally built in a sandboxed environment whose network
blocked `api.water.noaa.gov`, so `NWPS_STAGE_EXTRACTORS` in `app.js` was
written from guesses and was failing for most gauges. **This is now fixed**
— a real sample response was provided (2026-08-09) confirming the actual
shape: `{ observed: { primaryUnits: "ft", data: [ { validTime, primary },
... ] } }`. `getStageNWPS` now reads that directly as its first, expected
path, with a couple of cheap fallback shapes kept just in case a different
gauge/endpoint variant ever responds differently.

USGS backup gauges (`usgs_site_no`) added earlier while NWPS was broken are
left in place — they're still useful as a second source if NWPS itself is
ever down, not just a workaround. Some gauges still have no USGS backup
(`stpm5`, `sspm5`, `redm5`, `rdwm5`, `lkcm5`, `mscm5`, `widm5`, `wnam5`,
`trew3`, `lcrm5`, `genw3`, `gtti4`, `musi4`, `nboi2`, `brli4`, `eoki4`,
`uini2`, `qldi2`, `canm7`, `hnnm7`, `lusm7`, `clkm7`, `cagm7`) — with NWPS
now working those should generally be fine, but they'll show "Stage
unavailable" if NWPS itself has an outage for that gauge.

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

All 29 NOAA NWPS gauge IDs found while building this are in
`docs/data/gauges.json` (St. Paul down to St. Louis, one roughly every
lock & dam) — most aren't wired to a specific bridge yet, which is exactly
what makes them useful for extending bridge coverage or filling gaps:
`stpm5` (St. Paul), `sspm5` (South St. Paul), `redm5`/`rdwm5` (Red Wing),
`lkcm5` (Lake City), `wnam5`/`widm5`/`mscm5` (Winona area), `trew3`
(Trempealeau), `lcrm5` (La Crescent), `lacw3` (La Crosse), `genw3` (Genoa,
L&D 8), `gtti4` (Guttenberg, L&D 10), `dldi4`/`dbqi4` (Dubuque, L&D 11),
`rcki2` (Rock Island, L&D 15), `musi4` (Muscatine, L&D 16), `nboi2` (New
Boston, L&D 17), `brli4` (Burlington), `eoki4` (Keokuk, L&D 19), `uini2`
(Quincy), `qldi2` (Quincy, L&D 21), `canm7` (Canton, L&D 20), `hnnm7`
(Hannibal), `lusm7` (Louisiana), `clkm7` (Clarksville, L&D 24), `cagm7`
(Winfield, L&D 25), `alni2` (Alton — Melvin Price Lock and Dam, L&D 26),
`eadm7` (St. Louis). Their lat/lon are approximate (the town's location,
not the exact gauge structure) — fine for a map pin, not precise enough
for anything more. River miles for lock-and-dam-named gauges use the
lock's commonly-cited USACE milepost; the rest are left `null` rather than
guessed.

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

## Adding a gauge

Add an entry to `docs/data/gauges.json` with this shape:

```json
{
  "id": "nwps-gauge-id",
  "name": "Display name, e.g. 'Some City, MN — below Lock & Dam N'",
  "lat": 00.0,
  "lon": -00.0,
  "river_mile": 000.0,
  "source": "NWPS",
  "usgs_site_no": "USGS site number or null"
}
```

`usgs_site_no` is a fallback used automatically if the NWPS gauge doesn't
return data (see "NWPS response shape — confirmed" above; nice to have but
optional now that NWPS itself works). This list is independent of
`bridges.json` — a gauge doesn't need to be tied to a bridge to show up
here. Set `river_mile` to `null` if you don't have a sourced figure for it
(most entries currently do not — only a few lock-and-dam mile markers were
confidently sourced — see "Data provenance" above).

## Getting started

1. Enable GitHub Pages for the repository and point it at `/docs` on the
   `main` branch.
2. Visit `https://<your-username>.github.io/<repo-name>/`

No build step — it's a static site.

_Last updated: 2026-08-09_
