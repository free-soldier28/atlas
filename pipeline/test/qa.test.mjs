// the pack quality gate as a test: every defect class this project has shipped must stay at zero
// on the reference pack — a new city runs the same qa() in its build and fails on errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qa } from '../qa.mjs';

test('pack QA: rings, heights, bbox, water overlaps, road joint coverage', async () => {
  const rep = await qa('packs/grodno.mpk');
  const by = (c) => rep.errors.filter((e) => e.check === c);
  assert.equal(by('rings').length, 0, 'rings: ' + by('rings')[0]?.msg);
  assert.equal(by('heights').length, 0, 'heights: ' + by('heights')[0]?.msg);
  assert.equal(by('bbox').length, 0, 'bbox: ' + by('bbox')[0]?.msg);
  assert.equal(by('waterOverlap').length, 0, 'waterOverlap: ' + by('waterOverlap')[0]?.msg);
  assert.equal(by('roadJoints').length, 0, 'roadJoints: ' + by('roadJoints')[0]?.msg);
  assert.equal(by('footwayStubs').length, 0, 'footwayStubs: ' + by('footwayStubs')[0]?.msg);
  assert.equal(by('deckOverPath').length, 0, 'deckOverPath: ' + by('deckOverPath')[0]?.msg);
  console.log(`qa: tiles ${rep.stats.tiles}, road joints ${rep.stats.roadJoints} (gaps ${rep.stats.roadJointGaps}), warns ${rep.warns.length}`);
  for (const w of rep.warns) console.log('  warn:', w.check, w.msg);
});
