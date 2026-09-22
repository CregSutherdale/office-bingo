-- Sales Bingo: one-time Supabase setup. Paste this whole file into
-- Supabase > SQL Editor > New query > Run. Safe to run again (it rebuilds the functions
-- and keeps your data).
--
-- Change CHANGE-ME in the bingo_secret insert below to your team code. Everyone opens the app once with
--   https://<your pages link>/#team=<the code>
-- and their phone remembers it.

create table if not exists bingo_secret (id int primary key default 1 check (id = 1), code text not null);
insert into bingo_secret (id, code) values (1, 'CHANGE-ME')
  on conflict (id) do update set code = excluded.code;

create table if not exists bingo_settings (
  id int primary key default 1 check (id = 1),
  body jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists bingo_weeks (
  id date primary key,                     -- the Monday that starts the week
  layout jsonb not null,                   -- 25 labels, row by row; index 12 is FREE
  created_at timestamptz not null default now()
);

create table if not exists bingo_marks (
  week_id date not null references bingo_weeks(id) on delete cascade,
  cell smallint not null check (cell between 0 and 24 and cell <> 12),
  marked_by text not null default '',
  marked_at timestamptz not null default now(),
  primary key (week_id, cell)
);

-- Nobody reads or writes the tables directly: RLS on, no policies. The app goes through the
-- functions below, which check the team code first.
alter table bingo_secret enable row level security;
alter table bingo_settings enable row level security;
alter table bingo_weeks enable row level security;
alter table bingo_marks enable row level security;
revoke all on bingo_secret, bingo_settings, bingo_weeks, bingo_marks from anon, authenticated;

-- Starting settings (only if none yet). Edit them later in the app's Settings.
insert into bingo_settings (id, body) values (1, '{
  "title": "Sales Bingo",
  "team": [],
  "items": [
    {"label": "Raw New Auto", "count": 2},
    {"label": "2 Raw New Auto", "count": 2},
    {"label": "Added Auto", "count": 3},
    {"label": "Home", "count": 3},
    {"label": "Raw New Home", "count": 1},
    {"label": "Renters", "count": 2},
    {"label": "Life", "count": 2},
    {"label": "PAP", "count": 1},
    {"label": "RDP", "count": 1},
    {"label": "Boat", "count": 1},
    {"label": "Saved Policy", "count": 2},
    {"label": "Google Review", "count": 2},
    {"label": "Successful Pivot", "count": 2}
  ]
}'::jsonb) on conflict (id) do nothing;

-- This week's card, exactly as it is on the whiteboard (week of Mon 21 Sep 2026).
insert into bingo_weeks (id, layout) values ('2026-09-21', '[
  "Google Review", "Home", "Renters", "Boat", "Successful Pivot",
  "Life", "Raw New Auto", "Google Review", "Home", "2 Raw New Auto",
  "Successful Pivot", "Added Auto", "FREE", "2 Raw New Auto", "Raw New Home",
  "Saved Policy", "Renters", "Added Auto", "Google Review", "PAP",
  "Home", "Saved Policy", "Life", "Added Auto", "Raw New Auto"
]'::jsonb) on conflict (id) do nothing;
insert into bingo_marks (week_id, cell, marked_by) values
  ('2026-09-21', 11, ''), ('2026-09-21', 17, ''), ('2026-09-21', 20, ''), ('2026-09-21', 23, '')
  on conflict do nothing;

-- ---------------------------------------------------------------- functions

create or replace function bingo_check(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_code is null or p_code is distinct from (select code from bingo_secret where id = 1) then
    raise exception 'bad team code' using errcode = '28000';
  end if;
end $$;

-- Everything the app shows for one week, in one call.
create or replace function bingo_state(p_code text, p_week date) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform bingo_check(p_code);
  return jsonb_build_object(
    'settings', (select body from bingo_settings where id = 1),
    'week', (select jsonb_build_object('id', id, 'layout', layout) from bingo_weeks where id = p_week),
    'marks', coalesce((select jsonb_agg(jsonb_build_object('cell', cell, 'by', marked_by, 'at', marked_at) order by cell)
                       from bingo_marks where week_id = p_week), '[]'::jsonb),
    'weeks', coalesce((select jsonb_agg(w.id order by w.id desc)
                       from (select id from bingo_weeks order by id desc limit 26) w), '[]'::jsonb)
  );
end $$;

-- First phone to open a new week creates its shuffled card; everyone else gets that one.
create or replace function bingo_ensure_week(p_code text, p_week date, p_layout jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform bingo_check(p_code);
  if jsonb_typeof(p_layout) <> 'array' or jsonb_array_length(p_layout) <> 25 then
    raise exception 'layout must have 25 squares';
  end if;
  insert into bingo_weeks (id, layout) values (p_week, p_layout) on conflict (id) do nothing;
  return bingo_state(p_code, p_week);
end $$;

-- Reshuffle: new layout for the week, all X's cleared.
create or replace function bingo_set_layout(p_code text, p_week date, p_layout jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform bingo_check(p_code);
  if jsonb_typeof(p_layout) <> 'array' or jsonb_array_length(p_layout) <> 25 then
    raise exception 'layout must have 25 squares';
  end if;
  insert into bingo_weeks (id, layout) values (p_week, p_layout)
    on conflict (id) do update set layout = excluded.layout, created_at = now();
  delete from bingo_marks where week_id = p_week;
  return bingo_state(p_code, p_week);
end $$;

create or replace function bingo_mark(p_code text, p_week date, p_cell int, p_by text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform bingo_check(p_code);
  insert into bingo_marks (week_id, cell, marked_by) values (p_week, p_cell, left(coalesce(p_by, ''), 40))
    on conflict (week_id, cell) do nothing;   -- already X'd by someone: keep the first X
  return bingo_state(p_code, p_week);
end $$;

create or replace function bingo_unmark(p_code text, p_week date, p_cell int) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform bingo_check(p_code);
  delete from bingo_marks where week_id = p_week and cell = p_cell;
  return bingo_state(p_code, p_week);
end $$;

create or replace function bingo_save_settings(p_code text, p_week date, p_settings jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform bingo_check(p_code);
  if jsonb_typeof(p_settings) <> 'object' or length(p_settings::text) > 20000 then
    raise exception 'settings too large';
  end if;
  insert into bingo_settings (id, body, updated_at) values (1, p_settings, now())
    on conflict (id) do update set body = excluded.body, updated_at = now();
  return bingo_state(p_code, p_week);
end $$;

revoke all on function bingo_check(text) from public, anon, authenticated;
revoke all on function bingo_state(text, date), bingo_ensure_week(text, date, jsonb),
  bingo_set_layout(text, date, jsonb), bingo_mark(text, date, int, text), bingo_unmark(text, date, int),
  bingo_save_settings(text, date, jsonb) from public;
grant execute on function bingo_state(text, date), bingo_ensure_week(text, date, jsonb),
  bingo_set_layout(text, date, jsonb), bingo_mark(text, date, int, text), bingo_unmark(text, date, int),
  bingo_save_settings(text, date, jsonb) to anon, authenticated;
