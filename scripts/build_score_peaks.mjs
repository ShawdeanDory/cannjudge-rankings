import { readFileSync, writeFileSync } from 'node:fs';
import { createArchive, encodeArchive, observeSnapshot } from '../docs/score-replay.js';

const [output, ...inputs] = process.argv.slice(2);
if (!output || !inputs.length) throw new Error('Usage: node scripts/build_score_peaks.mjs OUTPUT SNAPSHOT [SNAPSHOT ...]');
const archive = createArchive();
for (const path of inputs) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  for (const snapshot of Array.isArray(data) ? data : [data]) observeSnapshot(archive, snapshot);
}
const { firstAt, latestAt, problems } = encodeArchive(archive);
if (!problems.length) throw new Error('No complete snapshots with valid scores');
const entries = problems.map(problem => JSON.stringify(problem));
writeFileSync(output, '{"firstAt":' + firstAt + ',"latestAt":' + latestAt +
  ',"problems":[\n' + entries.join(',\n') + '\n]}\n');
