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

  function layout(title, body, { back = '/', wide = false } = {}) {
    stopMedia();
    $app.innerHTML = `
      <header class="top">
        ${back ? `<button type="button" id="nav-back" aria-label="${esc(t('back'))}">‹</button>` : ''}
        <h1>${esc(title)}</h1>
        <button type="button" class="lang-toggle" id="lang-toggle">${state.lang === 'en' ? 'ไทย' : 'EN'}</button>
        ${state.user ? `<button type="button" id="logout">${esc(t('logout'))}</button>` : ''}
      </header>
      <main class="${wide ? 'wide' : ''}">${body}</main>`;
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
    if (activeStream && !(wiz && wiz.keepStream)) { activeStream.getTracks().forEach((tr) => tr.stop()); activeStream = null; }
  }
  function releaseStream() {
    if (activeStream) { activeStream.getTracks().forEach((tr) => tr.stop()); activeStream = null; }
  }

  async function getCameraStream() {
    if (activeStream && activeStream.getVideoTracks().some((tr) => tr.readyState === 'live')) return activeStream;
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
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

  // ---------- pending queue (this device) ----------
  const PQ = 'ftt_pending';
  const pendingLoad = () => { try { return JSON.parse(localStorage.getItem(PQ) || '[]'); } catch { return []; } };
  const pendingSave = (arr) => { try { localStorage.setItem(PQ, JSON.stringify(arr)); } catch { /* ignore */ } };

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
    const pendingLocal = pendingLoad().length;
    let reviewCount = 0;
    if (['supervisor', 'admin'].includes(u.role)) {
      const r = await api('GET', '/api/review/queue');
      if (r.ok) reviewCount = r.data.events.filter((e) => !e.own_submission).length;
    }
    const canInspect = true;
    layout(t('app_name'), `
      <p class="muted">${esc(u.display_name)} · ${esc(t('role_' + u.role))}</p>
      <div class="home-grid">
        ${canInspect ? `<a class="tile primary" href="/app/inspect" data-nav><span class="ico">⌖</span>${esc(t('scan_cylinder'))}</a>` : ''}
        <a class="tile" href="/app/recent" data-nav><span class="ico">🕘</span>${esc(t('my_recent'))}</a>
        <a class="tile" href="/app/pending" data-nav><span class="ico">⏳</span>${esc(t('pending_submissions'))}${pendingLocal ? ` <span class="badge">${pendingLocal}</span>` : ''}</a>
        <a class="tile" href="/app/damaged" data-nav style="grid-column:1/-1;min-height:84px"><span class="ico">⚠</span>${esc(t('report_damaged_label'))}</a>
      </div>
      ${['supervisor', 'admin'].includes(u.role) ? `
        <div class="section-title">${esc(t('supervisor_tools'))}</div>
        <div class="card list-links">
          <a href="/app/review" data-nav>${esc(t('review_queue'))} ${reviewCount ? `<span class="pill vs-evidence_pending">${reviewCount}</span>` : '›'}</a>
          <a href="/app/dashboard" data-nav>${esc(t('dashboard'))} ›</a>
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

  // ---------- controlled inspection wizard ----------
  let wiz = null;
  const STEPS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

  function newWizard(mode = 'normal') {
    return {
      mode, step: 1, session: null, cylinder: null, challenge: null, fix: null, fixError: null, mediaId: null,
      perms: { camera: 'pending', location: 'pending' }, keepStream: true,
      form: { event_type: 'inspection', site_id: '', bay: '', destination_site_id: '', delivery_ref: '', responsible_person: '', expected_return_date: '', condition: 'good', comments: '', checklist: {} },
      idemKey: uuid(),
    };
  }

  function wizLayout(body) {
    const n = wiz.step;
    const steps = STEPS.map((_, i) => `<span class="${i + 1 < n ? 'done' : i + 1 === n ? 'cur' : ''}"></span>`).join('');
    layout(wiz.mode === 'damaged_label' ? t('damaged_title') : t('scan_cylinder'), `
      <div class="steps">${steps}</div>
      <div class="step-label">${esc(t('step'))} ${n} ${esc(t('of'))} 8 · ${esc(t(STEPS[n - 1]))}</div>
      ${wiz.cylinder && n > 3 ? `<p class="muted small">${esc(wiz.cylinder.serial)} · ${esc(wiz.cylinder.id)}</p>` : ''}
      ${body}
      <div style="margin-top:18px"><button class="btn secondary" id="wiz-cancel">${esc(t('cancel'))}</button></div>`, { back: false });
    qs('#wiz-cancel').onclick = async () => {
      if (wiz.session) await api('POST', `/api/inspections/${wiz.session.id}/cancel`, {});
      endWizard();
      go('/');
    };
  }

  function endWizard() {
    if (wiz) wiz.keepStream = false;
    releaseStream();
    wiz = null;
  }

  function renderWizard() {
    if (!wiz) wiz = newWizard();
    if (!window.isSecureContext) {
      layout(t('scan_cylinder'), `<div class="notice bad">${esc(t('insecure_context'))}</div>`, { back: '/' });
      return;
    }
    const fns = { 1: wStart, 2: wPerms, 3: wScan, 4: wConfirm, 5: wLocation, 6: wEvidence, 7: wChecklist, 8: wReview };
    fns[wiz.step]();
  }
  const nextStep = (n) => { wiz.step = n || wiz.step + 1; renderWizard(); };

  function wStart() {
    wizLayout(`<div class="card"><p>${esc(t('s1_text'))}</p><button class="btn" id="go">${esc(t('start_session'))}</button><div id="err"></div></div>`);
    qs('#go').onclick = async () => {
      const r = await api('POST', '/api/inspections', {});
      if (!r.ok) { qs('#err').innerHTML = `<div class="notice bad">${esc(r.data.message)}</div>`; return; }
      wiz.session = r.data.session;
      nextStep(2);
    };
  }

  async function wPerms() {
    const p = wiz.perms;
    const cls = (v) => (v === 'granted' ? 'vs-recorded' : v === 'denied' ? 'vs-rejected' : '');
    wizLayout(`<div class="card">
      <p>${esc(t('s2_text'))}</p>
      <dl class="kv"><dt>${esc(t('camera'))}</dt><dd><span class="pill ${cls(p.camera)}">${esc(t(p.camera))}</span></dd>
      <dt>${esc(t('location'))}</dt><dd><span class="pill ${cls(p.location)}">${esc(t(p.location))}</span></dd></dl>
      ${p.camera === 'denied' ? `<div class="notice bad">${esc(t('camera_denied_help'))}</div>` : ''}
      ${p.location === 'denied' ? `<div class="notice warn">${esc(t('location_denied_help'))}</div>` : ''}
      <div class="stack" style="margin-top:12px">
        <button class="btn" id="req">${esc(p.camera === 'pending' ? t('request_permissions') : t('retry'))}</button>
        ${p.camera === 'granted' ? `<button class="btn secondary" id="cont">${esc(t('next'))}</button>` : ''}
      </div></div>`);
    qs('#req').onclick = async () => {
      try { await getCameraStream(); wiz.perms.camera = 'granted'; } catch { wiz.perms.camera = 'denied'; }
      const fix = await getFix();
      wiz.perms.location = fix.error === 'denied' ? 'denied' : 'granted';
      if (wiz.perms.camera === 'granted' && wiz.perms.location === 'granted') {
        nextStep(wiz.mode === 'damaged_label' ? 4 : 3);
      } else renderWizard();
    };
    const c = qs('#cont');
    if (c) c.onclick = () => nextStep(wiz.mode === 'damaged_label' ? 4 : 3);
  }

  async function wScan() {
    wizLayout(`<div class="card">
      <p>${esc(t('s3_text'))}</p>
      <div class="camera"><video id="cam" playsinline muted autoplay></video><div class="frame"></div></div>
      <p class="muted small" id="scan-status">${esc(t('scanning'))}</p>
      <div id="err"></div>
      <p class="muted small">${esc(t('s3_note'))}</p></div>`);
    let stream;
    try { stream = await getCameraStream(); } catch { wiz.perms.camera = 'denied'; return nextStep(2); }
    const video = qs('#cam');
    video.srcObject = stream;
    video.play().catch(() => {});
    const stop = startScanner(video, async (text) => {
      qs('#scan-status').textContent = '✓';
      const r = await api('POST', `/api/inspections/${wiz.session.id}/scan`, { qr_text: text, scan_method: 'live_camera' });
      if (!r.ok) {
        qs('#err').innerHTML = `<div class="notice bad">${esc(r.data.message)}</div><button class="btn secondary" id="rescan">${esc(t('retry'))}</button>`;
        qs('#rescan').onclick = () => renderWizard();
        return;
      }
      wiz.cylinder = r.data.cylinder;
      wiz.challenge = r.data.challenge;
      nextStep(4);
    });
    void stop;
  }

  function wConfirm() {
    const c = wiz.cylinder;
    wizLayout(`<div class="card">
      <p>${esc(t('s4_text'))}</p>
      <div class="challenge-code" style="letter-spacing:2px;font-size:34px">${esc(c.serial)}</div>
      <p class="muted" style="text-align:center">${esc(c.id)} · ${esc(c.gas_type)} · ${esc(c.size)}</p>
      <div class="photos">${c.photos.map((p) => `<img src="/api/photos/${p.id}" alt="${esc(p.kind)}">`).join('')}</div>
      <div class="stack" style="margin-top:14px"><button class="btn" id="ok">${esc(t('next'))}</button></div></div>`);
    qs('#ok').onclick = () => nextStep(5);
  }

  function fixState() {
    const f = wiz.fix;
    if (!f) return { ok: false, reason: wiz.fixError || 'none' };
    const age = (Date.now() - f.ts) / 1000;
    if (age > state.config.max_fix_age_s) return { ok: false, reason: 'stale', age };
    if (f.accuracy_m > state.config.max_accuracy_m) return { ok: false, reason: 'inaccurate', age };
    return { ok: true, age };
  }

  function wLocation() {
    const f = wiz.fix;
    const st = fixState();
    let msg = '';
    if (wiz.fixError === 'denied') msg = `<div class="notice bad">${esc(t('location_denied_help'))}</div>`;
    else if (wiz.fixError === 'timeout') msg = `<div class="notice bad">${esc(t('loc_timeout'))}</div>`;
    else if (wiz.fixError) msg = `<div class="notice bad">${esc(t('loc_unavailable'))}</div>`;
    else if (f && st.reason === 'stale') msg = `<div class="notice warn">${esc(t('loc_stale'))}</div>`;
    else if (f && st.reason === 'inaccurate') msg = `<div class="notice warn">${esc(t('loc_inaccurate'))}</div>`;
    else if (f && st.ok) msg = `<div class="notice info">${esc(t('loc_ok'))}</div>`;
    wizLayout(`<div class="card">
      <p>${esc(t('s5_text'))}</p>
      ${f ? `<div class="map" id="fix-map"></div>
        <dl class="kv" style="margin-top:10px"><dt>${esc(t('accuracy'))}</dt><dd>${esc(fmtAcc(f.accuracy_m))} <span class="muted small">(≤ ${state.config.max_accuracy_m} m)</span></dd>
        <dt>${esc(t('fix_age'))}</dt><dd id="fix-age">–</dd>
        <dt>Lat, Lng</dt><dd>${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}</dd></dl>` : ''}
      ${msg}
      <div class="stack" style="margin-top:12px">
        <button class="btn ${f ? 'secondary' : ''}" id="acq">${esc(f || wiz.fixError ? t('reacquire') : t('acquire_location'))}</button>
        ${f || wiz.fixError ? `<button class="btn" id="cont">${esc(t('next'))}</button>` : ''}
      </div></div>`);
    if (f) {
      drawMap(qs('#fix-map'), [{ lat: f.lat, lng: f.lng, accuracy_m: f.accuracy_m }], { sites: state.sites.filter((s) => s.lat != null) });
      const upd = () => { const el = qs('#fix-age'); if (!el) return; el.textContent = `${Math.round((Date.now() - f.ts) / 1000)} s (≤ ${state.config.max_fix_age_s} s)`; scanTimer = setTimeout(upd, 1000); };
      upd();
    }
    qs('#acq').onclick = async () => {
      qs('#acq').disabled = true;
      qs('#acq').textContent = t('loading');
      const fx = await getFix();
      if (fx.error) { wiz.fixError = fx.error; wiz.fix = null; } else { wiz.fixError = null; wiz.fix = fx; }
      renderWizard();
    };
    const c = qs('#cont');
    if (c) c.onclick = () => nextStep(6);
  }

  function pickMime() {
    const types = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];
    return types.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  async function wEvidence() {
    const ch = wiz.challenge;
    if (wiz.mediaId) {
      wizLayout(`<div class="card"><div class="notice info">✓ ${esc(t('uploaded'))}</div>
        <div class="stack"><button class="btn" id="cont">${esc(t('next'))}</button><button class="btn secondary" id="again">${esc(t('re_record'))}</button></div></div>`);
      qs('#cont').onclick = () => nextStep(7);
      qs('#again').onclick = async () => {
        const r = await api('POST', `/api/inspections/${wiz.session.id}/challenge`, {});
        if (!r.ok) return toast(r.data.message);
        wiz.challenge = r.data.challenge; wiz.mediaId = null; renderWizard();
      };
      return;
    }
    const maxS = state.config.max_clip_seconds || 30;
    const minS = state.config.min_clip_seconds || 4;
    wizLayout(`<div class="card">
      <p>${esc(t('s6_text'))}</p>
      <div class="notice info"><b>${esc(t('instruction'))}:</b> ${esc(t('ins_' + ch.instruction_key))}</div>
      <div class="camera"><video id="cam" playsinline muted autoplay></video>
        <div class="overlay"><div class="small">${esc(t('say_code'))}</div><div class="code">${esc(ch.code)}</div></div>
        <div class="rec" id="rec" hidden>● <span id="rec-t">0</span>s</div></div>
      <p class="muted small">${esc(t('code_expires'))}: ${esc(fmtTime(ch.expires_at))} · ${minS}–${maxS} s</p>
      <div class="stack"><button class="btn danger" id="rec-btn">● ${esc(t('record'))}</button></div>
      <div id="err"></div>
      <p class="muted small">${esc(t('evidence_note'))}</p></div>`);
    let stream;
    try { stream = await getCameraStream(); } catch { wiz.perms.camera = 'denied'; return nextStep(2); }
    const video = qs('#cam');
    video.srcObject = stream;
    video.play().catch(() => {});
    const btn = qs('#rec-btn');
    let rec = null; let chunks = []; let started = 0; let timer = null;
    const mime = pickMime();
    btn.onclick = () => {
      if (!rec) {
        if (!window.MediaRecorder) { qs('#err').innerHTML = '<div class="notice bad">MediaRecorder not supported on this browser.</div>'; return; }
        chunks = [];
        rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 1_500_000 } : undefined);
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = async () => {
          clearInterval(timer);
          const stopped = Date.now();
          const duration = stopped - started;
          if (duration < minS * 1000) { qs('#err').innerHTML = `<div class="notice warn">≥ ${minS} s</div>`; rec = null; btn.textContent = `● ${t('record')}`; qs('#rec').hidden = true; return; }
          const blob = new Blob(chunks, { type: (rec.mimeType || mime || 'video/webm').split(';')[0] });
          btn.disabled = true; btn.textContent = t('uploading');
          const fd = new FormData();
          fd.append('challenge_id', ch.id);
          fd.append('capture_source', 'live_camera_recorder');
          fd.append('started_at', new Date(started).toISOString());
          fd.append('stopped_at', new Date(stopped).toISOString());
          fd.append('duration_ms', String(duration));
          fd.append('clip', blob, 'clip');
          const r = await api('POST', `/api/inspections/${wiz.session.id}/media`, undefined, { form: fd });
          if (!r.ok) {
            qs('#err').innerHTML = `<div class="notice bad">${esc(r.data.message)}</div>`;
            if (['CHALLENGE_EXPIRED', 'MEDIA_EXISTS'].includes(r.data.error)) {
              const nr = await api('POST', `/api/inspections/${wiz.session.id}/challenge`, {});
              if (nr.ok) { wiz.challenge = nr.data.challenge; setTimeout(renderWizard, 1500); }
            } else { btn.disabled = false; btn.textContent = `● ${t('record')}`; rec = null; }
            return;
          }
          wiz.mediaId = r.data.media.id;
          nextStep(7);
        };
        started = Date.now();
        rec.start(1000);
        btn.textContent = `■ ${t('stop')}`;
        qs('#rec').hidden = false;
        timer = setInterval(() => {
          const s = Math.round((Date.now() - started) / 1000);
          const el = qs('#rec-t'); if (el) el.textContent = s;
          if (s >= maxS && rec && rec.state === 'recording') rec.stop();
        }, 250);
      } else if (rec.state === 'recording') {
        rec.stop();
      }
    };
  }

  function siteOptions(selected, filter) {
    return state.sites.filter(filter || (() => true)).map((s) => `<option value="${s.id}" ${String(selected) === String(s.id) ? 'selected' : ''}>${esc(s.name)}${s.kind === 'customer' ? ' (' + esc(t('customer')) + ')' : ''}</option>`).join('');
  }

  function wChecklist() {
    const f = wiz.form;
    if (!f.site_id && wiz.cylinder) {
      const cur = wiz.cylinder.movement_status === 'in_transit' ? wiz.cylinder.destination_site_id : wiz.cylinder.current_site_id;
      if (cur) f.site_id = String(cur);
    }
    const keys = ['beside_cylinder', 'serial_matches', 'qr_attached', 'condition_checked', 'site_bay_correct']
      .filter((k) => !(wiz.mode === 'damaged_label' && k === 'qr_attached'));
    const types = ['inspection', 'warehouse_received', 'dispatched', 'customer_received', 'transferred', 'empty_returned', 'maintenance'];
    const conds = ['good', 'damaged', 'leaking', 'label_damaged', 'needs_supervisor'];
    wizLayout(`<form id="ck" class="card">
      <p>${esc(t('s7_text'))}</p>
      ${keys.map((k) => `<label class="check ${f.checklist[k] ? 'checked' : ''}"><input type="checkbox" name="ck_${k}" ${f.checklist[k] ? 'checked' : ''}>${esc(t('ck_' + k))}</label>`).join('')}
      <label class="field"><span class="req">${esc(t('event_type'))}</span><select name="event_type">${types.map((x) => `<option value="${x}" ${f.event_type === x ? 'selected' : ''}>${esc(t('et_' + x))}</option>`).join('')}</select></label>
      <label class="field"><span class="req">${esc(t('site'))}</span><select name="site_id"><option value=""></option>${siteOptions(f.site_id)}</select></label>
      <label class="field">${esc(t('storage_bay'))}<input name="bay" value="${esc(f.bay)}" maxlength="60"></label>
      <div id="dest-wrap"><label class="field"><span class="req">${esc(t('destination'))}</span><select name="destination_site_id"><option value=""></option>${siteOptions(f.destination_site_id)}</select></label>
        <label class="field">${esc(t('expected_return'))} (${esc(t('optional'))})<input type="date" name="expected_return_date" value="${esc(f.expected_return_date)}"></label></div>
      <div class="grid2">
        <label class="field">${esc(t('responsible_person'))}<input name="responsible_person" value="${esc(f.responsible_person || state.user.display_name)}" maxlength="120"></label>
        <label class="field">${esc(t('delivery_ref'))} (${esc(t('optional'))})<input name="delivery_ref" value="${esc(f.delivery_ref)}" maxlength="80"></label>
      </div>
      <label class="field"><span class="req">${esc(t('condition'))}</span><select name="condition">${conds.map((x) => `<option value="${x}" ${f.condition === x ? 'selected' : ''}>${esc(t('cond_' + x))}</option>`).join('')}</select></label>
      <label class="field">${esc(t('comments'))}<textarea name="comments" maxlength="2000">${esc(f.comments)}</textarea></label>
      <div id="err"></div>
      <button class="btn" type="submit">${esc(t('next'))}</button></form>`);
    const form = qs('#ck');
    const syncDest = () => { qs('#dest-wrap').hidden = !['dispatched', 'transferred'].includes(form.event_type.value); };
    syncDest();
    form.event_type.onchange = syncDest;
    qsa('.check input', form).forEach((i) => { i.onchange = () => i.parentElement.classList.toggle('checked', i.checked); });
    form.onsubmit = (e) => {
      e.preventDefault();
      for (const k of keys) f.checklist[k] = form[`ck_${k}`].checked;
      for (const k of ['event_type', 'site_id', 'bay', 'destination_site_id', 'expected_return_date', 'responsible_person', 'delivery_ref', 'condition', 'comments']) f[k] = form[k].value.trim();
      const errs = [];
      if (keys.some((k) => !f.checklist[k])) errs.push(t('s7_text'));
      if (!f.site_id) errs.push(t('site'));
      if (['dispatched', 'transferred'].includes(f.event_type) && !f.destination_site_id) errs.push(t('destination'));
      if ((f.condition !== 'good' || wiz.mode === 'damaged_label') && f.comments.length < 5) errs.push(t('comments_required'));
      if (errs.length) { qs('#err').innerHTML = `<div class="notice bad">${errs.map(esc).join('<br>')}</div>`; return; }
      nextStep(8);
    };
  }

  function buildPayload(extra = {}) {
    const f = wiz.form;
    const fx = wiz.fix;
    return {
      challenge_id: wiz.challenge.id, event_type: f.event_type, site_id: Number(f.site_id), bay: f.bay,
      destination_site_id: ['dispatched', 'transferred'].includes(f.event_type) && f.destination_site_id ? Number(f.destination_site_id) : null,
      expected_return_date: f.expected_return_date || null, responsible_person: f.responsible_person, delivery_ref: f.delivery_ref,
      condition: f.condition, comments: f.comments, checklist: f.checklist,
      location: fx ? { lat: fx.lat, lng: fx.lng, accuracy_m: fx.accuracy_m, fix_timestamp: new Date(fx.ts).toISOString(), client_sent_at: new Date().toISOString() } : null,
      ...extra,
    };
  }

  function wReview() {
    const f = wiz.form;
    const fx = wiz.fix;
    const st = fixState();
    const site = state.sites.find((s) => String(s.id) === String(f.site_id));
    const dest = state.sites.find((s) => String(s.id) === String(f.destination_site_id));
    const isDamaged = wiz.mode === 'damaged_label';
    wizLayout(`<div class="card">
      <p>${esc(t('s8_text'))}</p>
      <dl class="kv">
        <dt>${esc(t('serial'))}</dt><dd>${esc(wiz.cylinder.serial)}</dd>
        <dt>${esc(t('event_type'))}</dt><dd>${esc(t('et_' + f.event_type))}</dd>
        <dt>${esc(t('site'))}</dt><dd>${esc(site ? site.name : '')}</dd>
        ${f.bay ? `<dt>${esc(t('operator_reported_bay'))}</dt><dd>${esc(f.bay)}</dd>` : ''}
        ${dest && ['dispatched', 'transferred'].includes(f.event_type) ? `<dt>${esc(t('destination'))}</dt><dd>${esc(dest.name)}</dd>` : ''}
        <dt>${esc(t('condition'))}</dt><dd>${esc(t('cond_' + f.condition))}</dd>
        <dt>${esc(t('location_accuracy'))}</dt><dd>${fx ? esc(fmtAcc(fx.accuracy_m)) : esc(t('loc_unavailable'))}</dd>
        <dt>${esc(t('fix_age'))}</dt><dd id="age">${fx ? Math.round(st.age) + ' s' : t('none')}</dd>
        <dt>${esc(t('evidence_clip'))}</dt><dd>✓</dd>
      </dl>
      <div id="loc-msg">${!st.ok && !isDamaged ? `<div class="notice warn">${esc(st.reason === 'stale' ? t('loc_stale') : st.reason === 'inaccurate' ? t('loc_inaccurate') : t('loc_unavailable'))}</div>` : ''}</div>
      <div id="err"></div>
      <div class="stack" id="actions">
        ${!isDamaged && fx ? `<button class="btn secondary" id="reacq">${esc(t('reacquire'))}</button>` : ''}
        <button class="btn" id="submit">${esc(isDamaged ? t('submit') : t('submit_event'))}</button>
      </div></div>`);
    const reacq = qs('#reacq');
    if (reacq) reacq.onclick = async () => { reacq.disabled = true; reacq.textContent = t('loading'); const fx2 = await getFix(); if (!fx2.error) wiz.fix = fx2; else wiz.fixError = fx2.error; renderWizard(); };
    qs('#submit').onclick = async () => {
      // Re-acquire automatically if the fix became stale before submission.
      if (!isDamaged && wiz.fix && fixState().reason === 'stale') {
        qs('#submit').disabled = true; qs('#submit').textContent = t('reacquire') + '…';
        const fx2 = await getFix();
        if (!fx2.error) wiz.fix = fx2;
      }
      await doSubmit(buildPayload());
    };
  }

  async function doSubmit(payload) {
    const btn = qs('#submit');
    if (btn) { btn.disabled = true; btn.textContent = t('submitting'); }
    const r = await api('POST', `/api/inspections/${wiz.session.id}/submit`, payload, { headers: { 'Idempotency-Key': wiz.idemKey } });
    if (r.ok) return showSubmitted(r.data.event);
    if (r.status === 0) {
      const q = pendingLoad();
      q.push({ key: wiz.idemKey, session_id: wiz.session.id, payload, serial: wiz.cylinder.serial, saved_at: new Date().toISOString() });
      pendingSave(q);
      toast(t('saved_pending'), 5000);
      endWizard();
      return go('/app/pending');
    }
    if (btn) { btn.disabled = false; btn.textContent = t('submit_event'); }
    const d = r.data;
    if (d.exception_allowed) {
      // Location issue: block normal submission, offer retry or exception.
      wiz.idemKey = uuid();
      if (btn) btn.hidden = true; // normal submission stays blocked
      qs('#err').innerHTML = `<div class="notice bad"><b>${esc(t('location_blocked'))}</b><br>${esc(d.message)}</div>
        <div class="stack"><button class="btn secondary" id="loc-retry">${esc(t('retry'))}: ${esc(t('reacquire'))}</button></div>
        <label class="field" style="margin-top:12px">${esc(t('exception_reason'))}<textarea id="exc-reason"></textarea></label>
        <button class="btn warn" id="exc">${esc(t('submit_exception'))}</button>`;
      qs('#loc-retry').onclick = async () => { const fx2 = await getFix(); if (!fx2.error) { wiz.fix = fx2; wiz.fixError = null; } else wiz.fixError = fx2.error; renderWizard(); };
      const ra = qs('#reacq'); if (ra) ra.hidden = true;
      qs('#exc').onclick = async () => {
        const reason = qs('#exc-reason').value.trim();
        if (reason.length < 5) return toast(t('exception_reason'));
        await doSubmit(buildPayload({ location_exception: true, exception_reason: reason }));
      };
      return;
    }
    if (d.error === 'CONCURRENT_UPDATE') { qs('#err').innerHTML = `<div class="notice bad">${esc(t('concurrent'))}</div>`; return; }
    wiz.idemKey = uuid();
    qs('#err').innerHTML = `<div class="notice bad">${esc(d.message || 'Error')}</div>`;
  }

  function showSubmitted(ev) {
    const serial = wiz ? wiz.cylinder.serial : '';
    endWizard();
    layout(t('submitted'), `<div class="card">
      <div class="notice info"><b>✓ ${esc(t('submitted'))}</b> · #${ev.id} · ${esc(serial)}</div>
      <dl class="kv">
        <dt>${esc(t('event_type'))}</dt><dd>${esc(t('et_' + ev.event_type))}</dd>
        <dt>${esc(t('movement_status'))}</dt><dd>${ev.movement_status_after ? msPill(ev.movement_status_after) : t('none')}</dd>
        <dt>${esc(t('verification_status'))}</dt><dd>${vsPill(ev.verification_status)}</dd>
        <dt>${esc(t('location'))}</dt><dd>${esc(t('loc_' + ev.location_status))} · ${esc(t('geo_' + ev.geofence_result))}</dd>
      </dl>
      ${ev.flags.length ? `<h3>${esc(t('flags'))}</h3>${ev.flags.map((f) => `<span class="pill flag">${esc(f.flag_type)}</span>`).join(' ')}` : ''}
      <div class="stack" style="margin-top:14px"><a class="btn" href="/app/inspect" data-nav>${esc(t('scan_cylinder'))}</a>
      <a class="btn secondary" href="/" data-nav>${esc(t('home'))}</a></div></div>`, { back: '/' });
  }

  // Damaged-label exception: find by serial, then the evidence workflow.
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
          if (!window.isSecureContext) return toast(t('insecure_context'));
          const rr = await api('POST', '/api/exceptions/damaged-label', { cylinder_id: b.dataset.id });
          if (!rr.ok) return toast(rr.data.message);
          wiz = newWizard('damaged_label');
          wiz.session = rr.data.session; wiz.cylinder = rr.data.cylinder; wiz.challenge = rr.data.challenge;
          wiz.form.condition = 'label_damaged';
          wiz.step = 2;
          history.pushState({}, '', '/app/inspect');
          renderWizard();
        };
      });
    };
  }

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
    const local = pendingLoad();
    const r = await api('GET', '/api/me/events');
    const awaiting = r.ok ? r.data.events.filter((e) => /pending/.test(e.verification_status)) : [];
    layout(t('pending_submissions'), `
      <div class="section-title">${esc(t('local_queue'))}</div>
      ${local.length ? local.map((p, i) => `<div class="card"><b>${esc(p.serial)}</b> · ${esc(t('et_' + p.payload.event_type))}<br>
        <span class="muted small">${esc(fmtTime(p.saved_at))}</span>${p.error ? `<div class="notice bad">${esc(p.error)}</div>` : ''}
        <div class="btn-row" style="margin-top:10px"><button class="btn small" data-resend="${i}">${esc(t('resend'))}</button><button class="btn small secondary" data-discard="${i}">${esc(t('discard'))}</button></div></div>`).join('')
        : `<p class="muted">${esc(t('no_items'))}</p>`}
      <div class="section-title">${esc(t('awaiting_review'))}</div>
      ${awaiting.length ? `<div class="card"><ul class="timeline">${awaiting.map((e) => `<li class="pending"><a href="/app/event/${e.id}" data-nav><b>${esc(e.serial)}</b> · ${esc(t('et_' + e.event_type))} ${vsPill(e.verification_status)}<br><span class="muted small">${esc(fmtTime(e.server_received_at))}</span></a></li>`).join('')}</ul></div>`
        : `<p class="muted">${esc(t('no_items'))}</p>`}`, { back: '/' });
    qsa('[data-resend]').forEach((b) => {
      b.onclick = async () => {
        const q = pendingLoad();
        const p = q[Number(b.dataset.resend)];
        const rr = await api('POST', `/api/inspections/${p.session_id}/submit`, { ...p.payload, location: p.payload.location ? { ...p.payload.location, client_sent_at: new Date().toISOString() } : null }, { headers: { 'Idempotency-Key': p.key } });
        if (rr.ok) { q.splice(Number(b.dataset.resend), 1); pendingSave(q); toast(t('submitted')); }
        else if (rr.status) { p.error = rr.data.message; pendingSave(q); }
        renderPending();
      };
    });
    qsa('[data-discard]').forEach((b) => {
      b.onclick = () => { const q = pendingLoad(); q.splice(Number(b.dataset.discard), 1); pendingSave(q); renderPending(); };
    });
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
          <dt>QR</dt><dd>${e.qr_verified ? '✓ live scan of active label' : '✗ not QR-verified'}</dd>
          ${e.is_exception ? `<dt>Exception</dt><dd>${esc(e.exception_kind)}: ${esc(e.exception_reason || '')}</dd>` : ''}
          ${e.corrects_event_id ? `<dt>${esc(t('corrects'))}</dt><dd><a href="/app/event/${e.corrects_event_id}" data-nav>#${e.corrects_event_id}</a></dd>` : ''}
          ${e.corrected_by_event_id ? `<dt>${esc(t('corrected_by'))}</dt><dd><a href="/app/event/${e.corrected_by_event_id}" data-nav>#${e.corrected_by_event_id}</a></dd>` : ''}
        </dl>
        ${e.cylinder ? `<p><a href="/app/cylinder/${esc(e.cylinder.id)}" data-nav>${esc(t('view_record'))} ›</a></p>` : ''}
      </div>
      ${e.lat != null ? '<div class="card"><div class="map" id="ev-map"></div></div>' : ''}
      ${e.flags.length ? `<div class="card"><h2>${esc(t('flags'))}</h2><p class="muted small">${esc(t('signals_note'))}</p>
        ${e.flags.map((f) => `<p><span class="pill flag">${esc(f.flag_type)}</span> <span class="small">${esc(f.detail || '')}</span></p>`).join('')}</div>` : ''}
      ${e.media ? `<div class="card"><h2>${esc(t('evidence_clip'))}</h2>
        ${e.challenge ? `<p>${esc(t('challenge_code'))}: <b style="font-size:22px;letter-spacing:4px">${esc(e.challenge.code)}</b><br><span class="muted small">${esc(t('instruction'))}: ${esc(t('ins_' + e.challenge.instruction_key))}</span></p>` : ''}
        ${e.media.purged_at ? `<p class="muted">${esc(t('media_purged'))}</p>` : `<video class="evidence" controls playsinline preload="metadata" src="/api/media/${esc(e.media.id)}"></video>`}
        <p class="muted small">${Math.round(e.media.duration_ms / 1000)} s · ${Math.round(e.media.size_bytes / 1024)} KB · received ${esc(fmtTime(e.media.server_received_at))} · sha256 ${esc(e.media.sha256.slice(0, 12))}…</p></div>` : ''}
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

  async function renderSites() {
    const r = await api('GET', '/api/admin/sites');
    const rows = r.ok ? r.data.sites : [];
    const form = (s = {}) => `<form class="card site-form" data-id="${s.id || ''}">
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
      <button class="btn small" type="submit">${esc(t('save'))}</button></form>`;
    layout(t('sites'), `<h2>${esc(t('add_site'))}</h2>${form()}<div class="section-title">${esc(t('sites'))}</div>${rows.map(form).join('')}`, { back: '/' });
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
        <label class="field">${esc(t('password'))} (≥10)<input name="password" type="password" minlength="10" required autocomplete="new-password"></label></div>
        <button class="btn small" type="submit">${esc(t('save'))}</button></form>
      ${rows.map((u) => `<form class="card user-form" data-id="${u.id}"><b>${esc(u.username)}</b><div class="grid2">
        <label class="field">${esc(t('display_name'))}<input name="display_name" value="${esc(u.display_name)}"></label>
        <label class="field">${esc(t('role'))}<select name="role">${roles.map((x) => `<option value="${x}" ${u.role === x ? 'selected' : ''}>${esc(t('role_' + x))}</option>`).join('')}</select></label>
        <label class="field">${esc(t('reset_password'))}<input name="password" type="password" autocomplete="new-password"></label>
        <label class="check" style="align-self:end"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}>${esc(t('active'))}</label></div>
        <button class="btn small" type="submit">${esc(t('save'))}</button></form>`).join('')}`, { back: '/' });
    qs('#add').onsubmit = async (e) => {
      e.preventDefault();
      const rr = await api('POST', '/api/admin/users', Object.fromEntries(new FormData(e.target)));
      toast(rr.ok ? '✓' : rr.data.message);
      if (rr.ok) renderUsers();
    };
    qsa('.user-form').forEach((f) => {
      f.onsubmit = async (e) => {
        e.preventDefault();
        const body = { display_name: f.display_name.value, role: f.role.value, active: f.active.checked };
        if (f.password.value) body.password = f.password.value;
        const rr = await api('PUT', `/api/admin/users/${f.dataset.id}`, body);
        toast(rr.ok ? '✓' : rr.data.message);
      };
    });
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
    if (!state.user) {
      const next = p === '/app/login' ? new URLSearchParams(location.search).get('next') : (p !== '/' ? p + location.search : null);
      return renderLogin(next && next.startsWith('/') && !next.startsWith('//') ? next : null);
    }
    if (p !== '/app/inspect' && wiz) endWizard();
    if (p === '/' || p === '/app/login') return renderHome();
    if (p === '/app/inspect') { if (!wiz) wiz = newWizard(); return renderWizard(); }
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
