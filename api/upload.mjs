// Together — date-photo upload (Vercel). Stores a memory photo in a PRIVATE Storage
// bucket scoped to the caller's couple. Returns the storage path; display URLs are
// signed on the fly by /api/db. Gated by verified initData.
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { verifyInitData } from '../lib/telegram.mjs';

const { BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE } = process.env;
export const maxDuration = 30;
const BUCKET = 'memories';

let _svc;
function svc() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new Error('Missing env: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE');
  if (!_svc) _svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
  return _svc;
}

async function resolveCouple(u) {
  const existing = await svc().from('app_users').select('couple_id').eq('telegram_id', u.id).maybeSingle();
  if (existing.data && existing.data.couple_id) return existing.data.couple_id;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Моя пара';
  const c = await svc().from('couples').insert({ name }).select('id').single();
  if (c.error) throw new Error('couple create: ' + c.error.message);
  await svc().from('app_users').upsert({ telegram_id: u.id, couple_id: c.data.id, name, photo_url: u.photo_url || null });
  return c.data.id;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Missing env: BOT_TOKEN' });
    const body = req.body || {};
    const user = verifyInitData(body.initData, BOT_TOKEN);
    if (!user || !user.id) return res.status(401).json({ error: 'unauthorized' });
    const couple_id = await resolveCouple(user);

    const raw = String(body.image || '');
    const m = raw.match(/^data:image\/\w+;base64,(.+)$/);
    const buf = Buffer.from(m ? m[1] : raw, 'base64');
    if (!buf.length || buf.length > 6 * 1024 * 1024) return res.status(400).json({ error: 'bad image' });

    await svc().storage.createBucket(BUCKET, { public: false }).catch(() => {}); // idempotent
    const path = `${couple_id}/${crypto.randomUUID()}.jpg`;
    const { error } = await svc().storage.from(BUCKET).upload(path, buf, { contentType: 'image/jpeg', upsert: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ data: { path } });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
