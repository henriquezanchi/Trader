import { runTrendStudy,runAdaptiveTrendStudy } from '../lib/trend-study.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { importMinuteCSV } from '../lib/minute-import.mjs';
import { runWalkForward } from '../lib/walk-forward.mjs';
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--input','--asset','--source','--currency','--output','--mode'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw Error('Uso: node scripts/minute-research.mjs --input arquivo.csv --asset bitcoin --source fornecedor --currency BRL --output estudo.json');
  options[args[i]] = args[i + 1];
}
if (!options['--input'] || !options['--output']) throw Error('Informe --input e --output');
if (options['--input'] === options['--output']) throw Error('O relatório deve ser salvo em outro arquivo');
const imported = importMinuteCSV(await readFile(options['--input'], 'utf8'), { asset: options['--asset'], source: options['--source'], currency: options['--currency'] });
if (options['--mode'] && !['walk-forward','trend-exits','trend-adaptive'].includes(options['--mode'])) throw Error('Modo inválido');
const run = options['--mode']==='trend-adaptive'?runAdaptiveTrendStudy:options['--mode']==='trend-exits'?runTrendStudy:runWalkForward;
const result = run(imported.observations, options['--asset'], { source: options['--source'], manifest: imported.manifest });
await writeFile(options['--output'], JSON.stringify(result), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result.report.summary, null, 2));
