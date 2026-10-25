-- Adapt to the history actually available, preserving real sampled cycles.
begin;
create or replace function public.trade_lab_chart_read(period text) returns jsonb language plpgsql security definer set search_path='' as $$
declare duration interval; step integer; result jsonb;
begin
 case period
 when '1h' then duration=interval '1 hour';step=60;
 when '1d' then duration=interval '1 day';step=300;
 when '1w' then duration=interval '7 days';step=1800;
 when '1m' then duration=interval '1 month';step=7200;
 when '1y' then duration=interval '1 year';step=86400;
 when '5y' then duration=interval '5 years';step=604800;
 else raise exception 'Prazo inválido';end case;
 step=least(step,greatest(60,ceil(extract(epoch from (now()-greatest(now()-duration,(select min(observed_at) from trade_lab.equity_points))))/360/60)::integer*60));
 with filtered as (select * from trade_lab.equity_points where observed_at>=now()-duration and observed_at<=now()),
 sampled as (select distinct on (floor(extract(epoch from observed_at)/step)) observed_at as at,equity,audit_id as "auditId" from filtered order by floor(extract(epoch from observed_at)/step),observed_at desc)
 select jsonb_build_object('points',coalesce((select jsonb_agg(to_jsonb(s) order by s.at) from sampled s),'[]'::jsonb),'availableFrom',(select min(observed_at) from trade_lab.equity_points),'from',now()-duration,'through',now(),'cycleCount',(select count(*) from filtered),'bucketSeconds',step) into result;
 return result;
end $$;
commit;
