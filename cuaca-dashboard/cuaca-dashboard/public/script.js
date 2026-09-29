let fatalErrorShown = false;

function reportFatalError(msg) {
  console.error('[dashboard] Error:', msg);
  if (fatalErrorShown) return;
  fatalErrorShown = true;
  try {
    const el = document.getElementById('locStripText') || document.getElementById('locStrip');
    if (el) {
      el.textContent = `⚠️ Dashboard mengalami error: ${msg} — coba refresh paksa (Ctrl+Shift+R). Kalau masih terjadi, buka Console (F12) dan kirim pesan errornya.`;
    }
    document.querySelectorAll('.skeleton-row').forEach(s => { s.style.display = 'none'; });
  } catch {
  }
}

window.addEventListener('error', (e) => {
  reportFatalError(e.error?.message || e.message || 'kesalahan tidak diketahui');
});
window.addEventListener('unhandledrejection', (e) => {
  reportFatalError(e.reason?.message || String(e.reason) || 'kesalahan tidak diketahui');
});

const WIB_OFFSET = '+07:00';
const REFRESH_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const AUTO_CYCLE_MS = 5 * 1000;
const IDLE_RESUME_MS = 5 * 60 * 1000;
const WATCHDOG_MS = 30000;
const SUMSEL_BOUNDS = [[-4.95, 102.05], [-1.6, 106.35]];

const ICON_MAP = [
  [/hujan\s*petir|badai/i, '⛈️'],
  [/hujan\s*lebat/i, '🌧️'],
  [/hujan\s*sedang/i, '🌧️'],
  [/hujan\s*ringan|hujan\s*lokal|gerimis/i, '🌦️'],
  [/hujan/i, '🌧️'],
  [/kabut|asap|kabur/i, '🌫️'],
  [/berawan\s*tebal/i, '☁️'],
  [/cerah\s*berawan/i, '⛅'],
  [/berawan/i, '☁️'],
  [/cerah/i, '☀️'],
];

let province = null;
let regions = [];
let viewCode = 'all';
let state = null;
let highlighted = null;
let loadSeq = 0;
let showAllIcons = true;
let boundaryVisible = true;

let map = null;
let mapUnavailable = false;
let boundaryGroup = null;
let labelGroup = null;
let maskGroup = null;
let markerGroup = null;

let autoCycleTimer = null;
let idleResumeTimer = null;
let idleResumeAt = null;
let cycleVisited = [];

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function wibDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}
function wibWeekday(date) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', weekday: 'long' }).format(date);
}
function wibHour(date) {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false
  }).format(date));
}

function iconFor(desc = '') {
  for (const [regex, icon] of ICON_MAP) if (regex.test(desc)) return icon;
  return '🌤️';
}

function nearestTo(list, ts) {
  return list.reduce((best, cur) =>
    Math.abs(cur.time.getTime() - ts) < Math.abs(best.time.getTime() - ts) ? cur : best
  , list[0]);
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Gagal memuat ${url} (status ${res.status})`);
  return res.json();
}

function extractForecast(json) {
  let list = [];
  const lokasi = json?.lokasi || json?.data?.[0]?.lokasi || {};

  const dataArr = Array.isArray(json?.data) ? json.data : [];
  dataArr.forEach(d => {
    const cuaca = d?.cuaca;
    if (Array.isArray(cuaca)) {
      cuaca.forEach(group => {
        if (Array.isArray(group)) list.push(...group);
        else if (group) list.push(group);
      });
    }
  });

  if (list.length === 0 && Array.isArray(json?.cuaca)) {
    json.cuaca.forEach(group => {
      if (Array.isArray(group)) list.push(...group);
      else list.push(group);
    });
  }

  list = list
    .filter(x => x && x.local_datetime)
    .map(x => ({
      time: new Date(x.local_datetime.replace(' ', 'T') + WIB_OFFSET),
      t: Number(x.t),
      hu: Number(x.hu),
      desc: x.weather_desc || x.weather_desc_en || '-',
    }))
    .sort((a, b) => a.time - b.time);

  return { lokasi, list };
}

function locationLatLon(lokasi) {
  const lat = Number(lokasi?.lat ?? lokasi?.latitude ?? lokasi?.lintang);
  const lon = Number(lokasi?.lon ?? lokasi?.longitude ?? lokasi?.bujur);
  if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  return null;
}

function titleCase(text) {
  return String(text || '').toLowerCase().replace(/(^|[\s.\-/])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

function regionTitle(name) {
  return titleCase(name).replace(/^Kab\.?\s+/, 'Kabupaten ');
}

function regionLabelText(region) {
  return region.title.replace(/^Kabupaten\s+/, 'Kab. ');
}

function regionByCode(code) {
  return regions.find(r => r.code === code) || null;
}

function makeRegion(r) {
  return {
    code: r.code,
    name: r.name,
    title: regionTitle(r.name),
    districts: null,
    districtsPromise: null,
    repPoint: null,
    repPromise: null,
    repTried: false,
    boundary: null,
    boundaryLayer: null,
    labelMarker: null,
    boundaryPromise: null,
    boundaryAttempts: 0,
    boundaryTried: false,
    kecPoints: [],
    kecIndex: 0,
    kecLoading: false,
    kecDone: false,
  };
}

function isSelected(p) {
  return !!state && state.adm4 === p.adm4;
}

function tickClock() {
  const now = new Date();

  const time = new Intl.DateTimeFormat('id-ID', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, timeZone: 'Asia/Jakarta'
  }).format(now).replace(/:/g, '.');

  const date = new Intl.DateTimeFormat('id-ID', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Asia/Jakarta'
  }).format(now);

  setText('clock', `${time} WIB`);
  setText('dateLabel', date);
  renderAutoCycleStatus();
}

function renderLocStrip() {
  const el = document.getElementById('locStripText');
  if (!el) return;
  if (!state) { el.textContent = 'Memuat lokasi…'; return; }
  el.innerHTML = `Lokasi pemantauan: <strong>${state.villName}</strong>, Kec. ${state.distName}, ${regionTitle(state.regName)}`;
}

function renderAutoCycleStatus() {
  const el = document.getElementById('autoCycleStatus');
  if (!el) return;
  if (idleResumeAt) {
    const sisaMenit = Math.max(1, Math.ceil((idleResumeAt - Date.now()) / 60000));
    el.textContent = `✋ Dipilih manual — otomatis lagi dalam ~${sisaMenit} menit`;
  } else if (autoCycleTimer) {
    el.textContent = '🔄 Berpindah acak tiap 5 detik';
  } else {
    el.textContent = '';
  }
}

function renderForecast3(list) {
  const container = document.getElementById('forecast3List');
  if (!container) return;
  container.innerHTML = '';

  const byDate = new Map();
  list.forEach(item => {
    const key = wibDateKey(item.time);
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(item);
  });

  const todayKey = wibDateKey(new Date());
  const tomorrowKey = wibDateKey(new Date(Date.now() + 24 * 60 * 60 * 1000));

  const days = [...byDate.entries()].slice(0, 3);
  const globalMax = Math.max(...list.map(i => i.t));
  const globalMin = Math.min(...list.map(i => i.t));

  days.forEach(([key, items]) => {
    const temps = items.map(i => i.t);
    const min = Math.min(...temps);
    const max = Math.max(...temps);

    const midday = items.reduce((best, cur) =>
      Math.abs(wibHour(cur.time) - 12) < Math.abs(wibHour(best.time) - 12) ? cur : best
    );

    let label;
    if (key === todayKey) label = 'Hari ini';
    else if (key === tomorrowKey) label = 'Besok';
    else label = wibWeekday(midday.time);

    const posPct = globalMax === globalMin ? 50 : ((max - globalMin) / (globalMax - globalMin)) * 100;

    const row = document.createElement('div');
    row.className = 'f3-row';
    row.innerHTML = `
      <div class="f3-day">${label}</div>
      <div class="f3-icon">${iconFor(midday.desc)}</div>
      <div class="f3-bar">
        <span class="f3-dot" style="left:${posPct}%"></span>
        <span class="f3-min-label">${Math.round(min)}°</span>
        <span class="f3-max-label">${Math.round(max)}°</span>
      </div>
      <div class="f3-max">${Math.round(max)}°</div>
    `;
    container.appendChild(row);
  });
}

function renderHumidity(nearest) {
  const pct = Math.max(0, Math.min(100, nearest?.hu ?? 0));
  const circumference = 2 * Math.PI * 50;
  const arc = document.getElementById('gaugeArc');
  if (arc) arc.style.strokeDasharray = `${(pct / 100) * circumference} ${circumference}`;
  setText('humidityValue', `${Math.round(pct)}%`);
}

function renderTempChart(list) {
  const svg = document.getElementById('tempChart');
  const note = document.getElementById('tempNote');
  if (!svg) return;

  const now = Date.now();
  const points = list.filter(i => i.time.getTime() >= now).slice(0, 8);

  if (!points.length) {
    svg.innerHTML = '';
    if (note) note.textContent = '';
    return;
  }

  const rect = svg.getBoundingClientRect();
  const W = rect.width > 10 ? rect.width : 320;
  const H = rect.height > 10 ? rect.height : 150;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const temps = points.map(p => p.t);
  const min = Math.min(...temps);
  const max = Math.max(...temps) === min ? min + 1 : Math.max(...temps);

  const PAD_T = 38, PAD_B = 20;
  const usableH = Math.max(20, H - PAD_T - PAD_B);

  const coords = points.map((p, i) => {
    const x = points.length === 1 ? 0 : (i / (points.length - 1)) * W;
    const y = PAD_T + usableH - ((p.t - min) / (max - min)) * usableH;
    return [x, y];
  });

  const linePath = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${W},${H} L0,${H} Z`;

  const labels = points.map((p, i) => {
    const [x, y] = coords[i];
    const anchor = i === 0 ? 'start' : (i === points.length - 1 ? 'end' : 'middle');
    const lx = i === 0 ? x + 2 : (i === points.length - 1 ? x - 2 : x);
    const jam = p.time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).replace(':', '.');
    return `
      <text x="${lx.toFixed(1)}" y="${(y - 20).toFixed(1)}" font-size="10.5" font-weight="700" fill="#0B3C6B" text-anchor="${anchor}">${Math.round(p.t)}°</text>
      <text x="${lx.toFixed(1)}" y="${(y - 9).toFixed(1)}" font-size="8.5" fill="#6B7280" text-anchor="${anchor}">${jam}</text>
    `;
  }).join('');

  svg.innerHTML = `
    <defs>
      <linearGradient id="tempFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#0B3C6B" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#0B3C6B" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${areaPath}" fill="url(#tempFill)" stroke="none"/>
    <path d="${linePath}" fill="none" stroke="#0B3C6B" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${coords.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#F2A900" stroke="#0B3C6B" stroke-width="1"/>`).join('')}
    ${labels}
  `;

  if (note) note.textContent = 'Diambil langsung dari BMKG, diperbarui otomatis tiap 10 menit.';
}

function renderHourly(list) {
  const container = document.getElementById('hourlyStrip');
  if (!container) return;

  const now = Date.now();
  const upcoming = list.filter(i => i.time.getTime() >= now).slice(0, 8);
  container.innerHTML = '';

  upcoming.forEach(item => {
    const day = wibWeekday(item.time).slice(0, 3);
    const time = item.time.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' }).replace(':', '.');
    const div = document.createElement('div');
    div.className = 'hr-item';
    div.innerHTML = `
      <div class="hr-day">${day}</div>
      <div class="hr-time">${time}</div>
      <div class="hr-icon">${iconFor(item.desc)}</div>
      <div class="hr-desc">${item.desc}</div>
      <div class="hr-temp">${Math.round(item.t)}°C</div>
    `;
    container.appendChild(div);
  });
}

function updateNote() {
  const el = document.getElementById('mapLegendNote');
  if (!el) return;
  if (mapUnavailable) { el.textContent = 'Peta tidak tersedia.'; return; }
  if (!regions.length) { el.textContent = 'Memuat peta…'; return; }
  const total = regions.length;
  const reps = regions.filter(r => r.repTried).length;
  const bounds = regions.filter(r => r.boundaryTried).length;
  const parts = [];
  if (reps < total) parts.push(`ikon ${reps}/${total}`);
  if (bounds < total) parts.push(`batas ${bounds}/${total}`);
  const region = viewCode === 'all' ? null : regionByCode(viewCode);
  if (region && region.kecLoading) {
    parts.push(`kecamatan ${region.kecPoints.length}/${region.districts ? region.districts.length : '?'}`);
  }
  el.textContent = parts.length ? `Memuat ${parts.join(' · ')}…` : `${total} kabupaten/kota dimuat.`;
}

function syncSelect() {
  const sel = document.getElementById('selWilayah');
  if (sel && sel.value !== viewCode) sel.value = viewCode;
}

function populateSelect() {
  const sel = document.getElementById('selWilayah');
  if (!sel) return;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = 'Seluruh Sumatera Selatan';
  sel.appendChild(all);
  regions.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.code;
    opt.textContent = r.title;
    sel.appendChild(opt);
  });
  sel.value = viewCode;
  sel.addEventListener('change', () => { chooseRegion(sel.value); });
}

function toggleLegend() {
  const legend = document.getElementById('mapLegend');
  const btn = document.getElementById('btnLegend');
  if (!legend) return;
  const collapsed = legend.classList.toggle('collapsed');
  if (btn) {
    btn.textContent = collapsed ? '+' : '−';
    btn.title = collapsed ? 'Tampilkan legenda' : 'Sembunyikan legenda';
    btn.setAttribute('aria-label', btn.title);
  }
}

async function buildPoint(region, dist) {
  try {
    const villages = (await getJson(`/api/wilayah/villages/${dist.code}`)).data || [];
    if (!villages.length) return null;
    const vill = villages[0];

    const json = await getJson(`/api/cuaca?adm4=${encodeURIComponent(vill.code)}`);
    const { lokasi, list } = extractForecast(json);
    const latlon = locationLatLon(lokasi);
    if (!latlon || !list.length) return null;

    const nearest = nearestTo(list, Date.now());
    return {
      regCode: region.code, regName: region.name,
      distCode: dist.code, distName: dist.name,
      villCode: vill.code, villName: vill.name,
      adm4: vill.code,
      lat: latlon.lat, lon: latlon.lon,
      desc: nearest.desc, temp: nearest.t, hu: nearest.hu,
      marker: null,
    };
  } catch (err) {
    console.warn(`Lewati kecamatan ${dist.name}:`, err.message);
    return null;
  }
}

function ensureDistricts(region) {
  if (region.districts) return Promise.resolve(region.districts);
  if (!region.districtsPromise) {
    region.districtsPromise = getJson(`/api/wilayah/districts/${region.code}`)
      .then(data => {
        region.districts = data.data || [];
        return region.districts;
      })
      .finally(() => { region.districtsPromise = null; });
  }
  return region.districtsPromise;
}

function ensureRepPoint(region) {
  if (region.repPoint) return Promise.resolve(region.repPoint);
  if (!region.repPromise) {
    region.repPromise = (async () => {
      const districts = await ensureDistricts(region);
      const limit = Math.min(districts.length, 4);
      for (let i = 0; i < limit; i++) {
        const p = await buildPoint(region, districts[i]);
        if (p) { region.repPoint = p; break; }
      }
      return region.repPoint;
    })().finally(() => {
      region.repTried = true;
      region.repPromise = null;
    });
  }
  return region.repPromise;
}

async function loadRegionKecamatan(region) {
  if (region.kecDone || region.kecLoading) return;
  region.kecLoading = true;
  updateNote();
  try {
    const districts = await ensureDistricts(region);
    while (region.kecIndex < districts.length) {
      if (viewCode !== region.code) break;
      const dist = districts[region.kecIndex];
      const reusable = region.repPoint && region.repPoint.distCode === dist.code;
      const p = reusable ? region.repPoint : await buildPoint(region, dist);
      region.kecIndex += 1;
      if (p) {
        region.kecPoints.push(p);
        onPointsChanged(region);
      }
      updateNote();
      await wait(60);
    }
    if (region.kecIndex >= districts.length) region.kecDone = true;
  } catch (err) {
    console.warn(`Gagal memuat kecamatan ${region.title}:`, err.message);
  } finally {
    region.kecLoading = false;
    updateNote();
  }
}

async function loadAllRepPoints() {
  for (const region of regions) {
    try {
      await ensureRepPoint(region);
    } catch (err) {
      console.warn(`Lewati ${region.title}:`, err.message);
    }
    onPointsChanged(region);
    await wait(60);
  }
}

function boundaryQueries(region) {
  const provTitle = province ? titleCase(province.name) : 'Sumatera Selatan';
  const plain = region.title.replace(/^(Kabupaten|Kota)\s+/, '');
  return [...new Set([`${region.title}, ${provTitle}`, `${plain}, ${provTitle}`])];
}

function closeGeoJsonRings(geojson) {
  try {
    const closeRing = (ring) => {
      if (!Array.isArray(ring) || ring.length < 2) return ring;
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, first];
      return ring;
    };

    const feats = geojson.type === 'FeatureCollection' ? geojson.features
      : geojson.type === 'Feature' ? [geojson]
      : [{ type: 'Feature', geometry: geojson }];

    feats.forEach(f => {
      const geom = f?.geometry;
      if (!geom) return;
      if (geom.type === 'Polygon') {
        geom.coordinates = geom.coordinates.map(closeRing);
      } else if (geom.type === 'MultiPolygon') {
        geom.coordinates = geom.coordinates.map(poly => poly.map(closeRing));
      }
    });

    return geojson;
  } catch {
    return geojson;
  }
}

async function loadBoundary(query) {
  try {
    const results = await getJson(`/api/batas?nama=${encodeURIComponent(query)}`);
    const hit = Array.isArray(results) ? results[0] : null;
    return hit?.geojson ? closeGeoJsonRings(hit.geojson) : null;
  } catch (err) {
    console.warn('Gagal memuat batas wilayah:', err);
    return null;
  }
}

function ensureBoundary(region) {
  if (region.boundary) return Promise.resolve(region.boundary);
  if (region.boundaryAttempts >= 2) return Promise.resolve(null);
  if (!region.boundaryPromise) {
    region.boundaryAttempts += 1;
    region.boundaryPromise = (async () => {
      for (const query of boundaryQueries(region)) {
        const geojson = await loadBoundary(query);
        if (geojson) { region.boundary = geojson; break; }
      }
      return region.boundary;
    })().finally(() => {
      region.boundaryTried = true;
      region.boundaryPromise = null;
    });
  }
  return region.boundaryPromise;
}

async function loadAllBoundaries() {
  for (let pass = 0; pass < 2; pass++) {
    for (const region of regions) {
      if (region.boundary) continue;
      await ensureBoundary(region);
      renderBoundaries();
      updateNote();
      await wait(60);
    }
  }
}

function currentPoints() {
  if (viewCode === 'all') return regions.map(r => r.repPoint).filter(Boolean);
  const region = regionByCode(viewCode);
  return region ? region.kecPoints : [];
}

function visiblePoints() {
  if (showAllIcons) return currentPoints();
  return state ? [state] : [];
}

function ensureMap() {
  if (map || mapUnavailable) return;

  if (typeof L === 'undefined') {
    mapUnavailable = true;
    console.error('Leaflet tidak termuat - peta dilewati, sisa dashboard tetap jalan.');
    const mapDiv = document.getElementById('mapDiv');
    if (mapDiv) {
      mapDiv.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:20px;text-align:center;color:#6B7280;font-size:13px;">Peta tidak dapat dimuat (gagal mengambil pustaka peta dari CDN). Cek koneksi internet ke unpkg.com, lalu muat ulang halaman.</div>';
    }
    updateNote();
    return;
  }

  map = L.map('mapDiv', { zoomControl: true });
  map.createPane('maskPane').style.zIndex = 390;
  map.createPane('labelPane').style.zIndex = 450;
  map.getPane('labelPane').style.pointerEvents = 'none';

  const petaJalan = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  const citraSatelit = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18,
    attribution: 'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, GIS User Community'
  });

  const labelSatelit = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18,
    pane: 'shadowPane',
    attribution: 'Labels &copy; Esri, DeLorme',
  });

  L.control.layers(
    { 'Peta (jalan & nama tempat)': petaJalan, 'Citra satelit': citraSatelit },
    {},
    { position: 'topleft', collapsed: false }
  ).addTo(map);

  map.on('baselayerchange', (e) => {
    if (e.name === 'Citra satelit') map.addLayer(labelSatelit);
    else map.removeLayer(labelSatelit);
  });

  maskGroup = L.layerGroup();
  boundaryGroup = L.layerGroup();
  labelGroup = L.layerGroup();
  markerGroup = L.layerGroup();
  if (boundaryVisible) [maskGroup, boundaryGroup, labelGroup].forEach(g => g.addTo(map));
  markerGroup.addTo(map);

  map.fitBounds(SUMSEL_BOUNDS);
  setTimeout(() => {
    if (map) {
      map.invalidateSize();
      fitView();
    }
  }, 300);
}

function setBoundaryVisible(on) {
  boundaryVisible = on;
  if (!map || !boundaryGroup) return;
  [maskGroup, boundaryGroup, labelGroup].forEach(g => {
    if (on) map.addLayer(g); else map.removeLayer(g);
  });
}

function wxIcon(p, selected) {
  return L.divIcon({
    className: '',
    html: `<div class="wx-icon${selected ? ' selected' : ''}">${iconFor(p.desc)}</div>`,
    iconSize: selected ? [46, 46] : [32, 32],
    iconAnchor: selected ? [23, 23] : [16, 16],
    popupAnchor: [0, selected ? -22 : -14],
  });
}

function popupHtml(p) {
  const regTitle = regionTitle(p.regName);
  const title = viewCode === 'all' ? regTitle : `Kec. ${p.distName}`;
  const rows = [['Kab/Kota', regTitle]];
  if (viewCode === 'all') rows.push(['Kecamatan', p.distName]);
  rows.push(['Kel/Desa', p.villName]);
  rows.push(['Cuaca', p.desc]);
  rows.push(['Suhu', `${Math.round(p.temp)}°C · Kelembapan ${Math.round(p.hu)}%`]);
  return `<strong>${title}</strong><hr style="margin:4px 0;border:none;border-top:1px solid #E4E9F1">` +
    rows.map(([k, v]) => `${k}: <strong>${v}</strong>`).join('<br/>');
}

function ensureMarker(p) {
  if (!p.marker) {
    const marker = L.marker([p.lat, p.lon], { icon: wxIcon(p, isSelected(p)), riseOnHover: true });
    marker.bindPopup(() => popupHtml(p));
    marker.on('click', () => {
      if (!isSelected(p)) selectPoint(p, { manual: true });
    });
    p.marker = marker;
  }
  return p.marker;
}

function setMarkerIcon(p, selected) {
  if (p && p.marker) p.marker.setIcon(wxIcon(p, selected));
}

function renderMarkers() {
  if (!map || !markerGroup) return;
  try {
    const wanted = new Set(visiblePoints().map(ensureMarker));
    markerGroup.getLayers().forEach(m => {
      if (!wanted.has(m)) markerGroup.removeLayer(m);
    });
    wanted.forEach(m => {
      if (!markerGroup.hasLayer(m)) markerGroup.addLayer(m);
    });
  } catch (err) {
    console.warn('Gagal menggambar ikon cuaca:', err);
  }
}

function refreshSelectionHighlight() {
  if (!map) return;
  if (highlighted && highlighted !== state) {
    setMarkerIcon(highlighted, false);
    if (highlighted.marker) highlighted.marker.setZIndexOffset(0);
  }
  if (state) {
    setMarkerIcon(state, true);
    if (state.marker) state.marker.setZIndexOffset(1000);
  }
  highlighted = state;
  if (!showAllIcons) renderMarkers();
}

function keepInView(p) {
  if (!map || !p) return;
  if (!map.getBounds().contains([p.lat, p.lon])) map.panTo([p.lat, p.lon]);
}

function boundaryStyle(single) {
  return {
    color: '#3DDC84',
    weight: single ? 3.5 : 2,
    fillColor: '#3DDC84',
    fillOpacity: single ? 0 : 0.05,
    lineJoin: 'round',
    lineCap: 'round',
  };
}

function makeBoundaryLayer(region) {
  return L.geoJSON(region.boundary, {
    style: boundaryStyle(false),
    onEachFeature: (feature, layer) => {
      layer.on('click', () => {
        if (viewCode === 'all') chooseRegion(region.code);
      });
    },
  });
}

function makeLabel(region) {
  if (!region.labelMarker) {
    const center = region.boundaryLayer.getBounds().getCenter();
    region.labelMarker = L.marker(center, {
      icon: L.divIcon({
        className: 'region-label',
        html: `<span>${regionLabelText(region)}</span>`,
        iconSize: [0, 0],
      }),
      interactive: false,
      keyboard: false,
      pane: 'labelPane',
    });
  }
  return region.labelMarker;
}

function buildMask(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const holes = polygons
    .filter(poly => poly && poly[0])
    .map(poly => poly[0].map(([lng, lat]) => [lat, lng]));
  const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
  return L.polygon([world, ...holes], {
    pane: 'maskPane',
    stroke: false,
    fillColor: '#ffffff',
    fillOpacity: 0.7,
    interactive: false,
  });
}

function renderBoundaries() {
  if (!map || !boundaryGroup) return;
  try {
    boundaryGroup.clearLayers();
    labelGroup.clearLayers();
    maskGroup.clearLayers();
    const single = viewCode !== 'all';
    const visible = single ? regions.filter(r => r.code === viewCode) : regions;
    visible.forEach(region => {
      if (!region.boundary) return;
      if (!region.boundaryLayer) region.boundaryLayer = makeBoundaryLayer(region);
      region.boundaryLayer.setStyle(boundaryStyle(single));
      boundaryGroup.addLayer(region.boundaryLayer);
      labelGroup.addLayer(makeLabel(region));
    });
    if (single) {
      const region = regionByCode(viewCode);
      if (region && region.boundary) maskGroup.addLayer(buildMask(region.boundary));
    }
  } catch (err) {
    console.warn('Gagal menggambar batas wilayah:', err);
  }
}

function fitView() {
  if (!map) return;
  try {
    if (viewCode === 'all') {
      map.fitBounds(SUMSEL_BOUNDS, { padding: [10, 10] });
      return;
    }
    const region = regionByCode(viewCode);
    if (!region) return;
    if (region.boundaryLayer) {
      map.fitBounds(region.boundaryLayer.getBounds(), { padding: [24, 24], maxZoom: 11 });
      return;
    }
    const pts = region.kecPoints.length ? region.kecPoints : (region.repPoint ? [region.repPoint] : []);
    if (pts.length) {
      map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lon])).pad(0.3), { maxZoom: 11 });
    }
  } catch (err) {
    console.warn('Gagal menyesuaikan tampilan peta:', err);
  }
}

function applyView() {
  renderBoundaries();
  renderMarkers();
  fitView();
  updateNote();
  if (viewCode === 'all') return;
  const region = regionByCode(viewCode);
  if (!region) return;
  const hadBoundary = !!region.boundary;
  ensureBoundary(region)
    .then(() => {
      if (!hadBoundary && viewCode === region.code) {
        renderBoundaries();
        fitView();
      }
    })
    .catch(err => console.warn('Batas wilayah gagal:', err));
  loadRegionKecamatan(region);
}

function onPointsChanged(region) {
  if (viewCode === 'all' || viewCode === region.code) renderMarkers();
  ensureAutoCycle();
  updateNote();
}

function startAutoCycle() {
  if (autoCycleTimer) return;
  idleResumeAt = null;
  autoCycleTimer = setInterval(() => {
    const p = pickNextPoint();
    if (p && !isSelected(p)) selectPoint(p, { manual: false });
  }, AUTO_CYCLE_MS);
  renderAutoCycleStatus();
}

function stopAutoCycle() {
  if (autoCycleTimer) clearInterval(autoCycleTimer);
  autoCycleTimer = null;
}

function ensureAutoCycle() {
  if (!autoCycleTimer && !idleResumeAt && currentPoints().length >= 2) startAutoCycle();
}

function pauseAutoCycleForManualInteraction() {
  stopAutoCycle();
  idleResumeAt = Date.now() + IDLE_RESUME_MS;
  if (idleResumeTimer) clearTimeout(idleResumeTimer);
  idleResumeTimer = setTimeout(() => {
    idleResumeAt = null;
    idleResumeTimer = null;
    startAutoCycle();
  }, IDLE_RESUME_MS);
  renderAutoCycleStatus();
}

function markVisited(p) {
  if (!cycleVisited.includes(p.adm4)) cycleVisited.push(p.adm4);
}

function pickNextPoint() {
  const pts = currentPoints();
  if (!pts.length) return null;
  if (pts.length === 1) return pts[0];
  const keys = new Set(pts.map(p => p.adm4));
  cycleVisited = cycleVisited.filter(k => keys.has(k));
  let pool = pts.filter(p => !cycleVisited.includes(p.adm4) && !isSelected(p));
  if (!pool.length) {
    cycleVisited = state ? [state.adm4] : [];
    pool = pts.filter(p => !isSelected(p));
  }
  return pool[Math.floor(Math.random() * pool.length)] || null;
}

function selectPoint(p, { manual }) {
  if (manual) pauseAutoCycleForManualInteraction();
  state = p;
  markVisited(p);
  renderLocStrip();
  refreshSelectionHighlight();
  loadWeather();
}

async function chooseRegion(code) {
  if (code !== 'all' && !regionByCode(code)) return;
  pauseAutoCycleForManualInteraction();
  viewCode = code;
  cycleVisited = [];
  syncSelect();
  applyView();

  if (code === 'all') {
    const reps = currentPoints();
    const p = reps.find(x => state && x.regCode === state.regCode) || reps[0];
    if (p) selectPoint(p, { manual: false });
    return;
  }

  const region = regionByCode(code);
  let p = null;
  try {
    p = await ensureRepPoint(region);
  } catch (err) {
    console.warn(`Gagal memuat cuaca ${region.title}:`, err.message);
  }
  if (viewCode !== code) return;
  if (p) selectPoint(p, { manual: false });
  updateNote();
}

async function loadWeather() {
  if (!state?.adm4) return;
  const seq = ++loadSeq;
  const target = state;

  try {
    const json = await getJson(`/api/cuaca?adm4=${encodeURIComponent(target.adm4)}`);
    if (seq !== loadSeq) return;
    const { list } = extractForecast(json);
    if (!list.length) throw new Error('Data cuaca kosong dari BMKG untuk lokasi ini.');

    const nearest = nearestTo(list, Date.now());

    renderForecast3(list);
    renderHumidity(nearest);
    renderTempChart(list);
    renderHourly(list);
    setText('tempNow', `${Math.round(nearest.t)} °C`);

    target.desc = nearest.desc;
    target.temp = nearest.t;
    target.hu = nearest.hu;
    if (map && target.marker) setMarkerIcon(target, isSelected(target));
    keepInView(target);
  } catch (err) {
    if (seq !== loadSeq) return;
    console.error('Gagal memuat data cuaca:', err);
    const el = document.getElementById('forecast3List');
    if (el) el.innerHTML = `<p style="color:#B3261E;font-size:13px;">Gagal memuat data cuaca. Akan dicoba lagi otomatis.</p>`;
  }
}

async function init() {
  setText('locStripText', 'Memuat data Sumatera Selatan…');

  try {
    const provinces = (await getJson('/api/wilayah/provinces')).data || [];
    province = provinces.find(p => /sumatera selatan/i.test(p.name)) || null;
    if (!province) throw new Error('Provinsi Sumatera Selatan tidak ditemukan.');

    const list = (await getJson(`/api/wilayah/regencies/${province.code}`)).data || [];
    if (!list.length) throw new Error('Daftar kabupaten/kota kosong.');
    regions = list.map(makeRegion);
  } catch (err) {
    console.error('Gagal memuat data wilayah Sumatera Selatan:', err);
    setText('locStripText', 'Gagal memuat data wilayah Sumatera Selatan dari wilayah.id. Cek koneksi, lalu refresh halaman.');
    return;
  }

  populateSelect();
  ensureMap();
  updateNote();

  const ordered = [
    ...regions.filter(r => /palembang/i.test(r.name)),
    ...regions.filter(r => !/palembang/i.test(r.name)),
  ];
  let first = null;
  for (const region of ordered.slice(0, 4)) {
    try {
      first = await ensureRepPoint(region);
    } catch (err) {
      console.warn(`Lewati ${region.title}:`, err.message);
    }
    if (first) break;
  }
  if (!first) {
    setText('locStripText', 'Gagal memuat data cuaca awal. Cek koneksi ke BMKG, lalu refresh halaman.');
    return;
  }

  applyView();
  selectPoint(first, { manual: false });
  setInterval(loadWeather, REFRESH_MS);

  loadAllRepPoints().catch(err => console.warn('Ikon wilayah gagal:', err));
  loadAllBoundaries().catch(err => console.warn('Batas wilayah gagal:', err));
}

document.getElementById('btnFullscreen')?.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.getElementById('app')?.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
});

document.getElementById('btnLegend')?.addEventListener('click', toggleLegend);

document.getElementById('chkBoundary')?.addEventListener('change', (e) => {
  setBoundaryVisible(e.target.checked);
});

document.getElementById('chkMarkers')?.addEventListener('change', (e) => {
  showAllIcons = e.target.checked;
  renderMarkers();
});

setInterval(tickClock, 1000);
tickClock();

setTimeout(() => {
  const el = document.getElementById('forecast3List');
  if (el && el.querySelector('.skeleton-row')) {
    el.innerHTML = `<p style="color:#B3261E;font-size:13px;">Memuat terlalu lama. Coba muat ulang halaman (F5). Kalau masih gagal, cek koneksi server ke api.bmkg.go.id / wilayah.id (lihat tab Console, F12, untuk detail error).</p>`;
  }
}, WATCHDOG_MS);

init();
