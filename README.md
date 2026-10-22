# Trade Lab

Protótipo de agente **por regras**, exclusivamente simulado, para BTC/BRL e orçamento virtual privado. Não usa modelo de IA, corretora, depósito ou chave de negociação. Não aumenta capital automaticamente.

## Arquitetura

- Vercel: painel estático e API Node protegida por token.
- Supabase: estado persistente privado, com RLS e escrita atômica por versão.
- GitHub Actions: chama a API uma vez por hora, no minuto 17 UTC. Pode atrasar ou deixar de executar; não é adequado para negociação que dependa de pontualidade.
- CoinGecko: preço indicativo BTC/BRL, com timestamp da fonte e tolerância máxima de dez minutos. HTTP 429, erros e cotações antigas impedem o ciclo.

## Publicar

1. Crie um repositório **privado** vazio no GitHub e envie estes arquivos, incluindo `.github/workflows/simulation.yml`. Não envie `.env`, credenciais ou `node_modules`.
2. Escolha o projeto Supabase autorizado. No SQL Editor, execute **uma vez** `supabase/001_trade_lab.sql`. A transação cria apenas o schema privado `trade_lab` e as funções `trade_lab_read` e `trade_lab_commit` em `public`. Não execute a migração de novo sobre uma instalação existente.
3. Importe o repositório na Vercel. Use preset **Other**, sem comando de build, diretório de saída **public**, Node **22.x**. As funções em `api/` são implantadas pela Vercel.
4. Configure na Vercel as variáveis de `.env.example`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BOT_TOKEN` e, opcionalmente, `COINGECKO_DEMO_API_KEY`. Gere o token com `openssl rand -hex 32` e guarde em um gerenciador de senhas. Nunca coloque esses segredos no código ou no chat. Faça o deploy após configurar as variáveis.
5. Em GitHub → Settings → Secrets and variables → Actions, crie `BOT_URL` com a URL HTTPS **de produção** da Vercel, e `BOT_TOKEN` com o mesmo token. Não é necessário dar ao GitHub acesso ao banco.
6. Abra o painel, digite o token e execute o primeiro ciclo. Depois rode `Simulação horária BTC` em Actions → Run workflow. Confirme o primeiro registro e a execução seguinte antes de considerar o agente ativo. O workflow precisa estar na branch padrão e habilitado. Proteções de acesso da Vercel precisam permitir chamadas do agendador à API; o token do agente continua obrigatório.

A instalação não está concluída até esses serviços estarem conectados. Nenhum agendamento é criado apenas por abrir o painel. Não use um projeto Supabase de outra aplicação sem escolher explicitamente esse destino.

## Estratégia e limites

Após 24 observações horárias consecutivas (intervalos de até 90 minutos), compara médias de 6 e 24 observações. Compra se a média curta supera a longa em mais de 0,2%; vende se fica mais de 0,2% abaixo. É uma hipótese simples para validar o sistema, não uma estratégia com rentabilidade demonstrada. Uma lacuna no agendamento reinicia a espera por uma janela contínua.

A compra debita o limite de entrada definido no motor, incluindo taxa simulada de 0,1%. O preço de compra tem deslizamento desfavorável de 0,1%; a venda usa deslizamento de 0,1% e desconta taxa de 0,1%. Só existe uma posição por vez. A exposição pode crescer com o preço após a compra; o teto de entrada limita o aporte por entrada. Não considera impostos, spread variável ou ordens mínimas de corretoras.

Perda observada acima do limite diário (America/Sao_Paulo) ou total configurado no motor provoca liquidação virtual e pausa. A base diária é a última avaliação disponível antes do primeiro ciclo do novo dia. A retomada após perda diária exige intervenção e só permite comprar quando o limite diário deixar de estar excedido; o limite total bloqueia retomada. Os limites são gatilhos, não garantias: gaps e custos podem superar os valores. Pausar manualmente mantém a posição e a avaliação de risco, mas impede negociações por estratégia.

## Segurança e persistência

Todas as rotas da API exigem Bearer token (mínimo 32 caracteres). O navegador guarda o token só em memória. O titular do token controla o robô simulado; revogue trocando o token na Vercel e no GitHub. Não há multiusuário nem gestão de sessões nesta versão. O HTML do painel é público, mas saldo e histórico exigem autenticação.

O schema `trade_lab` não é exposto na API REST. É isolamento lógico dentro do mesmo banco: recursos, cotas e administradores continuam compartilhados com o CRM. Nenhuma tabela ou função é liberada para `anon` ou `authenticated`; a service role fica só na Vercel. Cada alteração usa compare-and-swap no banco: ticks concorrentes e pausas invalidam gravações anteriores. Uma execução por hora UTC, sem reposição retroativa de ciclos perdidos. Mantém até 72 preços e 200 decisões; não é um arquivo histórico permanente nem um backtest. Falhas aparecem no painel e no Actions; não há alertas por e-mail.

## Desenvolver e testar

```sh
npm ci
npm test
cp .env.example .env
# Preencha as variáveis apenas no seu computador.
node --env-file=.env scripts/dev.mjs
```

Abra http://localhost:3000. Os testes do banco usam PostgreSQL em WASM (PGlite) e não acessam dados de produção. Os testes de preço usam respostas simuladas. Para validar no destino, execute a migração e teste um ciclo real de coleta na hospedagem.

## Evolução

Antes de dinheiro real: armazenar histórico completo, medir desempenho com taxas da corretora, comparar com comprar e manter BTC, avaliar quedas e falhas prolongadas e integrar autenticação individual. Uma futura integração com corretora deve ser um trabalho separado, com autorização expressa, chaves sem saque e limites revisados. O protótipo não tem caminhos de execução de ordens reais.

## Orçamento e instalações existentes

Os valores de bootstrap da migração e dos testes são fixtures sintéticas, sem relação com orçamento pessoal. Configure saldo, capital inicial e limites privadamente antes do primeiro ciclo. O campo `initialCapital` registra a base do resultado. Para estados de versões anteriores sem esse campo, configure `INITIAL_BALANCE_BRL` na Vercel com o capital original, sem alterar saldo ou histórico. Não reaplique a migração em uma instalação existente. Nunca publique exportações do banco, orçamento pessoal ou resultados.
