// Together — Afisha proxy (Vercel). Fetches events from KudaGo's public API and
// normalizes them into the app's idea shape. Gated by verified initData.
import { verifyInitData } from '../lib/telegram.mjs';

const { BOT_TOKEN } = process.env;
export const maxDuration = 30;

const KUDAGO = 'https://kudago.com/public-api/v1.4';
const MSK_OFFSET = 3 * 3600; // KudaGo timestamps → Moscow wall-clock

// KudaGo category slug → app category (drives card gradient/label/icon).
const CAT_MAP = {
  concert: 'concert', festival: 'concert', party: 'bar', cinema: 'film',
  theater: 'concert', exhibition: 'walk', quest: 'trip', tour: 'trip',
  recreation: 'walk', kids: 'walk', fashion: 'walk', photo: 'walk',
  'wellness-and-health': 'walk', education: 'walk',
};
const appCat = (cats) => { for (const c of cats || []) if (CAT_MAP[c]) return CAT_MAP[c]; return 'concert'; };

function normalize(e) {
  const now = Math.floor(Date.now() / 1000);
  const dates = (e.dates || []).filter((d) => d && (d.start > 0 || d.end > 0));
  // Relevant occurrence: upcoming, or currently ongoing (end still in the future). Long-running
  // exhibitions carry stale past starts — keying on end avoids showing a 2017 date.
  const occ = dates.filter((d) => (d.end || d.start) >= now).sort((a, b) => (a.start || 0) - (b.start || 0))[0];
  let event_date = '', event_time = '', ongoing = false;
  if (occ) {
    if (occ.start >= now) {
      const d = new Date((occ.start + MSK_OFFSET) * 1000);
      event_date = d.toISOString().slice(0, 10);
      const hm = d.toISOString().slice(11, 16);
      event_time = hm === '00:00' ? '' : hm;
    } else if (occ.end > 0) {
      ongoing = true; // happening now; show "до <end>"
      event_date = new Date((occ.end + MSK_OFFSET) * 1000).toISOString().slice(0, 10);
    }
  }
  const title = e.title ? e.title.charAt(0).toUpperCase() + e.title.slice(1) : '';
  const place = e.place ? [e.place.title, e.place.address].filter(Boolean).join(', ') : '';
  return {
    ext_id: 'kudago:' + e.id,
    title,
    url: e.site_url || '',
    og_image: (e.images && e.images[0] && e.images[0].image) || '',
    category: appCat(e.categories),
    location: place,
    lat: e.place && e.place.coords ? e.place.coords.lat : null,
    lon: e.place && e.place.coords ? e.place.coords.lon : null,
    event_date, event_time, ongoing,
    price: e.price || '',
    cats: e.categories || [],
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Missing env: BOT_TOKEN' });
    const body = req.body || {};
    const user = verifyInitData(body.initData, BOT_TOKEN);
    if (!user || !user.id) return res.status(401).json({ error: 'unauthorized' });

    const city = (body.city || 'msk').replace(/[^a-z-]/g, '').slice(0, 20) || 'msk';
    const pageSize = Math.min(Math.max(+body.page_size || 40, 1), 100);
    const now = Math.floor(Date.now() / 1000);
    const fields = 'id,title,dates,place,categories,price,images,site_url';
    let url = `${KUDAGO}/events/?location=${city}&actual_since=${now}&page_size=${pageSize}`
      + `&fields=${fields}&expand=place&text_format=text&order_by=-favorites_count`;
    if (body.category) url += `&categories=${encodeURIComponent(String(body.category).replace(/[^a-z,-]/g, ''))}`;

    const r = await fetch(url, { headers: { 'accept-language': 'ru' } });
    if (!r.ok) return res.status(502).json({ error: 'kudago ' + r.status });
    const j = await r.json();
    const events = (j.results || []).map(normalize).filter((e) => e.title && e.event_date);
    return res.status(200).json({ data: { events, count: j.count || events.length } });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
