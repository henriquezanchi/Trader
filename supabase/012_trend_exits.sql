begin;
create or replace function public.trade_lab_scenario_save(asset_id text,study_report jsonb,study_models jsonb,study_observations jsonb) returns bigint language plpgsql security definer set search_path='' as $$
declare result bigint;
begin
 if study_report->>'asset' is distinct from asset_id or coalesce(study_report#>>'{protocol,id}','') not in ('scenario-comparison-v1','scenario-comparison-v2','execution-horizons-v1','execution-walk-forward-v1','trend-exit-comparison-v1') or jsonb_array_length(study_observations)<120 or study_report->>'datasetHash' is null then raise exception 'Estudo inválido'; end if;
 insert into trade_lab.scenario_studies(asset,protocol,dataset_hash,report,models,observations)
 values(asset_id,study_report#>>'{protocol,id}',study_report->>'datasetHash',study_report,study_models,study_observations)
 on conflict(asset,protocol,dataset_hash) do nothing;
 select id into result from trade_lab.scenario_studies where asset=asset_id and protocol=study_report#>>'{protocol,id}' and dataset_hash=study_report->>'datasetHash';
 return result;
end $$;
commit;
