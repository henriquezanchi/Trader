begin;
create table trade_lab.equity_points (
 observed_at timestamptz primary key,
 audit_id bigint not null references trade_lab.audit(id),
 equity numeric not null check(equity>=0)
);
alter table trade_lab.equity_points enable row level security;
revoke all on trade_lab.equity_points from public,anon,authenticated,service_role;
create function trade_lab.record_equity_points() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into trade_lab.equity_points(observed_at,audit_id,equity)
 select distinct on ((e.value->>'at')::timestamptz) (e.value->>'at')::timestamptz,new.id,(e.value->>'equity')::numeric
 from jsonb_array_elements(new.decisions) with ordinality e(value,ord)
 where e.value->>'at' is not null and jsonb_typeof(e.value->'equity')='number'
 order by (e.value->>'at')::timestamptz,e.ord desc
 on conflict(observed_at) do update set audit_id=excluded.audit_id,equity=excluded.equity;
 return new;
end $$;
revoke all on function trade_lab.record_equity_points() from public,anon,authenticated,service_role;
create trigger equity_history after insert on trade_lab.audit for each row execute function trade_lab.record_equity_points();
insert into trade_lab.equity_points(observed_at,audit_id,equity)
 select distinct on ((e.value->>'at')::timestamptz) (e.value->>'at')::timestamptz,a.id,(e.value->>'equity')::numeric
 from trade_lab.audit a cross join lateral jsonb_array_elements(a.decisions) with ordinality e(value,ord)
 where e.value->>'at' is not null and jsonb_typeof(e.value->'equity')='number'
 order by (e.value->>'at')::timestamptz,a.id desc,e.ord desc;
create function public.trade_lab_chart_read(period text) returns jsonb language plpgsql security definer set search_path='' as $$
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
 with filtered as (select * from trade_lab.equity_points where observed_at>=now()-duration and observed_at<=now()),
 sampled as (select distinct on (floor(extract(epoch from observed_at)/step)) observed_at as at,equity,audit_id as "auditId" from filtered order by floor(extract(epoch from observed_at)/step),observed_at desc)
 select jsonb_build_object('points',coalesce((select jsonb_agg(to_jsonb(s) order by s.at) from sampled s),'[]'::jsonb),'availableFrom',(select min(observed_at) from trade_lab.equity_points),'from',now()-duration,'through',now(),'cycleCount',(select count(*) from filtered),'bucketSeconds',step) into result;
 return result;
end $$;
create function public.trade_lab_chart_cycle(audit_id bigint) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('decisions',decisions,'parameters',parameters,'context',context) from trade_lab.audit where id=audit_id;
$$;
revoke all on function public.trade_lab_chart_read(text) from public,anon,authenticated;
revoke all on function public.trade_lab_chart_cycle(bigint) from public,anon,authenticated;
grant execute on function public.trade_lab_chart_read(text) to service_role;
grant execute on function public.trade_lab_chart_cycle(bigint) to service_role;
commit;
