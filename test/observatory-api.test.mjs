import test from 'node:test';import assert from 'node:assert/strict';import handler from '../api/observatory.mjs';
test('API do observatório exige sessão e origem; registro sobrevive à falha de preço e não lê/escreve carteira',async()=>{
 const savedEnv={...process.env},savedFetch=globalThis.fetch,origin='https://trader-zanchi.vercel.app';
 Object.assign(process.env,{APP_ORIGIN:origin,SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',TRADE_LAB_USER_IDS:'owner',TRADE_LAB_EMAILS:'owner@example.test'});
 const campaign={selection_ends:new Date(Date.now()+86400000).toISOString(),capture_ends:new Date(Date.now()+2*86400000).toISOString()},records=[],calls=[];
 globalThis.fetch=async(url,options)=>{
  calls.push(url);
  if(url.endsWith('/auth/v1/user'))return {ok:true,json:async()=>({id:'owner',email:'owner@example.test',email_confirmed_at:'2026-01-01',is_anonymous:false})};
  if(url.includes('trade_lab_tips_register')){const p=JSON.parse(options.body);const r={id:p.tip_id,snapshot:p.tip_snapshot,registered_at:new Date().toISOString(),phase:'selection',version:0,evaluation:{status:'awaiting-entry'}};records.push(r);return {ok:true,json:async()=>r};}
  if(url.includes('trade_lab_tips_read'))return {ok:true,json:async()=>({campaign,recommendations:records,candidates:[]})};
  if(url.includes('api.coingecko.com'))throw Error('offline');
  assert.fail('Unexpected provider operation '+url);
 };
 const run=async(method='GET',body={},headers={})=>{const res={setHeader(){},status(c){this.code=c;return this;},json(d){this.data=d;}};await handler({url:'/api/observatory',method,headers:{origin,cookie:'__Host-trade_lab_access=synthetic',...headers},body},res);return res;};
 try{
  assert.equal((await run('GET',{}, {cookie:''})).code,401);assert.equal(calls.length,0);
  assert.equal((await run('POST',{}, {origin:'https://evil.test'})).code,403);
  const response=await run('POST',{action:'register',tip:{sourceId:'coindesk',author:'Analista público',url:'https://www.coindesk.com/example',publishedAt:new Date(Date.now()-60000).toISOString(),excerpt:'Comprar Bitcoin conforme análise publicada para as próximas horas.',rationale:'Avaliar em seis horas, sem reproduzir stops do autor.',asset:'bitcoin',direction:'COMPRAR',horizonMinutes:360,horizonBasis:'standardized',reviewed:true}});
  assert.equal(response.code,200);assert.equal(response.data.recommendations.length,1);assert.equal(response.data.recommendations[0].evaluation.status,'awaiting-entry');
  assert.ok(!calls.some(u=>u.includes('trade_lab_commit')||u.includes('trade_lab_read')));
 }finally{globalThis.fetch=savedFetch;for(const k of Object.keys(process.env))if(!Object.hasOwn(savedEnv,k))delete process.env[k];Object.assign(process.env,savedEnv);}
});
