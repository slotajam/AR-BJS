// Anti-collusion review signals: weighing comparisons, driver/customer pair
// concentration, risk scoring for random audits and per-driver / per-site
// risk summaries. These are prompts for review, never proof of fraud.
const crypto = require('crypto');
const { num } = require('./db');
const { effectiveVerification } = require('./domain');

const notRejected = (db) => (e) => effectiveVerification(db, e) !== 'rejected';

function weightFlags(db, settings, { cyl, ev }) {
  const flags = [];
  if (ev.gross_weight_kg == null) return flags;
  const tol = num(settings, 'weight_tolerance_kg');
  const net = ev.gross_weight_kg - cyl.tare_kg;
  if (ev.gross_weight_kg < cyl.tare_kg - tol) {
    flags.push(['weight_below_tare', `Gross ${ev.gross_weight_kg} kg is below the registered tare ${cyl.tare_kg} kg – possibly a different cylinder.`]);
  }
  if (['empty_returned', 'warehouse_received'].includes(ev.event_type)) {
    const dispatch = db.prepare(`SELECT * FROM events WHERE cylinder_id = ? AND event_type IN ('dispatched','transferred')
      AND gross_weight_kg IS NOT NULL ORDER BY id DESC LIMIT 5`).all(cyl.id).find(notRejected(db));
    if (dispatch) {
      const dispatchNet = dispatch.gross_weight_kg - cyl.tare_kg;
      const days = (Date.parse(ev.server_received_at) - Date.parse(dispatch.server_received_at)) / 86400000;
      if (net > dispatchNet + tol) {
        flags.push(['weight_gain', `Returned with ${net.toFixed(2)} kg content, more than ${dispatchNet.toFixed(2)} kg at dispatch (event #${dispatch.id}) – refilled or swapped?`]);
      } else if (Math.abs(net - dispatchNet) <= tol && days > num(settings, 'unused_after_days')) {
        flags.push(['returned_unused', `Content unchanged (${net.toFixed(2)} kg) after ${days.toFixed(1)} days away – was it delivered and used?`]);
      }
    }
    const receipt = db.prepare("SELECT * FROM events WHERE cylinder_id = ? AND event_type = 'customer_received' ORDER BY id DESC LIMIT 3").all(cyl.id).find(notRejected(db));
    if (receipt && receipt.user_id === ev.user_id) {
      flags.push(['self_weighed_return', 'Return weight recorded by the same person who recorded the customer delivery.']);
    }
  }
  return flags;
}

function pairFlags(db, settings, { ev }) {
  if (ev.event_type !== 'customer_received') return [];
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const rows = db.prepare(`SELECT user_id FROM events WHERE site_id = ? AND event_type = 'customer_received' AND server_received_at >= ?`).all(ev.site_id, since);
  const total = rows.length + 1;
  const mine = rows.filter((r) => r.user_id === ev.user_id).length + 1;
  const pct = (mine / total) * 100;
  if (total >= num(settings, 'pair_min_events') && pct >= num(settings, 'pair_concentration_pct')) {
    return [['driver_customer_pair_concentration', `The same driver recorded ${mine} of ${total} receipts at this customer in 90 days (${Math.round(pct)}%).`]];
  }
  return [];
}

const RISK_FLAGS = ['implausible_travel', 'out_of_geofence', 'geofence_uncertain', 'unexpected_custody', 'repeated_scan', 'clock_skew',
  'weight_below_tare', 'weight_gain', 'returned_unused', 'self_weighed_return', 'driver_customer_pair_concentration',
  'no_customer_confirmation', 'customer_code_entered_very_fast', 'sms_code_failed_attempts', 'scan_far_from_confirmed_fix',
  'audit_mismatch', 'audit_not_found_chain', 'phone_changed_recently'];

// Risk score per cylinder: more review signals, long stays at a customer and
// weight anomalies make a cylinder more likely to be picked for audit.
function cylinderRisk(db, cyl) {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const flags = db.prepare(`SELECT f.flag_type FROM flags f JOIN events e ON e.id = f.event_id
    WHERE e.cylinder_id = ? AND f.created_at >= ?`).all(cyl.id, since).map((r) => r.flag_type);
  let score = 1;
  const reasons = [];
  const risky = flags.filter((f) => RISK_FLAGS.includes(f));
  if (risky.length) { score += 2 * risky.length; reasons.push(`${risky.length} review signal(s) in 90 days`); }
  const weight = flags.filter((f) => ['weight_gain', 'returned_unused', 'weight_below_tare'].includes(f)).length;
  if (weight) { score += 3 * weight; reasons.push('weight anomaly'); }
  if (cyl.movement_status === 'at_customer') {
    const last = db.prepare('SELECT server_received_at FROM events WHERE id = ?').get(cyl.latest_submitted_event_id);
    const days = last ? (Date.now() - Date.parse(last.server_received_at)) / 86400000 : 0;
    if (days > 30) { score += 2; reasons.push(`${Math.round(days)} days at customer`); }
  }
  if (cyl.movement_status === 'missing') { score += 5; reasons.push('reported missing'); }
  return { score, reasons };
}

// Weighted random pick without replacement (crypto.randomInt).
function weightedSample(items, count) {
  const pool = items.map((it) => ({ ...it, w: Math.max(1, Math.round(it.score * 10)) }));
  const out = [];
  while (out.length < count && pool.length) {
    const total = pool.reduce((s, it) => s + it.w, 0);
    let r = crypto.randomInt(0, total);
    const idx = pool.findIndex((it) => (r -= it.w) < 0);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

function riskSummary(db) {
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const rows = db.prepare(`SELECT f.flag_type, e.user_id, e.site_id, u.display_name AS user_name, s.name AS site_name
    FROM flags f JOIN events e ON e.id = f.event_id LEFT JOIN users u ON u.id = e.user_id LEFT JOIN sites s ON s.id = e.site_id
    WHERE f.created_at >= ? AND f.flag_type IN (${RISK_FLAGS.map(() => '?').join(',')})`).all(since, ...RISK_FLAGS);
  const group = (keyFn, nameFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (k == null) continue;
      const g = m.get(k) || { id: k, name: nameFn(r), total: 0, by_type: {} };
      g.total += 1;
      g.by_type[r.flag_type] = (g.by_type[r.flag_type] || 0) + 1;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.total - a.total).slice(0, 10);
  };
  const statementNoAnswer = db.prepare(`SELECT s.id, s.name, COUNT(*) AS n FROM holdings_statements h JOIN sites s ON s.id = h.site_id
    WHERE h.response IS NULL AND h.expires_at < ? GROUP BY s.id ORDER BY n DESC LIMIT 10`).all(new Date().toISOString());
  return { drivers: group((r) => r.user_id, (r) => r.user_name), sites: group((r) => r.site_id, (r) => r.site_name), statement_no_answer: statementNoAnswer };
}

module.exports = { weightFlags, pairFlags, cylinderRisk, weightedSample, riskSummary, RISK_FLAGS };
