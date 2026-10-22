# Trade Lab

Laboratório de negociação **exclusivamente simulado**, com preços indicativos BTC/BRL, ETH/BRL e SOL/BRL via CoinGecko. Não executa ordens reais, não usa alavancagem e não integra um modelo de IA.

## Carteira e perfis

Após conectar com o `BOT_TOKEN`, pause o motor e abra **Perfil, ativos e limites**. Escolha um preset, ajuste os pesos e salve. Peso zero exclui um ativo sem posição aberta. Iniciar/retomar habilita a estratégia; o agendador externo precisa estar configurado para executar com a aba fechada. O painel consulta o estado, não substitui o agendador.

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
- Mantém até 72 preços por ativo e 200 decisões. Não é histórico completo ou backtest.

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

Vercel: preset Other, Node 22.x, saída `public`, sem build, funções em `api/`. Variáveis apenas no servidor: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` do projeto escolhido, `BOT_TOKEN` de pelo menos 32 caracteres e chave `COINGECKO_DEMO_API_KEY` opcional. Não use prefixos públicos.

Em uma instalação nova, aplique `supabase/001_trade_lab.sql` **uma única vez**, somente no projeto autorizado. Instalações existentes não precisam de nova migração para a carteira: a configuração usa o mesmo payload privado, preservando saldo, posições e histórico. Para estado legado sem `initialCapital`, configure `INITIAL_BALANCE_BRL` privadamente com o capital original. Não invente o valor nem reexecute a migração para redefini-lo. O motor BTC original continua funcionando até o usuário salvar uma carteira enquanto pausado.

GitHub Actions precisa de `BOT_URL` (URL HTTPS de produção) e `BOT_TOKEN`, sem acesso ao banco. O workflow `simulation.yml` executa no minuto 17 de cada hora; precisa estar habilitado na branch padrão. Confirme uma execução manual e uma agendada antes de afirmar operação automática. Actions pode atrasar ou não executar pontualmente.

## Segurança

HTML público, dados financeiros e configuração acessíveis apenas com Bearer token. Token somente em memória da aba. O titular pode controlar a simulação; troque o token no servidor e Actions para revogar acesso. Todas as mutações usam compare-and-swap por versão; configurar também exige a versão exibida ao usuário e pausa.

RLS e RPCs limitadas a service_role oferecem isolamento lógico no Supabase compartilhado, sem isolamento físico de recursos, cotas ou administradores. Nunca publique chaves, exportações do banco, orçamento ou resultados pessoais.
