/* Freon TankTracker – mobile web client. */
(() => {
  'use strict';

  const state = { user: null, config: {}, lang: 'en', sites: [] };
  const $app = document.getElementById('app');

  try { state.lang = localStorage.getItem('ftt_lang') || ((navigator.language || '').startsWith('th') ? 'th' : 'en'); } catch { /* storage blocked */ }

  // ---------- utilities ----------
  const t = (k) => (window.I18N[state.lang] && window.I18N[state.lang][k]) || window.I18N.en[k] || k;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(state.lang === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : t('none'));
  const fmtTimeS = (iso) => (iso ? new Date(iso).toLocaleString(state.lang === 'th' ? 'th-TH' : 'en-GB', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
  const fmtAcc = (m) => (m == null ? t('none') : `± ${Math.round(m)} m`);
  const vsPill = (s) => (s ? `<span class="pill vs-${esc(s)}">${esc(t('vs_' + s))}</span>` : '');
  const msPill = (s) => (s ? `<span class="pill ms">${esc(t('ms_' + s))}</span>` : '');
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

  function toast(msg, ms = 3000) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), ms);
  }

  async function api(method, url, body, { headers = {}, form } = {}) {
    const opts = { method, headers: { 'X-Requested-With': 'TankTracker', ...headers }, credentials: 'same-origin' };
    if (form) opts.body = form;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, opts); } catch (e) { return { ok: false, status: 0, data: { error: 'NETWORK', message: 'Network error.' } }; }
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    if (res.status === 401 && state.user && !url.startsWith('/api/auth')) { state.user = null; go('/'); }
    return { ok: res.ok, status: res.status, data };
  }

  function go(path, replace = false) {
    if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
    route();
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nav]');
    if (a) { e.preventDefault(); go(a.getAttribute('href')); }
  });
  window.addEventListener('popstate', () => route());

  function setLang(lang) {
    state.lang = lang;
    document.documentElement.lang = lang;
    try { localStorage.setItem('ftt_lang', lang); } catch { /* ignore */ }
    if (state.user) api('POST', '/api/me/lang', { lang });
    route();
  }

  let pageCleanup = null;
  function layout(title, body, { back = '/', wide = false, bare = false } = {}) {
    if (pageCleanup) { const fn = pageCleanup; pageCleanup = null; fn(); }
    stopMedia();
    $app.innerHTML = `
      <header class="top">
        ${back ? `<button type="button" id="nav-back" aria-label="${esc(t('back'))}">‹</button>` : ''}
        <h1>${esc(title)}</h1>
        <button type="button" class="lang-toggle" id="lang-toggle">${state.lang === 'en' ? 'ไทย' : 'EN'}</button>
        ${state.user ? `<button type="button" id="logout">${esc(t('logout'))}</button>` : ''}
      </header>
      <main class="${wide ? 'wide' : ''}${bare ? ' bare' : ''}">${body}</main>`;
    const b = qs('#nav-back');
    if (b) b.onclick = () => (history.length > 1 && back === true ? history.back() : go(back === true ? '/' : back));
    qs('#lang-toggle').onclick = () => setLang(state.lang === 'en' ? 'th' : 'en');
    const lo = qs('#logout');
    if (lo) lo.onclick = async () => { await api('POST', '/api/auth/logout', {}); state.user = null; go('/'); };
    window.scrollTo(0, 0);
  }

  // ---------- media helpers ----------
  let activeStream = null;
  let scanTimer = null;
  function stopMedia() {
    if (scanTimer) { cancelAnimationFrame(scanTimer); clearTimeout(scanTimer); scanTimer = null; }
    if (activeStream) { activeStream.getTracks().forEach((tr) => tr.stop()); activeStream = null; }
  }
  function releaseStream() {
    if (activeStream) { activeStream.getTracks().forEach((tr) => tr.stop()); activeStream = null; }
  }

  async function getCameraStream() {
    if (activeStream && activeStream.getVideoTracks().some((tr) => tr.readyState === 'live')) return activeStream;
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    return activeStream;
  }

  // Decodes QR codes from live camera frames only.
  function startScanner(video, onResult) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let detector = null;
    if ('BarcodeDetector' in window) { try { detector = new window.BarcodeDetector({ formats: ['qr_code'] }); } catch { detector = null; } }
    let done = false;
    const tick = async () => {
      if (done || !video.isConnected) return;
      if (video.readyState >= 2 && video.videoWidth) {
        try {
          let text = null;
          if (detector) {
            const codes = await detector.detect(video);
            if (codes.length) text = codes[0].rawValue;
          }
          if (!text && window.jsQR) {
            const w = Math.min(video.videoWidth, 960);
            const h = Math.round((video.videoHeight / video.videoWidth) * w);
            canvas.width = w; canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            const img = ctx.getImageData(0, 0, w, h);
            const code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
            if (code) text = code.data;
          }
          if (text) { done = true; onResult(text); return; }
        } catch { /* keep scanning */ }
      }
      scanTimer = setTimeout(tick, 160);
    };
    tick();
    return () => { done = true; };
  }

  function getFix() {
    return new Promise((resolve) => {
      if (!('geolocation' in navigator)) return resolve({ error: 'unavailable' });
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy, ts: p.timestamp || Date.now() }),
        (err) => resolve({ error: err.code === 1 ? 'denied' : err.code === 3 ? 'timeout' : 'unavailable', message: err.message }),
        { enableHighAccuracy: true, maximumAge: 0, timeout: (state.config.geolocation_timeout_s || 20) * 1000 },
      );
    });
  }

  function drawMap(el, points, { sites = [] } = {}) {
    if (!window.L || !el) return null;
    const map = window.L.map(el, { attributionControl: !!state.config.tile_url });
    if (state.config.tile_url) {
      window.L.tileLayer(state.config.tile_url, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    }
    const bounds = [];
    for (const s of sites) {
      if (s.lat == null) continue;
      window.L.circle([s.lat, s.lng], { radius: s.radius_m || 50, color: '#1d4ed8', weight: 1, dashArray: '4 4', fillOpacity: 0.04 }).addTo(map).bindTooltip(s.name);
      bounds.push([s.lat, s.lng]);
    }
    for (const p of points) {
      window.L.circle([p.lat, p.lng], { radius: Math.max(p.accuracy_m || 5, 3), color: '#0f7a3d', fillOpacity: 0.15 }).addTo(map);
      const m = window.L.marker([p.lat, p.lng], { draggable: false, keyboard: false }).addTo(map);
      if (p.label) m.bindPopup(p.label);
      bounds.push([p.lat, p.lng]);
    }
    if (points.length === 1 && !sites.length) map.setView([points[0].lat, points[0].lng], points[0].accuracy_m > 200 ? 14 : 17);
    else if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 17 });
    else map.setView([15.5, 101], 5);
    setTimeout(() => map.invalidateSize(), 50);
    return map;
  }

  // ---------- screens ----------
  function renderLogin(next) {
    layout(t('app_name'), `
      <div class="card">
        <h2>${esc(t('login'))}</h2>
        <form id="login-form" class="stack" autocomplete="on">
          <label class="field">${esc(t('username'))}<input name="username" autocomplete="username" required autocapitalize="none"></label>
          <label class="field">${esc(t('password'))}<input name="password" type="password" autocomplete="current-password" required></label>
          <div id="login-err"></div>
          <button class="btn" type="submit">${esc(t('login'))}</button>
        </form>
      </div>
      <p class="muted small">${esc(t('scan_note'))}</p>`, { back: false });
    qs('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const r = await api('POST', '/api/auth/login', { username: f.get('username'), password: f.get('password') });
      if (!r.ok) { qs('#login-err').innerHTML = `<div class="notice bad">${esc(r.data.message)}</div>`; return; }
      state.user = r.data.user;
      let stored = null;
      try { stored = localStorage.getItem('ftt_lang'); } catch { /* ignore */ }
      if (r.data.user.preferred_lang && !stored) state.lang = r.data.user.preferred_lang;
      await loadSites();
      go(next || '/', true);
    };
  }

  async function loadSites() {
    const r = await api('GET', '/api/sites');
    state.sites = r.ok ? r.data.sites : [];
  }

  async function renderHome() {
    const u = state.user;
    const phone = await api('GET', '/api/me/phone');
    let reviewCount = 0;
    if (['supervisor', 'admin'].includes(u.role)) {
      const r = await api('GET', '/api/review/queue');
      if (r.ok) reviewCount = r.data.events.filter((e) => !e.own_submission).length;
    }
    const canInspect = true;
    const phoneBanner = phone.ok && !phone.data.verified
      ? `<div class="notice warn"><b>${esc(t('phone_not_verified'))}</b><br>${esc(phone.data.registered ? t('phone_verify_now') : t('phone_ask_admin'))}<br><a href="/app/phone" data-nav>${esc(t('my_phone'))} ›</a></div>` : '';
    const devBanner = state.config.sms_dev ? `<div class="notice bad small">${esc(t('dev_sms_banner'))}</div>` : '';
    layout(t('app_name'), `
      ${devBanner}${phoneBanner}
      <p class="muted">${esc(u.display_name)} · ${esc(t('role_' + u.role))} · <a href="/app/phone" data-nav>${esc(t('my_phone'))}</a></p>
      <div class="home-grid">
        ${canInspect ? `<a class="tile primary" href="/app/inspect" data-nav><span class="ico">⌖</span>${esc(t('scan_cylinder'))}</a>` : ''}
        <a class="tile" href="/app/recent" data-nav><span class="ico">🕘</span>${esc(t('my_recent'))}</a>
        <a class="tile" href="/app/pending" data-nav><span class="ico">⏳</span>${esc(t('pending_submissions'))}</a>
        <a class="tile" href="/app/damaged" data-nav style="grid-column:1/-1;min-height:84px"><span class="ico">⚠</span>${esc(t('report_damaged_label'))}</a>
      </div>
      ${['supervisor', 'admin'].includes(u.role) ? `
        <div class="section-title">${esc(t('supervisor_tools'))}</div>
        <div class="card list-links">
          <a href="/app/review" data-nav>${esc(t('review_queue'))} ${reviewCount ? `<span class="pill vs-evidence_pending">${reviewCount}</span>` : '›'}</a>
          <a href="/app/audits" data-nav>${esc(t('audit_tasks'))} ›</a>
          <a href="/app/dashboard" data-nav>${esc(t('dashboard'))} ›</a>
          <a href="/app/statements" data-nav>${esc(t('statements'))} ›</a>
        </div>` : ''}
      ${u.role === 'admin' ? `
        <div class="section-title">${esc(t('admin_tools'))}</div>
        <div class="card list-links">
          <a href="/app/register" data-nav>${esc(t('register_cylinder'))} ›</a>
          <a href="/app/cylinders" data-nav>${esc(t('cylinders'))} ›</a>
          <a href="/app/sites" data-nav>${esc(t('sites'))} ›</a>
          <a href="/app/users" data-nav>${esc(t('users'))} ›</a>
          <a href="/app/settings" data-nav>${esc(t('settings'))} ›</a>
          <a href="/app/audit" data-nav>${esc(t('audit_log'))} ›</a>
        </div>` : ''}
      <p class="muted small">${esc(t('scan_note'))}</p>`, { back: false });
  }

  // QR landing: opened by a normal phone-camera scan. Read-only.
  async function renderQrLanding(token) {
    const r = await api('GET', `/api/public/qr/${encodeURIComponent(token)}`);
    if (!r.ok) {
      layout(t('qr_landing_title'), `<div class="notice bad">${esc(t('qr_unknown'))}</div>`, { back: '/' });
      return;
    }
    const c = r.data.cylinder;
    const revoked = r.data.status !== 'active';
    let actions = '';
    if (revoked) actions = `<div class="notice bad">${esc(t('qr_revoked'))}</div>`;
    else if (state.user) {
      actions = `<div class="stack">
        <a class="btn" href="/app/inspect" data-nav>${esc(t('start_inspection'))}</a>
        <a class="btn secondary" href="/app/cylinder/${esc(c.id)}" data-nav>${esc(t('view_record'))}</a></div>`;
    } else {
      actions = `<a class="btn" href="/app/login?next=${encodeURIComponent(location.pathname)}" data-nav>${esc(t('login_to_record'))}</a>`;
    }
    layout(t('qr_landing_title'), `
      <div class="card">
        <dl class="kv">
          <dt>${esc(t('serial'))}</dt><dd>${esc(c.serial)}</dd>
          <dt>${esc(t('internal_id'))}</dt><dd>${esc(c.id)}</dd>
          <dt>${esc(t('gas_type'))}</dt><dd>${esc(c.gas_type)}</dd>
          <dt>${esc(t('size'))}</dt><dd>${esc(c.size)}</dd>
          <dt>${esc(t('brand_owner'))}</dt><dd>${esc(c.brand_owner)}</dd>
        </dl>
      </div>
      <div class="notice info">${esc(t('qr_landing_note'))}</div>
      ${actions}`, { back: '/' });
  }

  function eventSummary(e) {
    if (!e) return `<p class="muted">${esc(t('none'))}</p>`;
    return `<dl class="kv">
      <dt>${esc(t('event_type'))}</dt><dd><a href="/app/event/${e.id}" data-nav>#${e.id} ${esc(t('et_' + e.event_type))}</a></dd>
      <dt>${esc(t('recorded_at'))}</dt><dd>${esc(fmtTime(e.server_received_at))}</dd>
      <dt>${esc(t('recorded_by'))}</dt><dd>${esc(e.recorded_by)}</dd>
      <dt>${esc(t('site'))}</dt><dd>${esc(e.site ? e.site.name : t('none'))}</dd>
      <dt>${esc(t('verification_status'))}</dt><dd>${vsPill(e.verification_status)}</dd>
    </dl>`;
  }

  async function renderCylinder(id) {
    const r = await api('GET', `/api/cylinders/${encodeURIComponent(id)}`);
    if (!r.ok) { layout(t('cylinders'), `<div class="notice bad">${esc(r.data.message)}</div>`, { back: true }); return; }
    const c = r.data.cylinder;
    const la = c.last_approved;
    const hasFix = la && la.lat != null;
    const isAdmin = state.user.role === 'admin';
    const isStaff = ['admin', 'supervisor'].includes(state.user.role);
    layout(`${c.serial}`, `
      <div class="card">
        <div class="row-between"><h2>${esc(c.serial)} <span class="muted small">${esc(c.id)}</span></h2>${msPill(c.movement_status)}</div>
        ${c.movement_status === 'in_transit' && c.destination_site ? `<p class="muted">${esc(t('destination'))}: <b>${esc(c.destination_site.name)}</b></p>` : ''}
        <dl class="kv">
          <dt>${esc(t('gas_type'))}</dt><dd>${esc(c.gas_type)}</dd>
          <dt>${esc(t('brand_owner'))}</dt><dd>${esc(c.brand_owner)}</dd>
          <dt>${esc(t('size'))}</dt><dd>${esc(c.size)} · ${esc(c.tare_kg)} kg</dd>
        </dl>
      </div>
      <div class="card">
        <h2>${esc(t('last_recorded_location'))}</h2>
        ${hasFix ? '<div class="map" id="cyl-map"></div>' : `<p class="muted">${esc(t('no_location_yet'))}</p>`}
        <dl class="kv" style="margin-top:10px">
          <dt>${esc(t('last_recorded_location'))}</dt><dd>${la ? esc(la.site ? la.site.name : '') : t('none')}${hasFix ? `<br><span class="muted small">${la.lat.toFixed(5)}, ${la.lng.toFixed(5)}</span>` : ''}</dd>
          <dt>${esc(t('recorded_at'))}</dt><dd>${la ? esc(fmtTime(la.server_received_at)) : t('none')}</dd>
          <dt>${esc(t('recorded_by'))}</dt><dd>${la ? esc(la.recorded_by) : t('none')}</dd>
          <dt>${esc(t('location_accuracy'))}</dt><dd>${hasFix ? esc(fmtAcc(la.accuracy_m)) : t('none')}</dd>
          <dt>${esc(t('verification_status'))}</dt><dd>${la ? vsPill(la.verification_status) : t('none')}</dd>
          ${la && la.bay ? `<dt>${esc(t('operator_reported_bay'))}</dt><dd>${esc(la.bay)}</dd>` : ''}
        </dl>
        <p class="muted small">${esc(t('scan_note'))}</p>
      </div>
      ${c.latest_submitted && (!la || c.latest_submitted.id !== la.id) ? `<div class="card"><h2>${esc(t('latest_submitted'))}</h2>${eventSummary(c.latest_submitted)}</div>` : ''}
      <div class="card"><h2>${esc(t('reference_photos'))}</h2><div class="photos">${c.photos.map((p) => `<img src="/api/photos/${p.id}" alt="${esc(p.kind)}">`).join('')}</div></div>
      <div class="card"><h2>${esc(t('timeline'))}</h2><ul class="timeline">${c.events.map((e) => `
        <li class="${e.verification_status === 'rejected' ? 'rejected' : /pending/.test(e.verification_status) ? 'pending' : ''}">
          <a href="/app/event/${e.id}" data-nav><b>#${e.id} ${esc(t('et_' + e.event_type))}</b> ${vsPill(e.verification_status)}<br>
          <span class="muted small">${esc(fmtTime(e.server_received_at))} · ${esc(e.recorded_by)} · ${esc(e.site ? e.site.name : '')}${e.accuracy_m != null ? ` · ${esc(fmtAcc(e.accuracy_m))}` : ''}</span>
          ${e.flags.length ? `<br>${e.flags.map((f) => `<span class="pill flag">${esc(f.flag_type)}</span>`).join(' ')}` : ''}</a></li>`).join('')}</ul></div>
      ${isStaff ? `<div class="card"><h2>${esc(t('label_history'))}</h2>
        <table class="data"><tr><th>QR</th><th>Status</th><th>${esc(t('recorded_at'))}</th></tr>
        ${(c.qr_codes || []).map((q) => `<tr><td>${esc(q.token.slice(0, 6))}…</td><td>${esc(q.status)}${q.revoked_reason ? `<br><span class="muted small">${esc(q.revoked_reason)}</span>` : ''}</td><td>${esc(fmtTime(q.created_at))}</td></tr>`).join('')}</table>
        <h3>Prints</h3><table class="data">${(c.label_prints || []).map((p) => `<tr><td>${esc(p.kind)}</td><td>${esc(p.printed_by)}</td><td>${esc(fmtTime(p.printed_at))}</td></tr>`).join('') || `<tr><td>${esc(t('none'))}</td></tr>`}</table>
        <h3>${esc(t('nfc_section'))}</h3><p class="muted small">${esc(t('nfc_unavailable'))}</p></div>` : ''}
      <div class="stack">
        ${isAdmin ? `<button class="btn secondary" id="print-one">${esc(t('print_label'))}</button>
          <button class="btn secondary" id="replace-label">${esc(t('replace_label'))}</button>` : ''}
        ${!['missing', 'retired'].includes(c.movement_status) ? `<button class="btn secondary" id="report-missing">${esc(t('report_missing'))}</button>` : ''}
        ${isAdmin && c.movement_status !== 'retired' ? `<button class="btn danger" id="retire">${esc(t('retire'))}</button>` : ''}
      </div>`, { back: true });
    if (hasFix) drawMap(qs('#cyl-map'), [{ lat: la.lat, lng: la.lng, accuracy_m: la.accuracy_m }]);
    const on = (sel, fn) => { const el = qs(sel); if (el) el.onclick = fn; };
    on('#print-one', () => printLabels([c.id]));
    on('#replace-label', async () => {
      const reason = prompt(t('replace_reason'));
      if (!reason) return;
      const rr = await api('POST', `/api/cylinders/${c.id}/replace-label`, { reason });
      if (!rr.ok) return toast(rr.data.message);
      window.open(rr.data.url, '_blank');
      renderCylinder(c.id);
    });
    on('#report-missing', async () => {
      const comments = prompt(t('missing_comments'));
      if (!comments) return;
      const rr = await api('POST', `/api/cylinders/${c.id}/missing`, { comments }, { headers: { 'Idempotency-Key': uuid() } });
      toast(rr.ok ? t('submitted') : rr.data.message);
      renderCylinder(c.id);
    });
    on('#retire', async () => {
      const reason = prompt(t('retire'));
      if (!reason) return;
      const rr = await api('POST', `/api/cylinders/${c.id}/retire`, { reason });
      toast(rr.ok ? t('submitted') : rr.data.message);
      renderCylinder(c.id);
    });
  }

  async function printLabels(ids) {
    const r = await api('POST', '/api/labels/print', { cylinder_ids: ids });
    if (!r.ok) return toast(r.data.message);
    window.open(r.data.url, '_blank');
  }

  // ---------- split-screen inspection ----------
  // Top half: live QR scanner, locked until the server confirms the location.
  // Bottom half: live location, then details, then the SMS code.
  let insp = null;

  function siteOptions(selected, filter) {
    return state.sites.filter(filter || (() => true)).map((s) => `<option value="${s.id}" ${String(selected) === String(s.id) ? 'selected' : ''}>${esc(s.name)}${s.kind === 'customer' ? ' (' + esc(t('customer')) + ')' : ''}</option>`).join('');
  }

  function haversine(a, b, c, d) {
    const R = 6371000; const r = (x) => (x * Math.PI) / 180;
    const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function newInspection(mode, extra = {}) {
    return {
      mode, stage: 'locate', session: null, cylinder: null, auditId: null, siteId: '', fix: null, fixError: null,
      confirmedUntil: 0, exception: false, locMsg: null, allowException: false, decoding: false, pending: null, event: null,
      idemKey: uuid(), form: { event_type: 'inspection', bay: '', destination_site_id: '', delivery_ref: '', responsible_person: '', expected_return_date: '', condition: mode === 'damaged_label' ? 'label_damaged' : 'good', comments: '', gross_weight_kg: '', scale_id: '', audit_outcome: '', checklist: {} },
      timers: [], watchId: null, map: null, mapCircle: null, mapMarker: null, ...extra,
    };
  }

  // Stops timers, location watch, scanner and camera but keeps the state,
  // so the page can be re-rendered (e.g. language switch) and resumed.
  function suspendInspection() {
    if (!insp) return;
    insp.timers.forEach((x) => clearInterval(x));
    insp.timers = [];
    if (insp.watchId != null && navigator.geolocation) navigator.geolocation.clearWatch(insp.watchId);
    insp.watchId = null;
    insp.decoding = false;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    releaseStream();
  }

  function endInspection() {
    suspendInspection();
    insp = null;
  }

  function fixPayload() {
    const f = insp.fix;
    if (!f) return null;
    return { lat: f.lat, lng: f.lng, accuracy_m: f.accuracy_m, fix_timestamp: new Date(f.ts).toISOString(), client_sent_at: new Date().toISOString() };
  }

  function liveState() {
    const f = insp.fix;
    const site = state.sites.find((s) => String(s.id) === String(insp.siteId));
    const age = f ? Math.max(0, Math.round((Date.now() - f.ts) / 1000)) : null;
    const accOk = f ? f.accuracy_m <= state.config.max_accuracy_m : false;
    const ageOk = age !== null && age <= state.config.max_fix_age_s;
    let geo = null; let dist = null;
    if (f && site && site.lat != null && site.radius_m) {
      dist = haversine(f.lat, f.lng, site.lat, site.lng);
      geo = dist + f.accuracy_m <= site.radius_m ? 'inside' : dist - f.accuracy_m > site.radius_m ? 'outside' : 'boundary_uncertain';
    } else if (f && site) geo = 'no_geofence';
    return { f, site, age, accOk, ageOk, geo, dist, good: !!f && accOk && ageOk && geo === 'inside' };
  }

  async function renderInspect(opts = {}) {
    if (!window.isSecureContext) { layout(t('scan_cylinder'), `<div class="notice bad">${esc(t('insecure_context'))}</div>`, { back: '/' }); return; }
    if (!insp || insp.done) {
      endInspection();
      insp = newInspection('normal', { auditId: opts.auditId || null });
    }
    pageCleanup = null;
    suspendInspection();
    if (!insp.session) {
      layout(t('scan_cylinder'), `<p class="muted">${esc(t('loading'))}</p>`, { back: '/' });
      const r = await api('POST', '/api/inspections', insp.auditId ? { audit_id: insp.auditId } : {});
      if (!r.ok) {
        const phoneLink = r.data.error === 'PHONE_NOT_VERIFIED' ? `<a class="btn" href="/app/phone" data-nav>${esc(t('my_phone'))}</a>` : '';
        endInspection();
        layout(t('scan_cylinder'), `<div class="notice bad">${esc(r.data.message)}</div>${phoneLink}`, { back: '/' });
        return;
      }
      insp.session = r.data.session;
    }
    if (!insp.siteId) {
      const cur = insp.cylinder && (insp.cylinder.movement_status === 'in_transit' ? insp.cylinder.destination_site_id : insp.cylinder.current_site_id);
      let last = null; try { last = localStorage.getItem('ftt_last_site'); } catch { /* ignore */ }
      insp.siteId = String(cur || last || (state.sites[0] && state.sites[0].id) || '');
      insp.siteAuto = !cur && !last; // pick the nearest site when the first fix arrives
    }
    const title = insp.mode === 'damaged_label' ? t('damaged_title') : insp.auditId ? t('audit_inspection') : t('scan_cylinder');
    layout(title, `
      <div class="split">
        <section class="cam-pane" aria-label="${esc(t('qr_scanner'))}">
          <video id="cam" playsinline muted autoplay></video>
          <div id="cam-overlay" class="cam-overlay"></div>
        </section>
        <section class="panel" id="panel" aria-live="polite"></section>
      </div>`, { back: false, bare: true });
    pageCleanup = endInspection;
    if (insp.mode === 'normal') {
      try {
        const stream = await getCameraStream();
        const v = qs('#cam');
        if (v) { v.srcObject = stream; v.play().catch(() => {}); }
      } catch { insp.cameraDenied = true; }
    }
    startLocationWatch();
    insp.timers.push(setInterval(tick, 1000));
    renderTop();
    renderPanel();
  }

  function startLocationWatch() {
    if (!('geolocation' in navigator)) { insp.fixError = 'unavailable'; return; }
    const opts = { enableHighAccuracy: true, maximumAge: 0, timeout: (state.config.geolocation_timeout_s || 20) * 1000 };
    const ok = (p) => {
      if (!insp) return;
      insp.fix = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy, ts: p.timestamp || Date.now() };
      insp.fixError = null;
      if (insp.siteAuto) {
        insp.siteAuto = false;
        const near = state.sites.filter((x) => x.lat != null)
          .map((x) => ({ x, d: haversine(insp.fix.lat, insp.fix.lng, x.lat, x.lng) })).sort((m, n) => m.d - n.d)[0];
        if (near && String(near.x.id) !== String(insp.siteId)) {
          insp.siteId = String(near.x.id);
          if (insp.stage === 'locate') { renderPanel(); return; }
        }
      }
      updateMap();
    };
    const bad = (e) => { if (!insp) return; if (e.code === 1) insp.fixError = 'denied'; else if (!insp.fix) insp.fixError = e.code === 3 ? 'timeout' : 'unavailable'; };
    insp.watchId = navigator.geolocation.watchPosition(ok, bad, opts);
    // Some phones stop reporting when standing still; ask again every 10 s.
    insp.timers.push(setInterval(() => navigator.geolocation.getCurrentPosition(ok, bad, opts), 10000));
  }

  function tick() {
    if (!insp) return;
    const ls = liveState();
    if (insp.stage === 'scan' && !insp.exception) {
      if (Date.now() > insp.confirmedUntil) return relock(t('relock_expired'));
      if (!ls.ageOk) return relock(t('relock_stale'));
      if (!ls.accOk) return relock(t('loc_inaccurate'));
      if (ls.geo === 'outside') return relock(t('relock_outside'));
    }
    updateLive(ls);
  }

  function relock(msg) {
    stopDecoder();
    insp.stage = 'locate';
    insp.confirmedUntil = 0;
    insp.locMsg = { kind: 'warn', text: msg };
    renderTop();
    renderPanel();
  }

  function stopDecoder() {
    insp.decoding = false;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    if (insp.stopScan) insp.stopScan();
  }

  function renderTop() {
    const o = qs('#cam-overlay');
    const pane = qs('.cam-pane');
    if (!o || !pane) return;
    pane.classList.toggle('locked', insp.stage === 'locate');
    const lockIcon = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>';
    const checkIcon = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#6fe39c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M7.5 12.5l3 3 6-6.5"></path></svg>';
    if (insp.mode === 'damaged_label') {
      o.innerHTML = `<div class="ov-center"><b>${esc(t('damaged_title'))}</b><span class="ov-big">${esc(insp.cylinder.serial)}</span><span>${esc(t('no_qr_scan'))}</span></div>`;
    } else if (insp.cameraDenied) {
      o.innerHTML = `<div class="ov-center"><b>${esc(t('camera_denied_help'))}</b></div>`;
    } else if (insp.stage === 'locate') {
      o.innerHTML = `<div class="ov-center">${lockIcon}<b>${esc(t('scanner_locked'))}</b><span>${esc(t('confirm_location_first'))}</span><span class="ov-small">${esc(t('live_camera_only'))}</span></div>`;
    } else if (insp.stage === 'scan') {
      o.innerHTML = `<div class="ov-frame"><i></i><i></i><i></i><i></i></div>
        <div class="ov-chip" id="ov-chip">${insp.exception ? esc(t('scanner_unlocked_exception')) : esc(t('scanner_unlocked'))}</div>
        <div class="ov-bottom">${esc(t('s3_text'))}</div>`;
    } else {
      const c = insp.cylinder;
      o.innerHTML = `<div class="ov-center">${checkIcon}<span>${esc(t('qr_read_live'))}</span><span class="ov-big">S/N ${esc(c.serial)}</span><span>${esc(c.id)} · ${esc(c.gas_type)} · ${esc(c.size)}</span>${insp.snapshotSaved ? `<span class="ov-small">${esc(t('snapshot_saved'))}</span>` : ''}</div>`;
    }
  }

  function geoLabel(geo) { return geo ? t('geo_' + geo) : t('none'); }

  function updateLive(ls = liveState()) {
    const set = (id, text, bad) => { const el = qs('#' + id); if (el) { el.textContent = text; el.classList.toggle('bad', !!bad); } };
    set('lv-acc', ls.f ? `± ${Math.round(ls.f.accuracy_m)} m` : t('none'), ls.f && !ls.accOk);
    set('lv-age', ls.age !== null ? `${ls.age} s` : t('none'), ls.age !== null && !ls.ageOk);
    set('lv-geo', geoLabel(ls.geo), ls.geo && ls.geo !== 'inside');
    const btn = qs('#loc-confirm');
    if (btn) btn.disabled = !ls.good;
    const hint = qs('#loc-hint');
    if (hint) {
      let txt = '';
      if (insp.fixError === 'denied') txt = t('location_denied_help');
      else if (!ls.f) txt = insp.fixError ? t('loc_unavailable') : t('getting_fix');
      else if (!ls.accOk) txt = t('loc_inaccurate');
      else if (!ls.ageOk) txt = t('waiting_fresh_fix');
      else if (ls.geo === 'outside') txt = t('relock_outside');
      else if (ls.geo === 'boundary_uncertain') txt = t('near_edge');
      else if (ls.geo === 'no_geofence') txt = t('geo_no_geofence');
      hint.textContent = txt;
      hint.hidden = !txt;
    }
    const chip = qs('#ov-chip');
    if (chip && insp.stage === 'scan' && !insp.exception) {
      const left = Math.max(0, Math.round((insp.confirmedUntil - Date.now()) / 1000));
      chip.textContent = `${t('scanner_unlocked')} · ${t('relocks_in')} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
    }
    const cd = qs('#code-resend');
    if (cd && insp.pending) {
      const wait = Math.max(0, Math.ceil((Date.parse(insp.pending.resend_available_at) - Date.now()) / 1000));
      cd.disabled = wait > 0 || insp.pending.resends_left <= 0;
      cd.textContent = insp.pending.resends_left <= 0 ? t('no_more_resends') : wait > 0 ? `${t('resend_code_in')} ${wait} s` : t('resend_code');
    }
  }

  function updateMap() {
    if (!insp || !insp.map || !insp.fix || !window.L) return;
    const ll = [insp.fix.lat, insp.fix.lng];
    if (!insp.mapMarker) {
      insp.mapCircle = window.L.circle(ll, { radius: Math.max(insp.fix.accuracy_m, 3), color: '#0f7a3d', fillOpacity: 0.15 }).addTo(insp.map);
      insp.mapMarker = window.L.marker(ll, { draggable: false, keyboard: false }).addTo(insp.map);
      insp.map.setView(ll, insp.fix.accuracy_m > 200 ? 14 : 17);
    } else {
      insp.mapCircle.setLatLng(ll).setRadius(Math.max(insp.fix.accuracy_m, 3));
      insp.mapMarker.setLatLng(ll);
    }
  }

  function buildMap() {
    insp.map = null; insp.mapCircle = null; insp.mapMarker = null;
    const el = qs('#imap');
    if (!el || !window.L) return;
    insp.map = window.L.map(el, { attributionControl: !!state.config.tile_url, zoomControl: false });
    if (state.config.tile_url) window.L.tileLayer(state.config.tile_url, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(insp.map);
    const site = state.sites.find((s) => String(s.id) === String(insp.siteId));
    if (site && site.lat != null) {
      window.L.circle([site.lat, site.lng], { radius: site.radius_m || 50, color: '#1d4ed8', weight: 1.5, dashArray: '5 5', fillOpacity: 0.04 }).addTo(insp.map);
      insp.map.setView([site.lat, site.lng], 16);
    } else insp.map.setView([15.5, 101], 5);
    setTimeout(() => insp && insp.map && insp.map.invalidateSize(), 60);
    updateMap();
  }

  function stepInfo() {
    const idx = { locate: 0, scan: 1, details: 2, code: 3, done: 4 }[insp.stage];
    const labels = [t('step1_label'), t('step2_label'), t('step3_label'), t('step4_label'), t('completed')];
    const bars = [0, 1, 2, 3].map((i) => `<span class="${i < idx ? 'done' : i === idx ? 'cur' : ''}"></span>`).join('');
    return `<div class="steps">${bars}</div><div class="step-label">${esc(labels[idx])}</div>`;
  }

  function renderPanel() {
    const p = qs('#panel');
    if (!p) return;
    const devBanner = state.config.sms_dev ? `<div class="dev-strip">${esc(t('dev_sms_short'))}</div>` : '';
    const cancel = insp.stage !== 'done' ? `<button class="btn secondary" id="insp-cancel">${esc(t('cancel'))}</button>` : '';
    let body = '';
    if (insp.stage === 'locate') body = panelLocate();
    else if (insp.stage === 'scan') body = panelScan();
    else if (insp.stage === 'details') body = panelDetails();
    else if (insp.stage === 'code') body = panelCode();
    else body = panelDone();
    p.innerHTML = `${stepInfo()}${devBanner}${body}<div style="margin-top:14px">${cancel}</div>`;
    const c = qs('#insp-cancel');
    if (c) c.onclick = async () => { if (insp.session) await api('POST', `/api/inspections/${insp.session.id}/cancel`, {}); endInspection(); go('/'); };
    if (insp.stage === 'locate') bindLocate();
    if (insp.stage === 'scan') startDecoder();
    if (insp.stage === 'details') bindDetails();
    if (insp.stage === 'code') bindCode();
    if (insp.stage === 'done') bindDone();
    updateLive();
  }

  function panelLocate() {
    const msg = insp.locMsg ? `<div class="notice ${insp.locMsg.kind}">${esc(insp.locMsg.text)}</div>` : '';
    const exc = insp.allowException ? `
      <details class="exc"><summary>${esc(t('exception_option'))}</summary>
        <label class="field">${esc(t('exception_reason'))}<textarea id="exc-reason"></textarea></label>
        <button class="btn warn" id="exc-go">${esc(t('submit_exception_continue'))}</button>
        <p class="muted small">${esc(t('exception_note'))}</p>
      </details>` : '';
    return `
      <h2 class="panel-title">${esc(t('your_location'))}</h2>
      <label class="field">${esc(t('site'))}<select id="loc-site">${siteOptions(insp.siteId)}</select></label>
      <div class="live-grid">
        <div><span>${esc(t('accuracy'))}</span><b id="lv-acc">–</b><small>≤ ${state.config.max_accuracy_m} m</small></div>
        <div><span>${esc(t('fix_age'))}</span><b id="lv-age">–</b><small>≤ ${state.config.max_fix_age_s} s</small></div>
        <div><span>Geofence</span><b id="lv-geo">–</b><small>${esc(t('checked_by_server'))}</small></div>
      </div>
      <div class="notice warn small" id="loc-hint" hidden></div>
      ${msg}
      <button class="btn" id="loc-confirm" disabled>${esc(t('confirm_location'))}</button>
      ${exc}
      <div class="map small-map" id="imap" style="margin-top:12px"></div>
      <p class="muted small">${esc(t('no_typed_coords'))}</p>`;
  }

  function bindLocate() {
    buildMap();
    qs('#loc-site').onchange = (e) => {
      insp.siteId = e.target.value;
      insp.siteAuto = false;
      try { localStorage.setItem('ftt_last_site', insp.siteId); } catch { /* ignore */ }
      insp.locMsg = null;
      renderPanel();
    };
    qs('#loc-confirm').onclick = async () => {
      const b = qs('#loc-confirm');
      b.disabled = true; b.textContent = t('loading');
      const r = await api('POST', `/api/inspections/${insp.session.id}/location`, { site_id: Number(insp.siteId), location: fixPayload() });
      if (!r.ok) {
        insp.locMsg = { kind: 'bad', text: r.data.message };
        insp.allowException = !!r.data.exception_allowed;
        renderPanel();
        return;
      }
      try { localStorage.setItem('ftt_last_site', insp.siteId); } catch { /* ignore */ }
      insp.confirmedUntil = Date.parse(r.data.confirmed_until);
      insp.exception = false;
      insp.locMsg = null;
      insp.stage = insp.mode === 'damaged_label' || insp.cylinder ? 'details' : 'scan';
      renderTop();
      renderPanel();
    };
    const eg = qs('#exc-go');
    if (eg) eg.onclick = async () => {
      const reason = qs('#exc-reason').value.trim();
      if (reason.length < 5) return toast(t('exception_reason'));
      const r = await api('POST', `/api/inspections/${insp.session.id}/location-exception`, { site_id: Number(insp.siteId), reason, location: fixPayload() });
      if (!r.ok) return toast(r.data.message);
      insp.exception = true;
      insp.locMsg = null;
      insp.stage = insp.mode === 'damaged_label' || insp.cylinder ? 'details' : 'scan';
      renderTop();
      renderPanel();
    };
  }

  function panelScan() {
    const ls = liveState();
    return `
      <div class="ok-card">
        <b>${esc(insp.exception ? t('location_exception_active') : t('location_confirmed'))}</b>
        <span>${ls.f ? `± ${Math.round(ls.f.accuracy_m)} m` : ''} · ${esc(ls.site ? ls.site.name : '')}</span>
      </div>
      <div class="live-grid">
        <div><span>${esc(t('accuracy'))}</span><b id="lv-acc">–</b></div>
        <div><span>${esc(t('fix_age'))}</span><b id="lv-age">–</b></div>
        <div><span>Geofence</span><b id="lv-geo">–</b></div>
      </div>
      <p class="small">${esc(t('location_watched'))}</p>
      <div class="notice info small">${esc(t('scan_next_hint'))}</div>
      <div id="scan-err"></div>`;
  }

  function grabFrame(video) {
    try {
      const w = Math.min(640, video.videoWidth || 640);
      const hgt = Math.round(((video.videoHeight || 480) / (video.videoWidth || 640)) * w);
      const c = document.createElement('canvas');
      c.width = w; c.height = hgt;
      c.getContext('2d').drawImage(video, 0, 0, w, hgt);
      return new Promise((resolve) => c.toBlob((b) => resolve(b), 'image/jpeg', 0.7));
    } catch { return Promise.resolve(null); }
  }

  function startDecoder() {
    if (insp.mode !== 'normal' || insp.decoding || insp.cameraDenied) return;
    const video = qs('#cam');
    if (!video) return;
    insp.decoding = true;
    insp.stopScan = startScanner(video, async (text) => {
      if (!insp || insp.stage !== 'scan') return;
      insp.decoding = false;
      const framePromise = grabFrame(video);
      const r = await api('POST', `/api/inspections/${insp.session.id}/scan`, { qr_text: text, scan_method: 'live_camera', location: fixPayload() });
      if (!insp) return;
      if (!r.ok) {
        if (r.data.error === 'LOCATION_NOT_CONFIRMED') return relock(r.data.message);
        const e = qs('#scan-err');
        if (e) e.innerHTML = `<div class="notice bad">${esc(r.data.message)}</div>`;
        setTimeout(() => { if (insp && insp.stage === 'scan') startDecoder(); }, 2500);
        return;
      }
      insp.cylinder = r.data.cylinder;
      if (r.data.snapshot_required) {
        const blob = await framePromise;
        if (blob) {
          const fd = new FormData();
          fd.append('capture_source', 'live_camera_frame');
          fd.append('snapshot', blob, 'frame.jpg');
          const sr = await api('POST', `/api/inspections/${insp.session.id}/snapshot`, undefined, { form: fd });
          insp.snapshotSaved = sr.ok;
        }
      }
      releaseStream();
      if (!insp.siteId && insp.cylinder.current_site_id) insp.siteId = String(insp.cylinder.current_site_id);
      insp.stage = 'details';
      renderTop();
      renderPanel();
    });
  }

  function needsWeight(f, site) {
    return site && site.kind === 'warehouse' && ['dispatched', 'empty_returned', 'warehouse_received'].includes(f.event_type);
  }

  function panelDetails() {
    const f = insp.form;
    const site = state.sites.find((s) => String(s.id) === String(insp.siteId));
    const keys = ['beside_cylinder', 'serial_matches', 'qr_attached', 'condition_checked', 'site_bay_correct']
      .filter((k) => !(insp.mode === 'damaged_label' && k === 'qr_attached'));
    const types = insp.auditId ? ['inspection'] : ['inspection', 'warehouse_received', 'dispatched', 'customer_received', 'transferred', 'empty_returned', 'maintenance'];
    const conds = ['good', 'damaged', 'leaking', 'label_damaged', 'needs_supervisor'];
    const c = insp.cylinder;
    return `<form id="det">
      <h2 class="panel-title">${esc(t('details'))}</h2>
      <p class="muted small">${esc(c.serial)} · ${esc(c.id)} · ${esc(t('site'))}: <b>${esc(site ? site.name : '')}</b></p>
      ${c.photos && c.photos.length ? `<div class="photos">${c.photos.map((ph) => `<img src="/api/photos/${ph.id}" alt="${esc(ph.kind)}">`).join('')}</div>` : ''}
      ${insp.auditId ? `<fieldset class="field"><legend>${esc(t('audit_outcome'))}</legend>
        <label class="check ${f.audit_outcome === 'found_ok' ? 'checked' : ''}"><input type="radio" name="audit_outcome" value="found_ok" ${f.audit_outcome === 'found_ok' ? 'checked' : ''}>${esc(t('ao_found_ok'))}</label>
        <label class="check ${f.audit_outcome === 'found_mismatch' ? 'checked' : ''}"><input type="radio" name="audit_outcome" value="found_mismatch" ${f.audit_outcome === 'found_mismatch' ? 'checked' : ''}>${esc(t('ao_found_mismatch'))}</label></fieldset>` : ''}
      <label class="field"><span class="req">${esc(t('event_type'))}</span><select name="event_type">${types.map((x) => `<option value="${x}" ${f.event_type === x ? 'selected' : ''}>${esc(t('et_' + x))}</option>`).join('')}</select></label>
      <div id="dest-wrap"><label class="field"><span class="req">${esc(t('destination'))}</span><select name="destination_site_id"><option value=""></option>${siteOptions(f.destination_site_id, (s) => String(s.id) !== String(insp.siteId))}</select></label>
        <label class="field">${esc(t('expected_return'))} (${esc(t('optional'))})<input type="date" name="expected_return_date" value="${esc(f.expected_return_date)}"></label></div>
      <div id="weight-wrap" class="grid2">
        <label class="field"><span class="${state.config.require_weight ? 'req' : ''}">${esc(t('gross_weight'))}</span><input type="number" step="0.01" min="0" inputmode="decimal" name="gross_weight_kg" value="${esc(f.gross_weight_kg)}"></label>
        <label class="field">${esc(t('scale_id'))} (${esc(t('optional'))})<input name="scale_id" value="${esc(f.scale_id)}" maxlength="40"></label>
        <p class="muted small" style="grid-column:1/-1">${esc(t('weight_note'))} ${esc(t('tare_kg'))}: ${esc(c.tare_kg)} kg</p>
      </div>
      <label class="field">${esc(t('storage_bay'))}<input name="bay" value="${esc(f.bay)}" maxlength="60"></label>
      <div class="grid2">
        <label class="field">${esc(t('responsible_person'))}<input name="responsible_person" value="${esc(f.responsible_person || state.user.display_name)}" maxlength="120"></label>
        <label class="field">${esc(t('delivery_ref'))} (${esc(t('optional'))})<input name="delivery_ref" value="${esc(f.delivery_ref)}" maxlength="80"></label>
      </div>
      <label class="field"><span class="req">${esc(t('condition'))}</span><select name="condition">${conds.map((x) => `<option value="${x}" ${f.condition === x ? 'selected' : ''}>${esc(t('cond_' + x))}</option>`).join('')}</select></label>
      <label class="field">${esc(t('comments'))}<textarea name="comments" maxlength="2000">${esc(f.comments)}</textarea></label>
      ${keys.map((k) => `<label class="check ${f.checklist[k] ? 'checked' : ''}"><input type="checkbox" name="ck_${k}" ${f.checklist[k] ? 'checked' : ''}>${esc(t('ck_' + k))}</label>`).join('')}
      <div id="det-err"></div>
      <button class="btn" type="submit" id="det-submit">${esc(t('submit_send_code'))}</button>
      <p class="muted small">${esc(t('saved_after_code'))}</p>
    </form>`;
  }

  function bindDetails() {
    const form = qs('#det');
    const f = insp.form;
    const site = state.sites.find((s) => String(s.id) === String(insp.siteId));
    const sync = () => {
      qs('#dest-wrap').hidden = !['dispatched', 'transferred'].includes(form.event_type.value);
      qs('#weight-wrap').hidden = !needsWeight({ event_type: form.event_type.value }, site);
    };
    sync();
    form.event_type.onchange = sync;
    qsa('.check input', form).forEach((i) => { i.onchange = () => { if (i.type === 'radio') qsa(`input[name="${i.name}"]`, form).forEach((r) => r.parentElement.classList.toggle('checked', r.checked)); else i.parentElement.classList.toggle('checked', i.checked); }; });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const keys = ['beside_cylinder', 'serial_matches', 'qr_attached', 'condition_checked', 'site_bay_correct'].filter((k) => !(insp.mode === 'damaged_label' && k === 'qr_attached'));
      for (const k of keys) f.checklist[k] = form[`ck_${k}`].checked;
      for (const k of ['event_type', 'destination_site_id', 'expected_return_date', 'gross_weight_kg', 'scale_id', 'bay', 'responsible_person', 'delivery_ref', 'condition', 'comments']) f[k] = form[k].value.trim();
      if (insp.auditId) { const ao = form.querySelector('input[name="audit_outcome"]:checked'); f.audit_outcome = ao ? ao.value : ''; }
      const errs = [];
      if (keys.some((k) => !f.checklist[k])) errs.push(t('s7_text'));
      if (['dispatched', 'transferred'].includes(f.event_type) && !f.destination_site_id) errs.push(t('destination'));
      if (needsWeight(f, site) && state.config.require_weight && !f.gross_weight_kg) errs.push(t('gross_weight'));
      if ((f.condition !== 'good' || insp.mode === 'damaged_label' || f.audit_outcome === 'found_mismatch') && f.comments.length < 5) errs.push(t('comments_required'));
      if (insp.auditId && !f.audit_outcome) errs.push(t('audit_outcome'));
      if (errs.length) { qs('#det-err').innerHTML = `<div class="notice bad">${errs.map(esc).join('<br>')}</div>`; return; }
      const btn = qs('#det-submit');
      btn.disabled = true; btn.textContent = t('submitting');
      // The location confirmation must still be valid: refresh it with the live fix.
      if (!insp.exception) {
        const lr = await api('POST', `/api/inspections/${insp.session.id}/location`, { site_id: Number(insp.siteId), location: fixPayload() });
        if (!lr.ok) {
          insp.stage = 'locate';
          insp.locMsg = { kind: 'bad', text: `${t('relock_at_submit')} ${lr.data.message}` };
          insp.allowException = !!lr.data.exception_allowed;
          renderTop(); renderPanel();
          return;
        }
        insp.confirmedUntil = Date.parse(lr.data.confirmed_until);
      }
      const body = {
        event_type: f.event_type, bay: f.bay, responsible_person: f.responsible_person, delivery_ref: f.delivery_ref,
        destination_site_id: ['dispatched', 'transferred'].includes(f.event_type) && f.destination_site_id ? Number(f.destination_site_id) : null,
        expected_return_date: f.expected_return_date || null, condition: f.condition, comments: f.comments, checklist: f.checklist,
        gross_weight_kg: needsWeight(f, site) && f.gross_weight_kg ? Number(f.gross_weight_kg) : null, scale_id: f.scale_id || null,
        audit_outcome: f.audit_outcome || null,
      };
      const r = await api('POST', `/api/inspections/${insp.session.id}/submit`, body, { headers: { 'Idempotency-Key': insp.idemKey } });
      if (!r.ok) {
        btn.disabled = false; btn.textContent = t('submit_send_code');
        if (r.data.error === 'LOCATION_NOT_CONFIRMED') return relock(r.data.message);
        insp.idemKey = uuid();
        qs('#det-err').innerHTML = `<div class="notice bad">${esc(r.data.message || r.data.error)}</div>`;
        return;
      }
      insp.pending = r.data.pending;
      insp.stage = 'code';
      renderPanel();
    };
  }

  function panelCode() {
    const p = insp.pending;
    const who = p.recipient === 'site_contact' ? t('code_sent_customer') : t('code_sent_you');
    return `
      <h2 class="panel-title">${esc(t('enter_sms_code'))}</h2>
      <p>${esc(who)}<br><b>${esc(p.phone_masked)}</b></p>
      <label class="field">${esc(t('four_digit_code'))}
        <input id="code-in" class="code-input" inputmode="numeric" autocomplete="one-time-code" maxlength="4" pattern="[0-9]*" placeholder="••••"></label>
      <div id="code-err"></div>
      <p class="muted small">${esc(t('code_valid_until'))} ${esc(fmtTime(p.expires_at))} · ${p.attempts_left} ${esc(t('tries_left'))}</p>
      <button class="btn" id="code-ok">${esc(t('confirm_code'))}</button>
      <button class="btn secondary" id="code-resend" style="margin-top:10px">${esc(t('resend_code'))}</button>
      <div id="dev-sms"></div>`;
  }

  async function showDevSms() {
    if (!state.config.sms_dev) return;
    const r = await api('GET', '/api/dev/sms-outbox');
    const el = qs('#dev-sms');
    if (!el || !r.ok) return;
    const m = r.data.messages[0];
    el.innerHTML = m ? `<div class="notice bad small"><b>${esc(t('dev_sms_title'))}</b> → ${esc(m.to)}<br>${esc(m.text)}</div>`
      : `<div class="notice bad small">${esc(t('dev_sms_not_visible'))}</div>`;
  }

  function bindCode() {
    const input = qs('#code-in');
    input.oninput = () => { input.value = input.value.replace(/\D/g, '').slice(0, 4); };
    input.focus();
    showDevSms();
    qs('#code-ok').onclick = async () => {
      const code = input.value;
      if (code.length !== 4) return;
      const b = qs('#code-ok'); b.disabled = true;
      const r = await api('POST', `/api/inspections/${insp.session.id}/confirm-code`, { code });
      b.disabled = false;
      if (r.ok) { insp.event = r.data.event; insp.stage = 'done'; insp.done = true; renderPanel(); return; }
      const err = qs('#code-err');
      if (['CODE_BURNED', 'CODE_EXPIRED', 'CONCURRENT_UPDATE', 'SESSION_CLOSED'].includes(r.data.error)) {
        err.innerHTML = `<div class="notice bad">${esc(r.data.message)}</div><a class="btn" href="/app/inspect" data-nav id="restart">${esc(t('start_again'))}</a>`;
        insp.done = true;
        qs('#code-ok').disabled = true;
        return;
      }
      if (r.data.attempts_left != null) insp.pending.attempts_left = r.data.attempts_left;
      err.innerHTML = `<div class="notice bad">${esc(r.data.message)}</div>`;
      input.value = '';
    };
    qs('#code-resend').onclick = async () => {
      const r = await api('POST', `/api/inspections/${insp.session.id}/resend-code`, {});
      if (!r.ok) return toast(r.data.message);
      insp.pending = r.data.pending;
      toast(t('code_resent'));
      showDevSms();
    };
  }

  function panelDone() {
    const ev = insp.event;
    return `
      <div class="ok-card"><b>✓ ${esc(t('submitted'))}</b><span>#${ev.id} · ${esc(insp.cylinder.serial)}</span></div>
      <dl class="kv">
        <dt>${esc(t('event_type'))}</dt><dd>${esc(t('et_' + ev.event_type))}</dd>
        <dt>${esc(t('movement_status'))}</dt><dd>${ev.movement_status_after ? msPill(ev.movement_status_after) : t('none')}</dd>
        <dt>${esc(t('verification_status'))}</dt><dd>${vsPill(ev.verification_status)}</dd>
        <dt>${esc(t('location'))}</dt><dd>${esc(t('loc_' + ev.location_status))} · ${esc(t('geo_' + ev.geofence_result))}</dd>
        <dt>SMS</dt><dd>${esc(ev.sms_recipient === 'site_contact' ? t('confirmed_by_customer') : t('confirmed_by_you'))} · ${esc(ev.sms_phone_masked || '')}</dd>
        ${ev.gross_weight_kg != null ? `<dt>${esc(t('gross_weight'))}</dt><dd>${ev.gross_weight_kg} kg (${esc(t('net'))} ${ev.net_content_kg} kg)</dd>` : ''}
      </dl>
      ${ev.flags.length ? `<h3>${esc(t('flags'))}</h3>${ev.flags.map((fl) => `<span class="pill flag">${esc(fl.flag_type)}</span>`).join(' ')}` : ''}
      <p class="muted small">${esc(t('scan_note'))}</p>
      <div class="stack" style="margin-top:14px"><button class="btn" id="again">${esc(t('scan_next'))}</button>
      <a class="btn secondary" href="/" data-nav>${esc(t('home'))}</a></div>`;
  }

  function bindDone() {
    qs('#again').onclick = () => { endInspection(); go('/app/inspect', true); };
  }

  // Damaged-label exception: find by serial, then location + details + code.
  function renderDamaged() {
    layout(t('damaged_title'), `<div class="card">
      <p>${esc(t('damaged_text'))}</p>
      <form id="f"><label class="field">${esc(t('find_by_serial'))}<input name="serial" required minlength="3" autocapitalize="characters"></label>
      <button class="btn" type="submit">${esc(t('search'))}</button></form>
      <div id="res" class="stack" style="margin-top:12px"></div></div>`, { back: '/' });
    qs('#f').onsubmit = async (e) => {
      e.preventDefault();
      const r = await api('GET', `/api/cylinders-lookup?serial=${encodeURIComponent(e.target.serial.value)}`);
      if (!r.ok) { qs('#res').innerHTML = `<div class="notice bad">${esc(r.data.message)}</div>`; return; }
      qs('#res').innerHTML = r.data.cylinders.map((c) => `<button class="btn secondary" data-id="${esc(c.id)}">${esc(c.serial)} · ${esc(c.gas_type)} · ${esc(c.id)}</button>`).join('') || `<p class="muted">${esc(t('no_items'))}</p>`;
      qsa('#res button').forEach((b) => {
        b.onclick = async () => {
          const rr = await api('POST', '/api/exceptions/damaged-label', { cylinder_id: b.dataset.id });
          if (!rr.ok) {
            qs('#res').innerHTML = `<div class="notice bad">${esc(rr.data.message)}</div>${rr.data.error === 'PHONE_NOT_VERIFIED' ? `<a class="btn" href="/app/phone" data-nav>${esc(t('my_phone'))}</a>` : ''}`;
            return;
          }
          endInspection();
          insp = newInspection('damaged_label', { session: rr.data.session, cylinder: rr.data.cylinder });
          history.pushState({}, '', '/app/inspect');
          renderInspect();
        };
      });
    };
  }
  // ---------- end split-screen inspection ----------

  async function renderRecent() {
    const r = await api('GET', '/api/me/events');
    const rows = r.ok ? r.data.events : [];
    layout(t('my_recent'), rows.length ? `<div class="card"><ul class="timeline">${rows.map((e) => `
      <li class="${e.verification_status === 'rejected' ? 'rejected' : /pending/.test(e.verification_status) ? 'pending' : ''}">
        <a href="/app/event/${e.id}" data-nav><b>${esc(e.serial)}</b> · ${esc(t('et_' + e.event_type))} ${vsPill(e.verification_status)}<br>
        <span class="muted small">${esc(fmtTime(e.server_received_at))} · ${esc(e.site ? e.site.name : '')}</span></a></li>`).join('')}</ul></div>`
      : `<p class="muted">${esc(t('no_items'))}</p>`, { back: '/' });
  }

  async function renderPending() {
    const r = await api('GET', '/api/me/events');
    const awaiting = r.ok ? r.data.events.filter((e) => /pending/.test(e.verification_status)) : [];
    layout(t('pending_submissions'), `
      <p class="muted small">${esc(t('pending_note'))}</p>
      <div class="section-title">${esc(t('awaiting_review'))}</div>
      ${awaiting.length ? `<div class="card"><ul class="timeline">${awaiting.map((e) => `<li class="pending"><a href="/app/event/${e.id}" data-nav><b>${esc(e.serial)}</b> · ${esc(t('et_' + e.event_type))} ${vsPill(e.verification_status)}<br><span class="muted small">${esc(fmtTime(e.server_received_at))}</span></a></li>`).join('')}</ul></div>`
        : `<p class="muted">${esc(t('no_items'))}</p>`}`, { back: '/' });
  }

  // ---------- supervisor ----------
  async function renderReviewQueue() {
    const r = await api('GET', '/api/review/queue');
    if (!r.ok) { layout(t('review_queue'), `<div class="notice bad">${esc(r.data.message)}</div>`); return; }
    const rows = r.data.events;
    layout(t('review_queue'), rows.length ? `<div class="card"><ul class="timeline">${rows.map((e) => `
      <li class="pending"><a href="/app/event/${e.id}" data-nav><b>#${e.id} ${esc(e.serial)}</b> · ${esc(t('et_' + e.event_type))} ${vsPill(e.verification_status)}
      ${e.own_submission ? `<span class="pill">${esc(t('own_submission'))}</span>` : ''}<br>
      <span class="muted small">${esc(fmtTime(e.server_received_at))} · ${esc(e.recorded_by)} · ${esc(e.site ? e.site.name : '')}</span><br>
      ${e.flags.map((f) => `<span class="pill flag">${esc(f.flag_type)}</span>`).join(' ')}</a></li>`).join('')}</ul></div>`
      : `<p class="muted">${esc(t('no_items'))}</p>`, { back: '/' });
  }

  async function renderEvent(id) {
    const r = await api('GET', `/api/events/${encodeURIComponent(id)}`);
    if (!r.ok) { layout('#' + id, `<div class="notice bad">${esc(r.data.message)}</div>`, { back: true }); return; }
    const e = r.data.event;
    const staff = ['supervisor', 'admin'].includes(state.user.role);
    const own = e.recorded_by_id === state.user.id;
    const reviewable = staff && !own && !['correction', 'registered'].includes(e.event_type);
    layout(`#${e.id} ${t('et_' + e.event_type)}`, `
      <div class="card">
        <div class="row-between"><h2>${esc(e.cylinder ? e.cylinder.serial : e.cylinder_id)}</h2>${vsPill(e.verification_status)}</div>
        <dl class="kv">
          <dt>${esc(t('event_type'))}</dt><dd>${esc(t('et_' + e.event_type))}${e.movement_status_after ? ' → ' + msPill(e.movement_status_after) : ''}</dd>
          <dt>${esc(t('recorded_at'))}</dt><dd>${esc(fmtTime(e.server_received_at))}</dd>
          <dt>${esc(t('recorded_by'))}</dt><dd>${esc(e.recorded_by)}</dd>
          <dt>${esc(t('responsible_person'))}</dt><dd>${esc(e.responsible_person || t('none'))}</dd>
          <dt>${esc(t('site'))}</dt><dd>${esc(e.site ? e.site.name : t('none'))}${e.site && e.site.customer_name ? ` <span class="muted small">(${esc(e.site.customer_name)})</span>` : ''}</dd>
          ${e.bay ? `<dt>${esc(t('operator_reported_bay'))}</dt><dd>${esc(e.bay)}</dd>` : ''}
          ${e.destination ? `<dt>${esc(t('destination'))}</dt><dd>${esc(e.destination.name)}</dd>` : ''}
          ${e.delivery_ref ? `<dt>${esc(t('delivery_ref'))}</dt><dd>${esc(e.delivery_ref)}</dd>` : ''}
          ${e.condition ? `<dt>${esc(t('condition'))}</dt><dd>${esc(t('cond_' + e.condition))}</dd>` : ''}
          ${e.comments ? `<dt>${esc(t('comments'))}</dt><dd>${esc(e.comments)}</dd>` : ''}
          <dt>${esc(t('location'))}</dt><dd>${esc(t('loc_' + e.location_status))}${e.location_issue ? ` (${esc(e.location_issue)})` : ''}</dd>
          ${e.lat != null ? `<dt>${esc(t('location_accuracy'))}</dt><dd>${esc(fmtAcc(e.accuracy_m))} · ${esc(t('fix_age'))} ${Math.round((e.fix_age_ms || 0) / 1000)} s</dd>
            <dt>Geofence</dt><dd>${esc(t('geo_' + e.geofence_result))}${e.geofence_distance_m != null ? ` · ${e.geofence_distance_m} m` : ''}</dd>` : ''}
          <dt>QR</dt><dd>${e.qr_verified ? esc(t('qr_live_ok')) : esc(t('qr_not_verified'))}</dd>
          ${e.sms_verified_at ? `<dt>SMS</dt><dd>${esc(e.sms_recipient === 'site_contact' ? t('confirmed_by_customer') : t('confirmed_by_operator'))} · ${esc(e.sms_phone_masked || '')}</dd>` : ''}
          ${e.gross_weight_kg != null ? `<dt>${esc(t('gross_weight'))}</dt><dd>${e.gross_weight_kg} kg · ${esc(t('net'))} ${e.net_content_kg} kg${e.scale_id ? ` · ${esc(t('scale_id'))} ${esc(e.scale_id)}` : ''}</dd>` : ''}
          ${e.audit_id ? `<dt>${esc(t('audit_outcome'))}</dt><dd>#${e.audit_id} · ${esc(t('ao_' + (e.audit_outcome || 'none')))}</dd>` : ''}
          ${e.is_exception ? `<dt>Exception</dt><dd>${esc(e.exception_kind)}: ${esc(e.exception_reason || '')}</dd>` : ''}
          ${e.corrects_event_id ? `<dt>${esc(t('corrects'))}</dt><dd><a href="/app/event/${e.corrects_event_id}" data-nav>#${e.corrects_event_id}</a></dd>` : ''}
          ${e.corrected_by_event_id ? `<dt>${esc(t('corrected_by'))}</dt><dd><a href="/app/event/${e.corrected_by_event_id}" data-nav>#${e.corrected_by_event_id}</a></dd>` : ''}
        </dl>
        ${e.cylinder ? `<p><a href="/app/cylinder/${esc(e.cylinder.id)}" data-nav>${esc(t('view_record'))} ›</a></p>` : ''}
      </div>
      ${e.lat != null ? '<div class="card"><div class="map" id="ev-map"></div></div>' : ''}
      ${e.flags.length ? `<div class="card"><h2>${esc(t('flags'))}</h2><p class="muted small">${esc(t('signals_note'))}</p>
        ${e.flags.map((f) => `<p><span class="pill flag">${esc(f.flag_type)}</span> <span class="small">${esc(f.detail || '')}</span></p>`).join('')}</div>` : ''}
      ${e.snapshot_id ? `<div class="card"><h2>${esc(t('scan_snapshot'))}</h2><img class="snapshot" src="/api/snapshots/${esc(e.snapshot_id)}" alt="${esc(t('scan_snapshot'))}"><p class="muted small">${esc(t('snapshot_review_hint'))}</p></div>` : ''}
      ${e.timeline_detail ? `<div class="card"><h2>${esc(t('timings'))}</h2><dl class="kv">
        <dt>${esc(t('t_started'))}</dt><dd>${esc(fmtTimeS(e.timeline_detail.session_started_at))}</dd>
        <dt>${esc(t('t_location'))}</dt><dd>${e.timeline_detail.location_confirmed_at ? esc(fmtTimeS(e.timeline_detail.location_confirmed_at)) : esc(t('exception') + ': ' + (e.timeline_detail.location_exception_reason || ''))}</dd>
        ${e.timeline_detail.scan_far_m ? `<dt>${esc(t('t_moved'))}</dt><dd>${e.timeline_detail.scan_far_m} m</dd>` : ''}
        <dt>${esc(t('t_code_sent'))}</dt><dd>${esc(fmtTimeS(e.timeline_detail.code_sent_at))}${e.timeline_detail.code_resends ? ` · ${e.timeline_detail.code_resends}× ${esc(t('resent'))}` : ''}</dd>
        <dt>${esc(t('t_code_ok'))}</dt><dd>${esc(fmtTimeS(e.timeline_detail.code_confirmed_at))}${e.timeline_detail.code_wrong_attempts ? ` · ${e.timeline_detail.code_wrong_attempts} ${esc(t('wrong_attempts'))}` : ''}</dd>
      </dl></div>` : ''}
      ${e.reference_photos && e.reference_photos.length ? `<div class="card"><h2>${esc(t('reference_photos'))}</h2><div class="photos">${e.reference_photos.map((p) => `<img src="/api/photos/${p.id}" alt="">`).join('')}</div></div>` : ''}
      ${e.checklist ? `<div class="card"><h2>${esc(t('checklist'))}</h2>${Object.entries(e.checklist).map(([k, v]) => `<p class="small">${v ? '☑' : '☐'} ${esc(t('ck_' + k))}</p>`).join('')}</div>` : ''}
      ${e.reviews && e.reviews.length ? `<div class="card"><h2>${esc(t('reviews'))}</h2>${e.reviews.map((rv) => `<p>${vsPill(rv.decision === 'approved' ? 'evidence_reviewed' : 'rejected')} ${esc(rv.reviewer)} · ${esc(fmtTime(rv.created_at))}${rv.reason_code ? ` · ${esc(t('rr_' + rv.reason_code))}` : ''}<br><span class="small">${esc(rv.notes || '')}</span></p>`).join('')}</div>` : ''}
      ${staff ? `<div class="card">
        ${own ? `<div class="notice warn">${esc(t('own_submission'))}</div>` : ''}
        ${reviewable ? `<h2>${esc(t('review_guidance'))}</h2><ul class="small"><li>${esc(t('guide_1'))}</li><li>${esc(t('guide_2'))}</li><li>${esc(t('guide_3'))}</li><li>${esc(t('guide_4'))}</li></ul>
          <label class="field">${esc(t('reject_reason'))}<select id="rr"><option value=""></option>${(r.data.reject_reasons || []).map((x) => `<option value="${x}">${esc(t('rr_' + x))}</option>`).join('')}</select></label>
          <label class="field">${esc(t('review_notes'))}<textarea id="notes"></textarea></label>
          <div id="err"></div>
          <div class="btn-row"><button class="btn" id="approve">${esc(t('approve'))}</button><button class="btn danger" id="reject">${esc(t('reject'))}</button></div>` : ''}
        ${e.event_type !== 'correction' ? `<div style="margin-top:12px"><button class="btn secondary" id="correct">${esc(t('add_correction'))}</button></div>` : ''}
      </div>` : ''}`, { back: true });
    if (e.lat != null) drawMap(qs('#ev-map'), [{ lat: e.lat, lng: e.lng, accuracy_m: e.accuracy_m }], { sites: e.site && state.sites.filter((s) => s.id === e.site.id) });
    const review = async (decision) => {
      const rr = await api('POST', `/api/events/${e.id}/review`, { decision, reason_code: qs('#rr').value, notes: qs('#notes').value });
      if (!rr.ok) { qs('#err').innerHTML = `<div class="notice bad">${esc(rr.data.message)}</div>`; return; }
      toast('✓');
      renderEvent(e.id);
    };
    if (qs('#approve')) { qs('#approve').onclick = () => review('approved'); qs('#reject').onclick = () => review('rejected'); }
    const cb = qs('#correct');
    if (cb) cb.onclick = async () => {
      const notes = prompt(t('correction_notes'));
      if (!notes) return;
      const rr = await api('POST', `/api/events/${e.id}/correction`, { notes });
      if (!rr.ok) return toast(rr.data.message);
      go(`/app/event/${rr.data.event.id}`);
    };
  }

  // ---------- dashboard ----------
  async function renderDashboard() {
    const [d, users] = await Promise.all([api('GET', '/api/dashboard'), api('GET', '/api/admin/users')]);
    if (!d.ok) { layout(t('dashboard'), `<div class="notice bad">${esc(d.data.message)}</div>`); return; }
    const x = d.data;
    const params = new URLSearchParams(location.search);
    const statuses = ['in_warehouse', 'in_transit', 'at_customer', 'empty_returned', 'maintenance', 'missing', 'retired'];
    const vstatuses = ['recorded', 'evidence_pending', 'evidence_reviewed', 'exception_pending', 'rejected'];
    const opt = (v, label, cur) => `<option value="${esc(v)}" ${cur === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
    layout(t('dashboard'), `
      <div class="stats">
        <div class="stat"><b>${x.registered_count}</b><span>${esc(t('registered_count'))}</span></div>
        <div class="stat"><b>${x.pending.evidence_pending}</b><span>${esc(t('pending_evidence'))}</span></div>
        <div class="stat"><b>${x.pending.exception_pending}</b><span>${esc(t('pending_exceptions'))}</span></div>
        <div class="stat"><b>${x.overdue_returns.length}</b><span>${esc(t('overdue_returns'))}</span></div>
        <div class="stat"><b>${x.no_recent_inspection.length}</b><span>${esc(t('no_recent'))} (&gt;${x.no_recent_days}d)</span></div>
        <div class="stat"><b>${x.codes.awaiting_sms_code}</b><span>${esc(t('awaiting_sms_code'))}</span></div>
        <div class="stat"><b>${x.codes.sms_unconfirmed}</b><span>${esc(t('sms_unconfirmed_24h'))}</span></div>
        <div class="stat"><b>${x.audits.open}</b><span>${esc(t('audits_open'))}${x.audits.unassigned ? ` (${x.audits.unassigned} ${esc(t('unassigned'))})` : ''}</span></div>
      </div>
      <div class="card"><h2>${esc(t('risk_summary'))}</h2><p class="muted small">${esc(t('signals_note'))}</p>
        <div class="grid2">
          <div><h3>${esc(t('by_driver'))}</h3>${x.risk.drivers.length ? `<table class="data">${x.risk.drivers.map((r) => `<tr><td>${esc(r.name || '')}</td><td><b>${r.total}</b></td><td class="small">${Object.entries(r.by_type).map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</td></tr>`).join('')}</table>` : `<p class="muted">${esc(t('no_items'))}</p>`}</div>
          <div><h3>${esc(t('by_customer_site'))}</h3>${x.risk.sites.length ? `<table class="data">${x.risk.sites.map((r) => `<tr><td>${esc(r.name || '')}</td><td><b>${r.total}</b></td><td class="small">${Object.entries(r.by_type).map(([k, n]) => `${esc(k)} ${n}`).join(', ')}</td></tr>`).join('')}</table>` : `<p class="muted">${esc(t('no_items'))}</p>`}
            ${x.risk.statement_no_answer.length ? `<p class="small"><b>${esc(t('statement_no_answer'))}:</b> ${x.risk.statement_no_answer.map((r) => `${esc(r.name)} (${r.n})`).join(', ')}</p>` : ''}</div>
        </div></div>
      <div class="grid2">
        <div class="card"><h2>${esc(t('weight_signals'))}</h2>${x.weight_signals.length ? `<table class="data">${x.weight_signals.map((w) => `<tr><td><a href="/app/event/${w.event_id}" data-nav>#${w.event_id}</a></td><td>${esc(w.serial)}</td><td><span class="pill flag">${esc(w.flag_type)}</span></td></tr>`).join('')}</table>` : `<p class="muted">${esc(t('no_items'))}</p>`}</div>
        <div class="card"><h2>${esc(t('statement_followups'))}</h2>${x.statement_followups.length ? `<table class="data">${x.statement_followups.map((w) => `<tr><td>${esc(w.site_name)}</td><td>${esc(w.response ? t('st_resp_' + w.response) : t('st_resp_no_answer'))}</td><td class="small">${esc(w.comments || '')}</td></tr>`).join('')}</table>` : `<p class="muted">${esc(t('no_items'))}</p>`}
          <p><a href="/app/statements" data-nav>${esc(t('statements'))} ›</a> · <a href="/app/audits" data-nav>${esc(t('audit_tasks'))} ›</a></p></div>
      </div>
      <div class="card"><h2>${esc(t('map'))}</h2><div class="map tall" id="dash-map"></div><p class="muted small">${esc(t('scan_note'))}</p></div>
      <div class="grid2">
        <div class="card"><h2>${esc(t('by_status'))}</h2><table class="data">${Object.entries(x.by_status).map(([k, v]) => `<tr><td>${msPill(k)}</td><td><b>${v}</b></td></tr>`).join('')}</table></div>
        <div class="card"><h2>${esc(t('by_site'))}</h2><table class="data">${Object.entries(x.by_site).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${Object.entries(v).map(([s, n]) => `${esc(t('ms_' + s))}: <b>${n}</b>`).join('<br>')}</td></tr>`).join('')}</table></div>
      </div>
      <div class="card"><h2>${esc(t('overdue_returns'))}</h2>${x.overdue_returns.length ? `<table class="data">${x.overdue_returns.map((o) => `<tr><td><a href="/app/cylinder/${esc(o.id)}" data-nav>${esc(o.serial)}</a></td><td>${esc(o.customer || o.site || '')}</td><td>${esc(fmtTime(o.due_at))}</td></tr>`).join('')}</table>` : `<p class="muted">${esc(t('no_items'))}</p>`}</div>
      <div class="card"><h2>${esc(t('no_recent'))}</h2>${x.no_recent_inspection.length ? `<table class="data">${x.no_recent_inspection.slice(0, 50).map((o) => `<tr><td><a href="/app/cylinder/${esc(o.id)}" data-nav>${esc(o.serial)}</a></td><td>${esc(fmtTime(o.last_event_at))}</td></tr>`).join('')}</table>` : `<p class="muted">${esc(t('no_items'))}</p>`}</div>
      <div class="card"><h2>${esc(t('suspicious'))}</h2><p class="muted small">${esc(t('signals_note'))}</p>${x.suspicious.length ? `<div class="table-wrap"><table class="data">${x.suspicious.map((s) => `<tr><td><a href="/app/event/${s.event_id}" data-nav>#${s.event_id}</a></td><td>${esc(s.serial)}</td><td><span class="pill flag">${esc(s.flag_type)}</span></td><td class="small">${esc(s.detail || '')}</td></tr>`).join('')}</table></div>` : `<p class="muted">${esc(t('no_items'))}</p>`}</div>
      <div class="card"><h2>${esc(t('cylinders'))} · ${esc(t('filters'))}</h2>
        <form id="flt" class="grid2">
          <label class="field">${esc(t('serial'))}<input name="serial" value="${esc(params.get('serial') || '')}"></label>
          <label class="field">${esc(t('gas_type'))}<input name="gas_type" value="${esc(params.get('gas_type') || '')}"></label>
          <label class="field">${esc(t('customer'))}<input name="customer" value="${esc(params.get('customer') || '')}"></label>
          <label class="field">${esc(t('site'))}<select name="site_id"><option value="">${esc(t('all'))}</option>${state.sites.map((s) => opt(s.id, s.name, params.get('site_id'))).join('')}</select></label>
          <label class="field">${esc(t('operator'))}<select name="operator_id"><option value="">${esc(t('all'))}</option>${(users.ok ? users.data.users : []).map((u) => opt(u.id, u.display_name, params.get('operator_id'))).join('')}</select></label>
          <label class="field">${esc(t('movement_status'))}<select name="movement_status"><option value="">${esc(t('all'))}</option>${statuses.map((s) => opt(s, t('ms_' + s), params.get('movement_status'))).join('')}</select></label>
          <label class="field">${esc(t('verification_status'))}<select name="verification_status"><option value="">${esc(t('all'))}</option>${vstatuses.map((s) => opt(s, t('vs_' + s), params.get('verification_status'))).join('')}</select></label>
          <label class="field">${esc(t('date_from'))}<input type="date" name="date_from" value="${esc(params.get('date_from') || '')}"></label>
          <label class="field">${esc(t('date_to'))}<input type="date" name="date_to" value="${esc(params.get('date_to') || '')}"></label>
          <div class="btn-row" style="align-items:end"><button class="btn small" type="submit">${esc(t('search'))}</button><button class="btn small secondary" type="button" id="clr">${esc(t('clear'))}</button></div>
        </form>
        <div class="btn-row" style="margin:8px 0"><a class="btn small secondary" id="csv-c" href="#">${esc(t('export_csv'))}</a><a class="btn small secondary" id="csv-e" href="#">${esc(t('export_events'))}</a></div>
        <div class="table-wrap" id="cyl-table">${esc(t('loading'))}</div>
      </div>`, { back: '/', wide: true });
    drawMap(qs('#dash-map'), x.markers.map((m) => ({ lat: m.lat, lng: m.lng, accuracy_m: m.accuracy_m,
      label: `<b>${esc(m.serial)}</b><br>${esc(t('ms_' + m.movement_status))}<br>${esc(t('recorded_at'))}: ${esc(fmtTime(m.recorded_at))}<br>${esc(t('age'))}: ${m.age_hours} ${esc(t('hours'))} · ${esc(fmtAcc(m.accuracy_m))}` })), { sites: x.sites });
    const query = new URLSearchParams([...params.entries()].filter(([, v]) => v)).toString();
    qs('#csv-c').href = `/api/export/cylinders.csv?${query}`;
    qs('#csv-e').href = `/api/export/events.csv?${query}`;
    qs('#csv-c').removeAttribute('data-nav'); qs('#csv-e').removeAttribute('data-nav');
    qs('#flt').onsubmit = (ev) => { ev.preventDefault(); const q = new URLSearchParams([...new FormData(ev.target)].filter(([, v]) => v)); go(`/app/dashboard?${q}`); };
    qs('#clr').onclick = () => go('/app/dashboard');
    const list = await api('GET', `/api/cylinders?${query}`);
    qs('#cyl-table').innerHTML = cylTable(list.ok ? list.data.cylinders : [], false);
  }

  function cylTable(rows, selectable) {
    if (!rows.length) return `<p class="muted">${esc(t('no_items'))}</p>`;
    return `<table class="data"><tr>${selectable ? '<th><input type="checkbox" id="sel-all" style="width:22px;min-height:22px"></th>' : ''}<th>${esc(t('serial'))}</th><th>${esc(t('gas_type'))}</th><th>${esc(t('movement_status'))}</th><th>${esc(t('last_recorded_location'))}</th><th>${esc(t('recorded_at'))}</th><th>${esc(t('verification_status'))}</th><th>${esc(t('latest_submitted'))}</th></tr>
      ${rows.map((c) => `<tr>${selectable ? `<td><input type="checkbox" class="sel" value="${esc(c.id)}" style="width:22px;min-height:22px"></td>` : ''}
        <td><a href="/app/cylinder/${esc(c.id)}" data-nav><b>${esc(c.serial)}</b></a><br><span class="muted small">${esc(c.id)}</span></td>
        <td>${esc(c.gas_type)}</td><td>${msPill(c.movement_status)}</td>
        <td>${c.last_approved ? esc(c.last_approved.site ? c.last_approved.site.name : '') + (c.last_approved.accuracy_m != null ? `<br><span class="muted small">${esc(fmtAcc(c.last_approved.accuracy_m))}</span>` : '') : t('none')}</td>
        <td class="small">${c.last_approved ? esc(fmtTime(c.last_approved.server_received_at)) : ''}</td>
        <td>${c.last_approved ? vsPill(c.last_approved.verification_status) : ''}</td>
        <td>${c.latest_submitted && (!c.last_approved || c.latest_submitted.id !== c.last_approved.id) ? `#${c.latest_submitted.id} ${vsPill(c.latest_submitted.verification_status)}` : ''}</td></tr>`).join('')}</table>`;
  }

  // ---------- admin ----------
  function renderRegister() {
    const conds = ['good', 'damaged', 'leaking', 'label_damaged', 'needs_supervisor'];
    layout(t('register_cylinder'), `<form id="reg" class="card">
      <label class="field"><span class="req">${esc(t('serial'))}</span><input name="serial" required maxlength="80" autocapitalize="characters"></label>
      <div class="grid2">
        <label class="field"><span class="req">${esc(t('brand_owner'))}</span><input name="brand_owner" required></label>
        <label class="field"><span class="req">${esc(t('gas_type'))}</span><input name="gas_type" required list="gases"></label>
        <label class="field"><span class="req">${esc(t('size'))}</span><input name="size" required placeholder="13.6 kg"></label>
        <label class="field"><span class="req">${esc(t('tare_kg'))}</span><input name="tare_kg" type="number" step="0.01" min="0.1" required></label>
        <label class="field">${esc(t('registration_date'))}<input name="registration_date" type="date" value="${new Date().toISOString().slice(0, 10)}"></label>
        <label class="field">${esc(t('expected_return_days'))}<input name="expected_return_days" type="number" min="1"></label>
      </div>
      <datalist id="gases"><option>R-22</option><option>R-32</option><option>R-134a</option><option>R-404A</option><option>R-410A</option><option>R-407C</option><option>R-600a</option></datalist>
      <label class="field"><span class="req">${esc(t('initial_site'))}</span><select name="initial_site_id" required><option value=""></option>${siteOptions('')}</select></label>
      <label class="field">${esc(t('storage_bay'))}<input name="initial_bay"></label>
      <label class="field"><span class="req">${esc(t('initial_condition'))}</span><select name="initial_condition">${conds.map((x) => `<option value="${x}">${esc(t('cond_' + x))}</option>`).join('')}</select></label>
      <h3>${esc(t('reg_photos'))}</h3>
      <div class="grid2">
        <label class="field"><span class="req">${esc(t('photo_whole'))}</span><input name="photo_whole" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required></label>
        <label class="field"><span class="req">${esc(t('photo_serial'))}</span><input name="photo_serial" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required></label>
      </div>
      <label class="field">${esc(t('nfc_uid'))} (${esc(t('optional'))})<input name="nfc_tag_uid"><span class="muted small">${esc(t('nfc_unavailable'))}</span></label>
      <div id="err"></div>
      <button class="btn" type="submit">${esc(t('register_cylinder'))}</button></form>`, { back: '/' });
    qs('#reg').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      const r = await api('POST', '/api/cylinders', undefined, { form: new FormData(e.target) });
      btn.disabled = false;
      if (!r.ok) { qs('#err').innerHTML = `<div class="notice bad">${esc(r.data.message)}</div>`; return; }
      toast(`${t('registered_ok')}: ${r.data.cylinder.id}`);
      go(`/app/cylinder/${r.data.cylinder.id}`);
    };
  }

  async function renderCylinders() {
    const params = new URLSearchParams(location.search);
    const r = await api('GET', `/api/cylinders?serial=${encodeURIComponent(params.get('serial') || '')}`);
    layout(t('cylinders'), `<div class="card">
      <form id="s" class="btn-row"><input name="serial" placeholder="${esc(t('serial'))}" value="${esc(params.get('serial') || '')}" style="flex:2 1 200px;margin:0"><button class="btn small" type="submit">${esc(t('search'))}</button></form>
      <div class="btn-row" style="margin:12px 0"><button class="btn small" id="print-sel">${esc(t('print_selected'))}</button><a class="btn small secondary" href="/app/register" data-nav>${esc(t('register_cylinder'))}</a></div>
      <div class="table-wrap">${cylTable(r.ok ? r.data.cylinders : [], true)}</div></div>`, { back: '/', wide: true });
    qs('#s').onsubmit = (e) => { e.preventDefault(); go(`/app/cylinders?serial=${encodeURIComponent(e.target.serial.value)}`); };
    const all = qs('#sel-all');
    if (all) all.onchange = () => qsa('.sel').forEach((c) => { c.checked = all.checked; });
    qs('#print-sel').onclick = () => {
      const ids = qsa('.sel').filter((c) => c.checked).map((c) => c.value);
      if (!ids.length) return toast(t('select'));
      printLabels(ids);
    };
  }

  // Phone verification: send a code to the number, then type it back.
  function verifyBox(id, sendUrl, verifyUrl) {
    return `<div class="verify-box" data-vid="${id}" data-send="${esc(sendUrl)}" data-verify="${esc(verifyUrl)}">
      <button type="button" class="btn small secondary vb-send">${esc(t('send_code'))}</button>
      <input class="vb-code" inputmode="numeric" maxlength="4" placeholder="••••" aria-label="${esc(t('four_digit_code'))}" style="max-width:120px;display:inline-block">
      <button type="button" class="btn small vb-verify">${esc(t('verify'))}</button>
      <div class="vb-msg small"></div></div>`;
  }
  function bindVerifyBoxes(onDone) {
    qsa('.verify-box').forEach((box) => {
      const msg = (txt, bad) => { const m = box.querySelector('.vb-msg'); m.textContent = txt; m.style.color = bad ? 'var(--bad)' : 'var(--green-dark)'; };
      box.querySelector('.vb-send').onclick = async () => {
        const r = await api('POST', box.dataset.send, {});
        if (!r.ok) return msg(r.data.message, true);
        msg(`${t('code_sent_to')} ${r.data.phone_masked}`);
        if (state.config.sms_dev) {
          const o = await api('GET', '/api/dev/sms-outbox');
          if (o.ok && o.data.messages[0]) msg(`${t('code_sent_to')} ${r.data.phone_masked} · ${t('dev_sms_title')}: ${o.data.messages[0].text}`);
        }
      };
      box.querySelector('.vb-verify').onclick = async () => {
        const code = box.querySelector('.vb-code').value.trim();
        const r = await api('POST', box.dataset.verify, { code });
        if (!r.ok) return msg(r.data.message, true);
        msg(`✓ ${t('verified')}`);
        if (onDone) setTimeout(onDone, 600);
      };
    });
  }

  async function renderPhone() {
    const r = await api('GET', '/api/me/phone');
    const p = r.ok ? r.data : {};
    layout(t('my_phone'), `<div class="card">
      <h2>${esc(t('my_phone'))}</h2>
      <dl class="kv"><dt>${esc(t('registered_number'))}</dt><dd>${p.registered ? esc(p.phone_masked) : esc(t('none'))}</dd>
      <dt>${esc(t('status'))}</dt><dd>${p.verified ? `<span class="pill vs-recorded">${esc(t('verified'))}</span>` : `<span class="pill vs-rejected">${esc(t('not_verified'))}</span>`}</dd></dl>
      ${!p.registered ? `<div class="notice warn">${esc(t('phone_ask_admin'))}</div>` : ''}
      ${p.registered && !p.verified ? `<p>${esc(t('phone_verify_now'))}</p>${verifyBox('me', '/api/me/phone/send-code', '/api/me/phone/verify')}` : ''}
      <p class="muted small">${esc(t('phone_why'))}</p></div>`, { back: '/' });
    bindVerifyBoxes(() => renderPhone());
  }

  async function renderSites() {
    const r = await api('GET', '/api/admin/sites');
    const rows = r.ok ? r.data.sites : [];
    const form = (s = {}) => `<form class="card site-form" data-id="${s.id || ''}">
      ${s.id ? `<b>${esc(s.name)}</b>` : ''}
      <div class="grid2">
        <label class="field">${esc(t('code'))}<input name="code" value="${esc(s.code || '')}" required></label>
        <label class="field">${esc(t('name'))}<input name="name" value="${esc(s.name || '')}" required></label>
        <label class="field">${esc(t('kind'))}<select name="kind"><option value="warehouse" ${s.kind === 'warehouse' ? 'selected' : ''}>${esc(t('warehouse'))}</option><option value="customer" ${s.kind === 'customer' ? 'selected' : ''}>${esc(t('customer'))}</option></select></label>
        <label class="field">${esc(t('customer'))}<input name="customer_name" value="${esc(s.customer_name || '')}"></label>
      </div>
      <label class="field">${esc(t('address'))}<input name="address" value="${esc(s.address || '')}"></label>
      <div class="muted small">${esc(t('geofence'))}</div>
      <div class="grid2"><label class="field">Lat<input name="lat" type="number" step="any" value="${s.lat ?? ''}"></label><label class="field">Lng<input name="lng" type="number" step="any" value="${s.lng ?? ''}"></label>
      <label class="field">Radius m<input name="radius_m" type="number" value="${s.radius_m ?? ''}"></label>
      <label class="check" style="align-self:end"><input type="checkbox" name="active" ${s.active === 0 ? '' : 'checked'}>${esc(t('active'))}</label></div>
      <label class="field">${esc(t('contact_phone'))} <span class="muted small">(${esc(t('contact_phone_hint'))})</span><input name="contact_phone" inputmode="tel" value="${esc(s.contact_phone_e164 || '')}"></label>
      ${s.id && s.contact_phone_e164 ? `<p class="small">${s.contact_phone_verified_at ? `<span class="pill vs-recorded">${esc(t('verified'))}</span>` : `<span class="pill vs-rejected">${esc(t('not_verified'))}</span> ${esc(t('verify_with_customer'))}`}</p>
        ${!s.contact_phone_verified_at ? verifyBox(`site${s.id}`, `/api/admin/sites/${s.id}/phone/send-code`, `/api/admin/sites/${s.id}/phone/verify`) : ''}` : ''}
      <button class="btn small" type="submit">${esc(t('save'))}</button></form>`;
    layout(t('sites'), `<h2>${esc(t('add_site'))}</h2>${form()}<div class="section-title">${esc(t('sites'))}</div>${rows.map(form).join('')}`, { back: '/' });
    bindVerifyBoxes(() => renderSites());
    qsa('.site-form').forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const body = Object.fromEntries(new FormData(f));
        body.active = f.active.checked;
        const id = f.dataset.id;
        const rr = await api(id ? 'PUT' : 'POST', id ? `/api/admin/sites/${id}` : '/api/admin/sites', body);
        toast(rr.ok ? '✓' : rr.data.message);
        if (rr.ok) { await loadSites(); renderSites(); }
      };
    });
  }

  async function renderUsers() {
    const r = await api('GET', '/api/admin/users');
    const rows = r.ok ? r.data.users : [];
    const roles = ['operator', 'supervisor', 'admin'];
    layout(t('users'), `
      <form id="add" class="card"><h2>${esc(t('add_user'))}</h2><div class="grid2">
        <label class="field">${esc(t('username'))}<input name="username" required autocapitalize="none"></label>
        <label class="field">${esc(t('display_name'))}<input name="display_name"></label>
        <label class="field">${esc(t('role'))}<select name="role">${roles.map((x) => `<option value="${x}">${esc(t('role_' + x))}</option>`).join('')}</select></label>
        <label class="field">${esc(t('password'))} (≥10)<input name="password" type="password" minlength="10" required autocomplete="new-password"></label>
        <label class="field">${esc(t('mobile_number'))}<input name="phone" inputmode="tel" placeholder="081-234-5678"></label></div>
        <button class="btn small" type="submit">${esc(t('save'))}</button></form>
      ${rows.map((u) => `<form class="card user-form" data-id="${u.id}"><div class="row-between"><b>${esc(u.username)}</b>${u.phone ? (u.phone_verified ? `<span class="pill vs-recorded">${esc(t('phone_verified'))}</span>` : `<span class="pill vs-rejected">${esc(t('phone_unverified'))}</span>`) : `<span class="pill">${esc(t('no_phone'))}</span>`}</div><div class="grid2">
        <label class="field">${esc(t('display_name'))}<input name="display_name" value="${esc(u.display_name)}"></label>
        <label class="field">${esc(t('role'))}<select name="role">${roles.map((x) => `<option value="${x}" ${u.role === x ? 'selected' : ''}>${esc(t('role_' + x))}</option>`).join('')}</select></label>
        <label class="field">${esc(t('mobile_number'))}<input name="phone" inputmode="tel" value="${esc(u.phone || '')}"></label>
        <label class="field">${esc(t('reset_password'))}<input name="password" type="password" autocomplete="new-password"></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}>${esc(t('active'))}</label></div>
        ${u.phone && !u.phone_verified ? `<p class="small">${esc(t('verify_with_user'))}</p>${verifyBox(`u${u.id}`, `/api/admin/users/${u.id}/phone/send-code`, `/api/admin/users/${u.id}/phone/verify`)}` : ''}
        <button class="btn small" type="submit">${esc(t('save'))}</button></form>`).join('')}`, { back: '/' });
    bindVerifyBoxes(() => renderUsers());
    qs('#add').onsubmit = async (e) => {
      e.preventDefault();
      const rr = await api('POST', '/api/admin/users', Object.fromEntries(new FormData(e.target)));
      toast(rr.ok ? '✓' : rr.data.message);
      if (rr.ok) renderUsers();
    };
    qsa('.user-form').forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const body = { display_name: f.display_name.value, role: f.role.value, active: f.active.checked, phone: f.phone.value.trim() };
        if (f.password.value) body.password = f.password.value;
        const rr = await api('PUT', `/api/admin/users/${f.dataset.id}`, body);
        toast(rr.ok ? '✓' : rr.data.message);
        if (rr.ok) renderUsers();
      };
    });
  }

  // ---------- audits ----------
  async function renderAudits() {
    const r = await api('GET', '/api/audits');
    if (!r.ok) { layout(t('audit_tasks'), `<div class="notice bad">${esc(r.data.message)}</div>`, { back: '/' }); return; }
    const isAdmin = state.user.role === 'admin';
    const open = r.data.audits.filter((a) => a.status === 'open');
    const done = r.data.audits.filter((a) => a.status === 'done');
    const card = (a) => `<div class="card">
      <div class="row-between"><b>#${a.id} · ${esc(a.serial)}</b>${msPill(a.movement_status)}</div>
      <p class="small">${esc(a.site ? a.site.name : '')}${a.site && a.site.customer_name ? ` (${esc(a.site.customer_name)})` : ''}<br>
      ${esc(t('risk'))}: ${a.risk_score} · ${esc(a.reasons || '')}<br>${esc(t('assigned_to'))}: ${esc(a.assigned_name || t('unassigned'))}</p>
      ${a.status === 'open' && a.assigned_to === state.user.id ? `<div class="btn-row">
        <a class="btn small" href="/app/inspect?audit=${a.id}" data-nav>${esc(t('start_audit'))}</a>
        <button class="btn small danger" data-nf="${a.id}">${esc(t('ao_not_found'))}</button>
        <button class="btn small secondary" data-ref="${a.id}">${esc(t('ao_customer_refused'))}</button></div>` : ''}
      ${a.status === 'open' && isAdmin ? `<div class="btn-row" style="margin-top:8px"><button class="btn small secondary" data-assign="${a.id}">${esc(t('assign'))}</button></div>` : ''}
      ${a.status === 'done' ? `<p class="small">${esc(t('ao_' + a.outcome))} · ${esc(a.completed_by || '')} · ${esc(fmtTime(a.completed_at))}${a.outcome_event_id ? ` · <a href="/app/event/${a.outcome_event_id}" data-nav>#${a.outcome_event_id}</a>` : ''}</p>` : ''}
    </div>`;
    layout(t('audit_tasks'), `
      <div class="notice info small">${esc(t('audit_intro'))}</div>
      ${isAdmin ? `<div class="card btn-row"><input id="gen-n" type="number" min="1" max="100" value="5" style="max-width:110px;margin:0" aria-label="count"><button class="btn small" id="gen">${esc(t('generate_audits'))}</button></div>` : ''}
      <div class="section-title">${esc(t('open'))} (${open.length})</div>${open.map(card).join('') || `<p class="muted">${esc(t('no_items'))}</p>`}
      <div class="section-title">${esc(t('completed'))}</div>${done.slice(0, 30).map(card).join('') || `<p class="muted">${esc(t('no_items'))}</p>`}`, { back: '/' });
    const g = qs('#gen');
    if (g) g.onclick = async () => { const rr = await api('POST', '/api/audits/generate', { count: Number(qs('#gen-n').value) }); toast(rr.ok ? `${rr.data.created} ✓` : rr.data.message); renderAudits(); };
    qsa('[data-nf]').forEach((b) => { b.onclick = async () => { const c = prompt(t('not_found_prompt')); if (!c) return; const rr = await api('POST', `/api/audits/${b.dataset.nf}/not-found`, { comments: c }); toast(rr.ok ? '✓' : rr.data.message); renderAudits(); }; });
    qsa('[data-ref]').forEach((b) => { b.onclick = async () => { const c = prompt(t('refused_prompt')); if (!c) return; const rr = await api('POST', `/api/audits/${b.dataset.ref}/refused`, { comments: c }); toast(rr.ok ? '✓' : rr.data.message); renderAudits(); }; });
    qsa('[data-assign]').forEach((b) => {
      b.onclick = async () => {
        const el = await api('GET', `/api/audits/${b.dataset.assign}/eligible`);
        if (!el.ok || !el.data.users.length) return toast(t('no_eligible_auditor'));
        const names = el.data.users.map((u, i) => `${i + 1}. ${u.display_name}`).join('\n');
        const pick = Number(prompt(`${t('assign')}:\n${names}`));
        const u = el.data.users[pick - 1];
        if (!u) return;
        const rr = await api('POST', `/api/audits/${b.dataset.assign}/assign`, { user_id: u.id });
        toast(rr.ok ? '✓' : rr.data.message); renderAudits();
      };
    });
  }

  // ---------- customer holdings statements ----------
  async function renderStatements() {
    const r = await api('GET', '/api/statements');
    const rows = r.ok ? r.data.statements : [];
    layout(t('statements'), `
      <div class="notice info small">${esc(t('statements_intro'))}</div>
      ${state.user.role === 'admin' ? `<div class="card"><button class="btn" id="gen">${esc(t('send_statements'))}</button><div id="gen-res"></div></div>` : ''}
      <div class="card table-wrap"><table class="data"><tr><th>${esc(t('site'))}</th><th>${esc(t('cylinders_count'))}</th><th>${esc(t('status'))}</th><th>${esc(t('recorded_at'))}</th><th>${esc(t('comments'))}</th></tr>
      ${rows.map((s) => `<tr><td>${esc(s.site_name)}<br><span class="muted small">${esc(s.phone_masked)}</span></td><td>${s.cylinders.length}</td><td>${esc(t('st_resp_' + s.status))}</td><td class="small">${esc(fmtTime(s.created_at))}</td><td class="small">${esc(s.comments || '')}</td></tr>`).join('') || `<tr><td colspan="5">${esc(t('no_items'))}</td></tr>`}</table></div>`, { back: '/', wide: true });
    const g = qs('#gen');
    if (g) g.onclick = async () => {
      g.disabled = true;
      const rr = await api('POST', '/api/statements/generate', {});
      if (!rr.ok) { toast(rr.data.message); g.disabled = false; return; }
      qs('#gen-res').innerHTML = `<p class="small">${esc(t('sent'))}: ${rr.data.sent.map((x) => esc(x.site)).join(', ') || '—'}<br>${esc(t('skipped'))}: ${rr.data.skipped.map((x) => `${esc(x.site)} (${esc(x.reason)})`).join(', ') || '—'}</p>`;
      setTimeout(renderStatements, 2500);
    };
  }

  // Public page for the customer (no login): confirm or dispute the count.
  async function renderPublicStatement(token) {
    const r = await api('GET', `/api/public/statement/${encodeURIComponent(token)}`);
    if (!r.ok) { layout(t('statement_title'), `<div class="notice bad">${esc(r.data.message)}</div>`, { back: false }); return; }
    const d = r.data;
    const closed = d.response || d.expired;
    layout(t('statement_title'), `<div class="card">
      <h2>${esc(d.site_name)}</h2>
      <p>${esc(t('statement_question'))}</p>
      <p class="challenge-code" style="letter-spacing:2px">${d.cylinders.length}</p>
      <ul class="small">${d.cylinders.map((sn) => `<li>${esc(sn)}</li>`).join('')}</ul>
      ${d.response ? `<div class="notice info">${esc(t('statement_thanks'))} (${esc(t('st_resp_' + d.response))})</div>` : d.expired ? `<div class="notice warn">${esc(t('statement_expired'))}</div>` : ''}
      ${!closed ? `<label class="field">${esc(t('comments'))} (${esc(t('if_different'))})<textarea id="st-c"></textarea></label>
        <div id="st-err"></div>
        <div class="btn-row"><button class="btn" id="st-ok">${esc(t('statement_confirm'))}</button><button class="btn danger" id="st-no">${esc(t('statement_dispute'))}</button></div>` : ''}
    </div>`, { back: false });
    const send = async (response) => {
      const rr = await api('POST', `/api/public/statement/${encodeURIComponent(token)}`, { response, comments: qs('#st-c').value });
      if (!rr.ok) { qs('#st-err').innerHTML = `<div class="notice bad">${esc(rr.data.message)}</div>`; return; }
      renderPublicStatement(token);
    };
    if (qs('#st-ok')) { qs('#st-ok').onclick = () => send('confirm'); qs('#st-no').onclick = () => send('dispute'); }
  }

  async function renderSettings() {
    const r = await api('GET', '/api/admin/settings');
    const s = r.ok ? r.data.settings : {};
    const keys = Object.keys(r.ok ? r.data.defaults : {});
    layout(t('settings'), `<form id="st" class="card"><h2>${esc(t('pilot_settings'))}</h2>
      ${keys.map((k) => `<label class="field">${esc(t('st_' + k))}<input name="${k}" type="number" min="0" step="any" value="${esc(s[k])}"></label>`).join('')}
      <button class="btn" type="submit">${esc(t('save'))}</button></form>
      <div class="card"><button class="btn secondary" id="ret">${esc(t('run_retention'))}</button></div>`, { back: '/' });
    qs('#st').onsubmit = async (e) => {
      e.preventDefault();
      const rr = await api('PUT', '/api/admin/settings', Object.fromEntries(new FormData(e.target)));
      toast(rr.ok ? '✓' : rr.data.message);
      if (rr.ok) await loadConfig();
    };
    qs('#ret').onclick = async () => { const rr = await api('POST', '/api/admin/retention/run', {}); toast(rr.ok ? `purged ${rr.data.purged}` : rr.data.message); };
  }

  async function renderAudit() {
    const r = await api('GET', '/api/admin/audit');
    const rows = r.ok ? r.data.entries : [];
    layout(t('audit_log'), `<div class="card table-wrap"><table class="data"><tr><th>#</th><th>${esc(t('recorded_at'))}</th><th>User</th><th>Action</th><th>Entity</th></tr>
      ${rows.map((a) => `<tr><td>${a.id}</td><td class="small">${esc(fmtTime(a.created_at))}</td><td>${esc(a.user || '')}</td><td>${esc(a.action)}</td><td class="small">${esc(a.entity || '')} ${esc(a.entity_id || '')}</td></tr>`).join('')}</table></div>`, { back: '/', wide: true });
  }

  // ---------- router ----------
  async function loadConfig() {
    const r = await api('GET', '/api/config');
    state.config = r.ok ? r.data : {};
  }

  async function route() {
    const p = location.pathname;
    const m = (re) => p.match(re);
    let mm;
    if ((mm = m(/^\/c\/([A-Za-z0-9_-]+)\/?$/))) return renderQrLanding(mm[1]);
    if ((mm = m(/^\/s\/([A-Za-z0-9_-]+)\/?$/))) return renderPublicStatement(mm[1]);
    if (!state.user) {
      const next = p === '/app/login' ? new URLSearchParams(location.search).get('next') : (p !== '/' ? p + location.search : null);
      return renderLogin(next && next.startsWith('/') && !next.startsWith('//') ? next : null);
    }
    if (p !== '/app/inspect' && insp) endInspection();
    if (p === '/' || p === '/app/login') return renderHome();
    if (p === '/app/inspect') {
      const a = new URLSearchParams(location.search).get('audit');
      if (insp && insp.done) endInspection();
      if (a && (!insp || insp.auditId !== Number(a))) endInspection();
      return renderInspect({ auditId: a ? Number(a) : null });
    }
    if (p === '/app/phone') return renderPhone();
    if (p === '/app/audits') return renderAudits();
    if (p === '/app/statements') return renderStatements();
    if (p === '/app/recent') return renderRecent();
    if (p === '/app/pending') return renderPending();
    if (p === '/app/damaged') return renderDamaged();
    if ((mm = m(/^\/app\/cylinder\/([^/]+)$/))) return renderCylinder(decodeURIComponent(mm[1]));
    if ((mm = m(/^\/app\/event\/(\d+)$/))) return renderEvent(mm[1]);
    if (p === '/app/review') return renderReviewQueue();
    if (p === '/app/dashboard') return renderDashboard();
    if (p === '/app/register') return renderRegister();
    if (p === '/app/cylinders') return renderCylinders();
    if (p === '/app/sites') return renderSites();
    if (p === '/app/users') return renderUsers();
    if (p === '/app/settings') return renderSettings();
    if (p === '/app/audit') return renderAudit();
    return renderHome();
  }

  (async () => {
    document.documentElement.lang = state.lang;
    await loadConfig();
    const me = await api('GET', '/api/auth/me');
    state.user = me.ok ? me.data.user : null;
    if (state.user) await loadSites();
    route();
  })();
})();
