import { readFileSync, writeFileSync } from 'node:fs';
import { emptyHistory, recordRanking } from '../docs/ranking-history.js';

const [output, previous, ...inputs] = process.argv.slice(2);
if (!output || !previous) throw new Error('Usage: node scripts/build_ranking_history.mjs OUTPUT PREVIOUS_OR_- [SNAPSHOT ...]');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const history = previous === '-' ? emptyHistory() : read(previous);
for (const path of inputs) {
  const samples = read(path);
  for (const data of Array.isArray(samples) ? samples : [samples]) recordRanking(history, data);
}
writeFileSync(output, JSON.stringify(history) + '\n');
console.log('Ranking history samples:', history.samples.length, 'Latest:', history.latest?.at);
