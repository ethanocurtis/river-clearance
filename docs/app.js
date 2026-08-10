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
const DATA_VERSION = '20260811d';

const REFRESH_MS = 5 * 60 * 1000; // auto-refresh every 5 minutes
const GAUGE_CACHE_KEY = 'gaugeCache';
const GAUGE_HISTORY_KEY = 'gaugeHistory';
const BRIDGES_CACHE_KEY = 'bridgesCache';
const GAUGES_LIST_CACHE_KEY = 'gaugesListCache';
const VESSELS_KEY = 'vessels';
const ACTIVE_VESSEL_KEY = 'activeVesselIndex';
const ROUTES_KEY = 'routes';
const ACTIVE_ROUTE_KEY = 'activeRouteId';

// Stage trend (rising/falling): compare the current reading to the oldest
// history sample that's at least TREND_MIN_AGE_MS old but not older than
// TREND_MAX_AGE_MS -- old enough that river stage has had time to actually
// move, not so old the comparison is meaningless. Differences smaller than
// TREND_THRESHOLD_FT are just noise/rounding, shown as steady.
const TREND_MIN_AGE_MS = 30 * 60 * 1000;
const TREND_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const TREND_THRESHOLD_FT = 0.1;

// Relative path: assumes this same server serves both the site and the API
// (see /server, STATIC_DIR) — same-origin, cookies just work. If the
// frontend ever runs somewhere separate from the API, change this to an
// absolute URL instead, e.g. 'https://your-api-domain.example/api'.
const API_BASE = '/api';

const state = {
  bridges: [],
  gauges: [],
  vessels: [],
  activeVesselIndex: 0,
  routes: [], // [{ id, name, bridgeIds: [...] }] -- see "Routes" section below
  activeRouteId: null, // null/'' = show all bridges
  user: null, // { id, email, role } once logged in, else null
  map: null,
  markers: [],
  gaugeMarkers: [],
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

function loadRoutes() {
  try {
    return JSON.parse(localStorage.getItem(ROUTES_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveRoutes(routes) {
  localStorage.setItem(ROUTES_KEY, JSON.stringify(routes));
}

function loadActiveRouteId() {
  return localStorage.getItem(ACTIVE_ROUTE_KEY) || null;
}

function saveActiveRouteId(id) {
  if (id) localStorage.setItem(ACTIVE_ROUTE_KEY, id);
  else localStorage.removeItem(ACTIVE_ROUTE_KEY);
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

// A short rolling history per gauge ID (a handful of {t, v} samples, each at
// least 5 minutes apart, pruned past TREND_MAX_AGE_MS) -- just enough to
// compare "now" against "a while ago" for the rising/falling trend badge.
// Unlike getGaugeCache/setCachedStage above (which only ever remember the
// single latest reading), this deliberately keeps more than one point.
function getGaugeHistory() {
  try {
    return JSON.parse(localStorage.getItem(GAUGE_HISTORY_KEY) || '{}');
  } catch {
    return {};
  }
}

function recordGaugeHistory(gaugeId, stageFt) {
  if (typeof stageFt !== 'number' || Number.isNaN(stageFt)) return;
  const hist = getGaugeHistory();
  const arr = hist[gaugeId] || [];
  const now = Date.now();
  if (arr.length && now - arr[arr.length - 1].t < 5 * 60 * 1000) return; // don't bloat on frequent refreshes
  arr.push({ t: now, v: stageFt });
  const cutoff = now - TREND_MAX_AGE_MS - 60 * 60 * 1000; // a little slack past the comparison window
  hist[gaugeId] = arr.filter((p) => p.t >= cutoff);
  localStorage.setItem(GAUGE_HISTORY_KEY, JSON.stringify(hist));
}

// Returns { dir: 'rising'|'falling'|'steady', diffFt, sinceMs } or null if
// there's no eligible history sample yet (e.g. first visit, or the site
// hasn't been open long enough to have a sample old enough to compare against).
function getTrend(gaugeId, currentStageFt) {
  if (typeof currentStageFt !== 'number' || Number.isNaN(currentStageFt)) return null;
  const arr = getGaugeHistory()[gaugeId];
  if (!arr || !arr.length) return null;
  const now = Date.now();
  const eligible = arr.filter((p) => now - p.t >= TREND_MIN_AGE_MS && now - p.t <= TREND_MAX_AGE_MS);
  if (!eligible.length) return null;
  const ref = eligible.reduce((a, b) => (a.t < b.t ? a : b)); // oldest eligible sample = most stable comparison
  const diffFt = currentStageFt - ref.v;
  const dir = Math.abs(diffFt) < TREND_THRESHOLD_FT ? 'steady' : diffFt > 0 ? 'rising' : 'falling';
  return { dir, diffFt, sinceMs: now - ref.t };
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

function cacheGaugesList(gauges) {
  localStorage.setItem(GAUGES_LIST_CACHE_KEY, JSON.stringify({ gauges, cachedAt: Date.now() }));
}

function getCachedGaugesList() {
  try {
    return JSON.parse(localStorage.getItem(GAUGES_LIST_CACHE_KEY) || 'null');
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
      syncVesselsToServer();
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
      syncVesselsToServer();
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
  syncVesselsToServer();
}

function showFormError(msg) {
  const el = $('vesselFormError');
  if (!el) return;
  el.textContent = msg || '';
  el.hidden = !msg;
}

// ---------------------------------------------------------------------------
// Account (real email/password, sessions via httpOnly cookie)
// ---------------------------------------------------------------------------

function showStatus(elId, msg, isError = false) {
  const el = $(elId);
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle('sync-status-error', isError);
}

// Thin fetch wrapper: always sends the session cookie, always expects JSON,
// throws a plain Error with the server's message on any non-2xx response so
// callers can just try/catch and show e.message.
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty/non-JSON body is fine for e.g. 204s */ }
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

function showAccountForm(which) {
  for (const id of ['loginForm', 'signupForm', 'forgotForm', 'resetForm']) $(id).hidden = id !== which;
  $('showLoginTab').classList.toggle('active', which === 'loginForm');
  $('showSignupTab').classList.toggle('active', which === 'signupForm');
  showStatus('accountStatus', '');
}

function openAccountModal() {
  $('accountModal').hidden = false;
}

function closeAccountModal() {
  $('accountModal').hidden = true;
}

// ---------------------------------------------------------------------------
// Welcome modal: NOT FOR NAVIGATION disclaimer + a nudge to log in so
// vessels/routes save across devices, shown once per browser. Skipped if a
// verify/reset link already opened the account modal on this same load, so
// two modals don't stack.
// ---------------------------------------------------------------------------

const WELCOME_SEEN_KEY = 'welcomeSeen';

function showWelcomeModalIfNeeded() {
  if (localStorage.getItem(WELCOME_SEEN_KEY)) return;
  $('welcomeLoginNote').hidden = Boolean(state.user);
  $('welcomeLoginBtn').hidden = Boolean(state.user);
  $('welcomeModal').hidden = false;
}

function dismissWelcomeModal() {
  localStorage.setItem(WELCOME_SEEN_KEY, '1');
  $('welcomeModal').hidden = true;
}

function wireWelcomeModal() {
  $('welcomeModalClose').onclick = dismissWelcomeModal;
  $('welcomeDismissBtn').onclick = dismissWelcomeModal;
  $('welcomeLoginBtn').onclick = () => {
    dismissWelcomeModal();
    openAccountModal();
  };
  $('welcomeModal').addEventListener('click', (e) => {
    if (e.target === $('welcomeModal')) dismissWelcomeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('welcomeModal').hidden) dismissWelcomeModal();
  });
}

function applyLoggedInUI(user) {
  state.user = user;
  $('accountLoggedOut').hidden = true;
  $('accountLoggedIn').hidden = false;
  $('accountEmail').textContent = user.email;
  $('accountAdminBadge').hidden = user.role !== 'admin';
  const trigger = $('accountTrigger');
  trigger.textContent = user.email;
  trigger.classList.add('logged-in');
  if (user.role === 'admin') initAdminPanel();
}

function applyLoggedOutUI() {
  state.user = null;
  $('accountLoggedOut').hidden = false;
  $('accountLoggedIn').hidden = true;
  $('adminSection').hidden = true;
  const trigger = $('accountTrigger');
  trigger.textContent = 'Log in';
  trigger.classList.remove('logged-in');
}

async function checkAuthStatus() {
  try {
    const body = await apiFetch('/auth/me');
    applyLoggedInUI(body.user);
    await loadVesselsFromServer();
    await loadRoutesFromServer();
  } catch {
    applyLoggedOutUI(); // 401 (not logged in) is the expected/common case here, not an error to surface
  }
}

async function doSignup() {
  const email = $('signupEmail').value.trim();
  const password = $('signupPassword').value;
  showStatus('accountStatus', 'Creating account…');
  try {
    const body = await apiFetch('/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) });
    showStatus('accountStatus', body.message);
  } catch (e) {
    showStatus('accountStatus', e.message, true);
  }
}

async function doLogin() {
  const email = $('loginEmail').value.trim();
  const password = $('loginPassword').value;
  showStatus('accountStatus', 'Logging in…');
  try {
    const body = await apiFetch('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    applyLoggedInUI(body.user);
    await loadVesselsFromServer();
    closeAccountModal();
  } catch (e) {
    showStatus('accountStatus', e.message, true);
  }
}

async function doLogout() {
  try { await apiFetch('/auth/logout', { method: 'POST' }); } catch { /* logging out anyway */ }
  applyLoggedOutUI();
  showAccountForm('loginForm');
  closeAccountModal();
}

async function doResendVerification() {
  const email = $('loginEmail').value.trim();
  if (!email) return showStatus('accountStatus', 'Enter your email above first, then click resend.', true);
  showStatus('accountStatus', 'Sending…');
  try {
    const body = await apiFetch('/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
    showStatus('accountStatus', body.message);
  } catch (e) {
    showStatus('accountStatus', e.message, true);
  }
}

async function doForgotPassword() {
  const email = $('forgotEmail').value.trim();
  showStatus('accountStatus', 'Sending…');
  try {
    const body = await apiFetch('/auth/request-password-reset', { method: 'POST', body: JSON.stringify({ email }) });
    showStatus('accountStatus', body.message);
  } catch (e) {
    showStatus('accountStatus', e.message, true);
  }
}

async function doResetPassword(token) {
  const newPassword = $('resetPassword').value;
  showStatus('accountStatus', 'Updating…');
  try {
    const body = await apiFetch('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword }) });
    showStatus('accountStatus', body.message);
    showAccountForm('loginForm');
  } catch (e) {
    showStatus('accountStatus', e.message, true);
  }
}

function wireAccountPanel() {
  $('accountTrigger').onclick = () => openAccountModal();
  $('accountModalClose').onclick = () => closeAccountModal();
  $('accountModal').addEventListener('click', (e) => {
    if (e.target === $('accountModal')) closeAccountModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('accountModal').hidden) closeAccountModal();
  });
  $('showLoginTab').onclick = () => showAccountForm('loginForm');
  $('showSignupTab').onclick = () => showAccountForm('signupForm');
  $('showForgotPassword').onclick = () => showAccountForm('forgotForm');
  $('backToLogin').onclick = () => showAccountForm('loginForm');
  $('signupSubmit').onclick = doSignup;
  $('loginSubmit').onclick = doLogin;
  $('forgotSubmit').onclick = doForgotPassword;
  $('resendVerification').onclick = doResendVerification;
  $('logoutBtn').onclick = doLogout;
}

// Handles the query-param states an emailed link can land you on
// (?verified=1, ?verify_error=1, ?reset_token=...), then cleans the URL so
// refreshing doesn't re-trigger the same message.
function handleAuthRedirectParams() {
  const params = new URLSearchParams(location.search);
  if (params.has('verified')) {
    openAccountModal();
    showAccountForm('loginForm');
    showStatus('accountStatus', "Email verified — you're logged in.");
  } else if (params.has('verify_error')) {
    openAccountModal();
    showAccountForm('loginForm');
    showStatus('accountStatus', 'That verification link is invalid or expired.', true);
  } else if (params.has('reset_token')) {
    const token = params.get('reset_token');
    openAccountModal();
    showAccountForm('resetForm');
    $('resetSubmit').onclick = () => doResetPassword(token);
  } else {
    return false;
  }
  history.replaceState({}, '', location.pathname);
  return true; // caller can skip opening any other modal (e.g. the welcome one) on top of this
}

// ---------------------------------------------------------------------------
// Vessel sync (automatic, tied to the logged-in account — no manual buttons)
// ---------------------------------------------------------------------------

async function loadVesselsFromServer() {
  try {
    const body = await apiFetch('/vessels');
    const vessels = body?.data?.vessels;
    if (Array.isArray(vessels) && vessels.length) {
      state.vessels = vessels;
      state.activeVesselIndex = Number.isInteger(body.data.activeVesselIndex) ? body.data.activeVesselIndex : 0;
      if (state.activeVesselIndex >= state.vessels.length) state.activeVesselIndex = 0;
      saveVessels(state.vessels);
      saveActiveVesselIndex(state.activeVesselIndex);
    } else {
      // Nothing saved server-side yet for this account -- push what's local
      // (e.g. the default vessel) up as a starting point.
      await syncVesselsToServer();
    }
    renderVesselList();
    await render();
  } catch (e) {
    console.warn('Could not load vessels from account', e);
  }
}

async function syncVesselsToServer() {
  if (!state.user) return;
  try {
    await apiFetch('/vessels', {
      method: 'PUT',
      body: JSON.stringify({ vessels: state.vessels, activeVesselIndex: state.activeVesselIndex }),
    });
  } catch (e) {
    console.warn('Could not sync vessels to account', e);
  }
}

// ---------------------------------------------------------------------------
// Route sync (same pattern as vessels above -- local by default, synced to
// the account when logged in)
// ---------------------------------------------------------------------------

async function loadRoutesFromServer() {
  try {
    const body = await apiFetch('/routes');
    const routes = body?.data?.routes;
    if (Array.isArray(routes) && routes.length) {
      state.routes = routes;
      state.activeRouteId = body.data.activeRouteId ?? null;
      saveRoutes(state.routes);
      saveActiveRouteId(state.activeRouteId);
    } else if (state.routes.length) {
      // Nothing saved server-side yet -- push what's local up as a starting point.
      await syncRoutesToServer();
    }
    renderRouteSelect();
    await render();
  } catch (e) {
    console.warn('Could not load routes from account', e);
  }
}

async function syncRoutesToServer() {
  if (!state.user) return;
  try {
    await apiFetch('/routes', {
      method: 'PUT',
      body: JSON.stringify({ routes: state.routes, activeRouteId: state.activeRouteId }),
    });
  } catch (e) {
    console.warn('Could not sync routes to account', e);
  }
}

// ---------------------------------------------------------------------------
// Routes UI: pick a saved subset/order of bridges as "my trip" instead of
// always seeing the whole river. Routes are just a name + a list of bridge
// IDs -- nothing river-specific baked in, so this keeps working as-is
// whenever more river segments get added later.
// ---------------------------------------------------------------------------

let editingRouteId = null; // null while the create/edit form is closed or creating new

function renderRouteSelect() {
  const sel = $('routeSelect');
  sel.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'All bridges';
  sel.appendChild(allOpt);
  for (const r of state.routes) {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${r.name} (${r.bridgeIds.length})`;
    sel.appendChild(opt);
  }
  const validValue = state.routes.some((r) => r.id === state.activeRouteId) ? state.activeRouteId : '';
  sel.value = validValue;
  state.activeRouteId = validValue || null;
}

function openRoutesModal() {
  renderRoutesList();
  hideRouteForm();
  $('routesModal').hidden = false;
}

function closeRoutesModal() {
  $('routesModal').hidden = true;
}

function renderRoutesList() {
  const wrap = $('routesList');
  wrap.innerHTML = '';
  if (!state.routes.length) {
    const p = document.createElement('p');
    p.className = 'sync-note';
    p.textContent = 'No saved routes yet -- add one below.';
    wrap.appendChild(p);
    return;
  }
  for (const r of state.routes) {
    const row = document.createElement('div');
    row.className = 'vessel-row'; // same look as the vessel list, no need for a separate style

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'vessel-select';
    selectBtn.textContent = `${r.name} — ${r.bridgeIds.length} bridge${r.bridgeIds.length === 1 ? '' : 's'}`;
    selectBtn.onclick = () => openRouteForm(r.id);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'vessel-delete';
    delBtn.textContent = '✕';
    delBtn.setAttribute('aria-label', `Delete route ${r.name}`);
    delBtn.onclick = () => deleteRoute(r.id);

    row.appendChild(selectBtn);
    row.appendChild(delBtn);
    wrap.appendChild(row);
  }
}

function openRouteForm(routeId) {
  editingRouteId = routeId || null;
  const route = routeId ? state.routes.find((r) => r.id === routeId) : null;
  $('routeName').value = route ? route.name : '';
  renderRouteChecklist(route ? new Set(route.bridgeIds) : new Set());
  $('routeFormError').hidden = true;
  $('routeForm').hidden = false;
}

function hideRouteForm() {
  editingRouteId = null;
  $('routeForm').hidden = true;
}

function renderRouteChecklist(selectedIds) {
  const wrap = $('routeBridgeChecklist');
  wrap.innerHTML = '';
  const sorted = [...state.bridges].sort((a, b) => (a.river_mile ?? 0) - (b.river_mile ?? 0));
  for (const b of sorted) {
    const label = document.createElement('label');
    label.className = 'route-checklist-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = b.id;
    cb.checked = selectedIds.has(b.id);
    label.appendChild(cb);
    label.append(` ${b.name} — Mile ${fmt(b.river_mile, 1)}`);
    wrap.appendChild(label);
  }
}

function saveRouteFromForm() {
  const name = $('routeName').value.trim();
  if (!name) return showRouteFormError('Enter a route name.');
  const bridgeIds = Array.from($('routeBridgeChecklist').querySelectorAll('input:checked')).map((cb) => cb.value);
  if (!bridgeIds.length) return showRouteFormError('Select at least one bridge.');

  if (editingRouteId) {
    const route = state.routes.find((r) => r.id === editingRouteId);
    route.name = name;
    route.bridgeIds = bridgeIds;
  } else {
    const id = `route-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    state.routes.push({ id, name, bridgeIds });
  }
  saveRoutes(state.routes);
  syncRoutesToServer();
  renderRouteSelect();
  renderRoutesList();
  hideRouteForm();
  render();
}

function deleteRoute(routeId) {
  state.routes = state.routes.filter((r) => r.id !== routeId);
  if (state.activeRouteId === routeId) {
    state.activeRouteId = null;
    saveActiveRouteId(null);
  }
  saveRoutes(state.routes);
  syncRoutesToServer();
  renderRouteSelect();
  renderRoutesList();
  render();
}

function showRouteFormError(msg) {
  const el = $('routeFormError');
  el.textContent = msg;
  el.hidden = false;
}

function wireRoutesPanel() {
  $('manageRoutesBtn').onclick = openRoutesModal;
  $('routesModalClose').onclick = closeRoutesModal;
  $('routesModal').addEventListener('click', (e) => {
    if (e.target === $('routesModal')) closeRoutesModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('routesModal').hidden) closeRoutesModal();
  });
  $('newRouteBtn').onclick = () => openRouteForm(null);
  $('routeSaveBtn').onclick = saveRouteFromForm;
  $('routeCancelBtn').onclick = hideRouteForm;
  $('routeSelect').onchange = () => {
    state.activeRouteId = $('routeSelect').value || null;
    saveActiveRouteId(state.activeRouteId);
    render();
  };
}

// ---------------------------------------------------------------------------
// Admin: edit bridges.json / gauges.json from the browser (no SSH/git needed)
// ---------------------------------------------------------------------------

function initAdminPanel() {
  $('adminSection').hidden = false;
}

async function adminLoadData(kind, textareaId, statusId) {
  showStatus(statusId, 'Loading…');
  try {
    const res = await fetch(`${API_BASE}/admin/data/${kind}`, { credentials: 'include' });
    const text = await res.text();
    if (!res.ok) {
      const body = JSON.parse(text || '{}');
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    $(textareaId).value = text;
    showStatus(statusId, 'Loaded current data.');
  } catch (e) {
    showStatus(statusId, `Couldn't load: ${e.message}`, true);
  }
}

async function adminSaveData(kind, textareaId, statusId) {
  let parsed;
  try {
    parsed = JSON.parse($(textareaId).value);
  } catch (e) {
    showStatus(statusId, `Not valid JSON: ${e.message}`, true);
    return;
  }
  showStatus(statusId, 'Saving…');
  try {
    const body = await apiFetch(`/admin/data/${kind}`, { method: 'PUT', body: JSON.stringify(parsed) });
    showStatus(statusId, `Saved ${body.count} entries — live on the site now.${gitSyncSuffix(body.git)}`, body.git?.error != null);
    // Reflect the change immediately without a full reload.
    if (kind === 'bridges') state.bridges = await loadBridges();
    else state.gauges = await loadGauges();
    await render();
  } catch (e) {
    showStatus(statusId, `Couldn't save: ${e.message}`, true);
  }
}

// Appends a short note about whether the save also reached GitHub, based on
// the `git` field the admin PUT endpoint returns (see gitSync.js).
function gitSyncSuffix(git) {
  if (!git || git.skipped) return ''; // auto-push not configured, or nothing changed -- nothing to say
  if (git.error) return ` Push to GitHub failed: ${git.error} — saved locally on the VM only; git pull/push manually to sync.`;
  if (git.pushed) return ' Pushed to GitHub.';
  return '';
}

function wireAdminPanel() {
  $('toggleAdmin').onclick = () => {
    const body = $('adminBody');
    const btn = $('toggleAdmin');
    const collapsed = body.hasAttribute('hidden');
    if (collapsed) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', String(collapsed));
    btn.textContent = collapsed ? 'Admin: Edit Site Data ▾' : 'Admin: Edit Site Data ▸';
  };
  $('adminLoadBridges').onclick = () => adminLoadData('bridges', 'adminBridgesText', 'adminBridgesStatus');
  $('adminSaveBridges').onclick = () => adminSaveData('bridges', 'adminBridgesText', 'adminBridgesStatus');
  $('adminLoadGauges').onclick = () => adminLoadData('gauges', 'adminGaugesText', 'adminGaugesStatus');
  $('adminSaveGauges').onclick = () => adminSaveData('gauges', 'adminGaugesText', 'adminGaugesStatus');
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

// NWPS v1 "stageflow" real response shape, confirmed 2026-08-09 from a live
// sample (`observed.data` is an array of points; each point has `primary`
// in `observed.primaryUnits` — "ft" for a stage gauge — and a `validTime`):
//   { "observed": { "primaryUnits": "ft", "data": [ { "validTime": "...", "primary": 16.92, ... }, ... ] } }
// The confirmed shape is tried first; the rest are cheap fallbacks in case a
// different gauge/endpoint variant ever responds with a flatter shape.
const NWPS_STAGE_EXTRACTORS = [
  (j) => Array.isArray(j?.observed?.data) && j.observed.data.length
    ? { value: Number(j.observed.data[j.observed.data.length - 1].primary), time: j.observed.data[j.observed.data.length - 1].validTime }
    : null,
  (j) => j?.observed?.primary != null ? { value: Number(j.observed.primary), time: j.observed.validTime } : null,
  (j) => Array.isArray(j?.data) && j.data.length
    ? { value: Number(j.data[j.data.length - 1].value ?? j.data[j.data.length - 1].primary), time: j.data[j.data.length - 1].validTime }
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

// Several bridges and standalone route gauges can point at the same NWPS
// gauge ID (e.g. Dubuque, Rock Island, La Crosse, St. Louis all show up both
// as a bridge's controlling gauge AND as their own row in the gauges list).
// This memoizes in-flight/completed NWPS fetches for the duration of one
// render() so the same gauge isn't hit twice over the network. Reset at the
// top of render().
let nwpsFetchMemo = new Map();
function memoGetStageNWPS(gaugeId) {
  if (!nwpsFetchMemo.has(gaugeId)) nwpsFetchMemo.set(gaugeId, getStageNWPS(gaugeId));
  return nwpsFetchMemo.get(gaugeId);
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

// Returns { stageFt, source, timestamp, gaugeId, stale } or null (no data,
// live or cached). `gaugeId` is whichever ID actually produced the reading
// (which can be the USGS fallback even when the bridge's primary source is
// NWPS) — the caller displays this, not just the bridge's preferred gauge,
// so the "Gauge" column always says where the number really came from.
async function getStageForBridge(b) {
  const cacheKey = b.controlling_gauge_id || b.usgs_site_no || b.id;

  let live = null;
  if (b.gauge_source === 'NWPS' && b.controlling_gauge_id) {
    live = await memoGetStageNWPS(b.controlling_gauge_id);
    if (live) live = { ...live, gaugeId: b.controlling_gauge_id };
    else if (b.usgs_site_no) {
      live = await getStageUSGS(b.usgs_site_no);
      if (live) live = { ...live, gaugeId: b.usgs_site_no };
    }
  } else if (b.gauge_source === 'USGS' && b.usgs_site_no) {
    live = await getStageUSGS(b.usgs_site_no);
    if (live) live = { ...live, gaugeId: b.usgs_site_no };
    else if (b.controlling_gauge_id) {
      live = await memoGetStageNWPS(b.controlling_gauge_id);
      if (live) live = { ...live, gaugeId: b.controlling_gauge_id };
    }
  }

  if (live) {
    setCachedStage(cacheKey, live);
    recordGaugeHistory(cacheKey, live.stageFt);
    return { ...live, stale: false };
  }

  const cached = getCachedStage(cacheKey);
  if (cached) return { ...cached, stale: true };

  return null; // genuinely no data — caller must show "Stage unavailable"
}

// Same never-fabricate/stale-cache contract as getStageForBridge, for a
// standalone route gauge (docs/data/gauges.json) that isn't tied to a
// specific bridge. Falls back to a USGS site if the gauge has one and NWPS
// doesn't return data.
async function getStageForGauge(g) {
  let live = await memoGetStageNWPS(g.id);
  if (live) live = { ...live, gaugeId: g.id };
  else if (g.usgs_site_no) {
    live = await getStageUSGS(g.usgs_site_no);
    if (live) live = { ...live, gaugeId: g.usgs_site_no };
  }

  if (live) {
    setCachedStage(g.id, live);
    recordGaugeHistory(g.id, live.stageFt);
    return { ...live, stale: false };
  }
  const cached = getCachedStage(g.id);
  if (cached) return { ...cached, stale: true };
  return null;
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

function clearGaugeMarkers() {
  state.gaugeMarkers.forEach((m) => m.remove());
  state.gaugeMarkers = [];
}

// Matches the card/table status colors in style.css so the map reads the
// same way as the list.
const STATUS_MARKER_COLOR = {
  ok: '#7be594',
  marginal: '#f3dc7b',
  blocked: '#f59b9b',
  unknown: '#b8c7e6',
  movable: '#7db8f5',
  needsdata: '#c8a8f5',
};
const GAUGE_MARKER_COLOR = '#4f8ff0';

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

// A small ▲/▼/▬ badge next to a stage reading based on getTrend() -- '' if
// there's no eligible history sample yet, so a first-time visitor just sees
// nothing extra rather than a placeholder.
function trendBadge(stage) {
  if (!stage) return '';
  const trend = getTrend(stage.gaugeId, stage.stageFt);
  if (!trend) return '';
  const arrow = trend.dir === 'rising' ? '▲' : trend.dir === 'falling' ? '▼' : '▬';
  const hours = trend.sinceMs / 3600000;
  const since = hours < 1 ? `${Math.round(trend.sinceMs / 60000)}m` : `${hours.toFixed(1)}h`;
  const title = `${fmt(Math.abs(trend.diffFt), 2)} ft ${trend.dir} over ~${since}`;
  return ` <span class="trend trend-${trend.dir}" title="${title}">${arrow}</span>`;
}

function sourceLabel(b, stage) {
  const src = stage ? stage.source : '—';
  // stage.gaugeId is whichever ID actually produced the reading (may be the
  // USGS fallback even for an NWPS-primary bridge) — prefer that over just
  // guessing the bridge's preferred gauge, which would mislabel a fallback
  // reading as if it came from the gauge that actually failed.
  const id = stage?.gaugeId || b.controlling_gauge_id || b.usgs_site_no || '';
  return id ? `${src}/${id}` : src;
}

// Fetches every bridge's stage concurrently rather than one at a time --
// with 40+ bridges each waiting on a network round trip, a sequential await
// loop here was the actual reason a first load could take minutes.
// memoGetStageNWPS still dedupes bridges/gauges that share a gauge ID even
// when their fetches overlap like this (see its comment above).
async function computeRows(bridges, vessel) {
  return Promise.all(bridges.map(async (b) => {
    const stage = await getStageForBridge(b);
    const clearance = (stage && b.reference_clearance_ft != null) ? computeClearance(b, stage.stageFt) : null;
    const st = statusFor(b, clearance, vessel.airDraftFt, vessel.marginFt ?? 2);
    // How much room your specific vessel has: bridge clearance minus your air
    // draft. Negative means the bridge is currently too low for you. This is
    // the number that actually answers "can I get under this" — the raw
    // `clearance` above is just the bridge's own number, same for everyone.
    const margin = clearance != null ? clearance - vessel.airDraftFt : null;
    return { bridge: b, stage, clearance, margin, status: st, vessel };
  }));
}

async function computeGaugeRows(gauges) {
  const rows = await Promise.all(gauges.map(async (g) => {
    const stage = await getStageForGauge(g);
    return { gauge: g, stage };
  }));
  return [...rows].sort((a, b) => (b.gauge.lat ?? 0) - (a.gauge.lat ?? 0)); // north to south
}

function renderAlertBanner(rows) {
  const banner = $('alertBanner');
  const blocked = rows.filter((r) => r.status.cls === 'blocked');
  if (blocked.length === 0) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  const worst = blocked.reduce((a, b) => (a.margin < b.margin ? a : b));
  banner.hidden = false;
  banner.textContent = `⚠ ${blocked.length} bridge${blocked.length > 1 ? 's' : ''} below your air draft — worst: ${worst.bridge.name} (${fmt(Math.abs(worst.margin))} ft too low for ${worst.vessel.name})`;
}

function renderCards(rows) {
  const wrap = $('bridgeCards');
  wrap.innerHTML = '';
  for (const r of rows) {
    const { bridge: b, stage, clearance, margin, status, vessel } = r;
    const card = document.createElement('div');
    card.className = `bridge-card status-${status.cls}`;
    const hasMargin = margin != null;
    card.innerHTML = `
      <div class="card-top">
        <strong>${b.name}</strong>
        <span class="status ${status.cls}">${status.label}</span>
      </div>
      <div class="card-mile">${b.river} · Mile ${fmt(b.river_mile, 1)} · ${b.type}</div>
      <div class="card-margin-label">${hasMargin ? `Margin for ${vessel.name} (${fmt(vessel.airDraftFt)}ft air draft)` : 'Margin for your vessel'}</div>
      <div class="card-clearance">${hasMargin ? `${fmt(margin)} ft` : '—'}</div>
      <div class="card-detail">
        Bridge clearance ${clearance != null ? fmt(clearance) + ' ft' : '—'} · Ref ${b.reference_clearance_ft != null ? fmt(b.reference_clearance_ft) + ' ft' : '—'} · Stage ${stageLabel(stage)}${trendBadge(stage)} · ${sourceLabel(b, stage)}
      </div>
      ${b.notes ? `<div class="card-note">${b.notes}</div>` : ''}
    `;
    wrap.appendChild(card);
  }
}

function renderGaugeList(rows) {
  const wrap = $('gaugeList');
  wrap.innerHTML = '';
  for (const r of rows) {
    const { gauge: g, stage } = r;
    const row = document.createElement('div');
    row.className = 'gauge-row';
    row.innerHTML = `
      <span class="gauge-name">${g.name}</span>
      <span class="gauge-id">${g.id}</span>
      <span class="gauge-stage">${stageLabel(stage)}${trendBadge(stage)}</span>
    `;
    wrap.appendChild(row);
  }
}

function renderTable(rows) {
  const tbody = document.querySelector('#bridgesTable tbody');
  tbody.innerHTML = '';
  for (const r of rows) {
    const { bridge: b, stage, clearance, margin, status } = r;
    const tr = document.createElement('tr');
    const cells = [
      `<strong>${b.name}</strong>`,
      b.river,
      fmt(b.river_mile, 1),
      b.type,
      b.reference_clearance_ft != null ? fmt(b.reference_clearance_ft) : '—',
      stageLabel(stage) + trendBadge(stage),
      clearance != null ? fmt(clearance) : '—',
      margin != null ? `<strong>${fmt(margin)}</strong>` : '—',
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
    const { bridge: b, stage, clearance, margin, status, vessel } = r;
    if (b.lat == null || b.lon == null) continue;
    const popup = `
      <strong>${b.name}</strong><br/>
      Mile ${fmt(b.river_mile, 1)} (${b.river})<br/>
      Ref: ${b.reference_clearance_ft != null ? fmt(b.reference_clearance_ft) + ' ft' : '—'}<br/>
      Stage: ${stageLabel(stage)}<br/>
      Bridge clearance: ${clearance != null ? fmt(clearance) + ' ft' : '—'}<br/>
      <em>Margin for ${vessel ? vessel.name : 'your vessel'}:</em> ${margin != null ? fmt(margin) + ' ft' : '—'} — <span class="status ${status.cls}">${status.label}</span>
    `;
    const marker = L.circleMarker([b.lat, b.lon], {
      radius: 8,
      color: '#0b1220',
      weight: 2,
      fillColor: STATUS_MARKER_COLOR[status.cls] || STATUS_MARKER_COLOR.unknown,
      fillOpacity: 0.9,
    }).addTo(state.map).bindPopup(popup);
    state.markers.push(marker);
  }
}

function renderGaugeMarkers(rows) {
  clearGaugeMarkers();
  if (!state.map) return;
  for (const r of rows) {
    const { gauge: g, stage } = r;
    if (g.lat == null || g.lon == null) continue;
    const popup = `
      <strong>${g.name}</strong><br/>
      NOAA gauge <code>${g.id}</code>${g.river_mile != null ? ` · Mile ${fmt(g.river_mile, 1)}` : ''}<br/>
      Stage: ${stageLabel(stage)}
    `;
    const marker = L.circleMarker([g.lat, g.lon], {
      radius: 5,
      color: '#0b1220',
      weight: 1,
      fillColor: GAUGE_MARKER_COLOR,
      fillOpacity: 0.85,
    }).addTo(state.map).bindPopup(popup);
    state.gaugeMarkers.push(marker);
  }
}

function applyFilters(bridges) {
  const river = $('riverSelect').value;
  let list = bridges.filter((b) => river === 'All' || b.river === river);
  if (state.activeRouteId) {
    const route = state.routes.find((r) => r.id === state.activeRouteId);
    if (route) {
      const idSet = new Set(route.bridgeIds);
      list = list.filter((b) => idSet.has(b.id));
    }
  }
  list = [...list].sort((a, b) => (a.river_mile ?? 0) - (b.river_mile ?? 0));
  return list;
}

async function render() {
  nwpsFetchMemo = new Map(); // fresh per render so bridges + gauges sharing a gauge ID fetch it once

  setLoading(true);
  try {
    const vessel = activeVessel();
    const bridges = applyFilters(state.bridges);

    const [rows, gaugeRows] = await Promise.all([
      computeRows(bridges, vessel),
      computeGaugeRows(state.gauges),
    ]);
    state.lastRenderRows = rows;

    let visibleRows = rows;
    if ($('onlyConcerning').checked) {
      visibleRows = rows.filter((r) => r.status.cls === 'blocked' || r.status.cls === 'marginal');
    }

    renderAlertBanner(state.lastRenderRows);
    renderCards(visibleRows);
    renderTable(visibleRows);
    renderMarkers(visibleRows);
    renderGaugeList(gaugeRows);
    renderGaugeMarkers(gaugeRows);

    $('lastUpdated').textContent = `Last updated ${new Date().toLocaleTimeString()}`;
  } finally {
    setLoading(false);
  }
}

// Fetching 40+ bridges' and 30+ gauges' live stage can take a while even
// running concurrently (NWPS/USGS themselves aren't instant) -- without this
// a first-time visitor watching a blank bridge list has no way to tell that
// from the site being broken.
function setLoading(isLoading) {
  $('loadingBanner').hidden = !isLoading;
  $('refresh').disabled = isLoading;
  $('refresh').textContent = isLoading ? 'Refreshing…' : 'Refresh Stages';
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

async function loadGauges() {
  const json = await fetchJSON(`./data/gauges.json?v=${DATA_VERSION}`);
  if (Array.isArray(json)) {
    cacheGaugesList(json);
    return json;
  }
  const cached = getCachedGaugesList();
  if (cached && Array.isArray(cached.gauges)) return cached.gauges;
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
  $('toggleGauges').onclick = () => {
    const body = $('gaugesBody');
    const btn = $('toggleGauges');
    const collapsed = body.hasAttribute('hidden');
    if (collapsed) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', String(collapsed));
    btn.textContent = collapsed ? 'NOAA Gauges Along the Route ▾' : 'NOAA Gauges Along the Route ▸';
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

  state.routes = loadRoutes();
  state.activeRouteId = loadActiveRouteId();
  renderRouteSelect();

  wireControls();
  wireAccountPanel();
  wireAdminPanel();
  wireRoutesPanel();
  wireWelcomeModal();
  registerServiceWorker();

  const handledAuthRedirect = handleAuthRedirectParams(); // ?verified=1 / ?verify_error=1 / ?reset_token=...
  await checkAuthStatus(); // may load vessels from the account, overriding the local defaults above
  if (!handledAuthRedirect) showWelcomeModalIfNeeded(); // don't stack on top of the account modal above

  [state.bridges, state.gauges] = await Promise.all([loadBridges(), loadGauges()]);
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
