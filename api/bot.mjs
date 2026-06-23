// Together — Telegram bot webhook on Vercel. Multi-tenant: links → ideas, text → shopping,
// each scoped to the SENDER's own couple (auto-provisioned). Open to everyone; invite links pair people up.
import { Bot, InlineKeyboard } from 'grammy';
import { createClient } from '@supabase/supabase-js';
import { extractEvent, MONTH_NAMES } from '../bot/extract.mjs';

const { BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE, SUPABASE_ANON_KEY, COUPLE_ID, ALLOWED_USER_IDS, TG_WEBHOOK_SECRET } = process.env;

const allowed = (ALLOWED_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ME_ID = process.env.ME_USER_ID || '681332519';
const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE || SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const bot = new Bot(BOT_TOKEN);

const INT = { want: { label: 'очень хочу 🔥' }, interesting: { label: 'интересно 🔖' }, someday: { label: 'когда-нибудь 🌙' } };

const WELCOME_PHOTO = 'https://frabjous-marzipan-6107d0.netlify.app/icons/welcome.png';
const WELCOME_CAPTION =
  '<b>Together</b> 💛 — ваш личный планировщик свиданий.\n\n' +
  'Кидай сюда:\n' +
  '🔗 <b>ссылку</b> на идею — афишу, фильм, заведение. Добавлю в список и спрошу, насколько хочется.\n' +
  '🛒 <b>покупки</b> текстом («молоко, хлеб») — разложу по темам.\n\n' +
  'Всё попадёт в приложение — там вы выберете, чем заняться. ✨';

// Multi-tenant: resolve the sender's couple (auto-provision on first contact). The bot is open to
// everyone — every write is scoped to the sender's own couple, so there's no cross-couple leakage.
async function resolveCouple(from) {
  const ex = await supa.from('app_users').select('couple_id').eq('telegram_id', from.id).maybeSingle();
  if (ex.data && ex.data.couple_id) return ex.data.couple_id;
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Моя пара';
  const c = await supa.from('couples').insert({ name }).select('id').single();
  if (!c.error) await supa.from('app_users').upsert({ telegram_id: from.id, couple_id: c.data.id, name });
  return c.data?.id;
}

bot.command('start', async (ctx) => {
  const payload = (ctx.match || '').trim();
  if (payload.startsWith('inv_')) {
    const token = payload.slice(4);
    const inv = await supa.from('invites').select('couple_id,used_by,expires_at').eq('token', token).maybeSingle();
    if (!inv.data) { await ctx.reply('Приглашение не найдено 😕'); return; }
    if (inv.data.used_by) { await ctx.reply('Это приглашение уже использовано.'); return; }
    if (inv.data.expires_at && new Date(inv.data.expires_at) < new Date()) { await ctx.reply('Приглашение устарело.'); return; }
    const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || '';
    await supa.from('app_users').upsert({ telegram_id: ctx.from.id, couple_id: inv.data.couple_id, name });
    await supa.from('invites').update({ used_by: ctx.from.id, used_at: new Date().toISOString() }).eq('token', token);
    await ctx.reply('💛 Готово! Теперь вы в общей паре. Открой приложение — увидите общий список идей и покупок.');
    return;
  }
  try { await ctx.replyWithPhoto(WELCOME_PHOTO, { caption: WELCOME_CAPTION, parse_mode: 'HTML' }); }
  catch (e) { await ctx.reply(WELCOME_CAPTION.replace(/<\/?b>/g, '')); }
});

bot.on('message:text', async (ctx) => {
  const url = (ctx.message.text.match(/https?:\/\/\S+/) || [])[0];
  const author = String(ctx.from?.id) === ME_ID ? 'me' : 'she';
  const cid = await resolveCouple(ctx.from); // sender's own couple

  if (!url) {
    const items = ctx.message.text.split(/[\n,]+/).map((t) => t.trim()).filter(Boolean).slice(0, 20);
    if (!items.length) return;
    const { data, error } = await supa.from('shopping')
      .insert(items.map((t) => ({ couple_id: cid, text: t, theme: 'other', author }))).select('id');
    if (error) { console.error('shop insert failed:', error); await ctx.reply('Не смог сохранить покупки 😕'); return; }
    const ids = (data || []).map((r) => r.id).join('-');
    const kb = new InlineKeyboard().text('🍎 Еда', `sht:food:${ids}`).text('📦 Маркетплейсы', `sht:market:${ids}`).row().text('🧺 Другое', `sht:other:${ids}`);
    await ctx.reply(`В покупки добавлено: ${items.join(', ')}.\nКакая тема?`, { reply_markup: kb });
    return;
  }
  await ctx.replyWithChatAction('typing');

  const ev = await extractEvent(url);
  const { data, error } = await supa.from('ideas').insert({
    couple_id: cid, title: ev.title, url: ev.url, og_image: ev.image,
    location: ev.location, event_date: ev.date, event_time: ev.time,
    author, status: 'idea', intensity: 'interesting',
  }).select('id').single();
  if (error) { console.error('insert failed:', error); await ctx.reply('Ой, не смог сохранить 😕 попробуй ещё раз.'); return; }

  let info = '';
  if (ev.date) { const d = new Date(ev.date + 'T00:00:00'); info += `\n🗓 ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}${ev.time ? ', ' + ev.time : ''}`; }
  if (ev.location) info += `\n📍 ${ev.location}`;

  const kb = new InlineKeyboard().text('🔥 Очень хочу', `int:${data.id}:want`).text('🔖 Интересно', `int:${data.id}:interesting`).row().text('🌙 Когда-нибудь', `int:${data.id}:someday`);
  await ctx.reply(`Добавила: «${ev.title}».${info}\nНасколько хочется?`, { reply_markup: kb });
});

bot.callbackQuery(/^int:(\d+):(want|interesting|someday)$/, async (ctx) => {
  const [, id, intensity] = ctx.match;
  const cid = await resolveCouple(ctx.from);
  const { error } = await supa.from('ideas').update({ intensity }).eq('id', id).eq('couple_id', cid);
  if (error) { await ctx.answerCallbackQuery({ text: 'Не вышло 😕' }); return; }
  await ctx.editMessageText(`Готово — отметила «${INT[intensity].label}». Уже в вашем списке. 💛`);
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^sht:(food|market|other):(.*)$/, async (ctx) => {
  const [, theme, idsStr] = ctx.match;
  const ids = idsStr.split('-').filter(Boolean);
  const cid = await resolveCouple(ctx.from);
  if (ids.length) await supa.from('shopping').update({ theme }).in('id', ids).eq('couple_id', cid);
  const label = { food: 'Еда 🍎', market: 'Маркетплейсы 📦', other: 'Другое 🧺' }[theme];
  await ctx.editMessageText(`Готово — тема «${label}». В вашем списке покупок. 🛒`);
  await ctx.answerCallbackQuery();
});

bot.catch((err) => console.error('bot error:', err));

let initPromise;
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if ((req.headers['x-telegram-bot-api-secret-token'] || '') !== (TG_WEBHOOK_SECRET || '')) return res.status(401).end();
  try {
    if (!initPromise) initPromise = bot.init();
    await initPromise;
    await bot.handleUpdate(req.body);
  } catch (e) { console.error('bot handler error:', e); }
  return res.status(200).end();
}
