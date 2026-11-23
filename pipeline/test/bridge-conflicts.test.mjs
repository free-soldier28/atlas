// bridge vs building conflicts: the fix in build-city and the guard in qa must agree on one rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, buildingHitsDeck, redundantDeck } from '../lib/bridge-conflicts.mjs';

// deck along x=0..100 at z=0, 12 m wide, 5 m high in the middle, ramps down at both ends
const deck = makeDeck([0, 0, 40, 0, 60, 0, 100, 0], [6, 500, 500, 6], 6);

test('building through the elevated span is caught', () => {
  const house = [30, -6, 40, -6, 40, 6, 30, 6];
  assert.equal(buildingHitsDeck(house, 9, deck), true);
});

test('a low structure under the span is not a conflict', () => {
  const shed = [50, -5, 60, -5, 60, 5, 50, 5];
  assert.equal(buildingHitsDeck(shed, 4, deck), false, 'the deck clears a 4 m garage');
});

test('banks and ramps below 1.2 m are free', () => {
  const house = [0, -5, 8, -5, 8, 5, 0, 5];
  assert.equal(buildingHitsDeck(house, 9, deck), false, 'no elevated deck above this footprint');
});

test('a big building straddling the corridor is caught by its centroid', () => {
  const big = [-20, -20, 120, -20, 120, 20, -20, 20];
  assert.equal(buildingHitsDeck(big, 9, deck), true);
});

test('far buildings are rejected by the bbox prefilter', () => {
  const far = [500, 500, 510, 500, 510, 510, 500, 510];
  assert.equal(buildingHitsDeck(far, 30, deck), false);
});

test('a short deck crossing a long one at the same height is redundant', () => {
  const long = makeDeck([0, 0, 100, 0, 200, 0, 300, 0, 400, 0], [6, 200, 500, 200, 6], 6);
  const short = makeDeck([90, 0, 110, 0], [6, 500, 6], 6); // crosses the long deck at x=100, both at 5 m
  assert.equal(redundantDeck(short, long), true);
  assert.equal(redundantDeck(long, short), false, 'the longer deck wins');
  const stacked = makeDeck([90, 0, 110, 0], [500, 900, 500], 6); // 9 m overhead: a real stacked crossing
  assert.equal(redundantDeck(stacked, long), false);
});
