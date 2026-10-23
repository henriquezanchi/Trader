-- Pesquisa privada: aplicar uma única vez, preservando as migrações anteriores.
begin;
create table trade_lab.research_cycles (
  id bigint generated always as identity primary key,
  state_version integer not null unique,
  recorded_at timestamptz not null default now(),
  data jsonb not null check(jsonb_typeof(data) = 'object')
);
alter table trade_lab.research_cycles enable row level security;
revoke all on trade_lab.research_cycles from public, anon, authenticated, service_role;

create function trade_lab.record_research()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if jsonb_typeof(new.payload->'researchDelta') = 'object'
     and new.payload->'researchDelta' is distinct from old.payload->'researchDelta' then
    insert into trade_lab.research_cycles(state_version, data) values(new.version,new.payload->'researchDelta');
  end if;
  return new;
end;
$$;
revoke all on function trade_lab.record_research() from public, anon, authenticated, service_role;
create trigger trade_lab_research after update on trade_lab.state
  for each row execute function trade_lab.record_research();

create function public.trade_lab_research_read(before_id bigint default null)
returns jsonb language sql security definer set search_path = '' as $$
  with page as (
    select id, state_version, recorded_at, data from trade_lab.research_cycles
    where before_id is null or id < before_id order by id desc limit 12
  ) select jsonb_build_object('entries',coalesce(jsonb_agg(to_jsonb(page) order by id desc),'[]'::jsonb),
      'nextCursor',case when count(*) = 12 then min(id) else null end) from page;
$$;
revoke all on function public.trade_lab_research_read(bigint) from public, anon, authenticated;
grant execute on function public.trade_lab_research_read(bigint) to service_role;
commit;
