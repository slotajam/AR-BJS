// Random, unannounced physical audits. Cylinders are picked at random,
// weighted towards risk, and assigned only to a supervisor/admin who is not
// the last person who moved the cylinder and has no recent events at its site.
// Operators cannot see audit tasks.
const risk = require('./risk');

module.exports = function registerAudits(app, ctx) {
  const { db, dbm, h, fail, str, S, nowIso, audit, auth, getCyl, getSite, randomId } = ctx;
  const staff = auth.requireRole('supervisor', 'admin');
  const admin = auth.requireRole('admin');

  function eligibleAuditors(cyl) {
    const since = new Date(Date.now() - S('audit_independence_days') * 86400000).toISOString();
    const last = db.prepare(`SELECT user_id FROM events WHERE cylinder_id = ? AND movement_status_after IS NOT NULL
      AND event_type <> 'registered' ORDER BY id DESC LIMIT 1`).get(cyl.id);
    const linked = new Set(cyl.current_site_id
      ? db.prepare('SELECT DISTINCT user_id FROM events WHERE site_id = ? AND server_received_at >= ?').all(cyl.current_site_id, since).map((r) => r.user_id)
      : []);
    return db.prepare("SELECT id, display_name FROM users WHERE active = 1 AND role IN ('supervisor','admin') ORDER BY id").all()
      .filter((u) => (!last || u.id !== last.user_id) && !linked.has(u.id));
  }

  function generate(createdBy, count) {
    const cyls = db.prepare(`SELECT * FROM cylinders WHERE movement_status <> 'retired'
      AND id NOT IN (SELECT cylinder_id FROM audits WHERE status = 'open')`).all();
    const scored = cyls.map((c) => ({ cyl: c, ...risk.cylinderRisk(db, c) }));
    const picked = risk.weightedSample(scored, count);
    const created = [];
    const t = nowIso();
    for (const p of picked) {
      const pool = eligibleAuditors(p.cyl);
      const assignee = pool.length ? pool[require('crypto').randomInt(0, pool.length)].id : null;
      const info = db.prepare(`INSERT INTO audits (cylinder_id, risk_score, reasons, assigned_to, created_by, created_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'open')`).run(p.cyl.id, p.score, p.reasons.join('; ') || 'random selection', assignee, createdBy, t);
      created.push(Number(info.lastInsertRowid));
    }
    return created;
  }

  ctx.autoGenerateAudits = () => {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    if (db.prepare('SELECT 1 FROM audits WHERE created_at >= ? LIMIT 1').get(weekAgo)) return [];
    const n = S('audits_per_week');
    if (!n) return [];
    const ids = dbm.tx(db, () => generate(null, n));
    if (ids.length) db.prepare("INSERT INTO audit_log (action, entity, detail, created_at) VALUES ('audits_generated', 'audit', ?, ?)").run(JSON.stringify({ ids, auto: true }), nowIso());
    return ids;
  };

  function auditView(a) {
    const cyl = getCyl(a.cylinder_id);
    const site = getSite(cyl.current_site_id);
    const user = (id) => (id ? (db.prepare('SELECT display_name FROM users WHERE id = ?').get(id) || {}).display_name : null);
    return {
      id: a.id, cylinder_id: a.cylinder_id, serial: cyl.serial, movement_status: cyl.movement_status,
      site: site ? { id: site.id, name: site.name, customer_name: site.customer_name } : null,
      risk_score: a.risk_score, reasons: a.reasons, assigned_to: a.assigned_to, assigned_name: user(a.assigned_to),
      created_at: a.created_at, status: a.status, outcome: a.outcome, outcome_event_id: a.outcome_event_id,
      comments: a.comments, completed_by: user(a.completed_by), completed_at: a.completed_at,
    };
  }

  app.get('/api/audits', staff, (req, res) => {
    const rows = req.user.role === 'admin'
      ? db.prepare('SELECT * FROM audits ORDER BY status DESC, id DESC LIMIT 300').all()
      : db.prepare('SELECT * FROM audits WHERE assigned_to = ? ORDER BY status DESC, id DESC LIMIT 300').all(req.user.id);
    res.json({ audits: rows.map(auditView) });
  });

  app.post('/api/audits/generate', admin, h((req, res) => {
    const count = Math.max(1, Math.min(100, Number(req.body.count) || S('audits_per_week') || 1));
    const ids = dbm.tx(db, () => generate(req.user.id, count));
    audit(req, 'audits_generated', 'audit', null, { ids });
    res.status(201).json({ created: ids.length, audits: ids.map((id) => auditView(db.prepare('SELECT * FROM audits WHERE id = ?').get(id))) });
  }));

  app.get('/api/audits/:id/eligible', admin, h((req, res) => {
    const a = db.prepare('SELECT * FROM audits WHERE id = ?').get(Number(req.params.id));
    if (!a) fail(404, 'NOT_FOUND', 'Audit not found.');
    res.json({ users: eligibleAuditors(getCyl(a.cylinder_id)) });
  }));

  app.post('/api/audits/:id/assign', admin, h((req, res) => {
    const a = db.prepare('SELECT * FROM audits WHERE id = ?').get(Number(req.params.id));
    if (!a || a.status !== 'open') fail(404, 'NOT_FOUND', 'Open audit not found.');
    const uid = Number(req.body.user_id);
    if (!eligibleAuditors(getCyl(a.cylinder_id)).some((u) => u.id === uid)) {
      fail(409, 'NOT_INDEPENDENT', 'This person moved the cylinder last or has worked at its site recently, so they cannot audit it.');
    }
    db.prepare('UPDATE audits SET assigned_to = ? WHERE id = ?').run(uid, a.id);
    audit(req, 'audit_assigned', 'audit', a.id, { user: uid });
    res.json({ audit: auditView(db.prepare('SELECT * FROM audits WHERE id = ?').get(a.id)) });
  }));

  function assignedOpen(req) {
    const a = db.prepare('SELECT * FROM audits WHERE id = ?').get(Number(req.params.id));
    if (!a || a.status !== 'open') fail(404, 'NOT_FOUND', 'Open audit not found.');
    if (a.assigned_to !== req.user.id) fail(403, 'AUDIT_NOT_ASSIGNED', 'This audit is assigned to someone else.');
    return a;
  }

  // Cylinder not found: missing exception, and every event since the last
  // good audit is flagged for review.
  app.post('/api/audits/:id/not-found', staff, h((req, res) => {
    const comments = str(req.body.comments, 2000);
    if (comments.length < 5) fail(422, 'COMMENTS_REQUIRED', 'Describe where you looked and who you spoke to.');
    const out = dbm.tx(db, () => {
      const a = assignedOpen(req);
      const cyl = getCyl(a.cylinder_id);
      const lastGood = db.prepare("SELECT outcome_event_id FROM audits WHERE cylinder_id = ? AND outcome = 'found_ok' ORDER BY id DESC LIMIT 1").get(cyl.id);
      const fromId = lastGood ? lastGood.outcome_event_id : 0;
      const chain = db.prepare("SELECT id FROM events WHERE cylinder_id = ? AND id > ? AND event_type NOT IN ('correction')").all(cyl.id, fromId);
      const t = nowIso();
      for (const e of chain) {
        db.prepare('INSERT INTO flags (event_id, flag_type, detail, created_at) VALUES (?, ?, ?, ?)')
          .run(e.id, 'audit_not_found_chain', `Audit #${a.id} could not find this cylinder; review this record.`, t);
      }
      const ev = ctx.recordMissing(req, cyl, `Audit #${a.id}: not found. ${comments}`, `audit-${a.id}-${randomId(6)}`, null,
        [['audit_not_found', `Audit #${a.id} could not find the cylinder.`]]);
      db.prepare("UPDATE audits SET status = 'done', outcome = 'not_found', outcome_event_id = ?, comments = ?, completed_by = ?, completed_at = ? WHERE id = ?")
        .run(ev.id, comments, req.user.id, t, a.id);
      audit(req, 'audit_completed', 'audit', a.id, { outcome: 'not_found', flagged_events: chain.length });
      return { event_id: ev.id, flagged: chain.length };
    });
    res.json(out);
  }));

  app.post('/api/audits/:id/refused', staff, h((req, res) => {
    const comments = str(req.body.comments, 2000);
    if (comments.length < 5) fail(422, 'COMMENTS_REQUIRED', 'Describe what happened.');
    const a = assignedOpen(req);
    db.prepare("UPDATE audits SET status = 'done', outcome = 'customer_refused', comments = ?, completed_by = ?, completed_at = ? WHERE id = ?")
      .run(comments, req.user.id, nowIso(), a.id);
    audit(req, 'audit_completed', 'audit', a.id, { outcome: 'customer_refused' });
    res.json({ ok: true });
  }));
};
