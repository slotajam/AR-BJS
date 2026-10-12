// Customer holdings statements: each customer site's verified contact phone
// gets an SMS with a single-use link listing the cylinders recorded at the
// site, to confirm or dispute. Disputes and unanswered statements show on the
// dashboard for follow-up.
const crypto = require('crypto');

module.exports = function registerStatements(app, ctx) {
  const { db, h, fail, str, S, nowIso, audit, auth, sms, maskPhone, baseUrlFor } = ctx;
  const admin = auth.requireRole('admin');
  const staff = auth.requireRole('admin', 'supervisor');
  const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

  async function generate(req, base) {
    if (sms.unavailable) fail(503, 'SMS_NOT_CONFIGURED', 'SMS is not configured on this server.');
    const sites = db.prepare("SELECT * FROM sites WHERE kind = 'customer' AND active = 1").all();
    const sent = []; const skipped = [];
    for (const site of sites) {
      if (!site.contact_phone_e164 || !site.contact_phone_verified_at) { skipped.push({ site: site.name, reason: 'no verified contact phone' }); continue; }
      const cyls = db.prepare("SELECT id, serial FROM cylinders WHERE current_site_id = ? AND movement_status = 'at_customer' ORDER BY serial").all(site.id);
      const token = crypto.randomBytes(24).toString('base64url');
      const now = new Date();
      const info = db.prepare(`INSERT INTO holdings_statements (site_id, token_hash, cylinders_json, phone_e164, created_by, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(site.id, tokenHash(token), JSON.stringify(cyls), site.contact_phone_e164, req ? req.user.id : null,
        now.toISOString(), new Date(now.getTime() + S('statement_valid_days') * 86400000).toISOString());
      try {
        await sms.send(site.contact_phone_e164, `TankTracker: our records show ${cyls.length} cylinder(s) at ${site.name}. Please confirm or dispute: ${base}/s/${token} / กรุณายืนยันจำนวนถัง`);
        sent.push({ site: site.name, cylinders: cyls.length, id: Number(info.lastInsertRowid) });
      } catch (e) {
        skipped.push({ site: site.name, reason: 'SMS failed' });
      }
    }
    const entry = { sent: sent.length, skipped };
    if (req) audit(req, 'statements_generated', 'holdings_statement', null, entry);
    else db.prepare("INSERT INTO audit_log (action, entity, detail, created_at) VALUES ('statements_generated', 'holdings_statement', ?, ?)").run(JSON.stringify({ ...entry, auto: true }), nowIso());
    return { sent, skipped };
  }

  ctx.autoGenerateStatements = async (base) => {
    const days = S('holdings_statement_days');
    if (!days || sms.unavailable) return null;
    const since = new Date(Date.now() - days * 86400000).toISOString();
    if (db.prepare('SELECT 1 FROM holdings_statements WHERE created_at >= ? LIMIT 1').get(since)) return null;
    if (!db.prepare("SELECT 1 FROM sites WHERE kind = 'customer' AND contact_phone_verified_at IS NOT NULL LIMIT 1").get()) return null;
    return generate(null, base);
  };

  app.post('/api/statements/generate', admin, h(async (req, res) => res.status(201).json(await generate(req, baseUrlFor(req)))));

  app.get('/api/statements', staff, (req, res) => {
    const now = nowIso();
    const rows = db.prepare(`SELECT h.*, s.name AS site_name FROM holdings_statements h JOIN sites s ON s.id = h.site_id ORDER BY h.id DESC LIMIT 200`).all();
    res.json({
      statements: rows.map((r) => ({
        id: r.id, site_id: r.site_id, site_name: r.site_name, cylinders: JSON.parse(r.cylinders_json), phone_masked: maskPhone(r.phone_e164),
        created_at: r.created_at, expires_at: r.expires_at, response: r.response, comments: r.comments, responded_at: r.responded_at,
        status: r.response || (r.expires_at < now ? 'no_answer' : 'waiting'),
      })),
    });
  });

  // Public, no login: the token in the SMS link is the only credential.
  function byToken(token) {
    const r = db.prepare(`SELECT h.*, s.name AS site_name FROM holdings_statements h JOIN sites s ON s.id = h.site_id WHERE h.token_hash = ?`)
      .get(tokenHash(String(token)));
    if (!r) fail(404, 'NOT_FOUND', 'This link is not valid.');
    return r;
  }

  app.get('/api/public/statement/:token', h((req, res) => {
    const r = byToken(req.params.token);
    res.json({
      site_name: r.site_name, cylinders: JSON.parse(r.cylinders_json).map((c) => c.serial), created_at: r.created_at,
      expires_at: r.expires_at, response: r.response, expired: r.expires_at < nowIso(),
    });
  }));

  app.post('/api/public/statement/:token', h((req, res) => {
    const r = byToken(req.params.token);
    if (r.response) fail(409, 'ALREADY_ANSWERED', 'This statement has already been answered.');
    if (r.expires_at < nowIso()) fail(410, 'EXPIRED', 'This link has expired.');
    const response = req.body.response === 'confirm' ? 'confirmed' : req.body.response === 'dispute' ? 'disputed' : null;
    if (!response) fail(422, 'RESPONSE_REQUIRED', 'Choose confirm or dispute.');
    const comments = str(req.body.comments, 1000);
    if (response === 'disputed' && comments.length < 3) fail(422, 'COMMENTS_REQUIRED', 'Tell us what is different.');
    db.prepare('UPDATE holdings_statements SET response = ?, comments = ?, responded_at = ? WHERE id = ? AND response IS NULL')
      .run(response, comments || null, nowIso(), r.id);
    db.prepare("INSERT INTO audit_log (action, entity, entity_id, detail, ip, created_at) VALUES ('statement_answered', 'holdings_statement', ?, ?, ?, ?)")
      .run(String(r.id), JSON.stringify({ response }), req.ip || null, nowIso());
    res.json({ ok: true, response });
  }));
};
