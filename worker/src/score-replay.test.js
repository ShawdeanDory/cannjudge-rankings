import assert from 'node:assert/strict';
import test from 'node:test';
import { createArchive, encodeArchive, mergeArchive, observeSnapshot, replayScores } from '../../docs/score-replay.js';

const hard = { id: 'hard', title: 'Hard', difficulty: 3 };
const easy = { id: 'easy', title: 'Easy', difficulty: 1 };
const names = ['us', 'other', 'missing'];
const submit = (team, score, sid, hour, rank, status = 'Pass') =>
  ({ team, score, sid, time: '2026-11-10T0' + hour + ':00:00Z', rank, status });
const snapshot = (hour, hardRows, easyRows) => ({
  ready: true, generated_at: Date.parse('2026-11-10T0' + hour + ':30:00Z') / 1000,
  total: { rows: names.map((team, i) => ({ team, score: 0, rank: i + 1, subs: 1 })) },
  problems: [hard, easy],
  by_problem: { hard: { complete: true, rows: hardRows }, easy: { complete: true, rows: easyRows } },
});

test('replays older public peaks, moves the first-place reward and flags only replacement submissions', () => {
  const old = snapshot(1, [submit('other', 85, 'old', 1, 1), submit('us', 72, 'us', 1, 2)],
    [submit('other', 60, 'same', 1, 1)]);
  const current = snapshot(2, [submit('us', 70, 'us', 1, 1), submit('other', 60, 'new', 2, 2)],
    [submit('other', 54, 'same', 1, 1), submit('missing', 0, 'fail', 2, 2, 'Wrong Answer')]);
  const original = createArchive();
  observeSnapshot(original, old);
  observeSnapshot(original, current);
  const archive = createArchive();
  mergeArchive(archive, JSON.parse(JSON.stringify(encodeArchive(original))));

  const { selected, ranked } = replayScores(current, archive, 'us');
  assert.equal(selected.replay, 21000);
  assert.equal(selected.replayRank, 2);
  assert.deepEqual(selected.drops, []);
  assert.equal(ranked[0].team, 'other');
  assert.equal(ranked[0].replay, 35500);
  assert.deepEqual(ranked[0].drops.map(drop => [drop.problem.id, drop.earlier.score, drop.base]), [['hard', 8500, 6000]]);
  assert.deepEqual(ranked[2].thresholds.map(item => [item.problem.id, item.score]), [['hard', 7001]]);
});

test('one missing question can overtake by also removing the selected team’s first-place bonus', () => {
  const current = snapshot(2, [submit('us', 80, 'us', 1, 1)], [submit('us', 25, 'us2', 1, 1)]);
  const { ranked } = replayScores(current, createArchive(), 'us');
  assert.equal(ranked[1].thresholds[0].score, 8167);
});
