import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyHistory, fiveHourBaseline, recordRanking } from '../../docs/ranking-history.js';

function snapshot(at, sid, score, rank) {
  const totals = [{ team: 'rival', score: 80 }, { team: 'ours', score }];
  totals.sort((a, b) => b.score - a.score);
  return {
    ready: true, generated_at: at, total: { rows: totals }, problems: [{ id: 'a' }],
    by_problem: { a: { complete: true, rows: [{
      team: 'ours', sid, time: new Date((at - 20) * 1000).toISOString(), status: 'Pass', score, rank,
    }] } },
  };
}

test('five-hour comparison chooses a real nearby sample and refuses distant baselines', () => {
  const history = emptyHistory();
  const at = 1800000000;
  recordRanking(history, snapshot(at - 5 * 3600 - 180, '1', 75, 4));
  recordRanking(history, snapshot(at - 5 * 3600 + 60, '2', 76, 4));
  recordRanking(history, snapshot(at, '3', 88, 2));
  assert.equal(fiveHourBaseline(history, at).at, at - 5 * 3600 + 60);
  assert.equal(fiveHourBaseline(history, at + 40 * 60), null);
});

test('records one activity per changed submission and caps the latest ten for a question', () => {
  const history = emptyHistory();
  const start = 1800000000;
  recordRanking(history, snapshot(start, 'old', 75, 4));
  recordRanking(history, snapshot(start + 60, 'new', 88, 2));
  recordRanking(history, snapshot(start + 120, 'new', 89, 2));
  const [event] = new Map(history.events).get('ours');
  assert.equal(new Map(history.events).get('ours').length, 1);
  assert.deepEqual([event.previousScore, event.score, event.previousRank, event.rank, event.totalDelta, event.totalRankDelta],
    [75, 88, 4, 2, 13, 1]);
  for (let i = 3; i < 17; i++) recordRanking(history, snapshot(start + i * 60, 'submission-' + i, 89 + i, 2));
  const events = new Map(history.events).get('ours');
  assert.equal(events.length, 10);
  assert.equal(events[0].sid, 'submission-16');
});
