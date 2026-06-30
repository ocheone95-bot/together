-- Together — фото со свиданий для экрана «Было». Безопасно для боевой БД.
-- Хранится ПУТЬ в приватном Storage-бакете 'memories' (URL подписывается на лету при загрузке).
alter table ideas add column if not exists done_photo text;
