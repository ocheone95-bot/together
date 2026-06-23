// Event extractor: pulls title / image / where / when / time from a link.
// Strategy: follow redirects → clean URL → JSON-LD schema.org Event → fall back to
// OG tags + regex on title/description for date/time/place. No headless browser.

const MONTH_RU = { янв:1, фев:2, мар:3, апр:4, мая:5, май:5, июн:6, июл:7, авг:8, сен:9, окт:10, ноя:11, дек:12 };
export const MONTH_NAMES = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];

export function cleanUrl(u) {
  try {
    const x = new URL(u);
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_referrer','from','clid','yclid','_openstat','etext','reqid'].forEach(p => x.searchParams.delete(p));
    return x.toString().replace(/\?$/, '');
  } catch (e) { return u; }
}

function parseWhen(text) {
  let date = null, time = null;
  const tm = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (tm) time = tm[1].padStart(2, '0') + ':' + tm[2];
  const dm = text.match(/\b(\d{1,2})\s+(янв|фев|мар|апр|мая|май|июн|июл|авг|сен|окт|ноя|дек)[а-яё]*/i);
  if (dm) {
    const day = +dm[1];
    const mon = MONTH_RU[dm[2].toLowerCase().slice(0, 3)];
    const yr = (text.match(/\b(20\d\d)\b/) || [])[1] || new Date().getFullYear();
    if (mon) date = `${yr}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (!date) {
    const nd = text.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b/);
    if (nd) { const yr = nd[3] ? (nd[3].length === 2 ? '20' + nd[3] : nd[3]) : new Date().getFullYear(); date = `${yr}-${nd[2].padStart(2, '0')}-${nd[1].padStart(2, '0')}`; }
  }
  return { date, time };
}

// The event date is often baked into the URL (slug `…-2026-08-29` or a `filterDates=`/`date=` query).
// This is the most reliable source: pages like Yandex Afisha report startDate shifted by a day
// (UTC vs Moscow), but the URL the user opened always carries the correct calendar date.
function dateFromUrl(u) {
  if (!u) return null;
  const q = u.match(/[?&](?:filterDates|date|startDate)=(\d{4}-\d{2}-\d{2})/i);
  if (q) return q[1];
  const slug = u.match(/[-/_](\d{4}-\d{2}-\d{2})(?=[-/?#]|$)/);
  if (slug) return slug[1];
  return null;
}

function metaTag(html, p) {
  return (html.match(new RegExp('<meta[^>]+(?:property|name)=["\\x27]' + p + '["\\x27][^>]+content=["\\x27]([^"\\x27]+)', 'i'))
    || html.match(new RegExp('<meta[^>]+content=["\\x27]([^"\\x27]+)["\\x27][^>]+(?:property|name)=["\\x27]' + p, 'i')) || [])[1];
}

function finalizeTitle(out, url) {
  out.title = String(out.title || url).split(/\s*[|/]\s*/)[0].replace(/\s*[—–-]\s*$/, '').trim().slice(0, 90) || url;
  return out;
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15';

async function fetchText(url, { headers, timeout = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: headers || { 'user-agent': UA, 'accept-language': 'ru,en' }, redirect: 'follow', signal: ctrl.signal });
    return { html: await res.text(), finalUrl: res.url || url };
  } finally { clearTimeout(t); }
}

// Pull og/JSON-LD metadata out of an HTML document into `out` (fills only empty fields,
// so it can be called twice — direct page first, Jina-rendered HTML as fallback).
function parseInto(out, html, pageUrl) {
  if (!out.image) out.image = metaTag(html, 'og:image') || out.image;
  const ogTitle = metaTag(html, 'og:title'), ogDesc = metaTag(html, 'og:description');

  // JSON-LD schema.org Events — aggregators (kassir) list many; pick THE page's event:
  // prefer one whose url matches this page; if exactly one, trust it; if several and none
  // matches, they're "recommended events" — ignore JSON-LD and let OG tags speak.
  const events = [];
  for (const m of [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]) {
    try {
      let d = JSON.parse(m[1].trim());
      let arr = Array.isArray(d) ? d : (d['@graph'] || [d]);
      if (!Array.isArray(arr)) arr = [arr];
      for (const o of arr) if (o && /Event/i.test(String(o['@type'] || ''))) events.push(o);
    } catch (e) { /* malformed ld+json — skip */ }
  }
  const samePath = (a, b) => { try { return new URL(a).pathname.replace(/\/$/, '') === new URL(b).pathname.replace(/\/$/, ''); } catch { return false; } };
  let evt = events.find(o => o.url && samePath(o.url, pageUrl));
  if (!evt && events.length === 1) evt = events[0];
  if (evt) {
    out.title = out.title || evt.name;
    if (evt.startDate) { const s = String(evt.startDate); out.date = out.date || (s.match(/\d{4}-\d{2}-\d{2}/) || [])[0]; out.time = out.time || (s.match(/T(\d{2}:\d{2})/) || [])[1]; }
    const loc = evt.location;
    if (loc && !out.location) out.location = (typeof loc === 'string' ? loc : (loc.name || loc.address?.streetAddress || loc.address?.addressLocality)) || out.location;
    if (!out.image) out.image = typeof evt.image === 'string' ? evt.image : (evt.image?.url || (Array.isArray(evt.image) ? evt.image[0] : null));
  }

  const full = [ogTitle, ogDesc].filter(Boolean).join(' . ');
  if (!out.date || !out.time) { const w = parseWhen(full); out.date = out.date || w.date; out.time = out.time || w.time; }
  if (!out.location) {
    const pm = (ogDesc || ogTitle || '').match(/\bв\s+(парк[еа]?|клуб[еа]?|театр[еа]?|центр[еа]?|музе[ея]|галере[ея]|бар[еу]?|кафе|ресторане?|зал[еа]?)\s+([«"][^»"]{2,40}[»"]|[А-ЯЁ][^,.!?]{2,40})/i);
    if (pm) out.location = (pm[1] + ' ' + pm[2]).replace(/\s+/g, ' ').trim().slice(0, 60);
  }
  out.title = out.title || ogTitle;
}

export async function extractEvent(url) {
  const out = { url: cleanUrl(url), title: null, image: null, location: null, date: null, time: null };
  let finalUrl = url;
  // Primary: fetch the page directly (fast; works for any site with server-rendered metadata).
  try {
    const r = await fetchText(url);
    finalUrl = r.finalUrl; out.url = cleanUrl(finalUrl);
    parseInto(out, r.html, finalUrl);
  } catch (e) { console.warn('direct fetch failed:', e?.message || e); }
  // Fallback: got nothing — the site either blocks datacenter IPs (kassir → fg.kassir.ru)
  // or renders only via JS. Jina Reader fetches+renders from its own IP and returns HTML,
  // which the same parser handles. Keeps the original URL as the page identity.
  if (!out.title && !out.image) {
    try {
      const r = await fetchText('https://r.jina.ai/' + url, { headers: { 'X-Return-Format': 'html', 'accept-language': 'ru,en' }, timeout: 22000 });
      finalUrl = url; out.url = cleanUrl(url);
      parseInto(out, r.html, url);
    } catch (e) { console.warn('jina fallback failed:', e?.message || e); }
  }
  // URL-embedded date is the most reliable — always let it win (e.g. Yandex Afisha off-by-one).
  const urlDate = dateFromUrl(finalUrl) || dateFromUrl(url);
  if (urlDate) out.date = urlDate;
  return finalizeTitle(out, url);
}
