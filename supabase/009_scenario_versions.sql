-- Preserve all previous studies; version comparisons never overwrite old snapshots.
begin;
create or replace function public.trade_lab_scenario_save(asset_id text,study_report jsonb,study_models jsonb,study_observations jsonb) returns bigint language plpgsql security definer set search_path='' as $$
declare result bigint;
begin
 if study_report->>'asset' is distinct from asset_id or coalesce(study_report#>>'{protocol,id}','') not in ('scenario-comparison-v1','scenario-comparison-v2') or jsonb_array_length(study_observations)<120 or study_report->>'datasetHash' is null then raise exception 'Estudo inválido'; end if;
 insert into trade_lab.scenario_studies(asset,protocol,dataset_hash,report,models,observations)
 values(asset_id,study_report#>>'{protocol,id}',study_report->>'datasetHash',study_report,study_models,study_observations)
 on conflict(asset,protocol,dataset_hash) do nothing;
 select id into result from trade_lab.scenario_studies where asset=asset_id and protocol=study_report#>>'{protocol,id}' and dataset_hash=study_report->>'datasetHash';
 return result;
end $$;
create function public.trade_lab_scenario_version(asset_id text,study_version text) returns jsonb language sql security definer set search_path='' as $$
 with latest as (select distinct on(asset) id,asset,recorded_at,report from trade_lab.scenario_studies where (asset_id is null or asset=asset_id) and (study_version is null or protocol=study_version) order by asset,id desc)
 select jsonb_build_object('studies',coalesce(jsonb_agg(jsonb_build_object('id',id,'asset',asset,'recordedAt',recorded_at,'report',case when asset_id is null then report->'summary' else report end) order by asset),'[]'::jsonb)) from latest;
$$;
revoke all on function public.trade_lab_scenario_version(text,text) from public,anon,authenticated;
grant execute on function public.trade_lab_scenario_version(text,text) to service_role;
create or replace function public.trade_lab_scenario_read(asset_id text default null) returns jsonb language sql security definer set search_path='' as $$
 select public.trade_lab_scenario_version(asset_id,null);
$$;
create or replace function public.trade_lab_scenario_models() returns jsonb language sql security definer set search_path='' as $$
 with latest as (select distinct on(asset) id,asset,protocol,recorded_at as "recordedAt",models from trade_lab.scenario_studies order by asset,id desc)
 select coalesce(jsonb_agg(to_jsonb(latest) order by asset),'[]'::jsonb) from latest;
$$;
commit;
