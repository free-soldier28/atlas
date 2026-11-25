// untagged footway vs carriageway clipping: cut only a near-perpendicular crossing, keep sidewalks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoadIndex, footwayRoadRuns } from '../lib/road-clip.mjs';

const roads = makeRoadIndex([{ cls: 4, width: 12, pts: [-100, 0, 100, 0] }]);

test('a footway crossing the road is cut, both approaches kept', () => {
  const runs = footwayRoadRuns([0, -20, 0, 20], roads);
  assert.ok(runs, 'crossing detected');
  assert.equal(runs.length, 2, 'two dry approaches');
  assert.ok(runs[0][1] < -6 && runs[1][1] > 6, 'cut spans the asphalt');
});

test('a sidewalk along the road is untouched', () => {
  assert.equal(footwayRoadRuns([0, 6, 100, 6], roads), null, 'parallel way stays whole');
});

test('a short footway completely inside the corridor is dropped', () => {
  const runs = footwayRoadRuns([0, -1, 0, 1], roads);
  assert.ok(!runs || runs.length === 0);
});
