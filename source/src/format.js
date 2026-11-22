// MPK v1 reader (see docs/mpk-format.md). Plain functions: the build concatenates this file.
// Pure JS (no WebGPU/WebAudio), so node tests can eval it directly.
function mpkOpen(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0x314b504d) throw new Error('not an MPK file');
  const hLen = dv.getUint32(4, true);
  const h = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hLen)));
  if (h.v !== 1) throw new Error(`MPK v${h.v} unsupported (want 1)`);
  return { h, u8, dv, tiles: new Map() };
}
const mpkInflate = async (b) => new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();

// tile (i): { x, z, lods: [ [layer, ...], ... ] } — layer by kind:
// 1 buildings {pts: Int32Array(nPts*2), bkind, roof, h10, base10} per record
// 2 roads {cls, flags, name, lanes, w10, pts} · 3/4 water-green {kind, pts}
// 5 terrainPatch {cell, h: Int16Array}
async function mpkTile(P, i) {
  let t = P.tiles.get(i);
  if (t) return t;
  const [x, z, off, len] = P.h.tiles[i];
  const u8 = new Uint8Array(await mpkInflate(P.u8.subarray(off, off + len)));
  const dv = new DataView(u8.buffer), rd = [];
  let p = 0;
  const u8v = () => dv.getUint8(p++), u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; },
    i16 = () => { const v = dv.getInt16(p, true); p += 2; return v; }, u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; },
    i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const nLod = u8v();
  for (let l = 0; l < nLod; l++) {
    const layers = [], nLayers = u8v();
    for (let k = 0; k < nLayers; k++) {
      const kind = u8v(), n = u32(), recs = [];
      for (let r = 0; r < n; r++) {
        if (kind === 1) {
          const nPts = u16(), bkind = u8v(), roof = u8v(), h10 = i16(), base10 = i16();
          const pts = new Int32Array(nPts * 2); for (let j = 0; j < nPts * 2; j++) pts[j] = i32();
          recs.push({ pts, bkind, roof, h10, base10 });
        } else if (kind === 2) {
          const cls = u8v(), flags = u8v(), name = u16(), lanes = u8v(), w10 = i16(), nPts = u16();
          const pts = new Int32Array(nPts * 2); for (let j = 0; j < nPts * 2; j++) pts[j] = i32();
          recs.push({ cls, flags, name, lanes, w10, pts });
        } else if (kind === 3 || kind === 4) {
          const wkind = u8v(), nPts = u16();
          const pts = new Int32Array(nPts * 2); for (let j = 0; j < nPts * 2; j++) pts[j] = i32();
          recs.push({ kind: wkind, pts });
        } else if (kind === 5) {
          const cell = u8v(), n = u8v(); const h = new Int16Array(n * n); for (let j = 0; j < n * n; j++) h[j] = i16();
          recs.push({ cell, h });
        } else { // unknown: skip the whole layer (forward compatibility)
          recs.push.apply(recs, [{ skip: true }]);
          break;
        }
      }
      layers.push({ kind, recs });
    }
    rd.push(layers);
  }
  P.tiles.set(i, t = { x, z, lods: rd });
  return t;
}

// routing graph: { nx: Int32Array, nz, ea: Uint32Array, eb, ecls, eflags, ename, elanes, espeed, elen }
async function mpkGraph(P) {
  if (!P.h.graph || P.graph) return P.graph;
  const u8 = new Uint8Array(await mpkInflate(P.u8.subarray(P.h.graph.off, P.h.graph.off + P.h.graph.len)));
  const dv = new DataView(u8.buffer);
  let p = 0; const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; }, i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; }, u16 = () => { const v = dv.getUint16(p, true); p += 2; return v; };
  const nN = u32(), nx = new Int32Array(nN), nz = new Int32Array(nN);
  for (let i = 0; i < nN; i++) { nx[i] = i32(); nz[i] = i32(); }
  const nE = u32(), ea = new Uint32Array(nE), eb = new Uint32Array(nE), ec = new Uint8Array(nE), ef = new Uint8Array(nE), en = new Uint16Array(nE), el = new Uint8Array(nE), es = new Uint16Array(nE), ed = new Uint32Array(nE);
  for (let i = 0; i < nE; i++) { ea[i] = u32(); eb[i] = u32(); ec[i] = dv.getUint8(p++); ef[i] = dv.getUint8(p++); en[i] = u16(); el[i] = dv.getUint8(p++); es[i] = u16(); ed[i] = u32(); }
  return (P.graph = { nx, nz, ea, eb, ecls: ec, eflags: ef, ename: en, elanes: el, espeed: es, elen: ed });
}
