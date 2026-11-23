// Range-capable MPK source: read the header first, then each tile's [off,len] slice on demand.
// Servers that honour Range get 206 and we never download the whole pack; servers that ignore it
// (and file:// / embedded packs) fall back to an in-memory Uint8Array. `fetchFn` is injectable so
// the Node tests can simulate both paths without a browser.
const openRange = async (url, fetchFn = fetch, opts = {}) => {
  if (opts.bytes) {
    const b = opts.bytes;
    return { u8: b, read: async (off, len) => b.subarray(off, off + len), ranged: false, total: b.byteLength };
  }
  const grab = async (a, b) => {
    const r = await fetchFn(url, { headers: { Range: `bytes=${a}-${b}` } });
    if (r.status !== 206 && !r.ok) throw new Error(`pack ${url}: HTTP ${r.status}`);
    return r;
  };
  if (!opts.forceFull) {
    let r;
    try { r = await grab(0, (opts.head || 131072) - 1); } catch { r = null; }
    if (r && r.status === 206) {
      let head = new Uint8Array(await r.arrayBuffer());
      // a pack may have a header larger than the first request (many tiles/strings)
      const need = 8 + new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4, true);
      if (head.byteLength < need) head = new Uint8Array(await (await grab(0, need - 1)).arrayBuffer());
      const total = Number((r.headers.get('content-range') || '').split('/')[1]) || head.byteLength;
      // tiles are stored contiguously; fetch aligned 64 KiB blocks so 980 tile reads become a
      // few dozen requests (and parallel prefetches inside a block coalesce into one).
      const CHUNK = 64 * 1024, blocks = new Map();
      const read = async (off, len) => {
        const a = Math.floor(off / CHUNK) * CHUNK, b = Math.min(total, Math.ceil((off + len) / CHUNK) * CHUNK);
        const key = a + ':' + b;
        let p = blocks.get(key);
        if (!p) {
          p = grab(a, b - 1).then(async (rr) => {
            if (rr.status !== 206) throw new Error('server ignored Range');
            return new Uint8Array(await rr.arrayBuffer());
          });
          blocks.set(key, p);
        }
        try { return (await p).subarray(off - a, off - a + len); } catch (e) { blocks.delete(key); throw e; }
      };
      return { u8: head, read, ranged: true, total };
    }
  }
  const r = await fetchFn(url);
  if (!r.ok) throw new Error(`pack ${url}: HTTP ${r.status}`);
  const all = new Uint8Array(await r.arrayBuffer());
  return { u8: all, read: async (off, len) => all.subarray(off, off + len), ranged: false, total: all.byteLength };
};
