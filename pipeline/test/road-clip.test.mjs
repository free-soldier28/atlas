// untagged footway vs carriageway clipping: cut only a near-perpendicular crossing, keep sidewalks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRoadIndex, footwayRoadRuns, makeFootprintIndex, footwayNearBuilding, footwayOnRoad, footwayOnRoadRuns, footwayStub } from '../lib/road-clip.mjs';

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

test('a short orphan footway is a stub; a crossing or a real road is not', () => {
  const short = { cls: 9, flags: 4, pts: [0, 0, 600, 0] }; // 6 m clipped stub, in cm
  assert.equal(footwayStub(short), true);
  assert.equal(footwayStub({ ...short, flags: 0 }), false, 'a short mapped path is not a clip artifact');
  assert.equal(footwayStub({ ...short, pts: [0, 0, 2000, 0] }), false, '20 m approach stays');
  assert.equal(footwayStub({ ...short, isCrossing: true }), false, 'tagged crossing spans the road');
  assert.equal(footwayStub({ ...short, cls: 4 }), false, 'carriageway is never a stub');
  assert.equal(footwayStub({ ...short, flags: 2 }), false, 'bridge deck is never a stub');
});

test('a path skirting a building and lying on the road is cut; an ordinary sidewalk is not', () => {
  const buildings = makeFootprintIndex([{ pts: [0, 0, 20, 0, 20, 20, 0, 20] }]);
  const roads = makeRoadIndex([{ cls: 5, width: 10, pts: [-100, 25, 100, 25] }]);
  const path = [10, 15, 10, 35];
  assert.equal(footwayNearBuilding(path, buildings), true);
  assert.ok(footwayOnRoad(path, roads) >= .5, 'most of the detour is on the asphalt');
  const runs = footwayOnRoadRuns(path, roads);
  assert.ok(runs && runs.length === 0, 'the on-road piece and its tiny approaches are dropped');
  const sidewalk = [40, 15, 40, 35]; // near the road, but not near any building
  assert.equal(footwayNearBuilding(sidewalk, buildings), false, 'an ordinary sidewalk stays whole');
  const entrance = [10, 8, 10, 11]; // a short step inside the wall, well clear of the road
  assert.equal(footwayNearBuilding(entrance, buildings), true);
  assert.equal(footwayOnRoad(entrance, roads), 0);
});
