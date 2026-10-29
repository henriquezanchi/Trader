-- Compact, private reporting projections; originals and financial state are preserved.
begin;
create table trade_lab.quality_audit (id bigint primary key, decisions jsonb not null);
create table trade_lab.quality_research (id bigint primary key,recorded_at timestamptz not null,data jsonb not null);
alter table trade_lab.quality_audit enable row level security;
alter table trade_lab.quality_research enable row level security;
revoke all on trade_lab.quality_audit,trade_lab.quality_research from public,anon,authenticated,service_role;
create function trade_lab.quality_decisions(source jsonb) returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',e->'id','at',e->'at','asset',e->'asset','mode',e->'mode','action',e->'action','fee',e->'fee','realizedPnl',e->'realizedPnl',
 'parameters',jsonb_build_object('explorationArm',e#>'{parameters,explorationArm}','entryPolicy',e#>'{parameters,entryPolicy}'),
 'learning',jsonb_build_object('entryId',e#>'{learning,entryId}'))),'[]'::jsonb)
 from jsonb_array_elements(source)e where e->>'mode'='fast' and e->>'action' in ('COMPRAR','VENDER');
$$;
create function trade_lab.quality_direction_data(source jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('directionCycle',jsonb_build_object(
 'outcomes',(select coalesce(jsonb_agg(jsonb_build_object('id',e->'id','protocolId',e->'protocolId','horizon',e->'horizon','status',e->'status','actualObservedAt',e->'actualObservedAt','targetAt',e->'targetAt')),'[]'::jsonb) from jsonb_array_elements(coalesce(source#>'{directionCycle,outcomes}','[]'::jsonb))e),
 'newPredictions',(select coalesce(jsonb_agg(jsonb_build_object('id',e->'id','protocolId',e->'protocolId','horizon',e->'horizon','targetAt',e->'targetAt') || case when e ? 'modelHash' then jsonb_build_object('modelHash',true) else '{}'::jsonb end || case when e ? 'inputHash' then jsonb_build_object('inputHash',true) else '{}'::jsonb end || case when e ? 'modelSnapshot' then jsonb_build_object('modelSnapshot',true) else '{}'::jsonb end),'[]'::jsonb) from jsonb_array_elements(coalesce(source#>'{directionCycle,newPredictions}','[]'::jsonb))e)));
$$;
create function trade_lab.quality_capture() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='audit' then
  insert into trade_lab.quality_audit values(new.id,trade_lab.quality_decisions(new.decisions));
 else
  insert into trade_lab.quality_research values(new.id,new.recorded_at,trade_lab.quality_direction_data(new.data));
 end if;return new;
end;
$$;
revoke all on function trade_lab.quality_capture(),trade_lab.quality_decisions(jsonb),trade_lab.quality_direction_data(jsonb) from public,anon,authenticated,service_role;
create trigger quality_audit_capture after insert on trade_lab.audit for each row execute function trade_lab.quality_capture();
create trigger quality_research_capture after insert on trade_lab.research_cycles for each row execute function trade_lab.quality_capture();
insert into trade_lab.quality_audit select id,trade_lab.quality_decisions(decisions) from trade_lab.audit;
insert into trade_lab.quality_research select id,recorded_at,trade_lab.quality_direction_data(data) from trade_lab.research_cycles;
create or replace function public.trade_lab_quality_read()
returns jsonb language sql security definer set search_path = '' as $$
 with trades as (
  select e.value as event from trade_lab.quality_audit a
  cross join lateral jsonb_array_elements(a.decisions)e
  where e.value->>'mode'='fast' and e.value->>'action' in ('COMPRAR','VENDER')
 ), groups as (
  select case when event->>'asset' like 'solana:%' then 'new-pools' else 'established' end as asset_group,
   count(*) filter(where event->>'action'='COMPRAR') as buys,
   count(*) filter(where event->>'action'='VENDER') as sells,
   count(*) filter(where event->>'action'='VENDER' and (event->>'realizedPnl')::numeric>0) as profitable_sells,
   coalesce(sum((event->>'fee')::numeric),0) as fees,
   coalesce(sum((event->>'realizedPnl')::numeric) filter(where event->>'action'='VENDER'),0) as realized_net,
   count(*) filter(where event->>'action'='VENDER' and event->>'realizedPnl' is null) as unknown_pnl
  from trades group by 1
 ), outcomes as (
  select e.value as event from trade_lab.quality_research c
  cross join lateral jsonb_array_elements(coalesce(c.data#>'{directionCycle,outcomes}','[]'::jsonb))e
 ), evaluation as (
  select coalesce(event->>'protocolId','legacy') as protocol,(event->>'horizon')::integer as horizon,
   count(*) as recorded_outcomes,count(distinct event->>'id') as unique_predictions,
   count(*) filter(where event->>'status'='scored') as evaluated,
   count(*) filter(where event->>'status'='missing-price') as missing,
   count(*) filter(where event->>'status'='scored' and (event->>'actualObservedAt')::timestamptz<(event->>'targetAt')::timestamptz) as price_before_target
  from outcomes group by 1,2
 ), issued as (
  select e.value as prediction,c.recorded_at as recorded_at from trade_lab.quality_research c
  cross join lateral jsonb_array_elements(coalesce(c.data#>'{directionCycle,newPredictions}','[]'::jsonb))e
 ), issuance as (
  select coalesce(prediction->>'protocolId','legacy') as protocol,(prediction->>'horizon')::integer as horizon,
   count(*) as recorded_predictions,count(distinct prediction->>'id') as unique_predictions,
   count(*) filter(where recorded_at >= (prediction->>'targetAt')::timestamptz) as recorded_after_target,
   count(*) filter(where prediction ? 'modelHash' and prediction ? 'inputHash' and prediction ? 'modelSnapshot') as fingerprinted
  from issued group by 1,2
 ), attributed as (
 select t.event,case when t.event->>'asset' like 'solana:%' then 'new-pools' else 'established' end as asset_group,
 coalesce(b.event#>>'{parameters,explorationArm}',t.event#>>'{parameters,explorationArm}','unattributed') as arm,
 coalesce(b.event#>>'{parameters,entryPolicy}',t.event#>>'{parameters,entryPolicy}','legacy-or-manual') as policy
 from trades t left join trades b on t.event#>>'{learning,entryId}'=b.event->>'id' and b.event->>'action'='COMPRAR'
 ), strategy_groups as (
 select p.period,a.asset_group,a.policy,a.arm,
 count(*) filter(where event->>'action'='COMPRAR') as buys,
 count(*) filter(where event->>'action'='VENDER') as sells,
 count(*) filter(where event->>'action'='VENDER' and (event->>'realizedPnl')::numeric>0) as wins,
 count(*) filter(where event->>'action'='VENDER' and (event->>'realizedPnl')::numeric<0) as losses,
 count(*) filter(where event->>'action'='VENDER' and event->>'realizedPnl' is null) as unknown_pnl,
 coalesce(sum((event->>'fee')::numeric),0) as fees,
 coalesce(sum((event->>'realizedPnl')::numeric) filter(where event->>'action'='VENDER'),0) as realized_net,
 avg((event->>'realizedPnl')::numeric) filter(where event->>'action'='VENDER') as expectancy_brl,
 sum(greatest((event->>'realizedPnl')::numeric,0)) filter(where event->>'action'='VENDER') /
 nullif(sum(greatest(-(event->>'realizedPnl')::numeric,0)) filter(where event->>'action'='VENDER'),0) as profit_factor,
 min((event->>'at')::timestamptz) as first_at,max((event->>'at')::timestamptz) as last_at
 from attributed a cross join (values ('all',null::interval),('7d',interval '7 days'),('24h',interval '24 hours')) p(period,span)
 where p.span is null or (event->>'at')::timestamptz>=now()-p.span
 group by p.period,a.asset_group,a.policy,a.arm
 ) select jsonb_build_object('asOf',now(),'trading',coalesce((select jsonb_agg(to_jsonb(g) order by g.asset_group) from groups g),'[]'::jsonb),
  'strategies',coalesce((select jsonb_agg(to_jsonb(s) order by s.period,s.asset_group,s.policy,s.arm) from strategy_groups s),'[]'::jsonb),
  'evaluation',coalesce((select jsonb_agg(to_jsonb(e) order by e.protocol,e.horizon) from evaluation e),'[]'::jsonb),
  'issuance',coalesce((select jsonb_agg(to_jsonb(i) order by i.protocol,i.horizon) from issuance i),'[]'::jsonb),
  'notes','Realized P/L already includes recorded trading costs; do not subtract fees again. Directional accuracy does not cover speculative pools.');
$$;
revoke all on function public.trade_lab_quality_read() from public, anon, authenticated;
grant execute on function public.trade_lab_quality_read() to service_role;
commit;
