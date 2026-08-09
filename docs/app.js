// River Bridge Clearance — client app.
//
// Design rules that matter for real (if still "verify before use") navigational
// reference:
//   1. NEVER invent a stage reading. If live data can't be fetched and there's no
//      cached reading, the bridge shows "Stage unavailable" — not a fake number.
//   2. A cached (stale) reading is always labeled as stale, with the time it was
//      last good, so nobody mistakes it for current.
//   3. Movable bridges and bridges with no known reference clearance get their own
//      status instead of being forced through OK/Marginal/Blocked math.

// Bump this on any deploy that changes bridges.json — browsers (and CDN
// edges) cache same-URL requests by filename, so without a cache-busting
// query param a returning visitor can keep seeing old bridge data after a
// push. Keep in sync with the ?v= on style.css/app.js in index.html and
// CACHE_NAME in sw.js.
const DATA_VERSION = '20260809';

const REFRESH_MS = 5 * 60 * 1000; // auto-refresh every 5 minutes
const GAUGE_CACHE_KEY = 'gaugeCache';
const BRIDGES_CACHE_KEY = 'bridgesCache';
const VESSELS_KEY = 'vessels';
const ACTIVE_VESSEL_KEY = 'activeVesselIndex';

const state = {
  bridges: [],
  vessels: [],
  activeVesselIndex: 0,
  map: null,
  markers: [],
  refreshTimer: null,
  lastRenderRows: [], // computed rows from the most recent render, for the alert banner
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function loadVessels() {
  try {
    return JSON.parse(localStorage.getItem(VESSELS_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveVessels(vessels) {
  localStorage.setItem(VESSELS_KEY, JSON.stringify(vessels));
}

function loadActiveVesselIndex() {
  const n = Number(localStorage.getItem(ACTIVE_VESSEL_KEY));
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function saveActiveVesselIndex(i) {
  localStorage.setItem(ACTIVE_VESSEL_KEY, String(i));
}

function getGaugeCache() {
  try {
    return JSON.parse(localStorage.getItem(GAUGE_CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function setCachedStage(gaugeId, reading) {
  const cache = getGaugeCache();
  cache[gaugeId] = { ...reading, cachedAt: Date.now() };
  localStorage.setItem(GAUGE_CACHE_KEY, JSON.stringify(cache));
}

function getCachedStage(gaugeId) {
  return getGaugeCache()[gaugeId] || null;
}

function cacheBridges(bridges) {
  localStorage.setItem(BRIDGES_CACHE_KEY, JSON.stringify({ bridges, cachedAt: Date.now() }));
}

function getCachedBridges() {
  try {
    return JSON.parse(localStorage.getItem(BRIDGES_CACHE_KEY) || 'null');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Vessel management (no blocking prompt()/alert() — inline form + list)
// ---------------------------------------------------------------------------

function ensureDefaultVessel() {
  if (state.vessels.length === 0) {
    state.vessels.push({ name: 'My Vessel', airDraftFt: 15, marginFt: 2 });
    saveVessels(state.vessels);
  }
  if (state.activeVesselIndex >= state.vessels.length) state.activeVesselIndex = 0;
}

function activeVessel() {
  return state.vessels[state.activeVesselIndex] || { name: 'Vessel', airDraftFt: 15, marginFt: 2 };
}

function renderVesselList() {
  const wrap = $('vesselList');
  wrap.innerHTML = '';
  state.vessels.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'vessel-row' + (i === state.activeVesselIndex ? ' active' : '');

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'vessel-select';
    selectBtn.textContent = `${v.name} — ${v.airDraftFt}ft (+${v.marginFt ?? 2}ft margin)`;
    selectBtn.onclick = () => {
      state.activeVesselIndex = i;
      saveActiveVesselIndex(i);
      renderVesselList();
      render();
    };

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'vessel-delete';
    delBtn.textContent = '✕';
    delBtn.setAttribute('aria-label', `Delete vessel ${v.name}`);
    delBtn.onclick = () => {
      if (state.vessels.length <= 1) return; // always keep at least one
      state.vessels.splice(i, 1);
      saveVessels(state.vessels);
      if (state.activeVesselIndex >= state.vessels.length) state.activeVesselIndex = state.vessels.length - 1;
      saveActiveVesselIndex(state.activeVesselIndex);
      renderVesselList();
      render();
    };

    row.appendChild(selectBtn);
    row.appendChild(delBtn);
    wrap.appendChild(row);
  });
}

function addVesselFromForm() {
  const name = $('vesselName').value.trim() || 'My Vessel';
  const air = Number($('vesselAirDraft').value);
  const margin = Number($('vesselMargin').value);
  if (Number.isNaN(air) || air < 0) return showFormError('Enter a valid air draft (ft).');
  if (Number.isNaN(margin) || margin < 0) return showFormError('Enter a valid safety margin (ft).');
  state.vessels.push({ name, airDraftFt: air, marginFt: margin });
  saveVessels(state.vessels);
  state.activeVesselIndex = state.vessels.length - 1;
  saveActiveVesselIndex(state.activeVesselIndex);
  $('vesselName').value = '';
  showFormError('');
  renderVesselList();
  render();
}

function showFormError(msg) {
  const el = $('vesselFormError');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ---------------------------------------------------------------------------
// Live stage fetching — never fabricates a value.
// ---------------------------------------------------------------------------

async function fetchJSON(url) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    const r = await fetch(url, { cache: 'no-store', signal: controller.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn('fetchJSON failed', url, e);
    return null;
  }
}

// NWPS's exact JSON shape could not be confirmed against the live API from this
// environment (network access to api.water.noaa.gov was blocked while building
// this). These extractors try the field paths documented/observed for the NWPS
// v1 "stageflow" endpoint; if the live shape differs, add another extractor here
// rather than changing the caller — the caller just wants {value, time} or null.
const NWPS_STAGE_EXTRACTORS = [
  (j) => j?.observed?.primary != null ? { value: Number(j.observed.primary), time: j.observed.validTime } : null,
  (j) => j?.observed?.stage != null ? { value: Number(j.observed.stage), time: j.observed.validTime } : null,
  (j) => j?.observed?.value != null ? { value: Number(j.observed.value), time: j.observed.validTime } : null,
  (j) => Array.isArray(j?.observations) && j.observations.length
    ? { value: Number(j.observations[j.observations.length - 1].value), time: j.observations[j.observations.length - 1].validTime }
    : null,
  (j) => Array.isArray(j?.data) && j.data.length
    ? { value: Number(j.data[j.data.length - 1].value), time: j.data[j.data.length - 1].validTime }
    : null,
];

async function getStageNWPS(gaugeId) {
  const url = `https://api.water.noaa.gov/nwps/v1/gauges/${encodeURIComponent(gaugeId)}/stageflow`;
  const json = await fetchJSON(url);
  if (!json) return null;
  for (const extract of NWPS_STAGE_EXTRACTORS) {
    try {
      const r = extract(json);
      if (r && !Number.isNaN(r.value)) {
        return { stageFt: r.value, source: 'NWPS', timestamp: r.time || null };
      }
    } catch { /* try next extractor */ }
  }
  return null;
}

// USGS Instantaneous Values API (gage height, parameter 00065) — stable, documented shape.
async function getStageUSGS(site) {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${encodeURIComponent(site)}&parameterCd=00065`;
  const json = await fetchJSON(url);
  try {
    const ts = json.value.timeSeries[0];
    const points = ts.values[0].value;
    if (!points.length) return null;
    const last = points[points.length - 1];
    const stageFt = Number(last.value);
    if (Number.isNaN(stageFt)) return null;
    return { stageFt, source: 'USGS', timestamp: last.dateTime };
  } catch {
    return null;
  }
}

// Returns { stageFt, source, timestamp, stale } or null (no data, live or cached).
async function getStageForBridge(b) {
  const cacheKey = b.controlling_gauge_id || b.usgs_site_no || b.id;

  let live = null;
  if (b.gauge_source === 'NWPS' && b.controlling_gauge_id) {
    live = await getStageNWPS(b.controlling_gauge_id);
    if (!live && b.usgs_site_no) live = await getStageUSGS(b.usgs_site_no);
  } else if (b.gauge_source === 'USGS' && b.usgs_site_no) {
    live = await getStageUSGS(b.usgs_site_no);
    if (!live && b.controlling_gauge_id) live = await getStageNWPS(b.controlling_gauge_id);
  }

  if (live) {
    setCachedStage(cacheKey, live);
    return { ...live, stale: false };
  }

  const cached = getCachedStage(cacheKey);
  if (cached) return { ...cached, stale: true };

  return null; // genuinely no data — caller must show "Stage unavailable"
}

// ---------------------------------------------------------------------------
// Clearance math + status
// ---------------------------------------------------------------------------

function computeClearance(b, stageFt) {
  const ref = Number(b.reference_clearance_ft);
  let clearance = ref - stageFt;
  if (b.adjustment_ft) clearance += Number(b.adjustment_ft);
  return clearance;
}

function statusFor(b, clearance, airDraft, marginFt) {
  if (b.type === 'movable') return { label: 'Movable — hail bridge', cls: 'movable' };
  if (b.reference_clearance_ft == null) return { label: 'Needs data', cls: 'needsdata' };
  if (clearance == null) return { label: 'Stage unavailable', cls: 'unknown' };
  if (clearance >= airDraft + marginFt) return { label: 'OK', cls: 'ok' };
  if (clearance >= airDraft) return { label: 'Marginal', cls: 'marginal' };
  return { label: 'Blocked', cls: 'blocked' };
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function initMap() {
  // Leaflet loads from a CDN — if that fails (offline, blocked, ad blocker),
  // the map is just unavailable. It's a nice-to-have; the table/cards are the
  // core feature and must keep working regardless.
  if (typeof L === 'undefined') {
    console.warn('Leaflet failed to load; map disabled.');
    $('toggleMap').setAttribute('disabled', '');
    $('toggleMap').textContent = 'Map unavailable';
    return;
  }
  try {
    state.map = L.map('map').setView([41.5, -90.8], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
    }).addTo(state.map);
  } catch (e) {
    console.warn('Map init failed', e);
    state.map = null;
  }
}

function clearMarkers() {
  state.markers.forEach((m) => m.remove());
  state.markers = [];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function fmt(n, digits = 1) {
  return typeof n === 'number' && !Number.isNaN(n) ? n.toFixed(digits) : '—';
}

function stageLabel(stage) {
  if (!stage) return '—';
  const val = `${fmt(stage.stageFt, 2)} ft`;
  return stage.stale ? `${val} (stale)` : val;
}

function sourceLabel(b, stage) {
  const src = stage ? stage.source : '—';
  const id = b.controlling_gauge_id || b.usgs_site_no || '';
  return id ? `${src}/${id}` : src;
}

async function computeRows(bridges, vessel) {
  const rows = [];
  for (const b of bridges) {
    const stage = await getStageForBridge(b);
    const clearance = (stage && b.reference_clearance_ft != null) ? computeClearance(b, stage.stageFt) : null;
    const st = statusFor(b, clearance, vessel.airDraftFt, vessel.marginFt ?? 2);
    rows.push({ bridge: b, stage, clearance, status: st });
  }
  return rows;
}

function renderAlertBanner(rows) {
  const banner = $('alertBanner');
  const blocked = rows.filter((r) => r.status.cls === 'blocked');
  if (blocked.length === 0) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  const worst = blocked.reduce((a, b) => (a.clearance < b.clearance ? a : b));
  banner.hidden = false;
  banner.textContent = `⚠ ${blocked.length} bridge${blocked.length > 1 ? 's' : ''} below your air draft — worst: ${worst.bridge.name} (${fmt(worst.clearance)} ft clearance)`;
}

function renderCards(rows) {
  const wrap = $('bridgeCards');
  wrap.innerHTML = '';
  for (const r of rows) {
    const { bridge: b, stage, clearance, status } = r;
    const card = document.createElement('div');
    card.className = `bridge-card status-${status.cls}`;
    card.innerHTML = `
      <div class="card-top">
        <strong>${b.name}</strong>
        <span class="status ${status.cls}">${status.label}</span>
      </div>
      <div class="card-mile">${b.river} · Mile ${fmt(b.river_mile, 1)} · ${b.type}</div>
      <div class="card-clearance">${clearance != null ? `${fmt(clearance)} ft` : '—'}</div>
      <div class="card-detail">
        Ref ${b.reference_clearance_ft != null ? fmt(b.reference_clearance_ft) + ' ft' : '—'} · Stage ${stageLabel(stage)} · ${sourceLabel(b, stage)}
      </div>
      ${b.notes ? `<div class="card-note">${b.notes}</div>` : ''}
    `;
    wrap.appendChild(card);
  }
}

function renderTable(rows) {
  const tbody = document.querySelector('#bridgesTable tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const { bridge: b, stage, clearance, status } = r;
    const tr = document.createElement('tr');
    const cells = [
      `<strong>${b.name}</strong>`,
      b.river,
      fmt(b.river_mile, 1),
      b.type,
      b.reference_clearance_ft != null ? fmt(b.reference_clearance_ft) : '—',
      stageLabel(stage),
      clearance != null ? fmt(clearance) : '—',
      `<span class="status ${status.cls}">${status.label}</span>`,
      sourceLabel(b, stage),
    ];
    cells.forEach((c) => {
      const td = document.createElement('td');
      td.innerHTML = c;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
}

function renderMarkers(rows) {
  clearMarkers();
  if (!state.map) return;
  for (const r of rows) {
    const { bridge: b, stage, clearance, status } = r;
    if (b.lat == null || b.lon == null) continue;
    const popup = `
      <strong>${b.name}</strong><br/>
      Mile ${fmt(b.river_mile, 1)} (${b.river})<br/>
      Ref: ${b.reference_clearance_ft != null ? fmt(b.reference_clearance_ft) + ' ft' : '—'}<br/>
      Stage: ${stageLabel(stage)}<br/>
      <em>Clearance now:</em> ${clearance != null ? fmt(clearance) + ' ft' : '—'} — <span class="status ${status.cls}">${status.label}</span>
    `;
    const marker = L.marker([b.lat, b.lon]).addTo(state.map).bindPopup(popup);
    state.markers.push(marker);
  }
}

function applyFilters(bridges) {
  const river = $('riverSelect').value;
  let list = bridges.filter((b) => river === 'All' || b.river === river);
  list = [...list].sort((a, b) => (a.river_mile ?? 0) - (b.river_mile ?? 0));
  return list;
}

async function render() {
  const vessel = activeVessel();
  const bridges = applyFilters(state.bridges);

  let rows = await computeRows(bridges, vessel);
  state.lastRenderRows = rows;

  if ($('onlyConcerning').checked) {
    rows = rows.filter((r) => r.status.cls === 'blocked' || r.status.cls === 'marginal');
  }

  renderAlertBanner(state.lastRenderRows);
  renderCards(rows);
  renderTable(rows);
  renderMarkers(rows);

  $('lastUpdated').textContent = `Last updated ${new Date().toLocaleTimeString()}`;
}

// ---------------------------------------------------------------------------
// Bridges data load (with offline cache fallback)
// ---------------------------------------------------------------------------

async function loadBridges() {
  const banner = $('offlineBanner');
  const json = await fetchJSON(`./data/bridges.json?v=${DATA_VERSION}`);
  if (Array.isArray(json)) {
    cacheBridges(json);
    banner.hidden = true;
    return json;
  }
  const cached = getCachedBridges();
  if (cached && Array.isArray(cached.bridges)) {
    banner.hidden = false;
    banner.textContent = `Offline — showing cached bridge list from ${new Date(cached.cachedAt).toLocaleString()}`;
    return cached.bridges;
  }
  banner.hidden = false;
  banner.textContent = 'Could not load bridge data and no cached copy is available.';
  return [];
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function wireControls() {
  $('riverSelect').onchange = render;
  $('refresh').onclick = render;
  $('onlyConcerning').onchange = render;
  $('addVessel').onclick = addVesselFromForm;
  $('toggleControls').onclick = () => {
    const controls = $('controlsBody');
    const btn = $('toggleControls');
    const collapsed = controls.hasAttribute('hidden');
    if (collapsed) controls.removeAttribute('hidden'); else controls.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', String(collapsed));
    btn.textContent = collapsed ? 'Vessel & filters ▾' : 'Vessel & filters ▸';
  };
  $('toggleMap').onclick = () => {
    const mapSection = $('map');
    const btn = $('toggleMap');
    const collapsed = mapSection.hasAttribute('hidden');
    if (collapsed) {
      mapSection.removeAttribute('hidden');
      setTimeout(() => state.map && state.map.invalidateSize(), 0);
    } else {
      mapSection.setAttribute('hidden', '');
    }
    btn.setAttribute('aria-expanded', String(collapsed));
    btn.textContent = collapsed ? 'Map ▾' : 'Map ▸';
  };
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}

async function init() {
  initMap();

  state.vessels = loadVessels();
  state.activeVesselIndex = loadActiveVesselIndex();
  ensureDefaultVessel();
  renderVesselList();

  wireControls();
  registerServiceWorker();

  state.bridges = await loadBridges();
  await render();

  state.refreshTimer = setInterval(render, REFRESH_MS);

  window.addEventListener('online', render);

  // Crossing the mobile/desktop breakpoint can reveal the map without Leaflet
  // knowing its container resized; nudge it after any viewport resize.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => state.map && state.map.invalidateSize(), 200);
  });
}

document.addEventListener('DOMContentLoaded', init);
