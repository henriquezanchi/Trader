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

### Carteira ampliada, ETFs e referência de CDI

`capital-upgrade` adiciona a diferença entre o capital contribuído e R$ 1.000 ao caixa virtual, uma única vez. Preserva posições, prejuízos, parâmetros e auditoria. O evento `APORTE` não é lucro; o gráfico passa a mostrar o período desde o aporte e mantém os registros anteriores no diário. O agendador existente continua responsável pelos ciclos.

BOVA11 e IVVB11 usam preços indicativos em BRL e histórico diário do Yahoo Finance. A estratégia de ETFs compara 6 e 24 pregões **já concluídos**, sem usar o candle em formação e sem executar operações retroativas. Ordens só são simuladas em cotas inteiras, com cotação do mesmo pregão de no máximo 20 minutos, na janela conservadora 10h05–16h45 de Brasília, excluindo fins de semana e feriados cadastrados de 2026–2027. Fora do calendário suportado não há execução. Falta de dados de ETF produz `AGUARDAR`, sem fabricar preço. Leilões, suspensões intradiárias, livro de ofertas, liquidez e execução real não são reproduzidos.

Hipóteses dos ETFs: emolumentos de 0,03%, deslizamento de 0,05%, corretagem zero; substituir por custos efetivos antes de integrar corretora. Vendas reservam conservadoramente 15% do lucro positivo (20% quando a aquisição registrada é do mesmo dia), sem compensar prejuízos. É uma estimativa por operação, não apuração fiscal mensal; compras em vários dias exigirão controle fiscal de lotes para uso real. Crédito de vendas só fica disponível no segundo dia de pregão seguinte. Valores em liquidação integram o patrimônio, mas não o saldo para compras.

O CDI é **benchmark bruto**, não uma aplicação de renda fixa: usa taxas diárias efetivamente publicadas na série SGS 12 do Banco Central. Começa após o aporte, não projeta taxas futuras e sinaliza dados incompletos. O caixa da carteira não recebe esse rendimento. O painel mostra resultado após custos simulados, tempo de observação e maior queda; uma amostra curta não autoriza concluir que a estratégia seja lucrativa. Impostos sobre cripto e custos da futura plataforma não estão integralmente modelados.

### Escolha de estratégia cripto

Os limites do perfil e a estratégia são parâmetros diferentes. `trend` preserva a regra original 6h/24h. `rsi-recovery` exige RSI anterior abaixo de 30, cruzamento para pelo menos 30 e reação positiva do preço; sai com RSI acima de 70 ou abaixo de 25, além dos limites globais. `dca-weekly` compra somente BTC, até 1% do capital contribuído a cada sete dias, limitado ao peso configurado, teto de 5% em BTC, saldo e exposição. DCA não exige janela técnica nem promete ganhos de curto prazo. As duas alternativas também têm carteiras paralelas de pesquisa, sem promoção automática com base em poucas operações.

RSI baixo isolado não significa compra; Fear & Greed e Mayer Multiple ainda não influenciam decisões. Nenhuma fonte de sentimento ou média de 200 dias é inventada quando falta histórico verificável. O laboratório de inteligência é recolhível e começa fechado.

### Modo híbrido e ciclo curto

`cryptoStrategy: hybrid` separa posições de cenário (livro `portfolio`) de posições curtas (livro `fast.positions`), compartilhando o mesmo caixa e limites globais. O blend dentro de cada peso de cripto é 80/20 no perfil de menor exposição, 50/50 no moderado e 30/70 no arrojado. Não multiplica o capital: o patrimônio, limites por ativo e exposição agregam os dois livros e valores em liquidação.

O agendador Supabase consulta a cada **2 minutos**, mesmo com o navegador fechado. Cenário e pesquisa continuam horários; ETFs usam dados diários concluídos. O livro curto precisa de três cotações com horários distintos, cobrindo 2–10 minutos, e estabilização: último preço não inferior ao anterior nem mais de 0,02% abaixo do primeiro, sem salto acima de 1,5% nem tendência macro abaixo de -3%. Não compra com cotação com mais de dois minutos.

Parâmetros experimentais menor/moderado/arrojado: entrada por ativo de até 1%/4%/8% do capital; alvo de ganho **líquido dos custos de ida e volta** de 0,6%/0,5%/0,5%; perda por posição de referência de 0,8%/1%/1,2%; intervalo de 15/8/4 minutos após saída; permanência máxima de 240/240/180 minutos. Os limites globais e pesos podem reduzir a entrada. Custos sozinhos reduzem patrimônio e contam nas perdas. Gaps e atrasos podem superar os stops. Não é alta frequência e não promete um ganho em cada operação.

Cada decisão curta, inclusive `AGUARDAR`, registra cotações usadas, contexto macro, critérios de entrada, parâmetros, custos, patrimônio e posições antes/depois. Saídas registram resultado realizado. Falhas na consulta de preços também registram `AGUARDAR` de proteção sem modificar dinheiro ou posições, no máximo uma vez por janela de dois minutos. Auditoria permanece privada e persistente; o diário mostra as últimas 200 decisões. A API usa o mesmo compare-and-swap para evitar confirmação, pausa e ciclos concorrentes sobrescreverem uns aos outros.

### Universo de ativos e diário

O catálogo inclui 16 ativos: BTC, ETH, SOL, BNB, XRP, ADA, LINK, AVAX, DOT, LTC e os ETFs BOVA11, IVVB11, SMAL11, DIVO11, GOLD11 e XFIX11. Os dez criptoativos são consultados em um único lote; ampliar o universo não cria capital adicional. Os limites por ativo e globais agregam todos os livros. Os ETFs continuam sujeitos à janela da B3, cotas inteiras e disponibilidade de fonte; estar no catálogo não garante sinal ou execução. Os perfis permitem escolher pesos zero para excluir ativos sem posição aberta.

O diário começa recolhido, com resumo do último ciclo e motivo da decisão mais recente. Ao expandir, mostra as últimas 200 decisões com motivo e identificação de ciclo curto, cenário, assistido ou proteção de dados. O relatório privado conserva o histórico completo, incluindo parâmetros e indicadores.

### Modo ativo, descoberta integrada e memória

`active` mantém o mesmo caixa BRL, exposição global e diário. Entradas em ativos estabelecidos exigem preço recente, volume de 24h de pelo menos R$ 1 milhão e ausência de bloqueio de cenário; não precisam aguardar três novas observações locais. Entradas são exploratórias quando a evidência ainda é limitada. Modelos direcionais com suporte no teste histórico podem bloquear entradas de maior risco ou antecipar saídas, sem afastar stops, instruções do usuário ou limites globais. Novas posições usam inicialmente alvo líquido de pelo menos duas vezes a perda de referência. Planos já associados a posições anteriores são preservados.

A descoberta consulta novos **pools** Solana via GeckoTerminal, não afirma que sejam tokens recém-lançados. Considera idade de até 60 minutos, liquidez de pelo menos US$ 1.000, volume recente e compras/vendas observadas. O limite `discoveryPct` (0–20% do capital, padrão arrojado 15%) é um teto de risco dentro do mesmo caixa, não capital extra. Cada entrada fica limitada a 2% do capital e ao restante dos limites compartilhados. O câmbio é indicativo, implícito na razão USDC/BRL e USDC/USD da CoinGecko. Custos hipotéticos de pools: 0,3% de swap, 1% de deslizamento, imposto de transferência assumido de 1% por lado, R$ 0,15 de rede e impacto aproximado pela reserva. Segurança, restrições de venda, taxas reais de token, roteamento e MEV não são verificados. Uma execução simulada não demonstra que seria possível vender na rede. A fonte informa coleta, mas não o horário exato da última negociação; isso permanece explícito no log. Falha na descoberta não impede avaliar os ativos estabelecidos.

Cada compra registra hipótese, contexto e resultado ainda desconhecido. Vendas com entrada identificada geram síntese líquida, duração e retorno normalizado ao risco. Ativo e família de cenários semelhantes são atualizados sem contar a mesma amostra duas vezes; perdas recorrentes reduzem a próxima entrada, e evidência própria positiva pode restaurar o teto normal, nunca ultrapassá-lo. Entradas múltiplas podem ser atribuídas proporcionalmente aos respectivos custos e quantidades. Saídas sem contexto original são registradas sem inventar uma hipótese retroativa. Operações correlacionadas não são provas independentes de vantagem.

### Previsões e histórico público

O índice em destaque mede direção do preço, diferente de rentabilidade após custos. O histórico horário público de até um mês por cripto é importado da CoinGecko, com Yahoo Finance como alternativa. Observações horárias usam seus horários reais; o pareamento histórico tolera até 15 minutos, sem interpolar preços. Só são usados candles concluídos, na moeda BRL e do ativo esperado. Treino ocupa os primeiros 70% do período; teste usa os 30% finais, excluindo alvos de treino que cruzam o corte. O relatório é calculado antes de reajustar o modelo com o passado completo para produção. Acurácia, acurácia balanceada, Brier e referência majoritária ficam no registro histórico. O modelo direcional histórico usa indicadores técnicos; não inventa notícias do passado. Não se afirma que o teste seja garantia de lucro ou que cubra vários anos.

As previsões ao vivo ficam gravadas antes do resultado, com preço, fonte, probabilidade, versão e horizonte de 1/6/24h. São avaliadas com a probabilidade original, antes de atualizar o modelo. Preços estáveis são excluídos do denominador; sem cotação próxima ao horizonte, registra avaliação ausente. A tolerância é de cinco minutos. Publicações de 1h podem ocorrer a cada 15 minutos; 6h/24h são horárias. Previsões sobrepostas não são amostras independentes. O painel separa teste histórico e acerto confirmado ao vivo, sem preencher acertos antecipadamente.

### Venda de posições curtas e navegação

`Vender agora` abre uma prévia assinada vinculada à posição, usuário e versão, válida por 60s; somente a confirmação executa a venda virtual. Vendas podem ser programadas por ganho líquido, preço igual ou superior ao alvo ou data/hora de Brasília. A primeira cotação válida após a condição permite a execução no ciclo de dois minutos. Programar horário pode estender o tempo máximo até esse instante; stops e limites globais permanecem prioritários. Programar preço/ganho substitui o alvo automático de ganho, mantendo o prazo máximo. Ordens são vinculadas àquela posição e não reaplicadas a uma compra futura.

Relatórios e sínteses ficam fechados por padrão. O gráfico agrupa cada ciclo por horário; clicar ou usar o teclado num ponto abre e destaca as decisões daquele momento. O motivo detalhado só é mostrado ao abrir `Ver decisão`.
