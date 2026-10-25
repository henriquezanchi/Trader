-- Index only: no financial state, permissions or audit records are changed.
-- Avoid scanning/decompressing unrelated research JSON to find the latest dataset.
begin;
set local lock_timeout = '5s';
create index if not exists research_training_asset_id_idx
 on trade_lab.research_cycles ((data #>> '{historyTraining,report,asset}'), id desc)
 where (data #>> '{historyTraining,report,asset}') is not null;
commit;
