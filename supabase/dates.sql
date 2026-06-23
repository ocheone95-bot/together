-- Together — important dates (run once in Supabase → SQL Editor).
-- Couple-level: when you got together / wedding. Person-level: birthday.
alter table couples   add column if not exists relationship_start date;
alter table couples   add column if not exists wedding_date       date;
alter table app_users add column if not exists birthday           date;
