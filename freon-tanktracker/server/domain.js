// Movement rules, geofence checks, review signals (flags) and the cylinder
// projection. Flags are review signals for a supervisor, not proof of fraud.
const { num } = require('./db');

const MOVEMENT_STATUSES = ['in_warehouse', 'in_transit', 'at_customer', 'empty_returned', 'maintenance', 'missing', 'retired'];

const EVENT_TYPES = ['registered', 'inspection', 'warehouse_received', 'dispatched', 'customer_received',
  'transferred', 'empty_returned', 'maintenance', 'missing_reported', 'retired', 'correction'];

// Event types an operator may submit through the controlled inspection flow.
const INSPECTION_EVENT_TYPES = ['inspection', 'warehouse_received', 'dispatched', 'customer_received',
  'transferred', 'empty_returned', 'maintenance'];

const CONDITIONS = ['good', 'damaged', 'leaking', 'label_damaged', 'needs_supervisor'];

const CHECKLIST_KEYS = ['beside_cylinder', 'serial_matches', 'qr_attached', 'condition_checked', 'site_bay_correct'];

const VERIFICATION = {
  recorded: 'recorded',
  evidence_pending: 'evidence_pending',
  evidence_reviewed: 'evidence_reviewed',
  exception_pending: 'exception_pending',
  rejected: 'rejected',
  secure_tag_authenticated: 'secure_tag_authenticated',
};
const ACCEPTED_STATUSES = new Set(['recorded', 'evidence_reviewed', 'secure_tag_authenticated']);

class RuleError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// Validates a movement and returns the resulting movement status.
// Destination receipt always needs its own inspection: dispatch only ever
// produces "in_transit", never an arrival.
function applyMovement(eventType, cyl, site, destination) {
  const from = cyl.movement_status;
  if (from === 'retired') throw new RuleError(409, 'CYLINDER_RETIRED', 'This cylinder is retired.');
  switch (eventType) {
    case 'inspection':
      // A missing cylinder that is found again returns to the site's status.
      if (from === 'missing') return site.kind === 'warehouse' ? 'in_warehouse' : 'at_customer';
      return null; // no movement change
    case 'warehouse_received':
      if (site.kind !== 'warehouse') throw new RuleError(422, 'SITE_KIND', 'Warehouse receipt must be recorded at a warehouse site.');
      return 'in_warehouse';
    case 'empty_returned':
      if (site.kind !== 'warehouse') throw new RuleError(422, 'SITE_KIND', 'Empty return must be recorded at a warehouse site.');
      return 'empty_returned';
    case 'customer_received':
      if (site.kind !== 'customer') throw new RuleError(422, 'SITE_KIND', 'Customer receipt must be recorded at a customer site.');
      if (from !== 'in_transit') throw new RuleError(409, 'NOT_IN_TRANSIT', 'Customer receipt requires the cylinder to be in transit. Record a dispatch first.');
      return 'at_customer';
    case 'dispatched':
    case 'transferred':
      if (!destination) throw new RuleError(422, 'DESTINATION_REQUIRED', 'Select the destination site.');
      if (destination.id === site.id) throw new RuleError(422, 'DESTINATION_SAME', 'Destination must differ from the current site.');
      if (from === 'in_transit') throw new RuleError(409, 'ALREADY_IN_TRANSIT', 'Cylinder is already in transit. Record the destination receipt first.');
      if (from === 'missing') throw new RuleError(409, 'CYLINDER_MISSING', 'Cylinder is reported missing. Record an inspection first.');
      return 'in_transit';
    case 'maintenance':
      return 'maintenance';
    default:
      throw new RuleError(422, 'EVENT_TYPE', 'Unsupported event type.');
  }
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Circle geofence. Uses the reported accuracy so results near the boundary
// are flagged as uncertain rather than inside/outside.
function checkGeofence(site, lat, lng, accuracy) {
  if (lat == null || lng == null) return { result: 'not_checked', distance: null };
  if (site.lat == null || site.lng == null || !site.radius_m) return { result: 'no_geofence', distance: null };
  const d = haversineM(lat, lng, site.lat, site.lng);
  const acc = Math.max(0, accuracy || 0);
  let result;
  if (d + acc <= site.radius_m) result = 'inside';
  else if (d - acc > site.radius_m) result = 'outside';
  else result = 'boundary_uncertain';
  return { result, distance: Math.round(d) };
}

function effectiveVerification(db, ev) {
  const r = db.prepare('SELECT decision FROM reviews WHERE event_id = ? ORDER BY id DESC LIMIT 1').get(ev.id);
  if (!r) return ev.initial_verification;
  return r.decision === 'approved' ? (ev.nfc_status === 'authenticated' ? 'secure_tag_authenticated' : 'evidence_reviewed') : 'rejected';
}

// Recomputes the cylinder projection from history. Rejected events never
// change the movement status or the last approved location.
// bumpVersion is set only when a new event is appended, so a supervisor
// review does not invalidate an operator's in-progress inspection.
function recomputeCylinder(db, cylinderId, { bumpVersion = false } = {}) {
  const events = db.prepare('SELECT * FROM events WHERE cylinder_id = ? ORDER BY id').all(cylinderId);
  const corrections = new Map();
  for (const e of events) if (e.event_type === 'correction' && e.corrects_event_id) corrections.set(e.corrects_event_id, e);
  let movement = null;
  let site = null;
  let destination = null;
  let latestSubmitted = null;
  let latestApproved = null;
  for (const e of events) {
    if (e.event_type === 'correction') continue;
    latestSubmitted = e.id;
    const status = effectiveVerification(db, e);
    if (status === 'rejected') continue;
    const corr = corrections.get(e.id);
    const siteId = corr && corr.site_id ? corr.site_id : e.site_id;
    if (e.movement_status_after) {
      movement = e.movement_status_after;
      destination = movement === 'in_transit' ? (corr && corr.destination_site_id) || e.destination_site_id : null;
    }
    if (siteId && movement !== 'in_transit') site = siteId;
    if (ACCEPTED_STATUSES.has(status) && (e.lat != null || e.event_type === 'registered')) latestApproved = e.id;
  }
  db.prepare(`UPDATE cylinders SET movement_status = ?, current_site_id = ?, destination_site_id = ?,
      latest_submitted_event_id = ?, latest_approved_event_id = ?, version = version + ? WHERE id = ?`)
    .run(movement || 'in_warehouse', site, destination, latestSubmitted, latestApproved, bumpVersion ? 1 : 0, cylinderId);
}

// Review signals computed on the server at submission time.
function computeFlags(db, settings, ctx) {
  const flags = [];
  const { cyl, ev, site } = ctx;
  if (ev.geofence_result === 'outside') flags.push(['out_of_geofence', `Fix ${ev.geofence_distance_m} m from site centre (radius ${site.radius_m} m, accuracy ${ev.accuracy_m} m).`]);
  if (ev.geofence_result === 'boundary_uncertain') flags.push(['geofence_uncertain', `Fix near site boundary: ${ev.geofence_distance_m} m from centre, radius ${site.radius_m} m, accuracy ${ev.accuracy_m} m.`]);
  if (ev.geofence_result === 'no_geofence') flags.push(['no_site_geofence', 'Selected site has no geofence configured.']);
  if (ev.location_status !== 'verified') flags.push(['location_not_verified', ev.location_issue || 'Location not verified.']);

  // Implausibly fast travel versus the previous located, non-rejected event.
  if (ev.lat != null) {
    const prev = db.prepare(`SELECT * FROM events WHERE cylinder_id = ? AND lat IS NOT NULL AND event_type <> 'correction'
      ORDER BY id DESC LIMIT 5`).all(cyl.id).find((p) => effectiveVerification(db, p) !== 'rejected');
    if (prev) {
      const km = haversineM(prev.lat, prev.lng, ev.lat, ev.lng) / 1000;
      const hours = Math.max((Date.parse(ev.server_received_at) - Date.parse(prev.server_received_at)) / 3600000, 1 / 3600);
      const kmh = km / hours;
      if (km > 2 && kmh > num(settings, 'fast_travel_kmh')) {
        flags.push(['implausible_travel', `${km.toFixed(1)} km from event #${prev.id} in ${(hours * 60).toFixed(1)} min (≈${Math.round(kmh)} km/h).`]);
      }
    }
  }

  // Repeated scans of the same cylinder in a short period.
  const mins = num(settings, 'repeat_scan_minutes');
  const since = new Date(Date.parse(ev.server_received_at) - mins * 60000).toISOString();
  const recent = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE cylinder_id = ? AND server_received_at >= ?
    AND event_type NOT IN ('correction','registered')`).get(cyl.id, since).n;
  if (recent > 0) flags.push(['repeated_scan', `${recent} other event(s) for this cylinder in the last ${mins} min.`]);

  // Unexpected custody changes.
  if (['customer_received', 'warehouse_received', 'empty_returned'].includes(ev.event_type)) {
    if (cyl.movement_status === 'in_transit' && cyl.destination_site_id && cyl.destination_site_id !== ev.site_id) {
      flags.push(['unexpected_custody', `Received at site ${ev.site_id} but dispatched to site ${cyl.destination_site_id}.`]);
    }
    if (ev.event_type !== 'customer_received' && cyl.movement_status === 'at_customer') {
      flags.push(['unexpected_custody', 'Received at warehouse without a recorded dispatch or transfer from the customer.']);
    }
  }
  if (ev.event_type === 'inspection' && cyl.movement_status !== 'in_transit' && cyl.current_site_id && cyl.current_site_id !== ev.site_id) {
    flags.push(['unexpected_custody', `Inspected at site ${ev.site_id} but last recorded at site ${cyl.current_site_id}.`]);
  }
  if (ev.event_type === 'inspection' && cyl.movement_status === 'missing') flags.push(['missing_found', 'Cylinder was reported missing.']);
  if (['dispatched', 'transferred'].includes(ev.event_type) && cyl.current_site_id && cyl.current_site_id !== ev.site_id) {
    flags.push(['unexpected_custody', `Dispatched from site ${ev.site_id} but last recorded at site ${cyl.current_site_id}.`]);
  }

  if (ev.clock_skew_s != null) flags.push(['clock_skew', `Phone clock differs from server by ≈${ev.clock_skew_s} s.`]);
  if (ev.condition && ev.condition !== 'good') flags.push(['condition_reported', `Condition reported: ${ev.condition}.`]);
  if (ev.is_exception) flags.push(['exception', ev.exception_kind]);
  return flags;
}

module.exports = {
  MOVEMENT_STATUSES, EVENT_TYPES, INSPECTION_EVENT_TYPES, CONDITIONS, CHECKLIST_KEYS, VERIFICATION, ACCEPTED_STATUSES,
  RuleError, applyMovement, haversineM, checkGeofence, effectiveVerification, recomputeCylinder, computeFlags,
};
