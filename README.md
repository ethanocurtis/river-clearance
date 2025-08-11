# River Bridge Clearance (Demo Scaffold)

**Not for navigation.** This is a frontend-only demo you can host on GitHub Pages. 
Replace `docs/data/bridges.json` with real bridge rows from USACE navigation charts and assign controlling gauges (NOAA NWPS or USGS).

## How it works
- Loads `docs/data/bridges.json`
- Fetches current stage from NOAA NWPS or USGS (fallbacks to demo values if unavailable)
- Computes `actual_clearance = reference_clearance_ft - stage_ft (+ adjustment)`
- Compares against your vessel air draft (saved in localStorage)
- Renders a table and map (Leaflet)

## Getting started
1. Enable GitHub Pages for the repository and point it at `/docs` on the `main` branch.
2. Visit `https://<your-username>.github.io/<repo-name>/`

_Last generated: 2025-08-11T11:19:09.132219Z_
