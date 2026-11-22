// MPK v1 writer (see docs/mpk-format.md). The encoder reference; source/src/format.js decodes exactly this.
import { deflateRawSync } from 'node:zlib';

// little-endian byte writer with packed (unaligned) integers
class BW {
  constructor() { this.a = new ArrayBuffer(1 << 16); this.dv = new DataView(this.a); this.p = 0; }
  need(n) { if (this.p + n > this.a.byteLength) { const b = new ArrayBuffer(max2(this.a.byteLength * 2, this.p + n)); new Uint8Array(b).set(new Uint8Array(this.a, 0, this.p)); this.a = b; this.dv = new DataView(b); } }
  u8(v) { this.need(1); this.dv.setUint8(this.p++, v); }
  u16(v) { this.need(2); this.dv.setUint16(this.p, v, true); this.p += 2; }
  i16(v) { this.need(2); this.dv.setInt16(this.p, v, true); this.p += 2; }
  u32(v) { this.need(4); this.dv.setUint32(this.p, v, true); this.p += 4; }
  i32(v) { this.need(4); this.dv.setInt32(this.p, v, true); this.p += 4; }
  bytes(b) { this.need(b.length); new Uint8Array(this.a, this.p, b.length).set(b); this.p += b.length; }
  done() { return new Uint8Array(this.a, 0, this.p); }
}
const max2 = (a, b) => (a > b ? a : b);

export class MPKBuilder {
  constructor(o) {
    this.h = { v: 1, id: o.id, name: o.name, attribution: o.attribution || '© OpenStreetMap contributors',
      origin: o.origin, tileSize: o.tileSize || 512, bbox: o.bbox, strings: [], tiles: [], graph: null, terrain: null,
      poses: o.poses || null, fly: o.fly || null };
    this.blobs = [];
  }
  str(s) { if (s === undefined || s === null || s === '') return 0; let i = this.h.strings.indexOf(s); if (i < 0) { i = this.h.strings.length; this.h.strings.push(s); } return i; }
  // tile(x, z, lods): lods = [ [layer, ...], ... ]; layer = { kind, recs } with recs matching the format doc
  tile(x, z, lods) {
    const w = new BW();
    w.u8(lods.length);
    for (const layers of lods) {
      w.u8(layers.length);
      for (const L of layers) {
        w.u8(L.kind); w.u32(L.recs.length);
        for (const r of L.recs) {
          if (L.kind === 1) { w.u16(r.pts.length / 2); w.u8(r.bkind | 0); w.u8(r.roof | 0); w.i16(r.h10 | 0); w.i16(r.base10 | 0); for (const v of r.pts) w.i32(v); }
          else if (L.kind === 2) { w.u8(r.cls); w.u8(r.flags | 0); w.u16(this.str(r.name)); w.u8(r.lanes | 0); w.i16(r.w10 | 0); w.u16(r.pts.length / 2); for (const v of r.pts) w.i32(v); }
          else if (L.kind === 3 || L.kind === 4) { w.u8(r.kind); w.u16(r.pts.length / 2); for (const v of r.pts) w.i32(v); }
          else if (L.kind === 5) { w.u8(r.cell); w.u8(Math.sqrt(r.h.length)); for (const v of r.h) w.i16(v); }
          else throw new Error(`unknown layer kind ${L.kind}`);
        }
      }
    }
    const off = this.fileLen(), b = deflateRawSync(w.done(), { level: 9 });
    this.blobs.push(b); this.h.tiles.push([x, z, off, b.length]);
  }
  graph(nodes, edges) {
    const w = new BW(); w.u32(nodes.length); for (const n of nodes) { w.i32(n[0]); w.i32(n[1]); }
    w.u32(edges.length);
    for (const e of edges) { w.u32(e.a); w.u32(e.b); w.u8(e.cls); w.u8(e.flags | 0); w.u16(this.str(e.name)); w.u8(e.lanes | 0); w.u16(e.speed | 0); w.u32(e.len | 0); }
    const off = this.fileLen(), b = deflateRawSync(w.done(), { level: 9 });
    this.blobs.push(b); this.h.graph = { off, len: b.length };
  }
  terrain(grid, cell, nx, nz) {
    const w = new BW(); for (let i = 0; i < nx * nz; i++) w.i16(grid[i]);
    const off = this.fileLen(), b = deflateRawSync(w.done(), { level: 9 });
    this.blobs.push(b); this.h.terrain = { off, len: b.length, cell, nx, nz };
  }
  fileLen() { return 8 + this.hLen + this.blobs.reduce((s, b) => s + b.length, 0); }
  // blob offsets live in the header, the header length depends on the offsets: iterate until it stops moving
  finish() {
    let len = 1024;
    for (let i = 0; i < 8; i++) {
      let off = 8 + len;
      for (const t of this.h.tiles) { t[2] = off; off += t[3]; }
      if (this.h.graph) { this.h.graph.off = off; off += this.h.graph.len; }
      if (this.h.terrain) { this.h.terrain.off = off; off += this.h.terrain.len; }
      const hj = Buffer.from(JSON.stringify(this.h), 'utf8');
      if (hj.length === len) return Buffer.concat([Buffer.from('MPK1', 'latin1'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(hj.length); return b; })(), hj, ...this.blobs]);
      len = hj.length;
    }
    throw new Error('MPK header offsets did not converge');
  }
}

// geodetic → local metres (the pack origin frame); shared by every pipeline script
export const geoToLocal = (lat, lon, lat0, lon0) => [(lon - lon0) * Math.cos(lat0 * Math.PI / 180) * 111320, -(lat - lat0) * 111320];
