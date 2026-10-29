import {requireUser,sameOrigin} from '../lib/auth.mjs';
import {readBody} from '../lib/http.mjs';
import {repository,getQuotes} from '../lib/services.mjs';
import {validateTip,observatoryReport,updateObservatory,collectTipCandidates,OBS_PROTOCOL} from '../lib/observatory.mjs';
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Cookie');
 try{await requireUser(req);}catch(error){return res.status(error.status??503).json({error:error.status?error.message:'Serviço de acesso indisponível'});}
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Método não permitido'});
 if(req.method==='POST'&&!sameOrigin(req))return res.status(403).json({error:'Origem inválida'});
 try{
  const repo=repository();
  if(req.method==='POST'){
   const body=await readBody(req);
   if(body.action==='register'){
    const tip=validateTip(body.tip);await repo.observatoryRegister(tip);
    if(body.candidateId)await repo.observatoryReview(body.candidateId,{status:'registered',reason:'Dica estruturada pelo usuário',tipId:tip.id});
   }else if(body.action==='review'){
    if(typeof body.id!=='string'||!body.reason||body.reason.length>1000)throw Error('Informe o motivo da rejeição');
    await repo.observatoryReview(body.id,{status:'rejected',reason:body.reason});
   }else if(body.action==='collect')await repo.observatoryCollect(await collectTipCandidates());
   else if(body.action!=='evaluate')return res.status(400).json({error:'Ação desconhecida'});
   if(['register','evaluate'].includes(body.action)){
    // A quote failure leaves the recorded tip pending; never undo its registration.
    try{const book=await repo.observatoryRead(),ids=[...new Set(book.recommendations.filter(r=>['awaiting-entry','tracking'].includes(r.evaluation.status)).map(r=>r.snapshot.asset))].filter(id=>OBS_PROTOCOL.assets.includes(id));
     const quotes=ids.length?await getQuotes(ids):{};await updateObservatory(repo,quotes,Date.now(),{collect:false});
    }catch{/* UI displays pending status; scheduler retries without a fabricated fill. */}
   }
  }
  const offset=new URL(req.url,'https://local.invalid').searchParams.get('offset')??'0';if(!/^[0-9]{1,6}$/.test(offset))throw Error('Página inválida');
  return res.status(200).json(observatoryReport(await repo.observatoryRead(Number(offset))));
 }catch(error){return res.status(error.message?.includes('Falha no banco')?503:400).json({error:error.message?.includes('Falha no banco')?'Observatório temporariamente indisponível':error.message});}
}
