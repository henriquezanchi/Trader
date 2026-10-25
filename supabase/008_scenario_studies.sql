begin;
create table trade_lab.scenario_studies (
 id bigint generated always as identity primary key,
 asset text not null,
 protocol text not null,
 dataset_hash text not null,
 recorded_at timestamptz not null default now(),
 report jsonb not null,
 models jsonb not null,
 observations jsonb not null,
 unique(asset,protocol,dataset_hash)
);
create index scenario_study_asset_id on trade_lab.scenario_studies(asset,id desc);
alter table trade_lab.scenario_studies enable row level security;
revoke all on trade_lab.scenario_studies from public,anon,authenticated,service_role;
create function public.trade_lab_scenario_save(asset_id text,study_report jsonb,study_models jsonb,study_observations jsonb) returns bigint language plpgsql security definer set search_path='' as $$
declare result bigint;
begin
 if study_report->>'asset' is distinct from asset_id or study_report#>>'{protocol,id}' is distinct from 'scenario-comparison-v1' or jsonb_array_length(study_observations)<120 or study_report->>'datasetHash' is null then raise exception 'Estudo inválido'; end if;
 insert into trade_lab.scenario_studies(asset,protocol,dataset_hash,report,models,observations)
 values(asset_id,study_report#>>'{protocol,id}',study_report->>'datasetHash',study_report,study_models,study_observations)
 on conflict(asset,protocol,dataset_hash) do nothing;
 select id into result from trade_lab.scenario_studies where asset=asset_id and protocol=study_report#>>'{protocol,id}' and dataset_hash=study_report->>'datasetHash';
 return result;
end $$;
create function public.trade_lab_scenario_read(asset_id text default null) returns jsonb language sql security definer set search_path='' as $$
 with latest as (select distinct on(asset) id,asset,recorded_at,report from trade_lab.scenario_studies where asset_id is null or asset=asset_id order by asset,id desc)
 select jsonb_build_object('studies',coalesce(jsonb_agg(jsonb_build_object('id',id,'asset',asset,'recordedAt',recorded_at,'report',case when asset_id is null then report->'summary' else report end) order by asset),'[]'::jsonb)) from latest;
$$;
create function public.trade_lab_scenario_models() returns jsonb language sql security definer set search_path='' as $$
 with latest as (select distinct on(asset) id,asset,recorded_at as "recordedAt",models from trade_lab.scenario_studies order by asset,id desc)
 select coalesce(jsonb_agg(to_jsonb(latest) order by asset),'[]'::jsonb) from latest;
$$;
create function public.trade_lab_scenario_dataset(asset_id text) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('observations',observations,'report',report->'summary') from trade_lab.scenario_studies where asset=asset_id order by id desc limit 1;
$$;
revoke all on function public.trade_lab_scenario_dataset(text) from public,anon,authenticated;
grant execute on function public.trade_lab_scenario_dataset(text) to service_role;
revoke all on function public.trade_lab_scenario_save(text,jsonb,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.trade_lab_scenario_read(text) from public,anon,authenticated;
revoke all on function public.trade_lab_scenario_models() from public,anon,authenticated;
grant execute on function public.trade_lab_scenario_save(text,jsonb,jsonb,jsonb) to service_role;
grant execute on function public.trade_lab_scenario_read(text) to service_role;
grant execute on function public.trade_lab_scenario_models() to service_role;
commit;
