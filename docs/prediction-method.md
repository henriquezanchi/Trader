# Protocolo de previsão mensurável

O protocolo `direction-audit-v2` define uma medição reproduzível. Não é garantia de lucro, causalidade econômica ou vantagem estatística. O resultado financeiro exige também custos, magnitude dos movimentos, tamanho das posições e execução possível.

## Contrato de cada previsão

- Alvo: sinal da variação do preço em BRL, em 1, 6 ou 24 horas após o registro da previsão.
- Base: preço positivo, fonte e horário real de observação; idade máxima de dois minutos e nenhum horário futuro.
- Entradas: observações agrupadas por hora, sem duplicar a cotação atual; mesma função de construção do vetor no treino e na emissão. O vetor técnico histórico não usa manchetes ou volumes retroativamente inventados.
- Identificação: protocolo, versão de atributos, ID, horizonte, probabilidades, vetor, coeficientes, parâmetros de atualização e hashes canônicos. A ordenação de chaves JSONB não altera os hashes. Os dados usados para construir o vetor ficam no ciclo privado de pesquisa.
- Modelo atual: regressão logística, atualização 0,03, regularização L2 0,001, coeficientes limitados a ±5 e logit a ±20. Registrar um modelo não significa que suas probabilidades estejam calibradas.
- Resultado: primeira cotação válida observada **no alvo ou depois dele**, até cinco minutos após, da mesma fonte, disponível antes da avaliação. Após dez minutos sem essa cotação, registra avaliação ausente; não usa preço atrasado de outro instante como se fosse o preço-alvo.

O produtor publica por hora. A carteira continua sendo monitorada pelo agendador de dois minutos. O conjunto principal é escolhido na emissão: a próxima janela de um ativo/horizonte só é principal depois do fim da janela principal anterior, da conclusão da avaliação e com preço-base não anterior ao preço usado para concluir a janela anterior. Previsões intermediárias de 6h/24h ficam como diagnóstico, com contagens separadas. Mesmo sem sobreposição temporal por ativo, criptomoedas continuam correlacionadas entre si.

Uma previsão auditável é verificada por replay do produto vetor × coeficientes e da função logística. A probabilidade original é avaliada antes de atualizar pesos. Só resultados das janelas principais do novo protocolo atualizam coeficientes; previsões legadas e diagnósticos sobrepostos não fazem isso. Uma operação que usa um sinal direcional referencia o ID já registrado, sem calcular outra probabilidade fora do índice.

## Métricas e referências

- **Acerto principal:** acertos / avaliações com preço válido. Preço estável não confirma alta nem baixa e entra como não acerto nesse índice.
- **Acerto binário:** exclui empates, apresentado separadamente quando necessário.
- **Cobertura:** avaliações válidas / avaliações válidas mais ausentes. Pendentes não viram acertos nem erros antecipadamente.
- **Matriz:** alta/baixa prevista versus alta/baixa/estabilidade observada; permite avaliar separadamente erros de compra e de saída.
- **Acerto balanceado:** média do reconhecimento de altas e baixas; indisponível se uma classe não ocorreu.
- **Brier e log loss:** erro das probabilidades nos casos de alta/baixa. Uma previsão neutra de 50% tem Brier 0,25. `1 − Brier/0,25` negativo significa pior que essa referência.
- **Calibração:** probabilidade média de alta por faixa versus frequência de altas realmente observada e quantidade de casos. Uma previsão de 70% não é confiança certificada sem verificar esse comportamento.
- **Baselines:** sempre prever alta e repetir a direção do último movimento conhecido, definidos antes do resultado e comparados nos mesmos casos.

O relatório mostra recortes por ativo e horizonte. Não se publica intervalo de confiança que trate ativos correlacionados como independentes. Para inferência estatística mais forte, a etapa seguinte deve avaliar blocos temporais e regimes, com correção para múltiplas tentativas de modelos.

O sinal direcional não é tratado como vantagem comprovada. A regra operacional mínima exige, por ativo/horizonte, 100 avaliações principais, ao menos 20 altas e 20 baixas, cobertura ≥95%, Brier skill >2%, acerto balanceado ≥55% e acerto pelo menos três pontos percentuais acima das duas referências. São critérios empíricos de triagem, não um teste formal de significância nem autorização para ultrapassar os limites do perfil.

## Teste histórico

O histórico usa a mesma exigência de preço no alvo ou depois dele, em até cinco minutos. Lacunas na resolução horária são registradas como ausências; não são interpoladas nem preenchidas com preços anteriores. Mantém o corte 70/30, com alvos de treino terminando antes do corte e métricas sem sobreposição no trecho reservado. Também registra quatro avaliações walk-forward: treino inicial em 50%, 62,5%, 75% e 87,5% do período; cada teste ocupa o bloco seguinte. Os modelos de cada bloco são ajustados apenas com o passado, sem escolher o melhor bloco retrospectivamente.

Depois de calcular os relatórios congelados, o modelo de produção pode ser reajustado com todo o passado conhecido. Os resultados dos testes pertencem ao procedimento avaliado, não são uma avaliação ao vivo desse reajuste final. Com cerca de um mês de dados, sobretudo para 24h, o número de janelas sem sobreposição ainda é pequeno e cobre poucos regimes.

## Legado, custos e proteção

A medição anterior permitia cotações até cinco minutos antes do alvo e sobreposição no índice agregado. Ela permanece identificada como legado, com data e contagens preservadas. Não é apagada nem misturada ao novo índice para sugerir melhora. O retrato na data da migração é preservado; previsões legadas que ainda vencerem têm seus resultados contabilizados no legado, sem atualizar coeficientes do novo procedimento.

O RPC privado `trade_lab_quality_read` informa contagens de publicação, fingerprints, avaliações, preços anteriores ao alvo e resultados financeiros por grupo. Somente o servidor pode executá-lo; o painel exige conta autorizada. Resultados realizados já incluem custos, que não devem ser descontados novamente. O índice direcional não inclui novos pools especulativos e não explica sozinho as perdas desses ativos.

A memória de operações é um mecanismo separado de redução de risco, não um classificador calibrado. Depois de pelo menos 20 resultados numa família, média líquida inferior a −1% e menos de 40% de saídas positivas, novas entradas daquele cenário ficam bloqueadas por seis horas a partir da última saída. A causa econômica e o prazo ficam registrados. A regra é uma proteção heurística contra repetir perdas observadas, não evidência de que o mercado futuro permanecerá igual. Os limites de perda existentes permanecem ativos e não são aumentados pelo protocolo.

### Evidência econômica recente

Além da previsão direcional, o plano ativo registra até 30 vendas recentes do mesmo cenário: resultado líquido em reais, média por venda, ganho e perda médios, fator de lucro e taxa de acerto de equilíbrio. O resultado realizado já contém os custos; eles não são descontados novamente. Lotes encerrados na mesma venda são agrupados por `exitId`. A janela usa as últimas 100 sínteses disponíveis, portanto pode conter menos de 30 vendas e não representa todo o histórico.

Com dez vendas e média líquida negativa, o tamanho fica limitado a 25% do teto da entrada. Com vinte vendas e média negativa, há bloqueio de novas entradas por seis horas após a última venda. A expiração permite uma nova exploração reduzida; não significa que a estratégia se recuperou. Essas regras são proteções heurísticas, não prova de vantagem estatística nem validação fora da amostra. Os limites financeiros globais continuam prioritários.

### Triagem conjunta por ativo e horizonte

A política fixa `forecast-readiness-v1` exige simultaneamente os critérios ao vivo acima e teste histórico do protocolo atual com pelo menos 100 casos, cobertura de 95%, ganho de Brier sobre a referência neutra maior que 2% e vantagem de acerto maior que três pontos percentuais sobre ambas as regras simples. O último dado histórico deve ter no máximo sete dias e não pode estar no futuro.

A estabilidade requer ao menos três janelas walk-forward elegíveis (dez casos válidos, cobertura de 95% e ambas as direções presentes); em pelo menos 75% delas, o modelo precisa superar ambas as regras simples e o Brier neutro. As janelas e o teste 70/30 reutilizam parte do mesmo período: não são evidências independentes. Esses limiares são regras de triagem, não testes de significância, estimativas de lucro ou autorização para aumentar risco. Notícias históricas não entram neste modelo técnico.

Somente a combinação de histórico e avaliação ao vivo permite que a previsão direcional seja usada nos filtros de entrada e saída. Ela não promove uma estratégia automaticamente. A ausência de suporte não autoriza ignorar risco ou custos; o plano exploratório permanece sujeito às proteções financeiras e econômicas. A auditoria no painel expõe o motivo de cada reprovação por ativo e horizonte. Os critérios são avaliados sobre os modelos reestimados ao longo do tempo, sem atribuir o resultado de todos a uma versão única congelada.

### Diagnóstico econômico das previsões históricas

`hourly-direction-cost-audit-v1` avalia três regras fixadas previamente: comprar quando a probabilidade de alta é pelo menos 50%, comprar com pelo menos 60% e comprar em todas as janelas como referência. Usa as mesmas previsões congeladas do teste cronológico e dos folds, sem sobreposição por ativo e horizonte. Não escolhe o limiar pelo resultado do teste. Somente compras, saída no horizonte; não simula stops intermediários, carteira compartilhada, limites de risco, execução real ou impostos. Portanto é um diagnóstico da magnitude prevista, não um replay da estratégia completa nem uma carteira adicional.

Taxa e deslizamento são os mesmos de `markets.fill` para cripto estabelecida. Para retorno bruto `r`, o fator líquido é `(1-fee)^2 * (1-slip)/(1+slip) * (1+r)`. Há cenário de estresse com taxas e deslizamento dobrados. A média é por operação hipotética conhecida, não retorno acumulado da carteira; resultados ausentes permanecem no número de entradas e na cobertura, nunca são tratados como ganhos. Não há validação econômica para ETFs ou pools neste índice. Enriquecer um dataset já conhecido atualiza somente seu relatório, preservando pesos aprendidos online, previsões pendentes, saldo e pausa financeira.

### Estimador de retorno líquido (somente diagnóstico)

`net-return-ridge-v1` estima a magnitude do retorno líquido, em pontos percentuais, com os mesmos indicadores técnicos horários. Usa regressão ridge com penalidade fixa 10, intercepto não penalizado, médias e escalas calculadas exclusivamente no treinamento; colunas constantes são zeradas. O alvo é o retorno de compra e venda líquido de custos do simulador, incluindo casos de preço estável. Há mínimo de 30 alvos conhecidos. Cada corte 70/30 ou walk-forward ajusta seu próprio estimador; nenhum alvo do treinamento pode ser conhecido depois do corte. A seleção não modifica os hiperparâmetros com base no teste.

O diagnóstico econômico v2 acrescenta uma regra fixa: retorno líquido previsto maior que 0,1% e ainda positivo com taxas/deslizamento dobrados. A transformação para o cenário de estresse usa a mesma fórmula exata de custos. O relatório guarda coeficientes, normalização, hash, último alvo de treinamento, erro absoluto médio, RMSE e viés fora da amostra. A referência é prever sempre a média líquida do treino. Viés positivo significa previsão excessivamente otimista. O modelo não é promovido para negociação, não atualiza o índice de acerto direcional e não promete retorno; ainda requer evidência histórica e prospectiva própria.

### Exploração simulada autorizada

`simulationExploration=true` é uma escolha explícita e reversível na carteira virtual. Ativar seleciona o motor ativo e retoma a simulação; desativar restaura a estratégia anterior e pausa. Não altera saldo, aportes, perdas anteriores ou coeficientes de previsão. Nesse modo, os limites globais de perda, ganho e prazo, os tetos percentuais de entrada/exposição, stops de perda da parcela curta, cooldown e bloqueios econômicos não impedem novas compras. O caixa é repartido entre os ativos elegíveis; continua impossível gastar mais que o caixa disponível. Pausa manual, cotações recentes válidas, calendário/liquidação de ETFs, custos de execução e preços e reservas positivos dos pools continuam aplicáveis. Filtros de idade, volume e concentração de pools também deixam de bloquear a exploração; segurança, impostos e execução de tokens continuam não verificados e explicitamente hipotéticos. Não há conexão com corretora nem execução real.

O aprendizado `paper-exploration-ucb-v1` compara saídas de 6, 20 e 60 minutos, com alvos líquidos fixos de 0,5%, 1% e 2%. Ordens de saída do usuário continuam válidas. UCB prioriza alternativas ainda não avaliadas e combina resultado observado com exploração; ordens abertas ajudam a distribuir as primeiras entradas. Cada venda atualiza, por família de ativos e alternativa, contagem, acertos financeiros, retorno líquido médio e recompensa limitada a [-1,1] (retorno percentual dividido por dez). Isso reduz a influência de um retorno extremo, mas não prova lucro ou independência das operações. Alvos e prazos utilizados, motivo da escolha e síntese de resultado ficam no diário. Não há R de perda predefinido quando o stop está desligado. O índice direcional conserva sua medição independente e não é inflado pelas operações exploratórias.

### Prazos do gráfico

O gráfico consulta pontos persistidos a partir da auditoria privada, com filtros móveis de uma hora, um dia, uma semana, um mês, um ano e cinco anos. Cada ponto representa o último ciclo de um intervalo; a amostragem se adapta ao histórico realmente disponível para exibir até aproximadamente 400 pontos. Assim, poucos dias de dados não viram um único ponto ao escolher cinco anos. Clicar abre as decisões originais, inclusive anteriores às últimas 200 da memória operacional. A data inicial disponível é exibida; não há interpolação de anos anteriores, backtest misturado ao saldo ou histórico inventado. O patrimônio inclui os efeitos dos aportes e não é uma curva de rentabilidade ajustada por contribuições.

### Estudos de cenários e meta de 80%

`scenario-comparison-v1` fixa dez candidatos: frequência de altas do treino, sempre alta, sempre baixa, último movimento, tendência, reversão, regressão incremental, regressão em lote regularizada, 15 vizinhos e frequência de cenário suavizada. A regressão em lote normaliza somente pelo treino e usa 100 passos, taxa 0,2 e penalidade 0,1. Os vizinhos usam apenas tendência, RSI, volatilidade e retorno de seis horas, todos conhecidos na emissão. Há 27 combinações de tendência (alta/baixa/lateral), volatilidade horária (até 0,2%, até 0,7%, acima de 0,7%) e RSI (abaixo de 30, de 30 a 70, acima de 70). Categorias vazias ficam explicitamente sem dados. O dataset horário não testa notícias históricas, volume, livro de ordens, ETFs ou pools.

Para cada ativo e horizonte de 1, 6 ou 24 horas, o primeiro corte usa 50% para treino e 20% para validação. Alvos devem ser conhecidos antes do corte seguinte. O menor Brier na validação com pelo menos vinte casos e 95% de cobertura escolhe o candidato; sem isso, usa-se a frequência do treino, sem declarar seleção validada. Os 30% finais avaliam todos os métodos, mas nunca escolhem o vencedor. Cada teste usa intervalos sem sobreposição; empates são não acertos e ausências afetam cobertura. O histórico já foi examinado por outras versões: esta comparação não cria magicamente um holdout inédito. Muitas comparações e correlação entre ativos impedem interpretar um resultado isolado como prova de vantagem.

Depois de congelar o relatório de teste, o candidato escolhido é reajustado com todo o passado disponível para emitir novas previsões. Os coeficientes de teste e de emissão têm hashes diferentes e identificados; a taxa histórica não é atribuída indevidamente ao reajuste. Modelos e datasets ficam em registros privados imutáveis; as previsões futuras referenciam o estudo e o hash, guardam a probabilidade antes do resultado e só são avaliadas com cotações posteriores ao alvo, até cinco minutos, da mesma fonte. Elas não sobrescrevem a medição anterior.

A meta empírica exige por ativo/prazo: pelo menos 200 resultados prospectivos válidos, 80% de acerto em todos os casos (não somente nos de maior confiança), quarenta altas e quarenta baixas, cobertura de 95%, probabilidades melhores que 50%, vantagem de três pontos percentuais sobre as referências e trinta compras hipotéticas com média líquida positiva sob custos normais e dobrados e cobertura econômica de 95%. Esses mínimos são critérios de pesquisa, não garantia estatística nem autorização para dinheiro real. A aplicação não tem integração de negociação real e `realTradingEnabled` permanece falso. O corte fixo de confiança de 70% é apresentado separadamente com participação e número de casos; não substitui o índice principal.

### Aprender a entrar e comparar com caixa

`paper-entry-value-v1`, ativado explicitamente na simulação, destina inicialmente 20% do patrimônio aos testes e reserva o restante para aproveitar evidência favorável; a porcentagem é ajustável entre 1 e 100. Isso é uma política de alocação, sem reativar stops ou limites financeiros de perda do perfil. O saldo nunca é reiniciado, e posições existentes não são encerradas à força. Sem evidência, a parcela de aproveitamento fica em caixa, cuja referência é 0% no intervalo.

Cada entrada recebe previamente uma partição determinística por ativo/instante: aproximadamente um quinto para validação e o restante para ajuste. A alternativa é escolhida somente pela maior média líquida do ajuste, com pelo menos vinte resultados; exige-se depois que a alternativa escolhida tenha ao menos dez resultados reservados, positivos em média, também após subtrair novamente os custos de execução observados. Também se exige média positiva após retirar o melhor resultado de cada amostra, inclusive no estresse, para não depender de um único ganho extremo. Não se procura outro vencedor olhando a validação quando o primeiro falha. Dados reservados não treinam a recompensa UCB. Os registros usam no máximo quarenta resultados de ajuste e vinte de validação por contexto, dos últimos trinta dias. São médias descritivas adaptativas, com amostras correlacionadas, não probabilidades garantidas ou holdout estatisticamente independente. O estresse de custos observados é uma aproximação conservadora, não replay exato do livro de ordens.

Para cada cotação válida, referências contrafactuais de 6, 20 e 60 minutos comparam comprar com permanecer em caixa, inclusive quando não há uma ordem da carteira. Elas usam tickets de referência de R$ 10 para cripto estabelecida e R$ 5 para pools, a mesma função de execução, alvo ou prazo e reservas indicativas do momento da saída. Não movimentam saldo nem contam como lucro da carteira, previsão direcional acertada ou operação real de treinamento. Resultados sem cotação válida ficam ausentes, não viram perdas ou ganhos inventados. Esses registros ampliam observação sem criar uma segunda carteira fictícia. Dados financeiros, métricas anteriores e perdas permanecem preservados.

Os estudos são atualizados automaticamente em rodízio horário, com intervalo mínimo de 24 horas por ativo, quando o ciclo principal termina com tempo disponível. O saldo é gravado antes dessa pesquisa, e uma falha não desfaz a carteira. A janela arquivada é mesclada com observações horárias novas e causais do mesmo provedor CoinGecko, limitada às últimas 750 observações; fontes diferentes não são misturadas. O dataset atualizado e o modelo geram outro registro imutável, preservando os estudos e previsões anteriores. Ausência de dados ou de tempo não é declarada como atualização concluída.

Entre entradas elegíveis, a parcela experimental prioriza contextos com menos resultados de ajuste e divergência entre previsões já registradas, sem olhar o desfecho futuro. Isso é uma heurística de informação, não probabilidade de lucro. A parcela de aproveitamento prioriza a média líquida do ajuste somente após a qualificação reservada; o diário registra contagens, divergência e IDs das previsões usadas.

### Contexto ampliado e comparação de versões

`scenario-comparison-v2` mantém os dez candidatos básicos e acrescenta regressão regularizada, vizinhos e a média fixa desses dois métodos com vinte sinais causais de preço. `hourly-price-context-v1` usa somente as últimas 24 observações horárias contínuas: retornos de 1/3/6/12 observações, aceleração, razão de volatilidade curta/longa, inclinação e ajuste linear do log-preço, distância de máximas/mínimas observadas, posição na faixa, rompimentos relativos às 23 observações anteriores, proporção de altas, diferença de EMAs, extremos de RSI e autocorrelação de retornos. Máximas e mínimas são das observações disponíveis, não máximas intrahora de candles inexistentes. Não há volume ou notícias históricas inventadas. Normalização, penalidade, vizinhos e pesos iguais da combinação são fixados antes do teste, com médias e escalas apenas do treino.

As versões V1 e V2 conservam registros imutáveis e contadores prospectivos separados. Previsões V1 já emitidas continuam sendo avaliadas, sem apagamento ou transferência de acertos à V2. As séries podem se sobrepor entre versões e não são observações independentes. Quando o modelo incremental publica uma referência com exatamente o mesmo preço, observação, emissão e alvo, a previsão do estudo guarda essa referência antes do resultado e apresenta uma comparação pareada, com o mesmo número de casos avaliados. Ausência de referência alinhada não é preenchida por aproximação. Testes passados já examinados permanecem exploratórios; só a confirmação prospectiva própria pode sustentar os critérios da meta. Os estudos anteriores continuam acessíveis no seletor de versão.

### Previsões alinhadas à execução de 6, 20 e 60 minutos

`execution-horizons-v1` usa cotações efetivamente registradas nas decisões rápidas da carteira, não interpola o histórico horário. O coletor privado aceita apenas os dez criptoativos estabelecidos com fonte CoinGecko, preço positivo e cotação observada há no máximo dois minutos. O instante de conhecimento é o maior entre a data da decisão e a gravação da auditoria; publicações tardias não são retrodatadas. Uma observação repetida conserva a primeira publicação, mesmo se outro registro posterior trouxer outro preço para o mesmo horário. Os índices e estudos horários não são substituídos nem misturados com esses dados.

Os modelos comparam os mesmos treze candidatos, separando treino/validação/teste em 50/20/30 e expurgando alvos ainda desconhecidos nos cortes. `two-minute-price-context-v1` interpreta as janelas de indicadores como observações de aproximadamente dois minutos. Exige 24 observações contínuas, sem lacunas maiores que cinco minutos, e define o retorno básico de seis observações em vez de seis horas. Não transforma pontos em candles nem inventa máximas ou volume. Treino e teste usam janelas sem sobreposição por prazo. A avaliação aceita somente a primeira cotação disponível observada após o alvo e até dois minutos depois, da mesma fonte; após seis minutos sem resultado válido, o caso é ausente. Os tickets econômicos continuam hipotéticos e líquidos dos custos do simulador.

Cada prazo tem previsões futuras, hashes e contadores próprios, separados das versões horárias. Uma previsão atual de prazo igual pode ser referenciada no diário de uma entrada, mas não é automaticamente tratada como vantagem comprovada nem recebe acerto pelo simples fato de a operação ter lucrado antes do alvo. As referências sem movimentação de saldo continuam separadas. As metas de 200 casos prospectivos, 80% de acerto, cobertura e resultado líquido positivo são mantidas. A obtenção mais rápida de amostras não garante maior acerto.

Os estudos curtos usam até seis mil observações arquivadas e são reavaliados em rodízio quando completam seis horas, com novos preços, quando o ciclo principal termina com tempo disponível. Falhas de pesquisa não desfazem a gravação da carteira. O painel exige escolher explicitamente a série de minutos; a opção padrão continua mostrando os estudos horários.

### Referência de queda e avaliação no painel

A meta empírica exige vantagem de mais de três pontos percentuais sobre as três referências nos mesmos casos: prever sempre alta, prever sempre queda e seguir o último movimento. A referência de queda é `(tn + fp) / valid`; preços sem variação continuam contando como erro para ambas as referências direcionais. Isso impede confundir um mercado predominantemente em queda com aprendizado superior. Os resultados originais e os modelos escolhidos permanecem preservados.

Na confirmação prospectiva, “Ver avaliação” abre os motivos da meta, acerto equilibrado, ausências, referências e retorno médio das compras hipotéticas após custos normais e dobrados. Essas compras são avaliações das previsões no horizonte registrado, não operações extras na carteira.

### Aprendizado em janelas sucessivas e regras de lucratividade

O protocolo `execution-walk-forward-v1` usa cinco testes cronológicos. A primeira janela treina nos primeiros 40% do histórico, valida nos 10% seguintes e testa nos próximos 10%. A janela seguinte amplia o treino e avança o teste; os testes não se sobrepõem dentro de um ativo e prazo. Rótulos que terminariam após a fronteira são excluídos daquela etapa. Até 1000 exemplos de treino e 200 de validação/teste são selecionados por posição temporal predefinida, sem consultar seus resultados. Mais histórico aumenta a variedade de regimes; não é apresentado como mais acertos prospectivos.

A seleção usa o protocolo `net-profit-validation-v1`. Uma estratégia precisa ter, na validação anterior ao teste:

- Pelo menos 20 oportunidades conhecidas e 10 compras avaliadas; cobertura de pelo menos 95% nas oportunidades e compras.
- Expectativa líquida positiva após taxas/deslizamento e após dobrar esses custos.
- Média líquida positiva mesmo retirando a melhor operação, nos dois custos.
- Ganhos líquidos acumulados de pelo menos 1,2 vez as perdas, quando há perdas. Se não há perdas, o fator é indefinido, e os demais critérios continuam obrigatórios.
- Retorno líquido por oportunidade superior a ficar em caixa (0% nominal no período) e a comprar em todas as mesmas oportunidades.

Entre candidatas qualificadas, vence a maior média líquida estressada por oportunidade na validação, com desempate pelo identificador. Sem candidatas qualificadas, o estudo usa o menor Brier como referência **somente de pesquisa**, explicitamente sem comprovação de lucro. Isso não habilita dinheiro real nem altera as travas da carteira, a parcela de exploração ou os stops configurados pelo usuário.

A adaptação por cenário pode usar outra candidata se a validação daquele cenário tiver pelo menos 10 casos, melhorar o Brier em 0,01 e satisfizer as regras de lucratividade. A composição também precisa satisfazer as regras na validação completa. Isso evita selecionar retrospectivamente pelo ganho do teste. A versão implantada para previsões futuras é reajustada com os rótulos já conhecidos, preservando a escolha feita antes do último teste; ela mantém seus próprios resultados na coorte `walkForwardLive`.

Para cada decisão histórica, o relatório privado preserva momento, horizonte, janela, cenário, método, hash do modelo, probabilidade, qualificação de lucro conhecida naquele momento e os retornos posteriores de comprar e ficar em caixa. Também resume ganhos perdidos e perdas evitadas nas recusas. São médias de operações hipotéticas de mesmo valor; não são retorno composto nem resultado da carteira. Casos sem preço continuam ausentes, sem serem convertidos em lucro ou prejuízo.

O painel oferece **Testar aprendizado e lucratividade**, versão **Janelas sucessivas · lucratividade**, com regras, motivos e registros fechados por padrão. A rotina continua coletando previsões futuras separadas, e refaz um estudo de origem auditada que esteja há pelo menos seis horas sem atualização quando sobra tempo no ciclo.

### Importar histórico em minutos de outro fornecedor

A fonte pública atual recusou `interval=5m` com erro de plano Enterprise. Não presumimos que dados horários tenham resolução de minutos. Para testar meses de histórico em outra fonte, há um comando local que gera um relatório privado:

```sh
node scripts/minute-research.mjs \
  --input historico.csv --asset bitcoin --source 'Nome do fornecedor' \
  --currency BRL --output estudo-bitcoin.json
```

O CSV usa preços **já denominados em BRL** e horários ISO com fuso:

```csv
available_at,observed_at,price_brl,asset
2026-01-01T00:02:01Z,2026-01-01T00:02:00Z,500000,bitcoin
```

Informe quando a cotação ou fechamento do candle ficou disponível em `available_at`, e o momento observado em `observed_at`; abertura de candle não serve como disponibilidade de seu fechamento. Exigimos pelo menos 240 observações após agrupar em dois minutos; não há interpolação. O importador aceita até 250 mil linhas/32 MiB, rejeita futuros, fontes/ativos misturados, preços conflitantes e resolução horária. O agrupamento mantém uma cotação real e seu horário original. Volume opcional é apenas declarado no manifesto e não entra no modelo. Não há conversão BRL/USD presumida, download arbitrário de URLs, uso de credenciais do fornecedor ou promoção de modelos de origem declarada para o motor ao vivo. O JSON resultante contém manifesto e hash da entrada, é criado com permissão privada e nunca sobrescreve um arquivo existente.

### Tendência, saída móvel e prazos mais longos

O protocolo `trend-exit-comparison-v1` compara seis regras: entradas sem filtro, em tendência e em rompimento, cada uma com alvo fixo ou saída móvel. Os prazos máximos são 6, 20, 60, 240 e 1440 minutos. Tendência exige EMA8 acima da EMA21 e valorização nas últimas 24 cotações; rompimento também exige superar a máxima das 23 anteriores. Não há confirmação por volume nesta versão, pois não temos a série histórica verificada.

O alvo fixo é +0,5% líquido; no prazo de um dia, +1%. A saída móvel é ativada nesses mesmos níveis, acompanha o pico líquido e vende após recuo de 0,3 ponto percentual (0,6 no prazo de um dia). Esses números são candidatas de teste predefinidas, não parâmetros comprovadamente ótimos. Toda saída usa o preço realmente observado após custos, não o preço ideal do gatilho. Uma queda brusca pode transformar um ganho observado em perda.

As candidatas compartilham as mesmas janelas de oportunidade dentro de cada prazo, sem sobreposição. Mesmo após uma saída antecipada, o valor hipotético fica em caixa até a próxima janela. A validação usa somente janelas já concluídas antes do teste; escolhe pelo retorno estressado por oportunidade entre candidatas que passam as regras de lucratividade. A referência é comprar sem filtro com saída por alvo fixo no mesmo prazo. O protocolo de lucro permite comparar uma melhora de saída contra essa referência de alvo fixo, inclusive quando ambas compram nas mesmas oportunidades; a referência deve ter cobertura comparável de pelo menos 95%.

Os cinco testes sucessivos ocupam a segunda metade do histórico. Cada operação pertence ao teste pelo instante de entrada; sua saída pode acontecer na janela seguinte. O calendário de oportunidades impede sobreposição, e um resultado só entra na validação futura depois de efetivamente concluído. Janelas ainda não concluídas no fim do arquivo não são contabilizadas como sucesso ou perda. Sem candidata qualificada, o relatório mantém a referência provisória e explica os critérios não atendidos. Não escolhe pelo maior lucro do teste. As tabelas de comparação de todas as candidatas são diagnósticas e não comprovam que a melhor observada no teste repetirá o resultado. Uma lacuna maior que cinco minutos invalida o caminho inteiro para todas as candidatas, evitando supor picos invisíveis. Prazos longos precisam de mais histórico; zero casos é ausência de evidência, não rentabilidade zero demonstrada.

O relatório registra sinal de entrada e seu hash, EMA8/EMA21, pico líquido, preço e momento de saída, motivo de comprar/manter caixa, regra selecionada e resultado líquido. É uma comparação de regras com operações hipotéticas de mesmo valor, não a reprodução de toda a carteira adaptativa. Resultados históricos não entram no índice de acerto de previsão.

No mesmo motor de exploração da carteira, foram adicionadas alternativas `trend-hours` (até 4 horas) e `trend-day` (até 1 dia). Exigem o sinal de tendência e não se aplicam a pools novos. O seletor compara os resultados dessas alternativas com as três anteriores; a parcela reservada de validação continua separada do ajuste. O orçamento de exploração e os parâmetros de risco salvos não são alterados. Posições já abertas preservam o plano de saída original; posições novas guardam o modo e a distância da saída móvel, e a programação manual do usuário continua tendo prioridade sobre saídas automáticas de ganho. Os logs de manter posição informam ativação, pico e recuo permitido.

As comparações com caixa também acompanham essas alternativas, usando a mesma função de saída móvel, sem movimentar saldo. Os prazos máximos continuam valendo para encerrar resultados e alimentar o aprendizado; a frequência de consulta permanece aproximadamente dois minutos, sem garantia de execução instantânea.

No painel: **Comparar tendência e saída móvel**. Regras, janelas e motivos detalhados ficam recolhidos até clicar. O estudo de um ativo que estiver há pelo menos seis horas sem atualização é refeito no ciclo horário quando sobra tempo, sem desfazer um ciclo financeiro já gravado.

O importador também permite históricos em minutos de outros fornecedores:

```sh
node scripts/minute-research.mjs --input historico.csv --asset bitcoin \
  --source 'Fornecedor declarado' --currency BRL --mode trend-exits --output tendencia.json
```

As mesmas restrições de moeda, horários disponíveis, fonte e ausência de interpolação continuam obrigatórias. A coleta atual de auditoria é limitada às últimas 6000 cotações por ativo para cada estudo remoto; o comando local permite comparar arquivos maiores. Não pressupomos ter meses de preços em minutos quando eles não foram obtidos.

### Recuperação de cotações e posições em pools

A atualização das posições abertas é independente da descoberta de novos pools. A busca de novos ativos é desligada enquanto a simulação estiver pausada, mas posições já abertas continuam sendo consultadas para avaliação e saídas de risco/prazo já previstas. A pausa e os parâmetros salvos não são alterados por essa recuperação.

As consultas de posições são divididas em lotes de até 20 endereços, até quatro lotes por ciclo. Livros maiores são alternados entre ciclos, preservando os registros ainda não consultados. Uma resposta HTTP com erro, um pool omitido ou um registro inválido não invalida os demais lotes. Diagnósticos registram o tamanho dos lotes, código HTTP quando disponível e motivo por posição. Só uma resposta válida atualiza o instante da cotação. Dados de token diferentes dos da posição, reserva zero, preços inválidos e respostas incompletas não geram uma venda fictícia nem uma baixa automática de 100%.

O câmbio USDC/BRL pode usar o registro anterior somente enquanto o seu horário original tiver no máximo dez minutos. A cotação do pool precisa ter sido consultada nos últimos dois minutos; não é rejuvenescida quando ocorre uma falha. Sem conversão BRL válida, não são publicadas cotações negociáveis. A fonte continua sendo indicativa, sem comprovação de execução real ou verificação de impostos do token.

Posições que precisariam sair mas não têm preço válido recebem `pendingExit` com motivo e data; a quantidade, o custo e o histórico são preservados. Quando há uma cotação válida, o motor normal pode liquidá-las pelos critérios de risco/prazo existentes, mantendo a simulação pausada para novas entradas. O painel distingue avaliação recente de antiga, sinaliza quando o patrimônio depende de preços antigos e mostra as pendências recolhidas até clicar. Valores antigos não são tratados como caixa disponível ou como prova de liquidez atual.

### Retomar o aprendizado com foco em tendência

A opção `learningArmMode` define as alternativas permitidas em **novas** entradas rápidas: `mixed` mantém a comparação de curtas e tendências; `trend` usa somente as saídas móveis de 4 horas e 1 dia. As posições abertas preservam seu plano original. O modo não altera a frequência de consulta, não promove dados históricos ao índice de acerto e não transfere resultados de comparação hipotética para a carteira.

No foco em tendência, EMA8 precisa estar acima da EMA21 e o retorno das 24 cotações precisa ser positivo. Se não houver sinal, a recusa informa os indicadores conhecidos; não escolhe uma operação curta apenas para gastar caixa. A escolha por evidência de lucro também considera somente as alternativas permitidas no modo atual. As comparações sem movimentar caixa continuam incluindo as alternativas curtas.

Configurações salvas por clientes antigos preservam o foco já configurado. Desligar novas entradas em pools (`discoveryPct=0`) é permitido com posições em pools ainda pendentes: essas posições são mantidas e continuam sendo consultadas para saídas válidas. A regra de impedir a remoção de um ativo estabelecido com posição aberta permanece.

Retomar uma carteira que já ultrapassou a perda histórica pode exigir reativar a exploração simulada explicitamente. Isso não apaga o prejuízo, não repõe o caixa, não reinicializa o saldo e não habilita ordens reais. O capital inicial e os registros antigos continuam visíveis; uma mudança de foco é registrada como configuração, não como lucro.

### Pesquisa V2: recuos, custos e saída ajustada à variação observada

As referências públicas consultadas foram os guias de [custos de negociação](https://github.com/stefan-jansen/machine-learning-for-trading/blob/30db4f00946ce91fbc98fef18582b8cbc3fd8afd/18_transaction_costs/README.md) e [microestrutura](https://github.com/stefan-jansen/machine-learning-for-trading/blob/30db4f00946ce91fbc98fef18582b8cbc3fd8afd/03_market_microstructure/README.md), de Stefan Jansen, e a documentação de `TrailingStrategy` em [backtesting.py](https://github.com/kernc/backtesting.py/blob/master/backtesting/lib.py). Elas fundamentam hipóteses sobre custos, dados e saídas variáveis; não validam nossos limiares nem comprovam lucro. Não foram copiadas implementações desses projetos nem adicionadas dependências.

O protocolo `trend-exit-comparison-v2` preserva as seis regras anteriores e acrescenta cinco comparações: tendência com saída adaptativa; recuo com alvo fixo; recuo com saída móvel fixa; recuo com saída adaptativa; recuo com filtro de custos e saída adaptativa. São onze regras nos mesmos cinco prazos e oportunidades da V1. A comparação entre muitas regras aumenta a chance de um resultado fortuito; a seleção continua usando só validação anterior, e o acerto direcional não recebe casos históricos dessas regras determinísticas.

Recuo exige a tendência já definida (EMA8 acima de EMA21 e valorização das 24 observações), reação positiva na última cotação, preço próximo à EMA8 e abaixo de uma máxima recente. A referência de máxima usa as últimas doze observações, excluindo as duas últimas. O recuo deve estar entre `max(0,05%, taxaVariação×0,5)` e `max(0,25%, taxaVariação×4)`; a distância acima da EMA8 não pode superar `max(0,15%, taxaVariação×2)`. Esses limites são predefinidos para pesquisa, não escolhidos pelo lucro do teste.

A regra econômica compara a amplitude máxima/mínima efetivamente observada nas 24 cotações com 1,25 vez o movimento bruto necessário para cobrir taxas e deslizamento de ida e volta. Uma amplitude menor recusa essa alternativa; uma maior não é uma previsão de lucro. Os custos não são reduzidos para melhorar resultados. O controle sem esse filtro permanece na comparação para medir se o filtro acrescenta valor.

A taxa de variação é `sqrt(soma(retornoLogPercentual²) / minutosObservados)`, com os mesmos 24 preços conhecidos e sem preencher lacunas. A escala de referência do prazo multiplica essa taxa por `sqrt(prazoEmMinutos)`. A ativação da saída é 0,8 vez a escala, limitada entre +0,25% e +2% líquidos. O recuo permitido é 0,5 vez a escala, limitado entre 0,15 e 1,5 ponto percentual. A hipótese de raiz do tempo pode falhar; essa escala não mede retorno esperado, não é ATR e não usa dados OHLC, volume ou spread real ausentes da fonte atual.

Os parâmetros são congelados na entrada e a saída ocorre no preço observado. Para novas entradas adaptativas no motor de exploração, o plano guarda versão, escala, limiares, hash e snapshot dos preços conhecidos. Não há redimensionamento retroativo de posições abertas. As alternativas `pullback-hours-adaptive` e `pullback-day-adaptive` participam da mesma parcela de exploração já configurada e acumulam resultados separados das duas alternativas de tendência anteriores. As regras curtas continuam sendo avaliadas sem movimentar caixa quando o foco é tendência; ETFs e pools não recebem essas alternativas.

A V2 é arquivada separadamente da V1; os modelos de previsão antigos, os saldos, o aprendizado e os históricos de perda são preservados. O painel oferece **Testar recuos, custos e volatilidade**, com motivos e planos recolhidos. A seleção por lucro exige os mesmos mínimos de amostra, cobertura, custos dobrados, retirada da melhor operação e vantagem contra a referência. Nenhuma mudança habilita dinheiro real, altera os 20% configurados ou libera novas compras de pools.

Para um histórico local em minutos, o importador aceita `--mode trend-adaptive`, mantendo BRL, disponibilidade temporal e ausência de interpolação obrigatórios. Os estudos automáticos alternam os arquivos V1/V2 que estejam sem atualização há seis horas, usando somente cotações auditadas.
