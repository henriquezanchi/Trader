-- Extract only actual, fresh quoted prices; preserve the earliest publication of a quote.
begin;
create table trade_lab.quote_observations(
 asset text not null,source text not null,observed_at timestamptz not null,known_at timestamptz not null,
 price numeric not null check(price>0),audit_id bigint not null references trade_lab.audit(id),
 primary key(asset,source,observed_at),check(known_at>=observed_at)
);
create index quote_asset_known on trade_lab.quote_observations(asset,known_at desc);
alter table trade_lab.quote_observations enable row level security;
revoke all on trade_lab.quote_observations from public,anon,authenticated,service_role;
create function trade_lab.record_quote_observations() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into trade_lab.quote_observations(asset,source,observed_at,known_at,price,audit_id)
 select distinct on(e.value->>'asset',e.value#>>'{quote,observedAt}') e.value->>'asset','coingecko',(e.value#>>'{quote,observedAt}')::timestamptz,greatest((e.value->>'at')::timestamptz,new.recorded_at),(e.value#>>'{quote,price}')::numeric,new.id
 from jsonb_array_elements(new.decisions) with ordinality e(value,ord)
 where e.value->>'mode'='fast' and e.value#>>'{quote,source}'='coingecko'
 and e.value->>'asset' in ('bitcoin','ethereum','solana','binancecoin','ripple','cardano','chainlink','avalanche-2','polkadot','litecoin')
 and jsonb_typeof(e.value#>'{quote,price}')='number' and (e.value#>>'{quote,price}')::numeric>0
 and (e.value#>>'{quote,observedAt}')::timestamptz<=greatest((e.value->>'at')::timestamptz,new.recorded_at)
 and greatest((e.value->>'at')::timestamptz,new.recorded_at)-(e.value#>>'{quote,observedAt}')::timestamptz<=interval '2 minutes'
 order by e.value->>'asset',e.value#>>'{quote,observedAt}',e.ord
 on conflict do nothing;
 return new;
end $$;
revoke all on function trade_lab.record_quote_observations() from public,anon,authenticated,service_role;
create trigger quote_history after insert on trade_lab.audit for each row execute function trade_lab.record_quote_observations();
insert into trade_lab.quote_observations(asset,source,observed_at,known_at,price,audit_id)
 select distinct on(e.value->>'asset',e.value#>>'{quote,observedAt}') e.value->>'asset','coingecko',(e.value#>>'{quote,observedAt}')::timestamptz,greatest((e.value->>'at')::timestamptz,a.recorded_at),(e.value#>>'{quote,price}')::numeric,a.id
 from trade_lab.audit a cross join lateral jsonb_array_elements(a.decisions) with ordinality e(value,ord)
 where e.value->>'mode'='fast' and e.value#>>'{quote,source}'='coingecko'
 and e.value->>'asset' in ('bitcoin','ethereum','solana','binancecoin','ripple','cardano','chainlink','avalanche-2','polkadot','litecoin')
 and jsonb_typeof(e.value#>'{quote,price}')='number' and (e.value#>>'{quote,price}')::numeric>0
 and (e.value#>>'{quote,observedAt}')::timestamptz<=greatest((e.value->>'at')::timestamptz,a.recorded_at)
 and greatest((e.value->>'at')::timestamptz,a.recorded_at)-(e.value#>>'{quote,observedAt}')::timestamptz<=interval '2 minutes'
 order by e.value->>'asset',e.value#>>'{quote,observedAt}',greatest((e.value->>'at')::timestamptz,a.recorded_at),a.id,e.ord;
create function public.trade_lab_execution_data(asset_id text) returns jsonb language sql security definer set search_path='' as $$
 with recent as(select * from trade_lab.quote_observations where asset=asset_id and source='coingecko' and known_at<=now() order by known_at desc,observed_at desc limit 6000),
 points as(select distinct on(known_at) known_at as at,observed_at as "observedAt",price,source from recent order by known_at,observed_at desc)
 select coalesce(jsonb_agg(to_jsonb(points) order by at),'[]'::jsonb) from points;
$$;
create function public.trade_lab_execution_models() returns jsonb language sql security definer set search_path='' as $$
 with latest as(select distinct on(asset) id,asset,protocol,recorded_at as "recordedAt",models from trade_lab.scenario_studies where protocol='execution-horizons-v1' order by asset,id desc)
 select coalesce(jsonb_agg(to_jsonb(latest) order by asset),'[]'::jsonb) from latest;
$$;
revoke all on function public.trade_lab_execution_data(text) from public,anon,authenticated;
revoke all on function public.trade_lab_execution_models() from public,anon,authenticated;
grant execute on function public.trade_lab_execution_data(text) to service_role;
grant execute on function public.trade_lab_execution_models() to service_role;
create or replace function public.trade_lab_scenario_save(asset_id text,study_report jsonb,study_models jsonb,study_observations jsonb) returns bigint language plpgsql security definer set search_path='' as $$
declare result bigint;
begin
 if study_report->>'asset' is distinct from asset_id or coalesce(study_report#>>'{protocol,id}','') not in ('scenario-comparison-v1','scenario-comparison-v2','execution-horizons-v1') or jsonb_array_length(study_observations)<120 or study_report->>'datasetHash' is null then raise exception 'Estudo inválido'; end if;
 insert into trade_lab.scenario_studies(asset,protocol,dataset_hash,report,models,observations)
 values(asset_id,study_report#>>'{protocol,id}',study_report->>'datasetHash',study_report,study_models,study_observations)
 on conflict(asset,protocol,dataset_hash) do nothing;
 select id into result from trade_lab.scenario_studies where asset=asset_id and protocol=study_report#>>'{protocol,id}' and dataset_hash=study_report->>'datasetHash';
 return result;
end $$;
create or replace function public.trade_lab_scenario_version(asset_id text,study_version text) returns jsonb language sql security definer set search_path='' as $$
 with latest as (select distinct on(asset) id,asset,recorded_at,report from trade_lab.scenario_studies where (asset_id is null or asset=asset_id) and ((study_version is null and protocol in ('scenario-comparison-v1','scenario-comparison-v2')) or protocol=study_version) order by asset,id desc)
 select jsonb_build_object('studies',coalesce(jsonb_agg(jsonb_build_object('id',id,'asset',asset,'recordedAt',recorded_at,'report',case when asset_id is null then report->'summary' else report end) order by asset),'[]'::jsonb)) from latest;
$$;
create or replace function public.trade_lab_scenario_models() returns jsonb language sql security definer set search_path='' as $$
 with latest as(select distinct on(asset) id,asset,protocol,recorded_at as "recordedAt",models from trade_lab.scenario_studies where protocol in ('scenario-comparison-v1','scenario-comparison-v2') order by asset,id desc)
 select coalesce(jsonb_agg(to_jsonb(latest) order by asset),'[]'::jsonb) from latest;
$$;
create or replace function public.trade_lab_scenario_dataset(asset_id text) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('observations',observations,'report',report->'summary') from trade_lab.scenario_studies where asset=asset_id and protocol in ('scenario-comparison-v1','scenario-comparison-v2') order by id desc limit 1;
$$;
commit;
