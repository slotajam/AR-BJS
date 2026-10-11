// Registered mobile numbers: users (operators, supervisors, admins) and
// customer-site contacts. A number counts only after a code sent to it by SMS
// has been entered back. Changing a number clears its verification.
module.exports = function registerPhone(app, ctx) {
  const { db, h, fail, str, S, nowIso, audit, auth, sms, codes, maskPhone } = ctx;

  function subject(kind, id) {
    if (kind === 'user') {
      const u = db.prepare('SELECT id, phone_e164 AS phone, phone_verified_at AS verified FROM users WHERE id = ?').get(id);
      if (!u) fail(404, 'NOT_FOUND', 'User not found.');
      return u;
    }
    const s = db.prepare('SELECT id, contact_phone_e164 AS phone, contact_phone_verified_at AS verified FROM sites WHERE id = ?').get(id);
    if (!s) fail(404, 'NOT_FOUND', 'Site not found.');
    return s;
  }

  async function sendVerification(req, kind, id) {
    if (sms.unavailable) fail(503, 'SMS_NOT_CONFIGURED', 'SMS is not configured on this server.');
    const sub = subject(kind, id);
    if (!sub.phone) fail(409, 'NO_PHONE', 'No mobile number is registered yet.');
    const hourAgo = new Date(Date.now() - 3600000).toISOString();
    const recent = db.prepare('SELECT COUNT(*) AS n FROM phone_verifications WHERE subject_kind = ? AND subject_id = ? AND created_at >= ?').get(kind, id, hourAgo).n;
    if (recent >= 5) fail(429, 'TOO_MANY_CODES', 'Too many codes sent in the last hour. Try again later.');
    db.prepare('UPDATE phone_verifications SET used_at = ? WHERE subject_kind = ? AND subject_id = ? AND used_at IS NULL').run(nowIso(), kind, id);
    const code = codes.newCode();
    const now = new Date();
    const info = db.prepare(`INSERT INTO phone_verifications (subject_kind, subject_id, phone_e164, code_hash, expires_at, created_by, created_at)
      VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(kind, id, sub.phone, new Date(now.getTime() + S('sms_code_ttl_s') * 1000).toISOString(), req.user.id, now.toISOString());
    const vid = Number(info.lastInsertRowid);
    db.prepare('UPDATE phone_verifications SET code_hash = ? WHERE id = ?').run(codes.hash(code, `verify-${vid}`), vid);
    try {
      const r = await sms.send(sub.phone, `TankTracker phone verification code ${code}. Valid ${Math.round(S('sms_code_ttl_s') / 60)} min. / รหัสยืนยันเบอร์ ${code}`);
      audit(req, 'phone_code_sent', kind, id, { to: maskPhone(sub.phone), provider: sms.name, provider_id: r.id });
    } catch (e) {
      db.prepare('UPDATE phone_verifications SET used_at = ? WHERE id = ?').run(nowIso(), vid);
      fail(502, e.code || 'SMS_SEND_FAILED', 'The verification code could not be sent.');
    }
    return { phone_masked: maskPhone(sub.phone) };
  }

  function checkVerification(req, kind, id, code) {
    const sub = subject(kind, id);
    if (!/^\d{4}$/.test(String(code || ''))) fail(422, 'CODE_FORMAT', 'Enter the 4-digit code.');
    const v = db.prepare(`SELECT * FROM phone_verifications WHERE subject_kind = ? AND subject_id = ? AND used_at IS NULL
      ORDER BY id DESC LIMIT 1`).get(kind, id);
    if (!v || v.phone_e164 !== sub.phone) fail(409, 'NO_CODE', 'Send a verification code first.');
    if (v.expires_at <= nowIso()) fail(410, 'CODE_EXPIRED', 'The code expired. Send a new one.');
    if (!codes.equal(codes.hash(String(code), `verify-${v.id}`), v.code_hash)) {
      const attempts = v.attempts + 1;
      if (attempts >= S('sms_code_max_attempts')) {
        db.prepare('UPDATE phone_verifications SET attempts = ?, used_at = ? WHERE id = ?').run(attempts, nowIso(), v.id);
        audit(req, 'phone_code_burned', kind, id);
        fail(403, 'CODE_BURNED', 'Too many wrong codes. Send a new code.');
      }
      db.prepare('UPDATE phone_verifications SET attempts = ? WHERE id = ?').run(attempts, v.id);
      fail(422, 'CODE_WRONG', `Wrong code. ${S('sms_code_max_attempts') - attempts} tries left.`);
    }
    const t = nowIso();
    db.prepare('UPDATE phone_verifications SET used_at = ? WHERE id = ?').run(t, v.id);
    if (kind === 'user') db.prepare('UPDATE users SET phone_verified_at = ? WHERE id = ?').run(t, id);
    else db.prepare('UPDATE sites SET contact_phone_verified_at = ? WHERE id = ?').run(t, id);
    audit(req, 'phone_verified', kind, id, { phone: maskPhone(sub.phone) });
    return { verified: true, phone_masked: maskPhone(sub.phone) };
  }

  const admin = auth.requireRole('admin');

  app.get('/api/me/phone', auth.requireAuth, (req, res) => {
    const u = db.prepare('SELECT phone_e164, phone_verified_at FROM users WHERE id = ?').get(req.user.id);
    res.json({ phone_masked: maskPhone(u.phone_e164), registered: !!u.phone_e164, verified: !!u.phone_verified_at });
  });
  app.post('/api/me/phone/send-code', auth.requireAuth, h(async (req, res) => res.json(await sendVerification(req, 'user', req.user.id))));
  app.post('/api/me/phone/verify', auth.requireAuth, h((req, res) => res.json(checkVerification(req, 'user', req.user.id, str(req.body.code, 10)))));
  app.post('/api/admin/users/:id/phone/send-code', admin, h(async (req, res) => res.json(await sendVerification(req, 'user', Number(req.params.id)))));
  app.post('/api/admin/users/:id/phone/verify', admin, h((req, res) => res.json(checkVerification(req, 'user', Number(req.params.id), str(req.body.code, 10)))));
  app.post('/api/admin/sites/:id/phone/send-code', admin, h(async (req, res) => res.json(await sendVerification(req, 'site', Number(req.params.id)))));
  app.post('/api/admin/sites/:id/phone/verify', admin, h((req, res) => res.json(checkVerification(req, 'site', Number(req.params.id), str(req.body.code, 10)))));

  // Development only: lets the person testing read the SMS that would have been
  // sent to their own phone (admins see all). Never available with a real provider.
  app.get('/api/dev/sms-outbox', auth.requireAuth, (req, res) => {
    if (!sms.isDev) return res.status(404).json({ error: 'NOT_FOUND', message: 'Unknown endpoint.' });
    const me = db.prepare('SELECT phone_e164 FROM users WHERE id = ?').get(req.user.id).phone_e164;
    const mine = sms.outbox.filter((m) => req.user.role === 'admin' || m.to === me).slice(-10).reverse();
    res.json({ messages: mine.map((m) => ({ to: maskPhone(m.to), text: m.text, at: m.at })) });
  });
};
