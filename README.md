# Trade Lab

Laboratório de negociação **exclusivamente simulado**, com preços indicativos BTC/BRL, ETH/BRL e SOL/BRL via CoinGecko. Não executa ordens reais, não usa alavancagem e não integra um modelo de IA.

## Carteira e perfis

Após entrar com e-mail e senha, pause o motor e abra **Perfil, ativos e limites**. Escolha um preset, ajuste os pesos e salve. Peso zero exclui um ativo sem posição aberta. Iniciar/retomar habilita a estratégia; o agendador externo precisa estar configurado para executar com a aba fechada. O painel consulta o estado, não substitui o agendador.

| Preset | BTC | ETH | SOL | Caixa mínimo planejado | Entrada por ativo | Perda diária | Perda total | Meta / prazo |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Conservador relativo a cripto | 6% | 4% | 0% | 90% | 5% | 0,5% | 2% | 2% / 90 dias |
| Moderado relativo a cripto | 15% | 8% | 2% | 75% | 10% | 1% | 5% | 5% / 90 dias |
| Arrojado / agressivo | 25% | 15% | 10% | 50% | 20% | 2% | 10% | 10% / 90 dias |

Os percentuais usam o **capital virtual inicial**, não aumentam o aporte com ganhos. A entrada efetiva respeita o menor entre saldo, teto por entrada, peso do ativo e exposição agregada disponível. Os pesos são tetos de compra, não ordens de alocação imediata nem rebalanceamento; a valorização pode elevar a exposição depois da entrada. O caixa não rende.

Estes perfis ilustrativos não são suitability bancário nem recomendações pessoais. Todas as criptomoedas têm alto risco e podem cair juntas. Os textos de potencial descrevem incerteza qualitativa; não são previsões ou promessas de rentabilidade. Não há suporte a ações, fundos ou renda fixa nesta versão.

## Motor e controles

- Médias de 6 e 24 observações **horárias consecutivas**, com margem de 0,2%, por ativo. Uma lacuna acima de 90 minutos exige nova janela contínua.
- Até uma posição por ativo. Um ativo recém-adicionado começa seu próprio aquecimento.
- Avaliações horárias podem manter posições entre dias; isso não garante day trade nem operações diárias.
- Cada negócio simula taxa de 0,1% e deslizamento desfavorável de 0,1%.
- Uma cotação ausente, inválida ou com mais de dez minutos bloqueia todo o ciclo, sem gravar saldo ou histórico parcial.
- Perdas diária e total são avaliadas sobre o patrimônio agregado. A referência diária é a última avaliação antes do primeiro ciclo do novo dia em America/Sao_Paulo; o valor do limite usa o capital inicial.
- Ao atingir perda, meta ou prazo, o motor liquida as posições virtuais e pausa. O prazo conta do primeiro início da carteira, incluindo pausas. Alterar parâmetros não reinicia essa data nem repõe perdas.
- Pausa manual impede operações de estratégia, mas mantém posições; ciclos ainda avaliam os limites e podem liquidá-las. Falhas de preço impedem essa avaliação. Gaps e custos podem ultrapassar os limites.
- Ativos com posição aberta não podem ser removidos da carteira até a saída pelo motor. Reduzir um peso impede novas entradas acima do teto, sem liquidar posições existentes imediatamente.
- Mantém até 72 preços por ativo e 200 decisões. O diário resumido mantém as últimas 200 decisões; o relatório privado persistente no banco preserva os registros novos sem esse corte. Não é backtest.

## Desenvolvimento

Node >=22.8 (CI e Vercel: 22.x), npm. Não requer Docker.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
# Configure variáveis privadas, sem enviar .env para o Git.
node --env-file=.env scripts/dev.mjs
```

No ambiente cloud, use um cache npm gravável: `npm ci --cache /workspace/.npm-cache --ignore-scripts --no-audit --no-fund`. Para chamadas remotas no Node 24 deste ambiente, `node --use-env-proxy` respeita o proxy configurado; preserve o trust TLS. O servidor local escuta a porta 3000. Os testes usam PostgreSQL em WASM (PGlite) e preços sintéticos, sem acessar produção.

## Hospedagem

Vercel: preset Other, Node 22.x, saída `public`, sem build, funções em `api/`. Variáveis apenas no servidor: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_ANON_KEY` do projeto escolhido, `APP_ORIGIN` (origem HTTPS do painel), `TRADE_LAB_USER_IDS` e `TRADE_LAB_EMAILS` (listas privadas de contas autorizadas), `BOT_TOKEN` de pelo menos 32 caracteres e chave `COINGECKO_DEMO_API_KEY` opcional. Não use prefixos públicos.

Em uma instalação nova, aplique `supabase/001_trade_lab.sql` **uma única vez**, somente no projeto autorizado. A carteira usa o mesmo payload privado, preservando saldo, posições e histórico. O relatório persistente exige aplicar uma única vez a nova `supabase/002_audit.sql`, que cria apenas a tabela de auditoria, um trigger no estado do Trade Lab e a RPC de leitura privada; não altera tabelas de outros aplicativos nem reaplica 001. Para estado legado sem `initialCapital`, configure `INITIAL_BALANCE_BRL` privadamente com o capital original. Não invente o valor nem reexecute a migração para redefini-lo. O motor BTC original continua funcionando até o usuário salvar uma carteira enquanto pausado.

O agendador de produção é o cron do Supabase, no minuto 17 de cada hora UTC, com URL e chave de assinatura no Vault e função restrita no schema privado. O servidor usa a mesma `SCHEDULER_SIGNING_KEY`; o cron envia uma assinatura HMAC limitada a 90 segundos e à mesma hora, sem colocar a chave de longa duração na fila HTTP. O projeto precisa de pg_cron, pg_net e supabase_vault; configurar esse serviço é uma etapa administrativa separada, não parte das migrações portáveis. Confirme cron.job_run_details e o resultado HTTP de um disparo automático antes de afirmar operação automática. O workflow GitHub `simulation.yml` permanece como disparo manual de emergência com `BOT_URL` e `BOT_TOKEN`, sem acesso ao banco. Não habilite dois agendamentos concorrentes; compare-and-swap e a proteção por hora evitam ordens duplicadas, mas não garantem pontualidade.

## Segurança

HTML público; dados e controles exigem uma conta explicitamente autorizada no Supabase Auth. O servidor valida a sessão e o ID/e-mail confirmado a cada pedido: contas de outros aplicativos do mesmo projeto não recebem acesso. Não há cadastro público de contas do Trade Lab. Tokens da sessão ficam em cookies HttpOnly, Secure e SameSite=Strict em produção, sem localStorage; a renovação é feita no servidor. Mutações do navegador exigem a origem configurada, sem confiar em Host recebido do cliente.

O `BOT_TOKEN` serve exclusivamente para o agendador executar `POST /api/agent?action=tick`; não dá acesso ao painel, saldo ou configurações. Ele continua privado no servidor e GitHub Actions. Todas as mutações do estado usam compare-and-swap por versão; configurar também exige a versão exibida ao usuário e pausa.

Contas existentes usam a senha atual do Supabase. Para uma conta nova ou senha esquecida, use **Definir ou recuperar senha** com um e-mail autorizado. Como a identidade é compartilhada no projeto, a troca de senha também afeta outros aplicativos que usam essa mesma conta; o instalador não altera senhas existentes. O Supabase envia o link pelo SMTP do projeto. O retorno precisa constar na lista de URLs permitidas do Auth (`APP_ORIGIN/` e `APP_ORIGIN/?recovery=1`). Adicione URLs preservando as de outros aplicativos; não altere o Site URL, SMTP, templates, cadastros ou senhas de outras contas. O link permite definir uma senha de pelo menos 12 caracteres. A recuperação não envia mensagens a e-mails fora da lista privada. O servidor exige autenticação válida antes de aceitar nova senha e limpa a sessão ao concluir.

O painel exibe resumo das últimas 24 horas e o tamanho da sequência horária atual por ativo. Observações antigas mantidas no histórico não contam como aquecimento contínuo. Sem posições, o caixa virtual não rende.

RLS e RPCs limitadas a service_role oferecem isolamento lógico no Supabase compartilhado, sem isolamento físico de recursos, cotas ou administradores. Nunca publique chaves, exportações do banco, orçamento ou resultados pessoais.

## Iniciar sem esperar um dia e inspecionar decisões

O botão **Preparar histórico e avaliar agora** obtém 23 amostras horárias reais de cada ativo na CoinGecko e uma cotação atual. Ele não inventa preços, não altera o capital e não executa operações retroativas. Exige carteira configurada/habilitada, nenhuma posição aberta, nenhuma preparação anterior e uma hora ainda não processada. Dados futuros, lacunas ou cotações atuais antigas impedem a gravação inteira. Mesmo com histórico completo, o resultado pode ser AGUARDAR por ausência de sinal. As amostras ao vivo anteriores são preservadas no contexto da preparação para inspeção; a janela de indicadores passa a usar o histórico validado.

O **Relatório privado de decisões** guarda, na mesma transação que altera o estado, a versão, configuração, decisões novas, médias, preço/timestamp/fonte, custos, risco e estado antes/depois. Pode ser paginado; anon/authenticated não acessam a tabela ou RPC diretamente. O backend valida a conta antes de servir o relatório. Um snapshot do diário legado é preservado e explicitamente marcado: parâmetros não registrados no passado não são reconstruídos. Não há mecanismo de IA ou alteração automática de estratégia nesta versão.

### Participar de uma operação simulada

No painel autenticado, **Modo assistido** consulta cotações indicativas e sugere entradas ou saídas. A atualização por minuto é opcional e só ocorre com a aba visível. Também é possível escolher um ativo da carteira e solicitar uma prévia manual. A prévia mostra taxas, deslizamento, saldo resultante e cenários de variação de preço; não promete lucro. Apenas **Confirmar** executa a operação simulada. Propostas expiram em 60 segundos e são invalidadas por alteração de versão da carteira ou movimento de preço superior a 0,2%. Compras respeitam os limites existentes; vendas permitem reduzir posições durante a pausa. Nenhuma ordem é enviada a corretoras.

### Pesquisa e aprendizado incremental

A migração adicional `supabase/003_research.sql` cria o histórico privado de pesquisa, sem recriar estado ou auditoria anteriores. Aplicar uma vez após as migrações existentes. Somente o servidor possui acesso ao RPC de leitura; o painel exige sessão autorizada.

A cada ciclo horário são registrados indicadores técnicos, volume disponível e manchetes RSS com fonte, data de publicação e primeira observação. O tom das manchetes usa um vocabulário fixo, identificado como `headline-lexicon-v1`; não é análise de texto por Claude. Falhas nas fontes ficam explícitas. A chave Anthropic não é utilizada por este módulo.

Modelos logísticos incrementais estimam retornos positivos após custos em horizontes de 1, 6 e 24 horas. Cada previsão é registrada antes do resultado; a avaliação usa a probabilidade original e só depois atualiza o modelo. Sem preço próximo ao horizonte, registra resultado ausente. As primeiras previsões partem de 50%, sem evidência aprendida.

Três estratégias são comparadas em carteiras paralelas normalizadas de 1000 unidades, com os mesmos limites percentuais e custos: médias móveis, confirmação por RSI e modelo aprendido. Não são saldos do usuário. Mudanças de configuração abrem nova comparação. Nenhuma estratégia substitui automaticamente a ativa. O modelo aprendido exige 100 resultados de treinamento; uma indicação para revisão exige ao menos 14 dias, 200 resultados de 6h, 10 negociações e comparação de retorno e drawdown. Esses critérios são mínimos experimentais, sem garantia de desempenho.
