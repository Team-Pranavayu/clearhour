// Our own public counter (see api/count.js). No third-party scripts.
// Only three things are counted: a visit (once per device per day), and "helpful" yes / no answers.

const today = () => new Date().toISOString().slice(0, 10);

function remember(key) {
  try {
    if (localStorage.getItem(key) === today()) return false;
    localStorage.setItem(key, today());
  } catch {
    /* storage blocked: still count, the server also limits to once per day */
  }
  return true;
}

// Only accept a real JSON answer from our function (a static host may answer with the HTML page).
async function readCounts(res) {
  if (!res.ok || !(res.headers.get('content-type') || '').includes('application/json')) return null;
  const c = await res.json();
  return Number.isFinite(c.visits) ? c : null;
}

export async function sendCount(event) {
  try {
    const res = await fetch('/api/count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event })
    });
    return await readCounts(res);
  } catch {
    return null;
  }
}

export async function getCounts() {
  try {
    return await readCounts(await fetch('/api/count'));
  } catch {
    return null;
  }
}

/** Called from the app on actions; only the ones we count are sent. */
export function track(name) {
  if (name.startsWith('city/') && remember('ch:counted-visit')) return sendCount('visit');
  if (name.startsWith('feedback/yes')) return sendCount('yes');
  if (name.startsWith('feedback/no')) return sendCount('no');
  return null;
}
