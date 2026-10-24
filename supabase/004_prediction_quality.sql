-- Read-only measurement report; does not change financial state or old audit records.
begin;
create function public.trade_lab_quality_read()
returns jsonb language sql security definer set search_path = '' as $$
 with trades as (
  select e.value as event from trade_lab.audit a
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
  select e.value as event from trade_lab.research_cycles c
  cross join lateral jsonb_array_elements(coalesce(c.data#>'{directionCycle,outcomes}','[]'::jsonb))e
 ), evaluation as (
  select coalesce(event->>'protocolId','legacy') as protocol,(event->>'horizon')::integer as horizon,
   count(*) as recorded_outcomes,count(distinct event->>'id') as unique_predictions,
   count(*) filter(where event->>'status'='scored') as evaluated,
   count(*) filter(where event->>'status'='missing-price') as missing,
   count(*) filter(where event->>'status'='scored' and (event->>'actualObservedAt')::timestamptz<(event->>'targetAt')::timestamptz) as price_before_target
  from outcomes group by 1,2
 ), issued as (
  select e.value as prediction,c.recorded_at as recorded_at from trade_lab.research_cycles c
  cross join lateral jsonb_array_elements(coalesce(c.data#>'{directionCycle,newPredictions}','[]'::jsonb))e
 ), issuance as (
  select coalesce(prediction->>'protocolId','legacy') as protocol,(prediction->>'horizon')::integer as horizon,
   count(*) as recorded_predictions,count(distinct prediction->>'id') as unique_predictions,
   count(*) filter(where recorded_at >= (prediction->>'targetAt')::timestamptz) as recorded_after_target,
   count(*) filter(where prediction ? 'modelHash' and prediction ? 'inputHash' and prediction ? 'modelSnapshot') as fingerprinted
  from issued group by 1,2
 ) select jsonb_build_object('asOf',now(),'trading',coalesce((select jsonb_agg(to_jsonb(g) order by g.asset_group) from groups g),'[]'::jsonb),
  'evaluation',coalesce((select jsonb_agg(to_jsonb(e) order by e.protocol,e.horizon) from evaluation e),'[]'::jsonb),
  'issuance',coalesce((select jsonb_agg(to_jsonb(i) order by i.protocol,i.horizon) from issuance i),'[]'::jsonb),
  'notes','Realized P/L already includes recorded trading costs; do not subtract fees again. Directional accuracy does not cover speculative pools.');
$$;
revoke all on function public.trade_lab_quality_read() from public, anon, authenticated;
grant execute on function public.trade_lab_quality_read() to service_role;
commit;
