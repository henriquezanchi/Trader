-- Valores de bootstrap são fixtures sintéticas. Configure o saldo privadamente antes de iniciar.
-- Execute apenas no projeto Supabase escolhido para este protótipo.
begin;
create schema trade_lab;
revoke all on schema trade_lab from public, anon, authenticated;
create table trade_lab.state (
  id integer primary key check (id = 1),
  version integer not null default 0,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table trade_lab.state enable row level security;
revoke all on trade_lab.state from public, anon, authenticated;
grant select, update on trade_lab.state to service_role;
insert into trade_lab.state(id, payload) values (1,
  '{"initialCapital":1000,"cash":1000,"btc":0,"paused":false,"reason":"Aguardando primeira cotação","lastPrice":null,"lastTick":null,"day":null,"dayEquity":1000,"observations":[],"events":[]}');

create function public.trade_lab_read()
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('version', version, 'payload', payload) from trade_lab.state where id = 1;
$$;
revoke all on function public.trade_lab_read() from public, anon, authenticated;
grant execute on function public.trade_lab_read() to service_role;

-- Compare-and-swap: gravação do saldo e do histórico na mesma transação.
-- Uma pausa concorrente ou outro tick invalida a versão anterior.
create function public.trade_lab_commit(expected_version integer, next_payload jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  if jsonb_typeof(next_payload) <> 'object'
     or not (next_payload ?& array['cash','btc','paused','observations','events'])
     or (next_payload->>'cash')::numeric < 0
     or (next_payload->>'btc')::numeric < 0 then
    raise exception 'Estado inválido';
  end if;
  update trade_lab.state
    set payload = next_payload, version = version + 1, updated_at = now()
    where id = 1 and version = expected_version;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;
revoke all on function public.trade_lab_commit(integer, jsonb) from public, anon, authenticated;
grant execute on function public.trade_lab_commit(integer, jsonb) to service_role;
commit;
