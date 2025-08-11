// Minimal client-side app to load bridges, fetch stages, and compute clearance.
// This demo safely handles API failures and uses fallback demo stages.
const state = {
  bridges: [],
  markers: [],
  map: null
};

const el = (id) => document.getElementById(id);

function loadVessels() {
  const saved = JSON.parse(localStorage.getItem('vessels') || '[]');
  const sel = el('vesselProfiles');
  sel.innerHTML = '';
  if (saved.length === 0) {
    saved.push({ name: 'My Vessel', airDraftFt: Number(el('airDraft').value) || 15 });
    localStorage.setItem('vessels', JSON.stringify(saved));
  }
  saved.forEach((v,i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = `${v.name} (${v.airDraftFt} ft)`;
    sel.appendChild(opt);
  });
  // set input to selected
  sel.onchange = () => {
    const v = saved[Number(sel.value)];
    el('airDraft').value = v.airDraftFt;
    render();
  };
}

function saveVessel() {
  const name = prompt('Vessel name?','My Vessel');
  if (!name) return;
  const air = Number(el('airDraft').value);
  if (Number.isNaN(air) || air < 0) return alert('Enter a valid air draft (ft).');
  const saved = JSON.parse(localStorage.getItem('vessels') || '[]');
  saved.push({ name, airDraftFt: air });
  localStorage.setItem('vessels', JSON.stringify(saved));
  loadVessels();
}

async function fetchJSON(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn('fetchJSON failed', url, e);
    return null;
  }
}

// NOAA NWPS observation
async function getStageNWPS(gaugeId) {
  // Example: https://api.water.noaa.gov/nwps/v1/observations/{gaugeId}?parameter=stage
  // (New NWPS API; some sites/gauges may differ. This is a best-effort demo.)
  const url = `https://api.water.noaa.gov/nwps/v1/observations/${encodeURIComponent(gaugeId)}?parameter=stage`;
  const json = await fetchJSON(url);
  if (!json || !Array.isArray(json.observations) || json.observations.length === 0) return null;
  const last = json.observations[json.observations.length - 1];
  // value assumed in feet
  return { stageFt: Number(last.value), source: 'NWPS', timestamp: last.validTime || last.issueTime || null };
}

// USGS Instantaneous Values (gage height 00065)
async function getStageUSGS(site) {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${encodeURIComponent(site)}&parameterCd=00065`;
  const json = await fetchJSON(url);
  try {
    const ts = json.value.timeSeries[0];
    const points = ts.values[0].value;
    if (!points.length) return null;
    const last = points[points.length - 1];
    const stageFt = Number(last.value);
    return { stageFt, source: 'USGS', timestamp: last.dateTime };
  } catch {
    return null;
  }
}

async function getStageForBridge(b) {
  // Try declared source first, then the other, then demo fallback.
  if (b.gauge_source === 'NWPS' && b.controlling_gauge_id) {
    const r = await getStageNWPS(b.controlling_gauge_id);
    if (r) return r;
    if (b.usgs_site_no) {
      const r2 = await getStageUSGS(b.usgs_site_no);
      if (r2) return r2;
    }
  } else if (b.gauge_source === 'USGS' && b.usgs_site_no) {
    const r = await getStageUSGS(b.usgs_site_no);
    if (r) return r;
    if (b.controlling_gauge_id) {
      const r2 = await getStageNWPS(b.controlling_gauge_id);
      if (r2) return r2;
    }
  }
  // Demo fallback
  return { stageFt: 10, source: 'DEMO', timestamp: null };
}

function computeClearance(b, stageFt) {
  // Default USACE rule: actual = reference - stage
  const ref = Number(b.reference_clearance_ft);
  let clearance = ref - stageFt;
  if (b.adjustment_ft) clearance += Number(b.adjustment_ft);
  return clearance;
}

function statusFor(clearance, airDraft) {
  if (clearance >= airDraft + 1) return { label: 'OK', cls: 'ok' };
  if (clearance >= airDraft) return { label: 'Marginal', cls: 'marginal' };
  return { label: 'Blocked', cls: 'blocked' };
}

function initMap() {
  state.map = L.map('map').setView([38.6, -90.2], 6);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(state.map);
}

function clearMarkers() {
  state.markers.forEach(m => m.remove());
  state.markers = [];
}

async function render() {
  const river = el('riverSelect').value;
  const air = Number(el('airDraft').value) || 0;

  const tbody = document.querySelector('#bridgesTable tbody');
  tbody.innerHTML = '';
  clearMarkers();

  const bridges = state.bridges.filter(b => river === 'All' || b.river === river);

  for (const b of bridges) {
    const stage = await getStageForBridge(b);
    const clearance = computeClearance(b, stage.stageFt);
    const st = statusFor(clearance, air);

    // Table row
    const tr = document.createElement('tr');
    const cells = [
      b.name,
      b.river,
      b.river_mile?.toFixed?.(1) ?? '',
      b.type,
      (b.reference_clearance_ft ?? '').toFixed ? b.reference_clearance_ft.toFixed(1) : b.reference_clearance_ft,
      stage.stageFt?.toFixed?.(2) ?? '—',
      clearance?.toFixed?.(2) ?? '—',
      `<span class="status ${st.cls}">${st.label}</span>`,
      `${stage.source}${b.usgs_site_no ? `/${b.usgs_site_no}` : (b.controlling_gauge_id ? `/${b.controlling_gauge_id}` : '')}`
    ];
    cells.forEach((c,i) => {
      const td = document.createElement('td');
      td.innerHTML = (i===0) ? `<strong>${c}</strong>` : c;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);

    // Map marker
    if (b.lat && b.lon && state.map) {
      const popup = `
        <strong>${b.name}</strong><br/>
        Mile ${b.river_mile ?? ''} (${b.river})<br/>
        Ref: ${b.reference_clearance_ft} ft<br/>
        Stage: ${stage.stageFt?.toFixed?.(2) ?? '—'} ft (${stage.source})<br/>
        <em>Clearance now:</em> ${clearance?.toFixed?.(2) ?? '—'} ft — <span class="status ${st.cls}">${st.label}</span>
      `;
      const marker = L.marker([b.lat, b.lon]).addTo(state.map).bindPopup(popup);
      state.markers.push(marker);
    }
  }
}

async function init() {
  initMap();
  loadVessels();
  el('saveVessel').onclick = saveVessel;
  el('refresh').onclick = render;
  el('riverSelect').onchange = render;

  const bridges = await fetchJSON('./data/bridges.json');
  state.bridges = Array.isArray(bridges) ? bridges : [];
  render();
}

document.addEventListener('DOMContentLoaded', init);
