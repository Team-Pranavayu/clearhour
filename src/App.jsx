import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LANGS, T } from './i18n.js';
import {
  LEVELS, aqiOf, DAYS_AHEAD, MAX_RANGE_DAYS, analyse, analyseDays, fetchForecast, fetchRange, searchPlaces, placeNameAt, placeById, localNameNear,
  isoDate, addDays, daysBetween
} from './aqi.js';
import { track, getCounts } from './track.js';

const POPULAR = [
  ['Delhi', 28.61, 77.21], ['Mumbai', 19.08, 72.88], ['Kolkata', 22.57, 88.36],
  ['Chennai', 13.08, 80.27], ['Bengaluru', 12.97, 77.59], ['Hyderabad', 17.39, 78.49],
  ['Ahmedabad', 23.03, 72.58], ['Lucknow', 26.85, 80.95], ['Patna', 25.59, 85.14], ['Pune', 18.52, 73.86]
].map(([name, lat, lon]) => ({ name, nameEn: name, nameLang: 'en', region: '', lat, lon }));

const today = () => isoDate(new Date());

const GROUPS = ['general', 'child', 'elderly', 'asthma', 'worker'];

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage blocked: app still works, just doesn't remember */
    }
  }
};

// Settings carried by a shared link. Short form (what we create):
//   ?g=1279233 (a searched city's id)  or  ?p=23.03,72.58&n=Ahmedabad (device location)
//   &l=hi &f=child &w=tm|d5 &d=20261108-20261110
// The older long form (?place=&lat=&lon=&lang=&for=&when=&from=&to=) is still read.
const URLP = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
const SHORT_WHEN = { tm: 'tomorrow', d5: 'days5' };
const LONG_WHEN = { tomorrow: 'tm', days5: 'd5' };
const ymd = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

function placeFromUrl() {
  const id = URLP.get('g');
  if (/^\d{1,10}$/.test(id || '')) return { id: Number(id), fromLink: true };
  let lat;
  let lon;
  if (URLP.get('p')) [lat, lon] = URLP.get('p').split(',').map(Number);
  else if (URLP.get('lat')) [lat, lon] = [Number(URLP.get('lat')), Number(URLP.get('lon'))];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = (URLP.get('n') || URLP.get('place') || '').slice(0, 80);
  // An English name is translated to the reader's language after loading (see localName).
  return { name, nameEn: /^[A-Za-z][A-Za-z .'-]*$/.test(name) ? name : '', nameLang: 'en', region: '', lat, lon };
}

function whenFromUrl() {
  const now = today();
  const w = SHORT_WHEN[URLP.get('w')] || URLP.get('when');
  if (w === 'tomorrow') return { mode: 'range', preset: 'tomorrow', from: addDays(now, 1), to: addDays(now, 1) };
  if (w === 'days5') return { mode: 'range', preset: 'days5', from: now, to: addDays(now, DAYS_AHEAD) };
  const short = /^(\d{8})-(\d{8})$/.exec(URLP.get('d') || '');
  const from = short ? ymd(short[1]) : URLP.get('from');
  const to = short ? ymd(short[2]) : URLP.get('to');
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '') && d >= addDays(now, -365) && d <= addDays(now, DAYS_AHEAD);
  if (ok(from) && ok(to) && from <= to && daysBetween(from, to) < MAX_RANGE_DAYS) {
    return { mode: 'range', preset: 'custom', from, to };
  }
  return { mode: 'next24' };
}

function defaultLang() {
  const fromLink = URLP.get('l') || URLP.get('lang');
  if (fromLink && T[fromLink]) return fromLink;
  const saved = store.get('ch:lang', null);
  if (saved && T[saved]) return saved;
  const nav = (navigator.language || 'en').slice(0, 2);
  return T[nav] ? nav : 'en';
}

function hourLabel(hour, lang) {
  return new Intl.DateTimeFormat(`${lang}-IN`, { hour: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, 0, 1, hour % 24))
  );
}

function range(startHour, endHour, lang, tomorrow = false) {
  // Non-breaking spaces keep "2 pm – 4 pm" on one line; only "(tomorrow)" may wrap.
  const keep = (s) => s.replace(/\s/g, ' ');
  // (⁠ = word joiner: browsers may otherwise break a line right after the dash.)
  const text = `${keep(hourLabel(startHour, lang))} ⁠–⁠ ${keep(hourLabel(endHour, lang))}`;
  if (!tomorrow) return text;
  return `${text} (${T[lang].tomorrow})`;
}

function dayLabel(iso, lang) {
  const [y, m, d] = iso.split("-").map(Number);
  const otherYear = y !== new Date().getFullYear();
  return new Intl.DateTimeFormat(`${lang}-IN`, {
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(otherYear ? { year: "numeric" } : {})
  }).format(
    new Date(y, m - 1, d)
  );
}

const isTomorrow = (hours, i) => hours[i].time.slice(0, 10) !== hours[0].time.slice(0, 10);

export default function App() {
  const [lang, setLang] = useState(defaultLang);
  const [group, setGroup] = useState(() => {
    const g = URLP.get('f') || URLP.get('for');
    return GROUPS.includes(g) ? g : store.get('ch:group', 'general');
  });
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [saved, setSaved] = useState(() => store.get('ch:last', null)); // { place, data, at }
  const [status, setStatus] = useState(''); // '', 'loading', or a message key
  const [offline, setOffline] = useState(false);
  const [picked, setPicked] = useState(null);
  const [info, setInfo] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [installEvt, setInstallEvt] = useState(null);
  const [feedback, setFeedback] = useState(() => (store.get("ch:fb", "") === today() ? "done" : ""));
  const [tour, setTour] = useState(null); // null | { kind: "start" | "result", ask: boolean }
  const [counts, setCounts] = useState(null); // { visits, yes, no } from our own /api/count

  // Send a counted event and show the new public totals.
  const count = (name) => {
    const p = track(name);
    if (p) p.then((c) => c && setCounts(c));
  };
  useEffect(() => {
    getCounts().then((c) => c && setCounts(c));
  }, []);
  const [when, setWhen] = useState(whenFromUrl); // or { mode: "range", preset, from, to }
  const [range2, setRange2] = useState(null); // { key, status: "loading" | "ok" | "error", days }
  const [voiceLangs, setVoiceLangs] = useState([]);
  const canSpeak =
    typeof window !== "undefined" && "speechSynthesis" in window && voiceLangs.some((v) => v.startsWith(lang));

  // Voices load late on some phones; keep the list fresh.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const read = () => setVoiceLangs(window.speechSynthesis.getVoices().map((v) => v.lang.toLowerCase().replace("_", "-")));
    read();
    window.speechSynthesis.addEventListener?.("voiceschanged", read);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", read);
  }, []);

  const t = T[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
    store.set('ch:lang', lang);
  }, [lang]);
  useEffect(() => store.set('ch:group', group), [group]);

  // Chrome/Android offer an install prompt for PWAs; keep it for our own button.
  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setInstallEvt(e);
    };
    const onInstalled = () => {
      setInstallEvt(null);
      track("installed");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Stop speaking when language changes or the page goes away.
  useEffect(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [lang]);

  // A shared link opens that place; otherwise refresh the last place.
  useEffect(() => {
    const fromLink = placeFromUrl();
    if (fromLink?.fromLink) {
      placeById(fromLink.id, lang).then((place) => (place ? load({ ...place, nameLang: lang }) : setStatus('notFound')));
      window.history.replaceState(null, '', window.location.pathname);
    } else if (fromLink) {
      load(fromLink);
      // Tidy the address bar so a re-shared or bookmarked page starts clean.
      window.history.replaceState(null, '', window.location.pathname);
    } else if (saved?.place) {
      load(saved.place, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(place, quiet = false) {
    if (!quiet) setStatus('loading');
    setResults([]);
    try {
      const data = await fetchForecast(place.lat, place.lon);
      const next = { place, data, at: Date.now() };
      setSaved(next);
      store.set('ch:last', next);
      setOffline(false);
      setStatus('');
      setPicked(null);
      if (!quiet) count(`city/${place.mine ? "my-location" : place.name}`);
    } catch {
      const cached = store.get('ch:last', null);
      if (cached && cached.place.lat === place.lat && cached.place.lon === place.lon) {
        setSaved(cached);
        setOffline(true);
        setStatus('');
      } else {
        setStatus('error');
      }
    }
  }

  async function onSearch(e) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    setStatus('loading');
    try {
      const found = await searchPlaces(q, lang);
      setResults(found);
      setStatus(found.length ? '' : 'notFound');
    } catch {
      setStatus('error');
    }
  }

  function onLocate() {
    if (!navigator.geolocation) return setStatus('locError');
    setStatus('loading');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        const [name, nameEn] = await Promise.all([
          placeNameAt(lat, lon, lang),
          lang === 'en' ? null : placeNameAt(lat, lon, 'en')
        ]);
        load({ name, nameEn: lang === 'en' ? name : nameEn, nameLang: lang, region: '', lat, lon, mine: true });
      },
      () => setStatus('locError'),
      { timeout: 10000, maximumAge: 10 * 60 * 1000 }
    );
  }

  const result = useMemo(() => (saved ? analyse(saved.data) : null), [saved]);

  const rangeKey = saved && when.mode === "range" ? `${saved.place.lat},${saved.place.lon},${when.from},${when.to}` : "";
  useEffect(() => {
    if (!rangeKey) return;
    let live = true;
    setRange2({ key: rangeKey, status: "loading" });
    fetchRange(saved.place.lat, saved.place.lon, when.from, when.to)
      .then((data) => {
        if (!live) return;
        const r = analyseDays(data);
        setRange2({ key: rangeKey, status: r.days.length ? "ok" : "empty", ...r });
        track(`dates/${when.preset}/${daysBetween(when.from, when.to) + 1}d`);
      })
      .catch(() => live && setRange2({ key: rangeKey, status: "error" }));
    return () => {
      live = false;
    };
  }, [rangeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const rangeNow = range2 && range2.key === rangeKey ? range2 : null;
  const view = when.mode === "range" ? "range" : "next24";

  // Tour, part 1: on the very first visit, on the landing screen (before any city is chosen).
  useEffect(() => {
    if (store.get("ch:tour", false)) return;
    const id = setTimeout(() => setTour((cur) => cur || { kind: "start", ask: true }), 600);
    return () => clearTimeout(id);
  }, []);

  // Tour, part 2: right after the first forecast appears, if part 1 was finished (not skipped).
  useEffect(() => {
    if (!result || tour || !store.get("ch:tour", false) || store.get("ch:tour2", false)) return;
    const id = setTimeout(() => setTour({ kind: "result", ask: false }), 600);
    return () => clearTimeout(id);
  }, [result, tour]);

  function endTour(finished) {
    const kind = tour?.kind;
    setTour(null);
    store.set("ch:tour", true);
    // Skipping anywhere, or finishing part 2, means no more tour.
    if (!finished || kind === "result") store.set("ch:tour2", true);
  }

  const placeName = !saved ? '' : saved.place.name || (saved.place.mine ? t.myLocation : `${saved.place.lat.toFixed(2)}, ${saved.place.lon.toFixed(2)}`);

  // A device-location name came back in the old language: fetch it again in the new one.
  useEffect(() => {
    const place = saved?.place;
    if (!place || place.nameLang === lang) return;
    let live = true;
    const lookup = place.mine
      ? placeNameAt(place.lat, place.lon, lang)
      : place.id
        ? placeById(place.id, lang).then((p) => p?.name || '')
        : place.nameEn
          ? localNameNear(place.nameEn, place.lat, place.lon, lang)
          : Promise.resolve('');
    lookup.then((name) => {
      if (!live || !name) return;
      const next = { ...saved, place: { ...saved.place, name, nameLang: lang } };
      setSaved(next);
      store.set('ch:last', next);
    });
    return () => {
      live = false;
    };
  }, [lang, saved?.place.lat, saved?.place.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  let bestText = "";
  let heroBest = null;
  let heroLabel = t.bestTime;
  if (view === "next24" && result?.best) {
    heroBest = result.best;
    const i = result.best.startIndex;
    const h = result.hours[i].hour;
    bestText = range(h, h + 2, lang, isTomorrow(result.hours, i));
  } else if (view === "range" && rangeNow?.status === "ok") {
    heroLabel = t.bestInRange;
    if (rangeNow.bestDay != null) {
      const d = rangeNow.days[rangeNow.bestDay];
      heroBest = d.best;
      const h = d.hours[d.best.startIndex].hour;
      bestText = `${dayLabel(d.date, lang)} · ${range(h, h + 2, lang)}`;
    }
  }

  function filterLabel() {
    if (when.mode === 'next24') return t.next24;
    const span = when.from === when.to ? dayLabel(when.from, lang) : `${dayLabel(when.from, lang)} – ${dayLabel(when.to, lang)}`;
    if (when.preset === 'days5') return `${t.days5} (${span})`;
    if (when.preset === 'tomorrow') {
      const w = t.tomorrow;
      return `${w.charAt(0).toLocaleUpperCase(lang) + w.slice(1)} (${span})`;
    }
    return span;
  }

  function share() {
    const { lat, lon, mine } = saved.place;
    // Don't put a precise home location in a shared link: round GPS to ~1 km.
    // Short, readable link with no %-encoded text. GPS is rounded to ~1 km (2 decimals) for everyone.
    const { id, nameEn } = saved.place;
    const parts = [];
    if (id && !mine) {
      parts.push(`g=${id}`); // the receiver gets the exact city, named in their own language
    } else {
      parts.push(`p=${lat.toFixed(2)},${lon.toFixed(2)}`);
      if (nameEn && /^[A-Za-z][A-Za-z .'-]{0,40}$/.test(nameEn)) parts.push(`n=${nameEn.trim().replace(/ /g, '+')}`);
    }
    parts.push(`l=${lang}`);
    if (group !== 'general') parts.push(`f=${group}`);
    if (when.mode === 'range') {
      // Presets stay relative so the link is still useful tomorrow; picked dates stay fixed.
      if (when.preset === 'custom') parts.push(`d=${when.from.replace(/-/g, '')}-${when.to.replace(/-/g, '')}`);
      else parts.push(`w=${LONG_WHEN[when.preset]}`);
    }
    const url = `${window.location.origin}/?${parts.join('&')}`;
    const spans = (hours, list) =>
      list.map((a) => range(hours[a.startIndex].hour, hours[a.endIndex].hour + 1, lang)).join(', ');

    const lines = [`*ClearHour · ${placeName}*`, filterLabel(), ''];
    if (heroBest) lines.push(`${heroLabel}: *${bestText}* (${t.levels[heroBest.level]})`);
    if (view === 'next24') {
      lines.push(`${t.now}: ${t.levels[result.now.level]}`);
      if (result.avoid.length) lines.push(`${t.avoid}: ${spans(result.hours, result.avoid)}`);
    } else if (rangeNow?.status === 'ok') {
      const MAX_LINES = 7; // keep the message readable; the link has the rest
      lines.push('');
      for (const d of rangeNow.days.slice(0, MAX_LINES)) {
        let line = `• ${dayLabel(d.date, lang)}: ${t.levels[d.level]}`;
        if (d.best) {
          const h = d.hours[d.best.startIndex].hour;
          line += ` | ${t.bestTime}: ${range(h, h + 2, lang)}`;
        }
        if (d.avoid.length) line += ` | ${t.avoid}: ${spans(d.hours, d.avoid)}`;
        lines.push(line);
      }
      if (rangeNow.days.length > MAX_LINES) lines.push('…');
      if (when.from < today()) lines.push('', `_${t.pastNote}_`);
    }
    lines.push('', `${t.whoFor}: *${t.groups[group]}*`, t.tips[group], '', `${t.shareCheck} ${url}`);

    track(`share-whatsapp/${when.mode === 'range' ? when.preset : 'next24'}/${lang}`);
    window.open(`https://wa.me/?text=${encodeURIComponent(lines.join('\n'))}`, '_blank', 'noopener');
  }

  function listen() {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      setSpeaking(false);
      return;
    }
    const parts = [placeName];
    if (heroBest) parts.push(`${heroLabel}: ${bestText}. ${t.levels[heroBest.level]}.`);
    parts.push(t.tips[group]);
    if (view === "next24") {
      parts.push(`${t.now}: ${t.levels[result.now.level]}. ${t.advice[result.now.level]}`);
    } else if (rangeNow?.status === "ok") {
      // Read every selected day, not just the best one.
      for (const d of rangeNow.days) {
        const day = [`${dayLabel(d.date, lang)}: ${t.levels[d.level]}`];
        if (d.best) {
          const h = d.hours[d.best.startIndex].hour;
          day.push(`${t.bestTime}: ${range(h, h + 2, lang)}`);
        }
        if (d.avoid.length) {
          const spans = d.avoid.map((a) => range(d.hours[a.startIndex].hour, d.hours[a.endIndex].hour + 1, lang));
          day.push(`${t.avoid}: ${spans.join(", ")}`);
        }
        parts.push(day.join(". "));
      }
    }
    // One clean pause between parts: drop each part's own full stop (. or ।) and the "·" separator.
    const spoken = parts
      .filter(Boolean)
      .map((p) => p.replace(/ · /g, ", ").replace(/[.।]+\s*$/, ""))
      .join(". ");
    const u = new SpeechSynthesisUtterance(spoken);
    u.lang = `${lang}-IN`;
    const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
    if (voice) u.voice = voice;
    u.rate = 0.95;
    u.onend = u.onerror = () => setSpeaking(false);
    synth.cancel();
    synth.speak(u);
    setSpeaking(true);
    track(`listen/${lang}`);
  }

  async function install() {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice;
    setInstallEvt(null);
  }

  function answer(yes) {
    count(`feedback/${yes ? "yes" : "no"}/${group}`);
    store.set("ch:fb", today());
    setFeedback("thanks");
  }

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <img src="/icon.svg" alt="" width="36" height="36" />
          <div>
            <h1>
              ClearHour <IndiaFlag />
            </h1>
            <p className="tagline">{t.tagline}</p>
          </div>
        </div>
        <LangPicker lang={lang} setLang={setLang} tip={t.tipLang} />
      </header>

      <Counter counts={counts} lang={lang} t={t} />

      <form className="search" onSubmit={onSearch}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t.search}
          aria-label={t.search}
        />
        <button type="submit">{t.searchBtn}</button>
      </form>
      <button className="locate" onClick={onLocate} type="button" data-tip={t.tipLocate}>
        <Icon name="locate" /> {t.useLocation}
      </button>

      <WhenBar when={when} setWhen={setWhen} lang={lang} t={t} />

      {results.length > 0 && (
        <ul className="results">
          {results.map((r) => (
            <li key={`${r.lat},${r.lon}`}>
              <button type="button" onClick={() => load({ ...r, nameLang: lang })}>
                <strong>{r.name}</strong>
                <span>{r.region}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {status === 'loading' && <p className="note">{t.loading}</p>}
      {status && status !== 'loading' && <p className="note warn">{t[status]}</p>}
      {offline && <p className="note warn">{t.offline}</p>}

      {!saved && !status && <p className="empty">{t.pickCity}</p>}

      {!saved && results.length === 0 && (
        <div className="popular">
          <span>{t.popular}</span>
          <div className="chips">
            {POPULAR.map((p) => (
              <button key={p.name} type="button" className="chip" onClick={() => load(p)}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {result && (
        <main>
          <div className="who">
            <span>{t.whoFor}</span>
            <div className="chips" role="radiogroup" aria-label={t.whoFor}>
              {GROUPS.map((g) => (
                <button
                  key={g}
                  type="button"
                  role="radio"
                  aria-checked={group === g}
                  className={group === g ? 'chip on' : 'chip'}
                  onClick={() => setGroup(g)}
                  data-tip={t.tipGroup}
                >
                  {t.groups[g]}
                </button>
              ))}
            </div>
          </div>

          {view === "range" && rangeNow?.status !== "ok" ? (
            <p className={rangeNow?.status === "loading" || !rangeNow ? "note" : "note warn"}>
              {!rangeNow || rangeNow.status === "loading" ? t.loading : rangeNow.status === "empty" ? t.noData : t.error}
            </p>
          ) : (
          <>
          <section className="card hero">
            <div className="row">
              <p className="place">{saved.place.mine && <Icon name="locate" size={15} />} {placeName}</p>
              <InfoButton info={info} setInfo={setInfo} t={t} />
            </div>
            {info && <InfoBox t={t} />}
            <p className="label">{heroLabel}</p>
            {heroBest ? (
              <>
                <p className="big">{bestText}</p>
                <Level level={heroBest.level} t={t} value={heroBest.avg} info={info} />
              </>
            ) : (
              <p>{t.noBest}</p>
            )}
            <p className="tip">{t.tips[group]}</p>
            <div className="actions">
              {heroBest && (
                <button type="button" className="share" onClick={share} data-tip={t.tipShare}>
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.7a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.2-.2-.5-.3Z" />
                  </svg>
                  {t.share}
                </button>
              )}
              {canSpeak && (
                <button type="button" className={speaking ? "listen on" : "listen"} onClick={listen} aria-pressed={speaking} data-tip={t.tipListen} data-tip-align="end">
                  <Icon name={speaking ? "stop" : "speaker"} /> {speaking ? t.stop : t.listen}
                </button>
              )}
            </div>
            {view === "range" && when.from < today() && <p className="pastnote">{t.pastNote}</p>}
          </section>

          {view === "range" ? (
            <DayList days={rangeNow.days} lang={lang} t={t} info={info} />
          ) : (
          <>
          <section className="grid">
            <div className="card">
              <p className="label">{t.now}</p>
              <Level level={result.now.level} t={t} value={result.now.pm25} info={info} />
              <p className="advice">{t.advice[result.now.level]}</p>
            </div>
            <div className="card">
              <p className="label">{t.avoid}</p>
              {result.avoid.length ? (
                <ul className="avoid">
                  {result.avoid.map((a) => (
                    <li key={a.startIndex}>
                      {range(
                        result.hours[a.startIndex].hour,
                        result.hours[a.endIndex].hour + 1,
                        lang,
                        isTomorrow(result.hours, a.startIndex)
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t.noAvoid}</p>
              )}
            </div>
          </section>

          <section className="card">
            <div className="row">
              <p className="label">{info ? t.chartTitle : t.chartTitle.split(" · ")[0]}</p>
              <InfoButton info={info} setInfo={setInfo} t={t} />
            </div>
            <Chart result={result} lang={lang} t={t} picked={picked} setPicked={setPicked} info={info} />
          </section>
          </>
          )}
          </>
          )}

          {feedback !== "done" && (
            <section className="card feedback">
              {feedback === "thanks" ? (
                <p>{t.thanks}</p>
              ) : (
                <>
                  <p className="fbq">{t.helpful}</p>
                  <div className="fbbtns">
                    <button type="button" onClick={() => answer(true)}><Icon name="up" /> {t.yes}</button>
                    <button type="button" onClick={() => answer(false)}><Icon name="down" /> {t.no}</button>
                  </div>
                </>
              )}
            </section>
          )}

          {installEvt && (
            <button type="button" className="install" onClick={install}>
              <Icon name="plus" /> {t.install}
            </button>
          )}

          <p className="meta">
            {t.updated}:{' '}
            {new Intl.DateTimeFormat(`${lang}-IN`, { dateStyle: 'medium', timeStyle: 'short' }).format(
              new Date(saved.at)
            )}
          </p>
        </main>
      )}

      {tour && (
        <Tour key={tour.kind} t={t} steps={tour.kind === "start" ? TOUR_START : TOUR_RESULT} ask={tour.ask}
          thanks={tour.kind === "result"} onEnd={endTour} />
      )}

      <footer>
        <p>{t.disclaimer}</p>
        <p>
          <a href="https://github.com/HarshitBhalani/clearhour" id="repo-link" target="_blank" rel="noopener noreferrer">
            Open source (MIT)
          </a>{' '}
          · Data: Open-Meteo / Copernicus CAMS
          {" · "}
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              window.scrollTo(0, 0);
              setTour({ kind: result ? "result" : "start", ask: true });
            }}
          >
            {t.tourAgain}
          </button>
        </p>
      </footer>
    </div>
  );
}

function Level({ level, t, value, info }) {
  return (
    <p className="level">
      <span className={`dot l${level}`} aria-hidden="true" />
      <strong>{t.levels[level]}</strong>
      {info && <span className="value"><b>AQI {aqiOf(value)}</b> · PM2.5 {value} µg/m³</span>}
    </p>
  );
}

function InfoButton({ info, setInfo, t }) {
  return (
    <button
      type="button"
      className={info ? "infobtn on" : "infobtn"}
      aria-pressed={info}
      aria-label={t.infoTitle}
      data-tip={t.tipInfo}
      data-tip-align="end"
      onClick={() => setInfo(!info)}
    >
      i
    </button>
  );
}

const AQI_RANGES = ['0–50', '51–100', '101–200', '201–300', '301–400', '401–500'];

function InfoBox({ t }) {
  let low = 0;
  return (
    <div className="infobox">
      <p className="infotitle">{t.infoTitle}</p>
      <p>{t.pmInfo}</p>
      <ul className="bands">
        {LEVELS.map((l, i) => {
          const pm = l.max === Infinity ? `> ${low}` : `${low === 0 ? 0 : low + 1}–${l.max}`;
          low = l.max;
          return (
            <li key={l.key}>
              <span className={`dot l${i}`} aria-hidden="true" />
              <span className="bandname">{t.levels[i]}</span>
              <strong>AQI {AQI_RANGES[i]}</strong>
              <span className="bandpm">PM2.5 {pm} µg/m³</span>
            </li>
          );
        })}
      </ul>
      <p className="aqinote">{t.aqiNote}</p>
    </div>
  );
}

function Chart({ result, lang, t, picked, setPicked, info }) {
  const { hours, best } = result;
  const W = 480;
  const H = 180;
  const padL = 34;
  const padB = 22;
  const padT = 8;
  const plotH = H - padB - padT;
  const maxVal = Math.max(120, ...hours.map((h) => h.pm25));
  const step = (W - padL) / hours.length;
  const barW = Math.max(4, step - 3);
  const y = (v) => padT + plotH - (v / maxVal) * plotH;
  const ticks = [0, 60, 120, 250].filter((v) => v <= maxVal);
  const sel = picked != null ? hours[picked] : null;

  return (
    <>
      <p className="readout" aria-live="polite">
        {sel
          ? `${hourLabel(sel.hour, lang)} · ${t.levels[sel.level]}${info ? ` · AQI ${aqiOf(sel.pm25)} · PM2.5 ${sel.pm25} µg/m³` : ""}`
          : <span className="hint">{t.tipChart}</span>}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label={t.chartTitle}>
        {best && (
          <rect
            x={padL + best.startIndex * step - 1}
            y={padT}
            width={step * 2}
            height={plotH}
            className="bestband"
            rx="4"
          />
        )}
        {ticks.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W} y1={y(v)} y2={y(v)} className="grid" />
            {info && (
              <text x={padL - 6} y={y(v) + 4} className="axis" textAnchor="end">
                {v}
              </text>
            )}
          </g>
        ))}
        {hours.map((h, i) => {
          const top = y(Math.max(h.pm25, 1));
          return (
            <g
              key={h.time}
              onClick={() => setPicked(i === picked ? null : i)}
              onMouseEnter={() => setPicked(i)}
              className="barhit"
            >
              <rect x={padL + i * step} y={padT} width={step} height={plotH} fill="transparent" />
              <path
                className={`bar l${h.level} ${picked === i ? 'sel' : ''}`}
                d={roundTop(padL + i * step + (step - barW) / 2, top, barW, padT + plotH - top)}
              />
              {i % 3 === 0 && (
                <text x={padL + i * step + step / 2} y={H - 6} className="axis" textAnchor="middle">
                  {hourLabel(h.hour, lang)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <ul className="legend">
        {LEVELS.map((l, i) => (
          <li key={l.key}>
            <span className={`dot l${i}`} aria-hidden="true" />
            {t.levels[i]}
          </li>
        ))}
      </ul>
      <details className="table">
        <summary>{t.tableTitle}</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">{t.colTime}</th>
              <th scope="col" className="num">AQI</th>
              <th scope="col" className="num">
                PM2.5 <span className="unit">µg/m³</span>
              </th>
              <th scope="col">{t.colLevel}</th>
            </tr>
          </thead>
          <tbody>
            {hours.map((h, i) => (
              <tr key={h.time} className={best && i >= best.startIndex && i < best.startIndex + 2 ? 'bestrow' : ''}>
                <td>{hourLabel(h.hour, lang)}</td>
                <td className="num">{aqiOf(h.pm25)}</td>
                <td className="num">{h.pm25}</td>
                <td>
                  <span className="lvl">
                    <span className={`dot l${h.level}`} aria-hidden="true" />
                    {t.levels[h.level]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

// Bar with 4px rounded top, square at the baseline.
function roundTop(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
}

function IndiaFlag() {
  const spokes = Array.from({ length: 24 }, (_, i) => {
    const a = (i * Math.PI) / 12;
    return <line key={i} x1="15" y1="10" x2={15 + 2.6 * Math.cos(a)} y2={10 + 2.6 * Math.sin(a)} />;
  });
  return (
    <svg className="flag" viewBox="0 0 30 20" width="24" height="16" role="img" aria-label="India">
      <rect width="30" height="20" fill="#ffffff" />
      <rect width="30" height="6.67" fill="#ff9933" />
      <rect y="13.33" width="30" height="6.67" fill="#138808" />
      <g stroke="#000080" strokeWidth="0.35">
        <circle cx="15" cy="10" r="2.8" fill="none" strokeWidth="0.5" />
        {spokes}
      </g>
      <circle cx="15" cy="10" r="0.6" fill="#000080" />
    </svg>
  );
}

function LangPicker({ lang, setLang, tip }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = LANGS.find((l) => l.code === lang);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (e.type === "keydown" ? e.key === "Escape" : !ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    ref.current?.querySelector("[aria-selected=true]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  function onListKey(e) {
    const items = [...ref.current.querySelectorAll("[role=option]")];
    const idx = items.indexOf(document.activeElement);
    const go = (n) => items[Math.min(Math.max(idx + n, 0), items.length - 1)].focus();
    if (e.key === "ArrowRight") go(1);
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowDown") go(2);
    else if (e.key === "ArrowUp") go(-2);
    else return;
    e.preventDefault();
  }

  return (
    <div className="lang" ref={ref}>
      <button
        type="button"
        className="langbtn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Language: ${current.en}`}
        data-tip={open ? undefined : tip}
        data-tip-align="end"
        onClick={() => setOpen(!open)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
        <span>{current.label}</span>
        <svg className={open ? "chev up" : "chev"} viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul className="langlist" role="listbox" aria-label="Language" onKeyDown={onListKey}>
          {LANGS.map((l) => (
            <li
              key={l.code}
              role="option"
              tabIndex={-1}
              aria-selected={l.code === lang}
              className={l.code === lang ? "on" : ""}
              onClick={() => { setLang(l.code); setOpen(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLang(l.code); setOpen(false); } }}
            >
              <span className="native">{l.label}</span>
              <span className="en">{l.en}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WhenBar({ when, setWhen, lang, t }) {
  const now = today();
  const min = addDays(now, -365);
  const max = addDays(now, DAYS_AHEAD);
  const [from, setFrom] = useState(when.from || now);
  const [to, setTo] = useState(when.to || addDays(now, 2));
  const [open, setOpen] = useState(when.preset === 'custom');
  const [err, setErr] = useState('');
  const [why, setWhy] = useState(false);
  const tomorrowWord = t.tomorrow;
  const presets = [
    ['next24', t.next24, () => setWhen({ mode: 'next24' })],
    [
      'tomorrow',
      tomorrowWord.charAt(0).toLocaleUpperCase(lang) + tomorrowWord.slice(1),
      () => setWhen({ mode: 'range', preset: 'tomorrow', from: addDays(now, 1), to: addDays(now, 1) })
    ],
    ['days5', t.days5, () => setWhen({ mode: 'range', preset: 'days5', from: now, to: max })]
  ];
  const active = when.mode === 'next24' ? 'next24' : when.preset;

  function apply(e) {
    e.preventDefault();
    if (!from || !to || from < min || to > max || to < min || from > max) {
      return setErr(`${dayLabel(min, lang)} – ${dayLabel(max, lang)}`);
    }
    const [a, b] = from <= to ? [from, to] : [to, from];
    if (daysBetween(a, b) + 1 > MAX_RANGE_DAYS) return setErr(t.maxRange);
    setErr('');
    setFrom(a);
    setTo(b);
    setWhen({ mode: 'range', preset: 'custom', from: a, to: b });
  }

  return (
    <div className="when">
      <span>{t.when}</span>
      <div className="chips">
        {presets.map(([key, label, go]) => (
          <button
            key={key}
            type="button"
            className={active === key && !open ? 'chip on' : 'chip'}
            onClick={() => {
              setOpen(false);
              setErr('');
              go();
            }}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className={open ? 'chip on' : 'chip'}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" className="calicon">
            <rect x="3.5" y="5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          {t.pick}
        </button>
      </div>
      {open && (
        <form className="dates" onSubmit={apply}>
          <div className="dateshead">
            <span>{dayLabel(min, lang)} – {dayLabel(max, lang)}</span>
            <button
              type="button"
              className={why ? 'infobtn small on' : 'infobtn small'}
              aria-pressed={why}
              aria-label={t.dateInfoTitle}
              data-tip={t.dateInfoTitle}
              data-tip-align="end"
              onClick={() => setWhy(!why)}
            >
              i
            </button>
          </div>
          {why && (
            <div className="infobox dateinfo">
              <p className="infotitle">{t.dateInfoTitle}</p>
              <p>{t.dateInfo.replace('{max}', dayLabel(max, lang)).replace('{min}', dayLabel(min, lang))}</p>
            </div>
          )}
          <label>
            <span>{t.from}</span>
            <input type="date" value={from} min={min} max={max} onChange={(e) => setFrom(e.target.value)} onClick={openPicker} required />
          </label>
          <label>
            <span>{t.to}</span>
            <input type="date" value={to} min={min} max={max} onChange={(e) => setTo(e.target.value)} onClick={openPicker} required />
          </label>
          <button type="submit">{t.show}</button>
          {err && <p className="note warn">{err}</p>}
        </form>
      )}
    </div>
  );
}

function DayList({ days, lang, t, info }) {
  return (
    <div className="days">
      {days.map((d) => (
        <DayCard key={d.date} d={d} lang={lang} t={t} info={info} single={days.length === 1} />
      ))}
    </div>
  );
}

function DayCard({ d, lang, t, info, single }) {
  const [picked, setPicked] = useState(null);
  const bestH = d.best ? d.hours[d.best.startIndex].hour : null;
  return (
    <section className="card day">
      <div className="row">
        <p className="dayname">{dayLabel(d.date, lang)}</p>
        <span className="daylevel">
          <span className={`dot l${d.level}`} aria-hidden="true" />
          {t.levels[d.level]}
        </span>
      </div>
      <dl className="dayfacts">
        <div>
          <dt>{t.bestTime}</dt>
          <dd>{d.best ? `${range(bestH, bestH + 2, lang)} · ${t.levels[d.best.level]}` : '–'}</dd>
        </div>
        <div>
          <dt>{t.avoid}</dt>
          <dd>
            {d.avoid.length
              ? d.avoid.map((a) => range(d.hours[a.startIndex].hour, d.hours[a.endIndex].hour + 1, lang)).join(', ')
              : '–'}
          </dd>
        </div>
        {info && (
          <div>
            <dt>{t.dayAvg}</dt>
            <dd>AQI {aqiOf(d.avg)} · PM2.5 {d.avg} µg/m³</dd>
          </div>
        )}
      </dl>
      {d.partialUntil != null && <p className="pastnote">{t.partial.replace('{time}', hourLabel(d.partialUntil, lang))}</p>}
      <details className="daychart" open={single}>
        <summary>{t.hourly}</summary>
        <Chart result={d} lang={lang} t={t} picked={picked} setPicked={setPicked} info={info} />
      </details>
    </section>
  );
}

// Landing screen: where to start. Steps whose element is not on screen are skipped.
const TOUR_START = [
  ['.search', 'tourSearch'],
  ['.locate', 'tourLocate'],
  ['.when', 'tourWhen'],
  ['.langbtn', 'tourLang'],
  ['.popular', 'tourPopular']
];
// After the first forecast: how to read and use it.
const TOUR_RESULT = [
  ['.hero .big', 'tourBest'],
  ['.who', 'tourGroups'],
  ['.hero .actions', 'tourActions'],
  ['.hero .infobtn', 'tourInfo']
];

function Tour({ t, steps: TOUR, ask, thanks, onEnd }) {
  // ['ask'] -> 0..n-1 (spotlight steps) -> ['thanks']
  const [step, setStep] = useState(ask ? 'ask' : 0);
  const [box, setBox] = useState(null);
  const cardRef = useRef(null);
  const isStep = typeof step === 'number';
  const done = () => (thanks ? setStep('thanks') : onEnd(true));
  const next = () => (step === 'ask' ? setStep(0) : step < TOUR.length - 1 ? setStep(step + 1) : done());

  useLayoutEffect(() => {
    if (!isStep) return setBox(null);
    const el = document.querySelector(TOUR[step][0]);
    if (!el) return next();
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ top: r.top - 6, left: r.left - 6, width: r.width + 12, height: r.height + 12 });
    };
    measure();
    const id = setInterval(measure, 100); // follow the smooth scroll, then stay put
    const stop = setTimeout(() => clearInterval(id), 700);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, { passive: true });
    return () => {
      clearInterval(id);
      clearTimeout(stop);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure);
    };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    cardRef.current?.querySelector('.tournext')?.focus();
    const onKey = (e) => e.key === 'Escape' && onEnd(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step, onEnd]);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(isStep ? 300 : 340, vw - 32);
  let style;
  if (isStep) {
    if (!box) return null;
    const below = box.top + box.height + 12;
    const top = below + 150 < vh ? below : Math.max(16, box.top - 12 - 150);
    const left = Math.min(Math.max(16, box.left + box.width / 2 - cardW / 2), vw - cardW - 16);
    style = { top, left, width: cardW };
  } else {
    style = { top: '50%', left: '50%', width: cardW, transform: 'translate(-50%, -50%)' };
  }
  const text = step === 'ask' ? t.tourAsk : step === 'thanks' ? t.tourThanks : t[TOUR[step][1]];

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={text}>
      <div className={isStep ? 'tourshade' : 'tourshade dim'} onClick={() => onEnd(false)} />
      {isStep && <div className="tourspot" style={box} />}
      <div className={isStep ? 'tourcard' : 'tourcard center'} ref={cardRef} style={style}>
        {!isStep && (
          <div className="tourbig" aria-hidden="true">
            <Icon name={step === 'ask' ? 'compass' : 'check'} size={28} />
          </div>
        )}
        <p>{text}</p>
        <div className="tourfoot">
          {isStep && (
            <span className="tourdots" aria-hidden="true">
              {TOUR.map((_, i) => (
                <i key={i} className={i === step ? 'on' : ''} />
              ))}
            </span>
          )}
          {step !== 'thanks' && (
            <button type="button" className="tourskip" onClick={() => onEnd(false)}>
              {t.skip}
            </button>
          )}
          <button type="button" className="tournext" onClick={step === 'thanks' ? () => onEnd(true) : next}>
            {step === 'ask'
              ? t.startTour
              : step === 'thanks'
                ? t.finish
                : step === TOUR.length - 1 && !thanks
                  ? t.done
                  : t.next}
          </button>
        </div>
      </div>
    </div>
  );
}

// Browsers only open the calendar from its small icon; open it from anywhere in the field.
function openPicker(e) {
  try {
    e.currentTarget.showPicker?.();
  } catch {
    /* older browsers: the field still works by typing */
  }
}

const ICONS = {
  locate: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" fill="currentColor" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
  speaker: <><path d="M11 5 6.5 9H3v6h3.5L11 19V5Z" /><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6a8 8 0 0 1 0 12" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />,
  up: <path d="M7 10v10H4V10h3Zm0 0 4-7.5a2.3 2.3 0 0 1 2.4 2.3V9h5a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.1 20H7" />,
  down: <path d="M17 14V4h3v10h-3Zm0 0-4 7.5a2.3 2.3 0 0 1-2.4-2.3V15h-5a2 2 0 0 1-2-2.3l1.3-7A2 2 0 0 1 6.9 4H17" />,
  plus: <path d="M12 5v14M5 12h14" />,
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3 19c.6-3.3 3-5 6-5s5.4 1.7 6 5" /><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.3c1.6.6 2.7 2.1 3 4.7" /></>,
  compass: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.7 2.7L16 9.8" /></>
};

function Icon({ name, size = 18 }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

// Public, honest usage numbers. Hidden until the server has real numbers to show.
const MIN_ANSWERS = 5;
function Counter({ counts, lang, t }) {
  if (!counts || !counts.visits) return null;
  const fmt = (n) => new Intl.NumberFormat(`${lang}-IN`).format(n);
  const answers = counts.yes + counts.no;
  return (
    <p className="counter" aria-live="polite">
      <Icon name="people" size={16} />
      <span>{t.countVisits.replace('{n}', fmt(counts.visits))}</span>
      {answers >= MIN_ANSWERS && (
        <>
          <span className="sep" aria-hidden="true">·</span>
          <span>
            {t.countHelped.replace('{p}', fmt(Math.round((counts.yes / answers) * 100))).replace('{m}', fmt(answers))}
          </span>
        </>
      )}
    </p>
  );
}
