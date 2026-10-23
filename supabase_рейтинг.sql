-- Онлайн-рейтинг охотников для приложения «Система».
-- Вставить целиком в Supabase → SQL Editor → Run (проект тот же, что у рекордов калькулятора).

-- Одна строка = один охотник. Ник закреплён за устройством через секретный код
-- (в базе хранится только хеш кода, сам код лежит в приложении игрока).
create table if not exists public.sys_players (
  nick        text primary key check (char_length(nick) between 1 and 20),
  nick_key    text not null unique generated always as (lower(nick)) stored, -- «Кирилл» и «кирилл» — один ник
  secret_hash text not null,
  level       int  not null check (level between 1 and 1000),
  total_xp    int  not null check (total_xp between 0 and 100000000),
  streak      int  not null check (streak between 0 and 100000),
  best        int  not null check (best between 0 and 100000),
  updated_at  timestamptz not null default now()
);

-- Защита (RLS): напрямую в таблицу снаружи никто не лезет
alter table public.sys_players enable row level security;
revoke all on public.sys_players from anon, authenticated;

-- Публичная витрина: без хешей. Сортировку и лимит задаёт приложение (?order=total_xp.desc&limit=100)
create or replace view public.sys_leaderboard as
  select nick, level, total_xp, streak, best, updated_at from public.sys_players;
grant select on public.sys_leaderboard to anon, authenticated;

-- Проверить ник: 'free' — свободен, 'mine' — твой, 'taken' — занят другим
create or replace function public.sys_check_nick(p_nick text, p_secret text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare h text;
begin
  select secret_hash into h from public.sys_players where nick_key = lower(btrim(p_nick));
  if not found then return 'free'; end if;
  if h = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex') then return 'mine'; end if;
  return 'taken';
end $$;

-- Отправить прогресс: занимает свободный ник или обновляет свою строку.
-- Опыт проверяется на соответствие уровню (та же формула, что в приложении:
-- на уровень L нужно 100 + (L-1)*30 опыта) — грубые подделки не пройдут.
create or replace function public.sys_submit(p_nick text, p_secret text, p_level int, p_total_xp int, p_streak int, p_best int)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare r public.sys_players; h text; lo int; hi int;
begin
  p_nick := btrim(p_nick);
  if p_nick is null or char_length(p_nick) not between 1 and 20 then return 'bad_nick'; end if;
  if p_secret is null or char_length(p_secret) < 20 then return 'bad_secret'; end if;
  if p_level is null or p_level not between 1 and 1000 then return 'bad_data'; end if;
  lo := 100 * (p_level - 1) + 15 * (p_level - 1) * (p_level - 2);  -- опыт на начало уровня
  hi := lo + 100 + (p_level - 1) * 30;                             -- опыт на следующий уровень
  if p_total_xp is null or p_total_xp < lo or p_total_xp >= hi then return 'bad_data'; end if;
  if p_streak is null or p_best is null or p_streak < 0 or p_best < p_streak or p_best > 100000 then return 'bad_data'; end if;

  h := encode(digest(p_secret, 'sha256'), 'hex');
  select * into r from public.sys_players where nick_key = lower(p_nick);
  if not found then
    insert into public.sys_players (nick, secret_hash, level, total_xp, streak, best)
      values (p_nick, h, p_level, p_total_xp, p_streak, p_best);
    return 'new';
  end if;
  if r.secret_hash <> h then return 'taken'; end if;
  update public.sys_players
    set nick = p_nick, level = p_level, total_xp = p_total_xp, streak = p_streak, best = p_best, updated_at = now()
    where nick_key = r.nick_key;
  return 'ok';
end $$;

-- Сменить ник (старая строка удаляется, только если секрет совпал)
create or replace function public.sys_leave(p_nick text, p_secret text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from public.sys_players
    where nick_key = lower(btrim(p_nick))
      and secret_hash = encode(digest(coalesce(p_secret, ''), 'sha256'), 'hex');
  if found then return 'ok'; end if;
  return 'not_found';
end $$;

revoke all on function public.sys_check_nick(text, text) from public;
revoke all on function public.sys_submit(text, text, int, int, int, int) from public;
revoke all on function public.sys_leave(text, text) from public;
grant execute on function public.sys_check_nick(text, text) to anon, authenticated;
grant execute on function public.sys_submit(text, text, int, int, int, int) to anon, authenticated;
grant execute on function public.sys_leave(text, text) to anon, authenticated;
