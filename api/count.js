// Public usage counter for ClearHour (Vercel serverless function).
// GET  /api/count            -> { visits, yes, no }
// POST /api/count {event}    -> event is "visit", "yes" or "no"; returns the new totals
//
// Storage: Upstash Redis REST (add it from Vercel → Storage / Marketplace; it sets the env vars).
// Honesty: each event counts at most once per IP per day. Only a salted hash of the IP is stored,
// and that key expires after a day. No cookies, no personal data.
import { createHash } from 'node:crypto';

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const EVENTS = { visit: 'ch:visits', yes: 'ch:yes', no: 'ch:no' };

async function redis(...cmd) {
  const res = await fetch(`${URL_}/${cmd.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return (await res.json()).result;
}

async function totals() {
  const [visits, yes, no] = await redis('mget', EVENTS.visit, EVENTS.yes, EVENTS.no);
  return { visits: Number(visits) || 0, yes: Number(yes) || 0, no: Number(no) || 0 };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'counter not configured' });

  try {
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const key = EVENTS[body.event];
      if (!key) return res.status(400).json({ error: 'unknown event' });

      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const day = new Date().toISOString().slice(0, 10);
      const who = createHash('sha256').update(`${ip}|${day}|${TOKEN.slice(0, 8)}`).digest('hex').slice(0, 24);
      // SET NX: only the first event of this kind from this IP today is counted.
      const first = await redis('set', `ch:seen:${body.event}:${who}`, '1', 'NX', 'EX', '90000');
      if (first === 'OK') await redis('incr', key);
      return res.status(200).json(await totals());
    }
    if (req.method === 'GET') return res.status(200).json(await totals());
    return res.status(405).json({ error: 'method not allowed' });
  } catch {
    return res.status(502).json({ error: 'counter unavailable' });
  }
}
