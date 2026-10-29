-- Private, prospective observation only. Does not update trade_lab.state.
begin;
create table trade_lab.tip_campaign (
 id integer primary key check(id=1),started_at timestamptz not null default now(),
 selection_ends timestamptz not null default now()+interval '14 days',
 capture_ends timestamptz not null default now()+interval '28 days',collection jsonb,evaluated_at timestamptz
);
insert into trade_lab.tip_campaign(id) values(1);
create table trade_lab.tip_candidates(id text primary key,first_seen_at timestamptz not null default now(),snapshot jsonb not null,review jsonb);
create table trade_lab.tip_recommendations(
 id text primary key,registered_at timestamptz not null default now(),phase text not null check(phase in ('selection','confirmation')),
 snapshot jsonb not null,version integer not null default 0,evaluation jsonb not null default '{"status":"awaiting-entry"}'
);
alter table trade_lab.tip_campaign enable row level security;
alter table trade_lab.tip_candidates enable row level security;
alter table trade_lab.tip_recommendations enable row level security;
revoke all on trade_lab.tip_campaign,trade_lab.tip_candidates,trade_lab.tip_recommendations from public,anon,authenticated,service_role;
create function public.trade_lab_tips_read(candidate_offset integer default 0) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('campaign',(select jsonb_build_object('startedAt',started_at,'selection_ends',selection_ends,'capture_ends',capture_ends,'evaluatedAt',evaluated_at) from trade_lab.tip_campaign where id=1),
 'collection',(select collection from trade_lab.tip_campaign where id=1),
 'recommendations',coalesce((select jsonb_agg(to_jsonb(r) order by registered_at desc) from trade_lab.tip_recommendations r),'[]'::jsonb),
 'candidates',coalesce((select jsonb_agg(to_jsonb(c) order by first_seen_at desc) from (select * from trade_lab.tip_candidates order by first_seen_at desc limit 100 offset greatest(0,least(candidate_offset,100000)))c),'[]'::jsonb),
 'candidateOffset',candidate_offset,'nextCandidateOffset',case when (select count(*) from trade_lab.tip_candidates)>candidate_offset+100 then candidate_offset+100 else null end,
 'candidateCount',(select count(*) from trade_lab.tip_candidates));
$$;
create function public.trade_lab_tips_register(tip_id text,tip_snapshot jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c trade_lab.tip_campaign;r trade_lab.tip_recommendations;
begin
 select * into c from trade_lab.tip_campaign where id=1 for update;
 select * into r from trade_lab.tip_recommendations where id=tip_id;if found then return to_jsonb(r);end if;
 if clock_timestamp()>=c.capture_ends then raise exception 'Período de registro encerrado; resultados continuam preservados';end if;
 if (select count(*) from trade_lab.tip_recommendations)>=500 then raise exception 'Limite de 500 dicas desta avaliação atingido';end if;
 if length(tip_id)<>64 or tip_snapshot->>'protocol'<>'public-tips-prospective-v1' or jsonb_typeof(tip_snapshot)<>'object' or octet_length(tip_snapshot::text)>12000 or (tip_snapshot->>'publishedAt')::timestamptz>clock_timestamp() or (tip_snapshot->>'publishedAt')::timestamptz<clock_timestamp()-interval '24 hours' then raise exception 'Dica inválida';end if;
 insert into trade_lab.tip_recommendations(id,phase,snapshot) values(tip_id,case when clock_timestamp()<c.selection_ends then 'selection' else 'confirmation' end,tip_snapshot) returning * into r;
 return to_jsonb(r);
end $$;
create function public.trade_lab_tips_collect(collection_data jsonb) returns void language plpgsql security definer set search_path='' as $$
declare item jsonb;
begin
 if octet_length(collection_data::text)>250000 then raise exception 'Coleta excessiva';end if;
 if now()>=(select capture_ends from trade_lab.tip_campaign where id=1) then return;end if;
 for item in select value from jsonb_array_elements(collection_data->'items') loop
  insert into trade_lab.tip_candidates(id,snapshot) values(item->>'id',item) on conflict(id) do nothing;
 end loop;
 update trade_lab.tip_campaign set collection=collection_data-'items' where id=1;
end $$;
create function public.trade_lab_tips_review(candidate_id text,review_data jsonb) returns void language plpgsql security definer set search_path='' as $$
begin
 if review_data->>'status' not in ('rejected','registered') or length(review_data->>'reason')<5 or octet_length(review_data::text)>2000 then raise exception 'Revisão inválida';end if;
 update trade_lab.tip_candidates set review=review_data||jsonb_build_object('at',clock_timestamp()) where id=candidate_id and review is null;
end $$;
create function public.trade_lab_tips_advance(patches jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare p jsonb;r trade_lab.tip_recommendations;e jsonb;from_status text;to_status text;n integer:=0;entry_price_at timestamptz;exit_price_at timestamptz;entry_equity numeric;exit_equity numeric;
begin
 if jsonb_array_length(patches)>500 or octet_length(patches::text)>2000000 then raise exception 'Avaliação excessiva';end if;
 for p in select value from jsonb_array_elements(patches) loop
  select * into r from trade_lab.tip_recommendations where id=p->>'id' for update;
  if not found or r.version<>(p->>'version')::integer then continue;end if;
  e:=p->'evaluation';from_status:=r.evaluation->>'status';to_status:=e->>'status';
  if from_status='awaiting-entry' and to_status='tracking' then
   entry_price_at:=(e#>>'{entry,observedAt}')::timestamptz;
   if entry_price_at<r.registered_at or entry_price_at>clock_timestamp() or entry_price_at<clock_timestamp()-interval '2 minutes' or clock_timestamp()>r.registered_at+interval '30 minutes' or (e->>'targetAt')::timestamptz is distinct from entry_price_at+(r.snapshot->>'horizonMinutes')::integer*interval '1 minute' then raise exception 'Entrada retroativa ou prazo inválido';end if;
  elsif from_status='awaiting-entry' and to_status='missing-entry' then
   if clock_timestamp()<=r.registered_at+interval '30 minutes' then raise exception 'Entrada ainda pode ser observada';end if;
  elsif from_status='tracking' and to_status in ('scored','missing-exit') then
   if e->'entry' is distinct from r.evaluation->'entry' or e->'targetAt' is distinct from r.evaluation->'targetAt' then raise exception 'Hipótese de entrada imutável';end if;
   if to_status='missing-exit' then
    if clock_timestamp()<=(r.evaluation->>'targetAt')::timestamptz+interval '10 minutes' then raise exception 'Saída ainda pode ser observada';end if;
   else
    exit_price_at:=(e#>>'{exit,observedAt}')::timestamptz;entry_price_at:=(e#>>'{entry,observedAt}')::timestamptz;
    if exit_price_at<(e->>'targetAt')::timestamptz or exit_price_at>clock_timestamp() or exit_price_at<clock_timestamp()-interval '2 minutes' or clock_timestamp()>(e->>'targetAt')::timestamptz+interval '10 minutes' then raise exception 'Saída fora do prazo';end if;
    select equity into entry_equity from trade_lab.equity_points where observed_at<=entry_price_at and observed_at>=entry_price_at-interval '5 minutes' order by observed_at desc limit 1;
    select equity into exit_equity from trade_lab.equity_points where observed_at<=exit_price_at and observed_at>=exit_price_at-interval '5 minutes' order by observed_at desc limit 1;
    -- No contribution is inferred as a trading gain. Null if the window crosses an aporte.
    if entry_equity>0 and exit_equity is not null and not exists(select 1 from trade_lab.state where (payload#>>'{capitalUpgrade,at}')::timestamptz>=entry_price_at and (payload#>>'{capitalUpgrade,at}')::timestamptz<=exit_price_at) then
     e:=e||jsonb_build_object('botPct',(exit_equity/entry_equity-1)*100,'botNote','Patrimônio indicativo do bot no mesmo intervalo, marcas até 5 min anteriores; pode conter cotações antigas');
    end if;
   end if;
  else continue;
  end if;
  update trade_lab.tip_recommendations set evaluation=e,version=version+1 where id=r.id;n:=n+1;
 end loop;update trade_lab.tip_campaign set evaluated_at=clock_timestamp() where id=1;return n;
end $$;
revoke all on function public.trade_lab_tips_read(integer),public.trade_lab_tips_register(text,jsonb),public.trade_lab_tips_collect(jsonb),public.trade_lab_tips_review(text,jsonb),public.trade_lab_tips_advance(jsonb) from public,anon,authenticated;
grant execute on function public.trade_lab_tips_read(integer),public.trade_lab_tips_register(text,jsonb),public.trade_lab_tips_collect(jsonb),public.trade_lab_tips_review(text,jsonb),public.trade_lab_tips_advance(jsonb) to service_role;
commit;
