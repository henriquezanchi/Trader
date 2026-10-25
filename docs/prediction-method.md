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
