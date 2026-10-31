-- Read-only diagnostic, indexed by the compact audit ledger. No portfolio mutation.
begin;
create function public.trade_lab_sale_diagnostics() returns jsonb language sql security definer set search_path='' as $$
with sales as materialized (
 select q.id as audit_id,e.value as light from trade_lab.quality_audit q
 cross join lateral jsonb_array_elements(q.decisions)e
 where e.value->>'action'='VENDER' order by q.id desc,e.value->>'id' desc limit 40
), buys as materialized (
 select q.id as audit_id,e.value as light from trade_lab.quality_audit q
 cross join lateral jsonb_array_elements(q.decisions)e where e.value->>'action'='COMPRAR'
), paired as (
 select s.audit_id,s.light,b.audit_id as buy_audit_id,b.light->>'id' as buy_id from sales s
 left join buys b on b.light->>'id'=s.light#>>'{learning,entryId}'
), rows as (
 select p.audit_id,p.light as sale_light,e.value->>'reason' as reason,e.value->'price' as exit_price,e.value->'quantity' as quantity,
 e.value->'before' as before,e.value#>'{parameters,maxMinutes}' as max_minutes,e.value#>'{parameters,takeProfitPct}' as target_pct,
 e.value#>'{parameters,exitMode}' as exit_mode,b.value->'at' as entry_at,b.value->'price' as entry_price,b.value->'quantity' as entry_quantity,
 (select jsonb_build_object('price',price,'observedAt',observed_at,'knownAt',known_at,'source',source) from trade_lab.quote_observations
 where asset=p.light->>'asset' and source='coingecko' and observed_at>=(p.light->>'at')::timestamptz+interval '1 hour'
 and observed_at<=(p.light->>'at')::timestamptz+interval '65 minutes' and known_at<=now() order by observed_at limit 1) as after_hour
 from paired p join trade_lab.audit a on a.id=p.audit_id cross join lateral jsonb_array_elements(a.decisions)e
 left join trade_lab.audit ab on ab.id=p.buy_audit_id
 left join lateral jsonb_array_elements(ab.decisions)b(value) on b.value->>'id'=p.buy_id
 where e.value->>'id'=p.light->>'id'
) select coalesce(jsonb_agg(to_jsonb(rows) order by audit_id desc,sale_light->>'id' desc),'[]'::jsonb) from rows;
$$;
revoke all on function public.trade_lab_sale_diagnostics() from public,anon,authenticated;
grant execute on function public.trade_lab_sale_diagnostics() to service_role;
create or replace function public.trade_lab_tips_review(candidate_id text,review_data jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if review_data->>'status' not in ('rejected','registered','needs-original') or length(review_data->>'reason')<5 or octet_length(review_data::text)>2000 then raise exception 'Revisão inválida';end if;
 update trade_lab.tip_candidates set review=review_data||jsonb_build_object('at',clock_timestamp(),'previous',review)
 where id=candidate_id and (review is null or review->>'status'='needs-original' and review_data->>'status'<>'needs-original');
end $$;
commit;
