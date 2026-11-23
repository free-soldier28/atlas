// GPS: where the vehicle comes from — a simulator walking the pack's routing graph, live
// navigator fixes, or a manual ?lat=&lon= point — snap-to-road onto the graph, and the vehicle
// marker. All sources funnel into setVehiclePose() (loader.js); the follow camera (main.js),
// the marker and window.__drive read VEHICLE.
const SIMV = 14; // simulator speed, m/s
let gpsOn = false, gpsSrc = '', liveId = -1, tSnap = -1, pvx = 1e9, pvz = 1e9; // pv: last raw pose

// vehicle marker: one small cone, one instance of its own type, written straight into the
// instance buffer. The mesh + type are registered through the world's type()/put() pair
// (buildWorld exposes them); the row lives in the extra slot main.js appends to bInst.
const MQB = new ArrayBuffer(48), MQF = new Float32Array(MQB), MBU = new Uint32Array(MQB);
let mBuf = null, mOff = 0, mTy = -1, MKTINT = 0xffffffff;
const markerBuf = (b, off) => { mBuf = b; mOff = off; markerMove(0, -5, 0, 0); }; // parked underground until the first fix
const markerMove = (x, y, z, yaw) => {
  if (!mBuf) return;
  MQF[0] = x; MQF[1] = y; MQF[2] = z; MQF[3] = 1; // position, scale
  MQF[4] = 0; MQF[5] = sin(yaw / 2); MQF[6] = 0; MQF[7] = cos(yaw / 2); // yaw quaternion
  MBU[8] = MKTINT; MBU[9] = mTy; MQF[10] = 1e6; MQF[11] = 1; // tint, type, rad (ALWAYS: never culled), sy
  Q.writeBuffer(mBuf, mOff, MQB);
};
// the mesh: open 1.6 m cone in the one material that takes the instance tint
const mkMarker = (Wd) => {
  MKTINT = rgb(0.2, 0.5, 1);
  const mb = new MB(32); mb.mat = M.PLASTER;
  mb.lathe([[0.6, 0], [0, 1.6]], { seg: 10 });
  mTy = Wd.type([mb.build()], K.SOLID, 1e9, 1e9, 1e9, 0, ALWAYS);
  Wd.put(mTy, 0, -5, 0); // gives the type its instance count; the slot's bytes come from markerBuf
  return Wd.nI; // instances before this one: the slot the marker owns
};

// snap-to-road: nearest drivable graph edge segment within 40 m, linear scan (city scale),
// at most every 200 ms. Zero allocation: SGP caches the segments once, results land in VEHICLE.
let SGP = null; // per edge: ax, az, dx, dz in metres
const snap = (x, z) => {
  VEHICLE.edge = -1;
  const g = PK.graph; if (!g) return;
  if (!SGP) {
    SGP = new Float64Array(g.ea.length * 4);
    for (let e = 0; e < g.ea.length; e++) { const ax = g.nx[g.ea[e]] / 100, az = g.nz[g.ea[e]] / 100; SGP[e * 4] = ax; SGP[e * 4 + 1] = az; SGP[e * 4 + 2] = g.nx[g.eb[e]] / 100 - ax; SGP[e * 4 + 3] = g.nz[g.eb[e]] / 100 - az; }
  }
  let bd = 1600, be = -1, bx = 0, bz = 0;
  for (let e = 0; e < g.ea.length; e++) {
    const ax = SGP[e * 4], az = SGP[e * 4 + 1], dx = SGP[e * 4 + 2], dz = SGP[e * 4 + 3];
    const L2 = dx * dx + dz * dz;
    let t = L2 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + dx * t, pz = az + dz * t, d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d2 < bd) { bd = d2; be = e; bx = px; bz = pz; }
  }
  if (be >= 0) { VEHICLE.sx = bx; VEHICLE.sz = bz; VEHICLE.edge = be; }
};

// the simulator: a random walk over the drivable graph edges, fixed seed, looping forever
let SIMR = null, simNode = -1, simEdge = -1, simX = 0, simZ = 0, simYaw = 0;
const simStart = () => {
  SIMR = RNG(0xC17A); // every run drives the same streets
  simEdge = -1;
  const g = PK.graph; if (!g || !g.ea.length) return;
  let bn = 0, bd = 1e18; // the node nearest the pack origin
  for (let n = 0; n < g.nx.length; n++) { const d = g.nx[n] * g.nx[n] + g.nz[n] * g.nz[n]; if (d < bd) { bd = d; bn = n; } }
  simNode = bn; simX = g.nx[bn] / 100; simZ = g.nz[bn] / 100;
  simEdge = simNextEdge(bn, -1);
};
// a random drivable edge at node n, avoiding the one just used unless it is the only one
const simNextEdge = (n, prev) => {
  const g = PK.graph; let c = 0;
  for (let e = 0; e < g.ea.length; e++) if (e !== prev && g.ecls[e] < 8 && (g.ea[e] === n || g.eb[e] === n)) c++;
  if (!c) { prev = -1; for (let e = 0; e < g.ea.length; e++) if (g.ecls[e] < 8 && (g.ea[e] === n || g.eb[e] === n)) c++; }
  if (!c) return -1;
  let k = (SIMR() * c) | 0;
  for (let e = 0; e < g.ea.length; e++) if (e !== prev && g.ecls[e] < 8 && (g.ea[e] === n || g.eb[e] === n) && k-- === 0) return e;
  return -1;
};
// advance dist metres along the current edge, carrying the rest into the next one
const simStep = (dist) => {
  const g = PK.graph;
  for (let i = 0; dist > 1e-6 && simEdge >= 0 && i++ < 64;) {
    const e = simEdge, o = g.ea[e] === simNode ? g.eb[e] : g.ea[e];
    const tx = g.nx[o] / 100, tz = g.nz[o] / 100, dx = tx - simX, dz = tz - simZ, L = hypot(dx, dz);
    if (L < 1e-6) { simNode = o; simEdge = simNextEdge(o, e); continue; }
    simYaw = atan2(dx, -dz);
    if (L > dist) { simX += dx / L * dist; simZ += dz / L * dist; dist = 0; }
    else { simX = tx; simZ = tz; simNode = o; dist -= L; simEdge = simNextEdge(o, e); }
  }
};

// sources
const gpsLabel = () => { const b = $('gb'); if (b) { b.textContent = gpsOn ? gpsSrc : 'Off'; b.className = gpsOn ? 'on' : ''; } };
const gpsFail = (m) => { console.warn('gps: ' + m + ' — driving the simulator instead'); if (gpsSrc === 'live') setSrc('sim'); };
const liveStart = () => {
  if (!navigator.geolocation) return gpsFail('no geolocation API');
  liveId = navigator.geolocation.watchPosition((p) => setVehiclePose(p.coords.latitude, p.coords.longitude, (p.coords.heading || 0) * DEG),
    (e) => gpsFail(e.message), { enableHighAccuracy: true });
};
const setSrc = (s) => {
  if (liveId >= 0) { navigator.geolocation.clearWatch(liveId); liveId = -1; }
  gpsOn = !!s; gpsSrc = s || ''; pvx = 1e9; // no travel yaw out of a teleport
  if (s === 'sim') simStart();
  else if (s === 'live') liveStart();
  else if (s === 'manual') setVehiclePose(+QP.get('lat'), +QP.get('lon'), (+QP.get('heading') || 0) * DEG);
  gpsLabel();
};
const gpsToggle = () => { // key G / menu button
  if (gpsOn) setSrc(null);
  else if (QP.has('lat') && QP.has('lon')) setSrc('manual');
  else setSrc('live');
};
// called by main.js once the world exists: start what the query params ask for
const gpsStart = () => {
  if (QP.has('lat') && QP.has('lon')) setSrc('manual');
  else if (QP.get('gps') === 'sim') setSrc('sim');
  else if (QP.get('gps') === 'live') setSrc('live');
  else gpsLabel();
};

// per frame while GPS is on: advance the source, snap (>= 200 ms apart), steer the marker
const gpsFrame = (dt) => {
  if (gpsSrc === 'sim') { simStep(SIMV * dt); const g = localToGeodetic(simX, simZ); setVehiclePose(g[0], g[1], simYaw); }
  const v = VEHICLE;
  if (F[TIME] - tSnap >= 0.2) { tSnap = F[TIME]; snap(v.x, v.z); }
  if (v.got) {
    if (pvx < 1e8) { const dx = v.x - pvx, dz = v.z - pvz; if (dx * dx + dz * dz > 0.04) v.yaw = atan2(dx, -dz); } // travel yaw from the motion
    pvx = v.x; pvz = v.z;
    markerMove(v.edge >= 0 ? v.sx : v.x, v.y, v.edge >= 0 ? v.sz : v.z, v.yaw);
  }
};

// what tests read: position (local + geodetic), snapped point, edge, yaw, speed
const gpsState = () => {
  const v = VEHICLE, [lat0, lon0] = PK.h.origin, k = Math.cos(lat0 * PI / 180) * 111320;
  return { lat: lat0 - v.z / 111320, lon: lon0 + v.x / k, x: round(v.x * 10) / 10, z: round(v.z * 10) / 10, sx: round(v.sx * 10) / 10, sz: round(v.sz * 10) / 10, edge: v.edge, yaw: round(v.yaw / DEG), speed: SIMR ? SIMV : 0 };
};
const simAdvance = (ms) => { if (!SIMR) simStart(); simStep(SIMV * ms / 1000); const g = localToGeodetic(simX, simZ); setVehiclePose(g[0], g[1], simYaw); snap(VEHICLE.x, VEHICLE.z); return gpsState(); };

// ?auto&gps=sim headless self-test: AUTO starts no frame loop, so start one, then log the
// vehicle after ~3 s and keep #drive fresh every second for --dump-dom greps
const gpsAuto = () => {
  setSrc('sim');
  const el = $('drive');
  if (el) { el.hidden = false; setInterval(() => { el.textContent = 'drive=' + JSON.stringify(gpsState()); }, 1000); }
  setTimeout(() => console.log('[gps] sim after 3 s: ' + JSON.stringify(gpsState())), 3000);
  requestAnimationFrame((t) => { F[LAST] = t; requestAnimationFrame(frame); });
};
