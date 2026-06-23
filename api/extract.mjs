// Together — link metadata extractor for the in-app create flow (Vercel).
// Same engine the bot uses (bot/extract.mjs), exposed to the Mini App so pasting a
// link auto-fills poster/title/date/place. Gated by verified initData — never an open proxy.
import { extractEvent } from '../bot/extract.mjs';
import { verifyInitData } from '../lib/telegram.mjs';

const { BOT_TOKEN } = process.env;

export const maxDuration = 30; // Jina Reader fallback (blocked/JS sites) can take ~20s

// Best-effort: map a link (and its title) to one of the app's idea categories.
// null = couldn't tell → let the user pick (frontend keeps its default).
const DOMAIN_CAT = [
  [/kinopoisk|kino|ivi\.|okko|kion|wink|netflix|premier\.|film|movie/i, 'film'],
  [/afisha|timepad|ticketscloud|kassir|ponominalu|bezantrakta|qtickets|radario|intickets|concert|teatr|theatre|philharm/i, 'concert'],
  [/2gis|restoclub|tripadvisor|eda\.|delivery-club|cafe|restaur|rest\.|kitchen/i, 'food'],
  [/booking|airbnb|ostrovok|tutu\.|aviasales|trip|hotel|otel|tury|travel|sutochno/i, 'trip'],
];
const KW_CAT = [
  [/фильм|кино|сеанс|премьер/i, 'film'],
  [/концерт|спектакл|театр|шоу|выступлен|стендап|stand-?up|фестивал/i, 'concert'],
  [/ресторан|кафе|ужин|завтрак|бранч|поесть|кухн|дегустац/i, 'food'],
  [/\bбар\b|паб|коктейл|вино|пивн/i, 'bar'],
  [/поездк|тур\b|отел|путешеств|за город|загород/i, 'trip'],
  [/прогул|парк|набережн|сквер|поход/i, 'walk'],
];
function guessCategory(url, title) {
  const u = String(url || '');
  for (const [re, c] of DOMAIN_CAT) if (re.test(u)) return c;
  const t = String(title || '');
  for (const [re, c] of KW_CAT) if (re.test(t) || re.test(u)) return c;
  return null;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Missing env: BOT_TOKEN' });

    const body = req.body || {};
    const user = verifyInitData(body.initData, BOT_TOKEN);
    if (!user || !user.id) return res.status(401).json({ error: 'unauthorized' });

    const url = String(body.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'bad url' });

    const ev = await extractEvent(url);
    const category = guessCategory(ev.url || url, ev.title);
    return res.status(200).json({ data: {
      url: ev.url || url, title: ev.title || '', image: ev.image || '',
      date: ev.date || '', time: ev.time || '', location: ev.location || '', category,
    } });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
