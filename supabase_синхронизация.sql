-- «Система»: один ник на нескольких устройствах (привязка по коду) + облачное сохранение прогресса.
-- Выполнять ПОСЛЕ supabase_рейтинг.sql. Вставить целиком в Supabase → SQL Editor → Run.

-- Устройства игрока: у каждого свой секретный код, в базе только хеши
create table if not exists public.sys_devices (
  nick_key    text not null references public.sys_players(nick_key) on delete cascade,
  secret_hash text not null,
  created_at  timestamptz not null default now(),
  primary key (nick_key, secret_hash)
);
alter table public.sys_devices enable row level security;
revoke all on public.sys_devices from anon, authenticated;

-- Уже вошедшие игроки: их первое устройство переносим в новую таблицу
insert into public.sys_devices (nick_key, secret_hash)
  select nick_key, secret_hash from public.sys_players
  on conflict do nothing;

-- Коды привязки: один активный код на ник, живёт 10 минут, 5 попыток ввода
create table if not exists public.sys_links (
  nick_key   text primary key references public.sys_players(nick_key) on delete cascade,
  code_hash  text not null,
  expires_at timestamptz not null,
  tries      int not null default 0
);
alter table public.sys_links enable row level security;
revoke all on public.sys_links from anon, authenticated;

-- Облачное сохранение: весь прогресс (без секретов) и время сохранения в миллисекундах
alter table public.sys_players add column if not exists save jsonb;
alter table public.sys_players add column if not exists save_at bigint not null default 0;

-- Хеш секрета
create or replace function public.sys_hash(p text)
returns text language sql immutable set search_path = public, extensions as $$
  select encode(digest(coalesce(p, ''), 'sha256'), 'hex')
$$;
revoke all on function public.sys_hash(text) from public, anon, authenticated;

-- Это устройство владеет ником?
create or replace function public.sys_is_owner(p_nick text, p_secret text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.sys_devices
                 where nick_key = lower(btrim(p_nick)) and secret_hash = public.sys_hash(p_secret))
$$;
revoke all on function public.sys_is_owner(text, text) from public, anon, authenticated;

-- Проверка ника теперь смотрит на все устройства
create or replace function public.sys_check_nick(p_nick text, p_secret text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from public.sys_players where nick_key = lower(btrim(p_nick))) then return 'free'; end if;
  if public.sys_is_owner(p_nick, p_secret) then return 'mine'; end if;
  return 'taken';
end $$;

-- Синхронизация: занимает свободный ник или обновляет свой.
-- Ответ 'stale' — в облаке более свежее сохранение, приложению надо его скачать.
create or replace function public.sys_sync(p_nick text, p_secret text, p_level int, p_total_xp int,
                                           p_streak int, p_best int, p_save jsonb, p_save_at bigint)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare r public.sys_players; lo int; hi int;
begin
  p_nick := btrim(p_nick);
  if p_nick is null or char_length(p_nick) not between 1 and 20 then return 'bad_nick'; end if;
  if p_secret is null or char_length(p_secret) < 20 then return 'bad_secret'; end if;
  if p_level is null or p_level not between 1 and 1000 then return 'bad_data'; end if;
  lo := 100 * (p_level - 1) + 15 * (p_level - 1) * (p_level - 2);
  hi := lo + 100 + (p_level - 1) * 30;
  if p_total_xp is null or p_total_xp < lo or p_total_xp >= hi then return 'bad_data'; end if;
  if p_streak is null or p_best is null or p_streak < 0 or p_best < p_streak or p_best > 100000 then return 'bad_data'; end if;
  if p_save is null or octet_length(p_save::text) > 200000 or p_save_at is null then return 'bad_data'; end if;

  select * into r from public.sys_players where nick_key = lower(p_nick);
  if not found then
    insert into public.sys_players (nick, secret_hash, level, total_xp, streak, best, save, save_at)
      values (p_nick, public.sys_hash(p_secret), p_level, p_total_xp, p_streak, p_best, p_save, p_save_at);
    insert into public.sys_devices (nick_key, secret_hash) values (lower(p_nick), public.sys_hash(p_secret));
    return 'new';
  end if;
  if not public.sys_is_owner(p_nick, p_secret) then return 'taken'; end if;
  if p_save_at < r.save_at then return 'stale'; end if;
  update public.sys_players
    set nick = p_nick, level = p_level, total_xp = p_total_xp, streak = p_streak, best = p_best,
        save = p_save, save_at = p_save_at, updated_at = now()
    where nick_key = r.nick_key;
  return 'ok';
end $$;

-- Скачать облачное сохранение (только своему устройству)
create or replace function public.sys_load(p_nick text, p_secret text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r public.sys_players;
begin
  if not public.sys_is_owner(p_nick, p_secret) then return null; end if;
  select * into r from public.sys_players where nick_key = lower(btrim(p_nick));
  return jsonb_build_object('save', r.save, 'save_at', r.save_at, 'nick', r.nick);
end $$;

-- Получить код привязки (на устройстве, которое уже владеет ником)
create or replace function public.sys_link_code(p_nick text, p_secret text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare abc text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea := gen_random_bytes(6); code text := ''; i int;
begin
  if not public.sys_is_owner(p_nick, p_secret) then return null; end if;
  for i in 0..5 loop
    code := code || substr(abc, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  insert into public.sys_links (nick_key, code_hash, expires_at, tries)
    values (lower(btrim(p_nick)), public.sys_hash(code), now() + interval '10 minutes', 0)
    on conflict (nick_key) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, tries = 0;
  return code;
end $$;

-- Ввести код на новом устройстве: 'ok' — устройство привязано
create or replace function public.sys_link_use(p_nick text, p_code text, p_new_secret text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare l public.sys_links;
begin
  if p_new_secret is null or char_length(p_new_secret) < 20 then return 'bad_secret'; end if;
  select * into l from public.sys_links where nick_key = lower(btrim(p_nick));
  if not found or l.expires_at < now() then return 'expired'; end if;
  if l.tries >= 5 then return 'locked'; end if;
  if l.code_hash <> public.sys_hash(upper(btrim(p_code))) then
    update public.sys_links set tries = tries + 1 where nick_key = l.nick_key;
    return 'wrong';
  end if;
  insert into public.sys_devices (nick_key, secret_hash) values (l.nick_key, public.sys_hash(p_new_secret))
    on conflict do nothing;
  delete from public.sys_links where nick_key = l.nick_key;
  return 'ok';
end $$;

-- Выйти на этом устройстве. Если устройств у ника не осталось — ник удаляется из рейтинга.
create or replace function public.sys_leave(p_nick text, p_secret text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.sys_devices
    where nick_key = lower(btrim(p_nick)) and secret_hash = public.sys_hash(p_secret);
  if not found then return 'not_found'; end if;
  delete from public.sys_players p
    where p.nick_key = lower(btrim(p_nick))
      and not exists (select 1 from public.sys_devices d where d.nick_key = p.nick_key);
  return 'ok';
end $$;

-- Старая функция отправки (первая версия APK) тоже понимает несколько устройств
create or replace function public.sys_submit(p_nick text, p_secret text, p_level int, p_total_xp int, p_streak int, p_best int)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare lo int; hi int;
begin
  p_nick := btrim(p_nick);
  if p_level is null or p_level not between 1 and 1000 then return 'bad_data'; end if;
  lo := 100 * (p_level - 1) + 15 * (p_level - 1) * (p_level - 2);
  hi := lo + 100 + (p_level - 1) * 30;
  if p_total_xp is null or p_total_xp < lo or p_total_xp >= hi then return 'bad_data'; end if;
  if not exists (select 1 from public.sys_players where nick_key = lower(p_nick)) then
    if p_secret is null or char_length(p_secret) < 20 or char_length(p_nick) not between 1 and 20 then return 'bad_data'; end if;
    insert into public.sys_players (nick, secret_hash, level, total_xp, streak, best)
      values (p_nick, public.sys_hash(p_secret), p_level, p_total_xp, p_streak, p_best);
    insert into public.sys_devices (nick_key, secret_hash) values (lower(p_nick), public.sys_hash(p_secret));
    return 'new';
  end if;
  if not public.sys_is_owner(p_nick, p_secret) then return 'taken'; end if;
  update public.sys_players set level = p_level, total_xp = p_total_xp, streak = p_streak, best = p_best, updated_at = now()
    where nick_key = lower(p_nick);
  return 'ok';
end $$;

revoke all on function public.sys_sync(text, text, int, int, int, int, jsonb, bigint) from public;
revoke all on function public.sys_load(text, text) from public;
revoke all on function public.sys_link_code(text, text) from public;
revoke all on function public.sys_link_use(text, text, text) from public;
grant execute on function public.sys_sync(text, text, int, int, int, int, jsonb, bigint) to anon, authenticated;
grant execute on function public.sys_load(text, text) to anon, authenticated;
grant execute on function public.sys_link_code(text, text) to anon, authenticated;
grant execute on function public.sys_link_use(text, text, text) to anon, authenticated;
