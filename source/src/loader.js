// pack loader: where the mpk comes from, and the world lifecycle the engine drives.
// v0: one pack, embedded (base64, build.mjs --pack=) or fetched. AGENT-STREAM replaces
// the source with tile-wise range reads and adds LRU/unload; callers use loadPack()/disposeWorld().
const EMBEDDED_PACK = /*PACK*/null;
const PACK_URL = QP.get('city') ? `packs/${QP.get('city')}.mpk` : 'packs/sample.mpk';
let PK = null; // opened pack (mpkOpen result) once loadPack() has run

async function loadPack(url = PACK_URL) {
  let u8;
  if (EMBEDDED_PACK) u8 = Uint8Array.from(atob(EMBEDDED_PACK), (c) => c.charCodeAt(0));
  else {
    const r = await fetch(url);
    if (!r.ok) fail(`map pack ${url}: HTTP ${r.status}`);
    u8 = new Uint8Array(await r.arrayBuffer());
  }
  PK = mpkOpen(u8);
  return PK;
}

// world lifecycle (v0 stubs; AGENT-STREAM owns the real versions)
// setMode: the two profiles the camera system drives. The overview mode shows the whole
// route over the country pack; street mode follows the vehicle. Only 'street' exists in v0.
let MODE = 'street';
const setMode = (m) => { MODE = m; };
// vehicle pose entry point: navigation, GPS and the simulator all come through here,
// lat/lon in degrees (WGS-84), heading in radians from north, clockwise. The world maps
// it to the local frame and moves the marker + follow camera.
let VEHICLE = null; // { x, y, z, yaw } local, set by onVehiclePose
const geodeticToLocal = (lat, lon) => {
  const [lat0, lon0] = PK.h.origin, k = Math.cos(lat0 * PI / 180) * 111320;
  return [(lon - lon0) * k, -(lat - lat0) * 111320];
};
const setVehiclePose = (lat, lon, heading = 0) => { const [x, z] = geodeticToLocal(lat, lon); VEHICLE = { x, y: 0, z, yaw: heading }; };
