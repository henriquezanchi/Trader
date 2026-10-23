-- Nova migração: registro privado persistente. Não reaplicar 001 em instalações existentes.
begin;
create table trade_lab.audit (
  id bigint generated always as identity primary key,
  state_version integer not null unique,
  recorded_at timestamptz not null default now(),
  kind text not null,
  parameters jsonb,
  decisions jsonb not null,
  context jsonb not null
);
alter table trade_lab.audit enable row level security;
revoke all on trade_lab.audit from public, anon, authenticated, service_role;
grant select on trade_lab.audit to service_role;

create function trade_lab.record_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare added jsonb;
begin
  select coalesce(jsonb_agg(e.value), '[]'::jsonb) into added
    from jsonb_array_elements(coalesce(new.payload->'events', '[]'::jsonb)) e
    where not exists (
      select 1 from jsonb_array_elements(coalesce(old.payload->'events', '[]'::jsonb)) prior
      where prior.value = e.value
    );
  insert into trade_lab.audit(state_version, kind, parameters, decisions, context)
  values (new.version,
    case when new.payload->'config' is distinct from old.payload->'config' then 'configuration'
      when new.payload->'paused' is distinct from old.payload->'paused' and jsonb_array_length(added) = 0 then 'control'
      else 'cycle' end,
    new.payload->'config', added,
    jsonb_build_object('paused',new.payload->'paused','reason',new.payload->'reason',
      'cashBefore',old.payload->'cash','cashAfter',new.payload->'cash',
      'initialCapital',new.payload->'initialCapital','bootstrap',new.payload->'bootstrap',
      'mutation',new.payload->'lastMutation'));
  return new;
end;
$$;
revoke all on function trade_lab.record_audit() from public, anon, authenticated;
create trigger trade_lab_audit after update on trade_lab.state
  for each row execute function trade_lab.record_audit();

-- O histórico legado é preservado sem inventar parâmetros que não foram registrados.
insert into trade_lab.audit(state_version, kind, parameters, decisions, context)
  select version, 'legacy_snapshot', null, coalesce(payload->'events','[]'::jsonb),
    jsonb_build_object('note','Histórico anterior ao relatório: parâmetros por decisão não foram registrados')
  from trade_lab.state;

create function public.trade_lab_audit_read(before_id bigint default null)
returns jsonb language sql security definer set search_path = '' as $$
  with page as (
    select id, state_version, recorded_at, kind, parameters, decisions, context
      from trade_lab.audit where before_id is null or id < before_id
      order by id desc limit 30
  ) select jsonb_build_object('entries',coalesce(jsonb_agg(to_jsonb(page) order by id desc),'[]'::jsonb),
      'nextCursor',case when count(*) = 30 then min(id) else null end) from page;
$$;
revoke all on function public.trade_lab_audit_read(bigint) from public, anon, authenticated;
grant execute on function public.trade_lab_audit_read(bigint) to service_role;
commit;
