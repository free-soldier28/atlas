// pack loader: where the mpk comes from, and the world lifecycle the engine drives.
// v0: one pack, embedded (base64, build.mjs --pack=) or fetched. AGENT-STREAM replaces
// the source with tile-wise range reads and adds LRU/unload; callers use loadPack()/disposeWorld().

const ENGINE = 'atlas 0.1'; // engine version, shown in the drawer footer

// city choice: ?city= wins, else the stored one, else Grodno — the embedded pack is the main build
let CITY = 'grodno';
try { CITY = QP.get('city') || localStorage.atlasCity || CITY; } catch {}
const PACK_URL = `packs/${CITY}.mpk`;
let CITIES = null; // manifest entries once packs/manifest.json loads: { cities: [{ id, name, url }] }
const EMBEDDED_PACK = /*PACK*/null;
let PK = null; // opened pack (mpkOpen result) once loadPack() has run

async function loadPack(url = PACK_URL) {
  // city menu: the manifest is optional (absent on file:// where fetch cannot read it)
  try { const r = await fetch('packs/manifest.json'); if (r.ok) { CITIES = await r.json(); mkCities(); } } catch {}
  const m = CITIES && CITIES.cities.find((c) => c.id === CITY), u = m ? m.url : url;
  // an embedded pack serves file:// and offline opens (no manifest to choose from); a city picked
  // in the drawer or ?city= overrides it, so the switcher actually switches
  let src;
  if (EMBEDDED_PACK && !m) src = await openRange(u, fetch, { bytes: Uint8Array.from(atob(EMBEDDED_PACK), (c) => c.charCodeAt(0)) });
  else src = await openRange(u, fetch, { forceFull: QP.has('norange') });
  PK = mpkOpen(src.u8);
  if (src.read) PK.read = src.read; // tiles + graph come from Range reads, not one big buffer
  PK.range = { ranged: src.ranged, total: src.total };
  if (QP.has('log')) console.log(`pack source: ${src.ranged ? `range (${src.total} bytes on disk)` : 'in memory'}`);
  // the loading plate and the drawer footer say what the pack says about itself
  const cn = $('cn'); if (cn) cn.textContent = PK.h.name || '';
  const at = $('at'); if (at && PK.h.attribution) at.textContent = PK.h.attribution;
  const pv = $('pv'); if (pv) pv.textContent = `${PK.h.name || ''} · ${PK.h.attribution || ''} · ${ENGINE}`;
  return PK;
}

// City menu: one button per manifest city, the current one lit; another choice is stored and reloaded
const mkCities = () => {
  const el = $('ci');
  if (!el || !CITIES.cities.length) return;
  for (const c of CITIES.cities) {
    const b = document.createElement('button');
    b.textContent = c.name;
    if (c.id === CITY) b.className = 'on';
    else b.onclick = () => { try { localStorage.atlasCity = c.id; } catch {} const h = new URL(location.href); h.searchParams.delete('city'); location.href = h.href; };
    el.append(b);
  }
  el.hidden = false;
};

// world lifecycle (v0 stubs; AGENT-STREAM owns the real versions)
// setMode: the two profiles the camera system drives. The overview mode shows the whole
// route over the country pack; street mode follows the vehicle. Only 'street' exists in v0.
let MODE = 'street';
const setMode = (m) => { MODE = m; };
// vehicle pose entry point: navigation, GPS and the simulator all come through here,
// lat/lon in degrees (WGS-84), heading in radians from north, clockwise. The world maps
// it to the local frame and moves the marker + follow camera. No allocation: the pose
// lands in VEHICLE, the conversions share the GEO scratch pair.
const GEO = new Float64Array(2);
const VEHICLE = { x: 0, y: 0, z: 0, yaw: 0, sx: 0, sz: 0, edge: -1, got: false }; // sx/sz: snapped point, edge: graph edge
const geodeticToLocal = (lat, lon) => {
  const [lat0, lon0] = PK.h.origin, k = Math.cos(lat0 * PI / 180) * 111320;
  GEO[0] = (lon - lon0) * k; GEO[1] = -(lat - lat0) * 111320;
  return GEO;
};
const localToGeodetic = (x, z) => {
  const [lat0, lon0] = PK.h.origin, k = Math.cos(lat0 * PI / 180) * 111320;
  GEO[0] = lat0 - z / 111320; GEO[1] = lon0 + x / k;
  return GEO;
};
const setVehiclePose = (lat, lon, heading = 0) => {
  const g = geodeticToLocal(lat, lon);
  VEHICLE.x = g[0]; VEHICLE.y = 0; VEHICLE.z = g[1]; VEHICLE.yaw = heading; VEHICLE.got = true;
};
