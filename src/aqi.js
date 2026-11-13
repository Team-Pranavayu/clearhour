// PM2.5 bands from India's National AQI (CPCB). CPCB defines them on 24-hour averages;
// we apply them to hourly forecast values as a practical guide, and say so in the app.
export const LEVELS = [
  { key: 'good', max: 30 },
  { key: 'satisfactory', max: 60 },
  { key: 'moderate', max: 90 },
  { key: 'poor', max: 120 },
  { key: 'verypoor', max: 250 },
  { key: 'severe', max: Infinity }
];

// CPCB National AQI: PM2.5 band edges (µg/m³) and the matching AQI range.
export const AQI_BANDS = [
  [0, 30, 0, 50],
  [31, 60, 51, 100],
  [61, 90, 101, 200],
  [91, 120, 201, 300],
  [121, 250, 301, 400]
];

/** AQI from PM2.5 alone. Above 250 µg/m³ (Severe) CPCB's range is 401–500; we show "400+". */
export function aqiOf(pm25) {
  const c = Math.round(pm25);
  if (c > 250) return '400+';
  const [clo, chi, ilo, ihi] = AQI_BANDS.find(([, hi]) => c <= hi);
  return String(Math.round(ilo + ((ihi - ilo) / (chi - clo)) * (c - clo)));
}

export function levelOf(pm25) {
  return LEVELS.findIndex((l) => pm25 <= l.max);
}

// The air-quality API returns a real forecast for about 4.5 days ahead; past data goes back years.
export const DAYS_AHEAD = 4;
export const MAX_RANGE_DAYS = 31;

// Awake hours we will suggest going out in (start hour 6:00, last window ends 22:00).
const FIRST_HOUR = 6;
const LAST_HOUR = 22;
const WINDOW = 2;

function toHours(data, from = 0) {
  const times = data.hourly.time;
  const pm = data.hourly.pm2_5;
  const hours = [];
  for (let i = from; i < times.length; i++) {
    if (pm[i] == null) continue;
    hours.push({ time: times[i], hour: Number(times[i].slice(11, 13)), pm25: Math.round(pm[i]), level: levelOf(pm[i]) });
  }
  return hours;
}

/** Cleanest 2-hour awake window, and awake hours at "poor" or worse grouped into ranges. */
export function windowAndAvoid(hours, notBefore = '') {
  let best = null;
  for (let i = 0; i + WINDOW <= hours.length; i++) {
    const slice = hours.slice(i, i + WINDOW);
    const consecutive = slice.every((h, k) => k === 0 || h.hour === (slice[k - 1].hour + 1) % 24);
    const awake = slice[0].hour >= FIRST_HOUR && slice[0].hour + WINDOW <= LAST_HOUR;
    if (!consecutive || !awake || slice[0].time < notBefore) continue;
    const avg = slice.reduce((s, h) => s + h.pm25, 0) / WINDOW;
    if (!best || avg < best.avg) best = { startIndex: i, avg: Math.round(avg), level: levelOf(avg) };
  }

  const avoid = [];
  hours.forEach((h, i) => {
    const awake = h.hour >= FIRST_HOUR && h.hour < LAST_HOUR;
    if (!awake || h.level < 3 || h.time < notBefore) return;
    const last = avoid[avoid.length - 1];
    if (last && last.endIndex === i - 1 && hours[i - 1].hour === (h.hour + 23) % 24) last.endIndex = i;
    else avoid.push({ startIndex: i, endIndex: i });
  });
  return { best, avoid };
}

/** Next 24 hours from the current local hour of the place. */
function localNowHour(data) {
  const offsetMs = (data.utc_offset_seconds || 0) * 1000;
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
}

export function analyse(data) {
  const localNow = localNowHour(data);
  let start = data.hourly.time.findIndex((t) => t.slice(0, 13) === localNow);
  if (start < 0) start = 0;
  const hours = toHours(data, start).slice(0, 24);
  if (!hours.length) return null;
  return { hours, now: hours[0], ...windowAndAvoid(hours) };
}

/** One summary per calendar day, plus the cleanest window across all days. */
export function analyseDays(data) {
  const now = localNowHour(data) + ":00"; // never suggest a time that has already passed
  const byDate = new Map();
  for (const h of toHours(data)) {
    const d = h.time.slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(h);
  }
  const days = [...byDate.entries()].map(([date, hours]) => {
    const avg = Math.round(hours.reduce((s, h) => s + h.pm25, 0) / hours.length);
    const last = hours[hours.length - 1];
    return {
      date,
      hours,
      avg,
      level: levelOf(avg),
      partialUntil: last.hour < 23 ? last.hour + 1 : null,
      // Only today is cut at the current hour; past dates show what the cleanest time was.
      ...windowAndAvoid(hours, date === now.slice(0, 10) ? now : '')
    };
  });
  let best = null;
  days.forEach((d, i) => {
    if (d.best && (!best || d.best.avg < days[best].best.avg)) best = i;
  });
  return { days, bestDay: best };
}

// Airports, stations etc. are not what people mean by "my city".
const NOT_A_PLACE = new Set(['AIRP', 'AIRH', 'AIRF', 'RSTN', 'BUSTN', 'HTL', 'SCH', 'HSP']);

export async function searchPlaces(query, lang) {
  const url =
    'https://geocoding-api.open-meteo.com/v1/search?count=10&countryCode=IN&format=json' +
    `&language=${encodeURIComponent(lang)}&name=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('search');
  const json = await res.json();
  const found = (json.results || [])
    .filter((r) => !NOT_A_PLACE.has(r.feature_code))
    // Towns and cities first, bigger ones first.
    .sort((a, b) => (/^PPL/.test(b.feature_code) - /^PPL/.test(a.feature_code)) || (b.population || 0) - (a.population || 0))
    .slice(0, 6)
    .map((r) => ({
      id: r.id,
      name: r.name,
      region: [r.admin2, r.admin1].filter(Boolean).join(', '),
      lat: r.latitude,
      lon: r.longitude
    }));
  if (found.length) return found;
  // Some names in Indian scripts (e.g. Bengali, Telugu, Odia) are missing there; ask OpenStreetMap once.
  return searchOsm(query, lang);
}

async function searchOsm(query, lang) {
  try {
    const res = await fetch(
      'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=in&limit=5&featureType=settlement&namedetails=1&addressdetails=1' +
        `&accept-language=${encodeURIComponent(lang)}&q=${encodeURIComponent(query)}`
    );
    if (!res.ok) return [];
    const list = await res.json();
    return list
      .filter((r) => ['city', 'town', 'village', 'municipality', 'suburb', 'county', 'state_district'].includes(r.addresstype))
      .map((r) => ({
        name: r.name,
        nameEn: (r.namedetails && r.namedetails['name:en']) || '',
        region: [r.address?.state_district, r.address?.state].filter(Boolean).join(', '),
        lat: Number(r.lat),
        lon: Number(r.lon)
      }));
  } catch {
    return [];
  }
}

/**
 * Name of the town/city at the device's own location, in the user's language.
 * BigDataCloud's free client-side endpoint (no key) is meant for exactly this use.
 * Returns '' on any failure so the app falls back to "My location".
 */
export async function placeNameAt(lat, lon, lang) {
  try {
    const res = await fetch(
      `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=${lang}`
    );
    if (!res.ok) return '';
    const j = await res.json();
    return j.city || j.locality || j.principalSubdivision || '';
  } catch {
    return '';
  }
}

const GEO = 'https://geocoding-api.open-meteo.com/v1';

/** One place by its GeoNames id, with the name in the given language. */
export async function placeById(id, lang) {
  try {
    const res = await fetch(`${GEO}/get?id=${encodeURIComponent(id)}&language=${lang}`);
    if (!res.ok) return null;
    const r = await res.json();
    if (!Number.isFinite(r.latitude)) return null;
    return { id: r.id, name: r.name, region: [r.admin2, r.admin1].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude };
  } catch {
    return null;
  }
}

/** Local-language name for an English place name near lat/lon (within ~30 km), or ''. */
export async function localNameNear(nameEn, lat, lon, lang) {
  try {
    const found = await searchPlaces(nameEn, lang);
    const near = found.find((r) => Math.abs(r.lat - lat) < 0.3 && Math.abs(r.lon - lon) < 0.3);
    return near ? near.name : '';
  } catch {
    return '';
  }
}

const BASE = 'https://air-quality-api.open-meteo.com/v1/air-quality?hourly=pm2_5&timezone=auto';

export async function fetchForecast(lat, lon) {
  const res = await fetch(`${BASE}&forecast_days=2&latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`);
  if (!res.ok) throw new Error('forecast');
  return res.json();
}

/** from/to are "YYYY-MM-DD" (inclusive). Works for past dates and up to DAYS_AHEAD ahead. */
export async function fetchRange(lat, lon, from, to) {
  const res = await fetch(
    `${BASE}&start_date=${from}&end_date=${to}&latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
  );
  if (!res.ok) throw new Error('forecast');
  return res.json();
}

// Local calendar helpers ("YYYY-MM-DD" in the user's own time zone).
export function isoDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
}
export function daysBetween(a, b) {
  const [y1, m1, d1] = a.split('-').map(Number);
  const [y2, m2, d2] = b.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
