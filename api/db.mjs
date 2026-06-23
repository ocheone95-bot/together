// Together — couple-scoped data proxy (Vercel). Identity = verified Telegram initData;
// every operation is restricted to the caller's own couple. Purchase notifications fire inline.
// Also handles couple-management ops (me / invite / leave / rename) via body.op.
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { verifyInitData } from '../lib/telegram.mjs';

const { BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE } = process.env;
const ADMIN_ID = process.env.ME_USER_ID || '681332519'; // only the owner sees app-wide stats
const TABLES = { ideas: true, shopping: true };

let _svc;
function svc() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new Error('Missing env: SUPABASE_URL and/or SUPABASE_SERVICE_ROLE');
  if (!_svc) _svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
  return _svc;
}

const tg = (method, payload) =>
  fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    .then((r) => r.json()).catch(() => null);

async function resolveCouple(u) {
  const existing = await svc().from('app_users').select('couple_id').eq('telegram_id', u.id).maybeSingle();
  if (existing.data && existing.data.couple_id) return existing.data.couple_id;
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Моя пара';
  const c = await svc().from('couples').insert({ name }).select('id').single();
  if (c.error) throw new Error('couple create: ' + c.error.message);
  await svc().from('app_users').upsert({ telegram_id: u.id, couple_id: c.data.id, name, photo_url: u.photo_url || null });
  return c.data.id;
}

async function notifyPartner(couple_id, actor) {
  const { data } = await svc().from('shopping').select('id,text').eq('couple_id', couple_id).eq('done', true).eq('notified', false);
  if (!data || !data.length) return;
  const ids = data.map((r) => r.id);
  const members = await svc().from('app_users').select('telegram_id').eq('couple_id', couple_id).neq('telegram_id', actor.id);
  const who = actor.first_name || 'Партнёр';
  const msg = data.length === 1
    ? `💛 ${who} купил: «${data[0].text}»`
    : `💛 ${who} выполнил из списка:\n` + data.map((r) => `• ${r.text}`).join('\n');
  for (const m of (members.data || [])) await tg('sendMessage', { chat_id: m.telegram_id, text: msg });
  await svc().from('shopping').update({ notified: true }).in('id', ids);
}

// Couple management: who am I with / invite a partner / leave to a fresh couple / rename.
async function handleOp(op, body, user, couple_id, res) {
  if (op === 'me') {
    // Resilient to dates.sql not being run yet: fall back to the basic columns on error.
    let c = await svc().from('couples').select('name,relationship_start,wedding_date,taste,taste_set').eq('id', couple_id).maybeSingle();
    if (c.error) c = await svc().from('couples').select('name,relationship_start,wedding_date').eq('id', couple_id).maybeSingle();
    if (c.error) c = await svc().from('couples').select('name').eq('id', couple_id).maybeSingle();
    let members = await svc().from('app_users').select('telegram_id,name,birthday').eq('couple_id', couple_id);
    if (members.error) members = await svc().from('app_users').select('telegram_id,name').eq('couple_id', couple_id);
    return res.status(200).json({ data: {
      couple_id, name: c.data?.name || '',
      relationship_start: c.data?.relationship_start || null, wedding_date: c.data?.wedding_date || null,
      taste: c.data?.taste || {}, taste_set: c.data?.taste_set || false,
      members: members.data || [], me: user.id, is_admin: String(user.id) === ADMIN_ID } });
  }
  if (op === 'stats') {
    if (String(user.id) !== ADMIN_ID) return res.status(403).json({ error: 'forbidden' });
    const u = await svc().from('app_users').select('*', { count: 'exact', head: true });
    const cc = await svc().from('couples').select('*', { count: 'exact', head: true });
    return res.status(200).json({ data: { users: u.count || 0, couples: cc.count || 0 } });
  }
  if (op === 'setdates') {
    const patch = {};
    if ('relationship_start' in body) patch.relationship_start = body.relationship_start || null;
    if ('wedding_date' in body) patch.wedding_date = body.wedding_date || null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no dates' });
    const { error } = await svc().from('couples').update(patch).eq('id', couple_id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ data: patch });
  }
  if (op === 'setbirthday') {
    let target = user.id;
    if (body.telegram_id) {
      const m = await svc().from('app_users').select('telegram_id').eq('couple_id', couple_id).eq('telegram_id', body.telegram_id).maybeSingle();
      if (m.data) target = body.telegram_id;
    }
    const { error } = await svc().from('app_users').update({ birthday: body.birthday || null }).eq('telegram_id', target);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ data: { telegram_id: target, birthday: body.birthday || null } });
  }
  if (op === 'invite') {
    const token = crypto.randomBytes(8).toString('hex');
    const ins = await svc().from('invites').insert({ token, couple_id, created_by: user.id }).select('token').single();
    if (ins.error) return res.status(500).json({ error: ins.error.message });
    return res.status(200).json({ data: { token, link: `https://t.me/togethera_bot?start=inv_${token}` } });
  }
  if (op === 'leave') {
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Моя пара';
    const nc = await svc().from('couples').insert({ name }).select('id').single();
    if (nc.error) return res.status(500).json({ error: nc.error.message });
    await svc().from('app_users').update({ couple_id: nc.data.id }).eq('telegram_id', user.id);
    return res.status(200).json({ data: { couple_id: nc.data.id } });
  }
  if (op === 'rename') {
    const name = String(body.name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'empty name' });
    await svc().from('couples').update({ name }).eq('id', couple_id);
    return res.status(200).json({ data: { name } });
  }
  if (op === 'settaste') {
    const patch = {};
    if ('taste' in body) patch.taste = body.taste && typeof body.taste === 'object' ? body.taste : {};
    if ('taste_set' in body) patch.taste_set = !!body.taste_set;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'no taste' });
    const { error } = await svc().from('couples').update(patch).eq('id', couple_id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ data: patch });
  }
  return res.status(400).json({ error: 'bad op' });
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
    if (!BOT_TOKEN) return res.status(500).json({ error: 'Missing env: BOT_TOKEN' });

    const body = req.body || {};
    const user = verifyInitData(body.initData, BOT_TOKEN);
    if (!user || !user.id) return res.status(401).json({ error: 'unauthorized' });

    const couple_id = await resolveCouple(user);

    if (body.op) return await handleOp(body.op, body, user, couple_id, res);

    const { table, action, values, match, select, single, order } = body;
    if (!TABLES[table]) return res.status(400).json({ error: 'bad table' });

    let q;
    if (action === 'select') {
      q = svc().from(table).select(select || '*').eq('couple_id', couple_id);
      if (order) q = q.order(order.col, { ascending: order.asc !== false });
    } else if (action === 'insert') {
      const rows = (Array.isArray(values) ? values : [values]).map((v) => ({ ...v, couple_id }));
      q = svc().from(table).insert(rows);
      if (select) q = q.select(select);
    } else if (action === 'update' || action === 'delete') {
      q = svc().from(table)[action](action === 'update' ? values : undefined).eq('couple_id', couple_id);
      for (const [k, v] of Object.entries(match || {})) q = Array.isArray(v) ? q.in(k, v) : q.eq(k, v);
    } else {
      return res.status(400).json({ error: 'bad action' });
    }
    if (single) q = q.single();

    const { data, error } = await q;
    if (!error && table === 'shopping' && action === 'update') {
      try { await notifyPartner(couple_id, user); } catch (e) { /* best-effort */ }
    }
    return res.status(200).json({ data: data ?? null, error: error ? error.message : null });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
