-- Together — Афиша Фаза B: вкусовой профиль пары. Безопасно для боевой БД.
-- taste = { categories: {<kudago-slug>: weight}, cineGenres: {<жанр>: 1} }
alter table couples add column if not exists taste     jsonb   default '{}'::jsonb;
alter table couples add column if not exists taste_set boolean default false;
