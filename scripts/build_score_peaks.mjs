import { readFileSync, writeFileSync } from 'node:fs';
import { createArchive, encodeArchive, mergeArchive, observeSnapshot } from '../docs/score-replay.js';

const [output, ...inputs] = process.argv.slice(2);
if (!output || !inputs.length) throw new Error('Usage: node scripts/build_score_peaks.mjs OUTPUT INPUT [INPUT ...]');
const archive = createArchive();
for (const path of inputs) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (Array.isArray(data?.problems) && data.firstAt > 0 && data.latestAt >= data.firstAt) {
    mergeArchive(archive, data);
  } else if (data?.by_problem || Array.isArray(data)) {
    for (const snapshot of Array.isArray(data) ? data : [data]) observeSnapshot(archive, snapshot);
  } else {
    throw new Error('Unsupported score archive or snapshot: ' + path);
  }
}
const { firstAt, latestAt, problems } = encodeArchive(archive);
if (!problems.length) throw new Error('No complete snapshots with valid scores');
const entries = problems.map(problem => JSON.stringify(problem));
writeFileSync(output, '{"firstAt":' + firstAt + ',"latestAt":' + latestAt +
  ',"problems":[\n' + entries.join(',\n') + '\n]}\n');
console.log('Shared score archive through ' + new Date(latestAt * 1000).toISOString());
