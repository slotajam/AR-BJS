// SMS sending, phone-number handling and one-time code hashing.
//
// Providers:
//   console      – development only. Messages go to the server log and an
//                  in-memory outbox; the UI shows a red "DEVELOPMENT SMS" banner.
//                  Refused when NODE_ENV=production.
//   twilio       – Twilio Messaging REST API (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//                  and TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID).
//   thaibulksms  – ThaiBulkSMS API v2 (THAIBULKSMS_API_KEY, THAIBULKSMS_API_SECRET,
//                  THAIBULKSMS_SENDER).
//   none         – no provider: inspections are refused with 503, never faked.
//
// The real providers are written to the vendors' published HTTP APIs but have
// not been exercised against a live account in this repository's tests.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class SmsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Normalises Thai and international numbers to E.164. Returns null if invalid.
function normalizePhone(input) {
  let s = String(input || '').trim().replace(/[\s\-().]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^0\d{8,9}$/.test(s)) s = `+66${s.slice(1)}`;         // Thai local format
  else if (/^66\d{8,9}$/.test(s)) s = `+${s}`;
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  return s;
}

// +66812341234 -> +66 8x-xxx-1234
function maskPhone(e164) {
  if (!e164) return '';
  const m = /^\+(66)(\d)(\d+)(\d{4})$/.exec(e164);
  if (m) return `+${m[1]} ${m[2]}x-xxx-${m[4]}`;
  return `${e164.slice(0, 4)}…${e164.slice(-4)}`;
}

function loadSecret(dataDir) {
  if (process.env.CODE_SECRET) return Buffer.from(process.env.CODE_SECRET);
  const f = path.join(dataDir, 'code-secret.key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32), { mode: 0o600 });
  return fs.readFileSync(f);
}

function codeHasher(secret) {
  return {
    newCode: () => String(crypto.randomInt(0, 10000)).padStart(4, '0'),
    hash: (code, binding) => crypto.createHmac('sha256', secret).update(`${binding}|${code}`).digest('hex'),
    equal: (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)),
  };
}

function consoleProvider() {
  const outbox = [];
  return {
    name: 'console',
    isDev: true,
    outbox,
    async send(to, text) {
      const id = `dev-${crypto.randomBytes(6).toString('hex')}`;
      outbox.push({ id, to, text, at: new Date().toISOString() });
      if (outbox.length > 500) outbox.shift();
      console.log(`[DEV SMS – not sent] to ${maskPhone(to)}: ${text}`);
      return { id };
    },
  };
}

function twilioProvider(env) {
  const sid = env.TWILIO_ACCOUNT_SID; const token = env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !(env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID)) {
    throw new Error('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM or TWILIO_MESSAGING_SERVICE_SID');
  }
  return {
    name: 'twilio',
    isDev: false,
    async send(to, text) {
      const body = new URLSearchParams({ To: to, Body: text });
      if (env.TWILIO_MESSAGING_SERVICE_SID) body.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
      else body.set('From', env.TWILIO_FROM);
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new SmsError('SMS_SEND_FAILED', `Twilio error ${res.status}: ${data.message || 'unknown'}`);
      return { id: data.sid };
    },
  };
}

function thaiBulkSmsProvider(env) {
  const key = env.THAIBULKSMS_API_KEY; const secret = env.THAIBULKSMS_API_SECRET;
  if (!key || !secret || !env.THAIBULKSMS_SENDER) {
    throw new Error('SMS_PROVIDER=thaibulksms needs THAIBULKSMS_API_KEY, THAIBULKSMS_API_SECRET and THAIBULKSMS_SENDER');
  }
  return {
    name: 'thaibulksms',
    isDev: false,
    async send(to, text) {
      const body = new URLSearchParams({ msisdn: to.replace(/^\+66/, '0'), message: text, sender: env.THAIBULKSMS_SENDER });
      const res = await fetch('https://api-v2.thaibulksms.com/sms', {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new SmsError('SMS_SEND_FAILED', `ThaiBulkSMS error ${res.status}`);
      return { id: data.phone_number_list && data.phone_number_list[0] ? data.phone_number_list[0].message_id : 'thaibulksms' };
    },
  };
}

function noneProvider() {
  return {
    name: 'none',
    isDev: false,
    unavailable: true,
    async send() { throw new SmsError('SMS_NOT_CONFIGURED', 'No SMS provider is configured on this server.'); },
  };
}

// Picks the provider from SMS_PROVIDER. Default: console outside production,
// none in production. Console in production is refused.
function createSms(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const name = env.SMS_PROVIDER || (production ? 'none' : 'console');
  if (name === 'console') {
    if (production) throw new Error('SMS_PROVIDER=console is not allowed when NODE_ENV=production.');
    return consoleProvider();
  }
  if (name === 'twilio') return twilioProvider(env);
  if (name === 'thaibulksms') return thaiBulkSmsProvider(env);
  if (name === 'none') return noneProvider();
  throw new Error(`Unknown SMS_PROVIDER: ${name}`);
}

module.exports = { createSms, normalizePhone, maskPhone, loadSecret, codeHasher, SmsError };
