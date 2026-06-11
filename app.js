/* ============================================================
   Real Estate Analytics — app.js
   Consume window.__APP_DATA__ (generado por build.py).
   ============================================================ */
"use strict";

const DATA = window.__APP_DATA__ || { properties: [], stats: {}, subte_stations: [] };

const WEIGHT_DEFS = [
  { key: "precio",    label: "Precio / USD·m²", desc: "Precio total y por m²", emoji: "💵" },
  { key: "ubicacion", label: "Ubicación + transporte", desc: "Cercanía a subte y conectividad", emoji: "📍" },
  { key: "tamano",    label: "Tamaño / ambientes", desc: "m² totales y ambientes", emoji: "📐" },
  { key: "estado",    label: "Estado / luz", desc: "Antigüedad, orientación, balcón, frente", emoji: "✨" },
];

const state = {
  weights: { ...(DATA.weights_default || { precio: .25, ubicacion: .25, tamano: .25, estado: .25 }) },
  filters: { barrios: new Set(), ambientes: 0, balcon: false, credito: false,
             precioMax: null, m2Min: null, subteMax: null, search: "" },
  sort: "score",
  rate: DATA.usd_ars_rate || 1200,
  selectedId: null,
  showSubte: false,
  routeMode: false,
  travelMode: "driving",
  routeZones: [],
  routeRadius: 500,        // radio de agrupación (m), configurable
  startPoint: null,        // {lat,lng,label} punto de partida opcional
  roundTrip: false,        // volver al inicio
  routeToken: 0,           // para descartar respuestas OSRM viejas
  routeCache: null,        // {sig, order, osrmInfo} para reusar ruta entre cambios de modo
};

let map, markerLayer, subteLayer, routeLayer, markers = {}, charts = {};

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

const fmtUSD = v => v == null ? "s/d" : "U$D " + Math.round(v).toLocaleString("es-AR");
const fmtUSDk = v => v == null ? "s/d" : "U$D " + (Math.round(v / 100) / 10).toLocaleString("es-AR") + "k";
const fmtInt = v => v == null ? "s/d" : Math.round(v).toLocaleString("es-AR");
const fmtM2 = v => v == null ? "s/d" : Math.round(v) + " m²";
const pid = p => "p" + p.row;
const rank = p => p.top != null ? fmtInt(p.top) : (p.row != null ? p.row : "·"); // fallback si no hay columna Top
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = s => s == null ? "" : String(s).replace(/[&<>"']/g, c => ESC[c]);   // anti-XSS para innerHTML
const safeHref = u => (typeof u === "string" && /^https?:\/\//i.test(u)) ? u : null; // sólo http(s)

function scoreColor(v) { // v 0..100 -> rojo->ámbar->verde
  const t = Math.max(0, Math.min(1, v / 100));
  const stops = [[229, 72, 77], [245, 165, 36], [48, 164, 108]];
  const i = t < .5 ? 0 : 1, lt = t < .5 ? t / .5 : (t - .5) / .5;
  const a = stops[i], b = stops[i + 1];
  const c = a.map((x, k) => Math.round(x + (b[k] - x) * lt));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function scoreColorA(v, alpha = 0.8) { // misma escala, con transparencia (para Chart.js)
  return scoreColor(v).replace("rgb(", "rgba(").replace(")", `,${alpha})`);
}

/* ============================================================
   PLANEAR RECORRIDO — clusters por 500 m + TSP + Google Maps
   ============================================================ */
const ROUTE_RADIUS_M = 500;
const ROUTE_BUFFER_M = 70;       // margen para que el círculo envuelva a los miembros
const TRAVEL_MODES = [
  { key: "driving", label: "🚗 Auto" },
  { key: "transit", label: "🚇 Transporte" },
  { key: "walking", label: "🚶 A pie" },
];
const cssVar = name => getComputedStyle(document.body).getPropertyValue(name).trim() || "#2f6df0";

function haversineJS(aLat, aLng, bLat, bLng) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Agrupa por single-linkage: si dos deptos están a < radio, caen en la misma zona.
function buildClusters(props, radiusM) {
  const R = radiusM || ROUTE_RADIUS_M;
  const pts = props.filter(p => p.geocode_ok && p.lat != null && p.lng != null);
  const parent = pts.map((_, i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++)
      if (haversineJS(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng) < R)
        parent[find(i)] = find(j);
  const groups = {};
  pts.forEach((p, i) => { const r = find(i); (groups[r] = groups[r] || []).push(p); });
  return Object.values(groups).map(members => {
    const lat = members.reduce((s, p) => s + p.lat, 0) / members.length;
    const lng = members.reduce((s, p) => s + p.lng, 0) / members.length;
    const maxd = members.reduce((m, p) => Math.max(m, haversineJS(lat, lng, p.lat, p.lng)), 0);
    return { members, lat, lng, radius: Math.max(R, Math.round(maxd + ROUTE_BUFFER_M)) };
  });
}

// TSP (camino abierto, o cerrado si roundTrip): NN multiarranque + 2-opt sobre una matriz dada.
function optimizeOrder(D, opts = {}) {
  const n = D.length;
  if (n <= 1) return [...Array(n).keys()];
  const { fixedStart = false, roundTrip = false } = opts;
  const at = (a, b) => { const v = D[a][b]; return (v == null || isNaN(v)) ? 1e12 : v; };
  const len = o => { let s = 0; for (let i = 0; i < o.length - 1; i++) s += at(o[i], o[i + 1]); if (roundTrip) s += at(o[o.length - 1], o[0]); return s; };
  const nn = start => {
    const vis = new Array(n).fill(false), o = [start]; vis[start] = true;
    while (o.length < n) {
      const last = o[o.length - 1]; let b = -1, bd = Infinity;
      for (let j = 0; j < n; j++) if (!vis[j] && at(last, j) < bd) { bd = at(last, j); b = j; }
      o.push(b); vis[b] = true;
    }
    return o;
  };
  let best = nn(0), bl = len(best);
  if (!fixedStart) for (let s = 1; s < n; s++) { const o = nn(s), l = len(o); if (l < bl) { bl = l; best = o; } }
  const lo = fixedStart ? 1 : 0;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = lo; i < n - 1; i++) for (let k = i + 1; k < n; k++) {
      const no = best.slice(0, i).concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
      const nl = len(no);
      if (nl < bl - 1e-6) { best = no; bl = nl; improved = true; }
    }
  }
  return best;
}

/* OSRM (OpenStreetMap) — ruteo real por calle, perfil 'driving', sin API key */
const OSRM_BASE = "https://router.project-osrm.org";
async function osrmFetch(path) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(OSRM_BASE + path, { signal: ctrl.signal }); clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json(); return j.code === "Ok" ? j : null;
  } catch (e) { clearTimeout(t); return null; }
}
const osrmCoords = nodes => nodes.map(z => `${z.lng.toFixed(6)},${z.lat.toFixed(6)}`).join(";");
async function osrmTable(nodes) {
  const j = await osrmFetch(`/table/v1/driving/${osrmCoords(nodes)}?annotations=duration,distance`);
  return j ? { dur: j.durations, dist: j.distances } : null;
}
async function osrmRoute(nodes) {
  const j = await osrmFetch(`/route/v1/driving/${osrmCoords(nodes)}?overview=full&geometries=geojson`);
  if (!j || !j.routes || !j.routes.length) return null;
  const rt = j.routes[0];
  return { distance: rt.distance, duration: rt.duration, latlngs: rt.geometry.coordinates.map(c => [c[1], c[0]]) };
}

function zoneTitle(z) {
  const barrios = [...new Set(z.members.map(m => m.barrio).filter(Boolean))];
  return barrios.join(" · ") || "Zona";
}
const ll6 = z => `${z.lat.toFixed(6)},${z.lng.toFixed(6)}`;
function mapsDir(z, mode) { return `https://www.google.com/maps/dir/?api=1&destination=${ll6(z)}&travelmode=${mode}`; }
function mapsRouteUrl(nodes, mode) {
  if (!nodes.length) return "#";
  if (nodes.length === 1) return `https://www.google.com/maps/search/?api=1&query=${ll6(nodes[0])}`;
  const origin = ll6(nodes[0]), destination = ll6(nodes[nodes.length - 1]);
  const mids = nodes.slice(1, -1).map(ll6).join("|");
  let u = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=${mode}`;
  if (mids) u += `&waypoints=${encodeURIComponent(mids)}`;
  return u;
}

/* ---------------- scoring ---------------- */
function composite(p, w = state.weights) {
  const s = p.scores || {};
  const tot = (w.precio + w.ubicacion + w.tamano + w.estado) || 1;
  return 100 * (w.precio * (s.precio || 0) + w.ubicacion * (s.ubicacion || 0)
             + w.tamano * (s.tamano || 0) + w.estado * (s.estado || 0)) / tot;
}

/* ---------------- filtros + orden ---------------- */
function passesFilter(p) {
  const f = state.filters;
  if (f.barrios.size && !f.barrios.has(p.barrio || "Sin dato")) return false;
  if (f.ambientes && (p.ambientes || 0) < f.ambientes) return false;
  if (f.balcon && !/balc|terraza/i.test(p.balcon || "")) return false;
  if (f.credito && !/^s[ií]$/i.test((p.apto_credito || "").trim())) return false;
  if (f.precioMax != null && p.precio != null && p.precio > f.precioMax) return false;
  if (f.m2Min != null && (p.m2 || 0) < f.m2Min) return false;
  if (f.subteMax != null && p.subte_caminata_min != null && p.subte_caminata_min > f.subteMax) return false;
  if (f.search) {
    const q = f.search.toLowerCase();
    const hay = [p.direccion, p.barrio, p.motivo].filter(Boolean).join(" ").toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function sortedList() {
  let list = DATA.properties.filter(passesFilter).map(p => ({ ...p, _score: composite(p) }));
  const by = {
    score: (a, b) => b._score - a._score,
    precio_asc: (a, b) => (a.precio ?? 1e9) - (b.precio ?? 1e9),
    precio_desc: (a, b) => (b.precio ?? -1) - (a.precio ?? -1),
    usd_m2: (a, b) => (a.usd_m2 ?? 1e9) - (b.usd_m2 ?? 1e9),
    m2: (a, b) => (b.m2 ?? -1) - (a.m2 ?? -1),
    subte: (a, b) => (a.subte_dist_m ?? 1e9) - (b.subte_dist_m ?? 1e9),
    top: (a, b) => (a.top ?? 1e9) - (b.top ?? 1e9),
  }[state.sort] || ((a, b) => b._score - a._score);
  return list.sort(by);
}

/* ============================================================
   RENDER: meta + KPIs
   ============================================================ */
function renderMeta() {
  const m = DATA;
  $("#meta-block").innerHTML =
    `<span><b>Fuente:</b> ${m.source_file || "—"}</span>` +
    `<span><b>Actualizado:</b> ${(m.generated_at || "").replace("T", " ")}</span>` +
    `<span>${(m.stats?.geocode_ok_n ?? 0)}/${m.stats?.n ?? 0} geolocalizados</span>`;
  $("#footer-src").textContent = m.source_file || "data.js";
}

function renderKPIs() {
  const s = DATA.stats || {};
  const best = [...DATA.properties].sort((a, b) => composite(b) - composite(a))[0];
  const cheapest = [...DATA.properties].filter(p => p.usd_m2 != null).sort((a, b) => a.usd_m2 - b.usd_m2)[0];
  const closest = [...DATA.properties].filter(p => p.subte_dist_m != null).sort((a, b) => a.subte_dist_m - b.subte_dist_m)[0];
  const kpis = [
    { v: s.n ?? 0, l: "Propiedades", sub: Object.keys(s.barrios || {}).length + " barrios" },
    { v: fmtUSDk(s.precio_prom), l: "Precio promedio", sub: `${fmtUSDk(s.precio_min)}–${fmtUSDk(s.precio_max)}` },
    { v: "U$D " + fmtInt(s.usd_m2_prom), l: "USD/m² promedio", sub: `${fmtInt(s.usd_m2_min)}–${fmtInt(s.usd_m2_max)}` },
    { v: fmtM2(s.m2_prom), l: "Superficie prom.", sub: `Antig. ${s.antig_prom ?? "?"} años` },
    { v: best ? "#" + fmtInt(best.top) : "—", l: "Mejor score", sub: best ? best.barrio : "", color: scoreColor(best ? composite(best) : 0) },
    { v: cheapest ? "#" + fmtInt(cheapest.top) : "—", l: "Mejor USD/m²", sub: cheapest ? "U$D " + fmtInt(cheapest.usd_m2) : "" },
    { v: closest ? closest.subte_caminata_min + " min" : "—", l: "Más cerca de subte", sub: closest ? "#" + fmtInt(closest.top) + " · " + closest.subte_nombre : "" },
  ];
  $("#kpi-bar").innerHTML = kpis.map(k =>
    `<div class="kpi"><div class="k-val" ${k.color ? `style="color:${k.color}"` : ""}>${k.v}</div>` +
    `<div class="k-lbl">${k.l}</div><div class="k-sub">${k.sub || ""}</div></div>`).join("");
}

/* ============================================================
   RENDER: controles (pesos + filtros)
   ============================================================ */
function renderWeights() {
  const g = $("#weights-grid");
  g.innerHTML = WEIGHT_DEFS.map(w => {
    const pct = Math.round(state.weights[w.key] * 100);
    return `<div class="weight">
      <div class="w-head"><span>${w.emoji} ${w.label}</span><span class="w-pct" id="wp-${w.key}">${pct}%</span></div>
      <input type="range" min="0" max="100" value="${pct}" data-w="${w.key}" />
      <small>${w.desc}</small></div>`;
  }).join("");
  $$('#weights-grid input[type="range"]').forEach(r =>
    r.addEventListener("input", () => {
      state.weights[r.dataset.w] = (+r.value) / 100;
      $(`#wp-${r.dataset.w}`).textContent = r.value + "%";
      refresh();
    }));
}

function renderFilters() {
  const barrios = Object.keys(DATA.stats?.barrios || {}).sort();
  const g = $("#filters-grid");
  g.innerHTML = `
    <div class="filter"><label>Barrio</label><div class="chip-row" id="f-barrios">
      ${barrios.map(b => `<span class="chip" data-b="${esc(b)}">${esc(b)} (${DATA.stats.barrios[b]})</span>`).join("")}
    </div></div>
    <div class="filter"><label>Ambientes (mínimo)</label><div class="chip-row" id="f-amb">
      ${[0, 2, 3, 4].map(n => `<span class="chip ${n === 0 ? "on" : ""}" data-amb="${n}">${n === 0 ? "Todos" : n + "+"}</span>`).join("")}
    </div></div>
    <div class="filter"><label>Características</label><div class="chip-row">
      <span class="chip" id="f-balcon">Balcón/Terraza</span>
      <span class="chip" id="f-credito">Apto crédito</span>
    </div></div>
    <div class="filter"><label>Precio máximo (U$D)</label>
      <div class="range-row"><input type="number" id="f-precio" placeholder="sin tope" step="1000" /></div></div>
    <div class="filter"><label>Superficie mínima (m²)</label>
      <div class="range-row"><input type="number" id="f-m2" placeholder="sin mín." step="1" /></div></div>
    <div class="filter"><label>Subte: máx. caminata (min)</label>
      <div class="range-row"><input type="number" id="f-subte" placeholder="sin límite" step="1" /></div></div>`;

  $$("#f-barrios .chip").forEach(c => c.addEventListener("click", () => {
    c.classList.toggle("on");
    const b = c.dataset.b;
    state.filters.barrios.has(b) ? state.filters.barrios.delete(b) : state.filters.barrios.add(b);
    refresh();
  }));
  $$("#f-amb .chip").forEach(c => c.addEventListener("click", () => {
    $$("#f-amb .chip").forEach(x => x.classList.remove("on"));
    c.classList.add("on"); state.filters.ambientes = +c.dataset.amb; refresh();
  }));
  $("#f-balcon").addEventListener("click", e => { e.target.classList.toggle("on"); state.filters.balcon = e.target.classList.contains("on"); refresh(); });
  $("#f-credito").addEventListener("click", e => { e.target.classList.toggle("on"); state.filters.credito = e.target.classList.contains("on"); refresh(); });
  $("#f-precio").addEventListener("input", e => { state.filters.precioMax = e.target.value ? +e.target.value : null; refresh(); });
  $("#f-m2").addEventListener("input", e => { state.filters.m2Min = e.target.value ? +e.target.value : null; refresh(); });
  $("#f-subte").addEventListener("input", e => { state.filters.subteMax = e.target.value ? +e.target.value : null; refresh(); });

  // accesibilidad: chips operables por teclado
  $$("#filters-panel .chip").forEach(c => {
    c.setAttribute("role", "button"); c.setAttribute("tabindex", "0");
    c.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); c.click(); } });
  });
}

/* ============================================================
   RENDER: lista de cards
   ============================================================ */
function tagFor(p) {
  const t = [];
  if (p.subte_caminata_min != null) t.push(`<span class="tag subte">🚇 ${p.subte_caminata_min} min · ${esc(p.subte_nombre)}</span>`);
  if (/balc|terraza/i.test(p.balcon || "")) t.push(`<span class="tag good">${/terraza/i.test(p.balcon) ? "🌅 Terraza" : "🪴 Balcón"}</span>`);
  if (/^s[ií]$/i.test((p.apto_credito || "").trim())) t.push(`<span class="tag good">🏦 Apto crédito</span>`);
  if (p.refacciones) t.push(`<span class="tag warn">🔧 A refaccionar</span>`);
  if (p.faltantes && p.faltantes.length) t.push(`<span class="tag">❓ ${p.faltantes.length} dato(s) s/d</span>`);
  return t.join("");
}

function cardHTML(p) {
  const sc = composite(p), col = scoreColor(sc);
  const subs = WEIGHT_DEFS.map(w => {
    const v = (p.scores?.[w.key] || 0) * 100;
    return `<div class="sb"><div class="bar-track"><div class="bar-fill" style="width:${v}%;background:${scoreColor(v)}"></div></div><div class="sb-lbl">${w.emoji}</div></div>`;
  }).join("");
  return `<div class="card ${state.selectedId === pid(p) ? "active" : ""}" data-id="${pid(p)}" role="button" tabindex="0" aria-label="Ver detalle de ${esc(p.direccion || "propiedad")}, score ${Math.round(sc)}">
    <div class="card-top">
      <div class="rank-badge" style="background:${col}">${rank(p)}</div>
      <div class="card-title">
        <div class="addr">${esc(p.direccion || "Sin dirección")}</div>
        <div class="barrio">${esc(p.barrio || "—")}${p.ambientes != null ? " · " + fmtInt(p.ambientes) + " amb" : ""}</div>
      </div>
      <div class="score-ring"><div class="sc-num" style="color:${col}">${Math.round(sc)}</div><div class="sc-lbl">score</div></div>
    </div>
    <div class="card-stats">
      <div class="stat-cell"><div class="s-val">${fmtUSDk(p.precio)}</div><div class="s-lbl">Precio</div></div>
      <div class="stat-cell"><div class="s-val">${fmtInt(p.usd_m2)}</div><div class="s-lbl">USD/m²</div></div>
      <div class="stat-cell"><div class="s-val">${fmtInt(p.m2)}</div><div class="s-lbl">m²</div></div>
      ${p.margen_neg_pct != null
        ? `<div class="stat-cell"><div class="s-val">${p.margen_neg_pct}%</div><div class="s-lbl">margen neg.</div></div>`
        : p.antiguedad != null
          ? `<div class="stat-cell"><div class="s-val">${fmtInt(p.antiguedad)}</div><div class="s-lbl">años</div></div>`
          : `<div class="stat-cell"><div class="s-val">${fmtInt(p.ambientes)}</div><div class="s-lbl">amb.</div></div>`}
    </div>
    <div class="card-tags">${tagFor(p)}</div>
    <div class="subscore-bars">${subs}</div>
  </div>`;
}

function renderList() {
  const list = sortedList();
  $("#cards").innerHTML = list.map(cardHTML).join("") || `<p class="hint" style="padding:20px">Sin resultados con estos filtros.</p>`;
  $("#list-count").textContent = `${list.length} de ${DATA.properties.length} propiedades`;
  $("#filter-count").textContent = `${list.length} resultado(s)`;
  $$("#cards .card").forEach(c => {
    c.addEventListener("click", () => openDetail(c.dataset.id));
    c.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(c.dataset.id); } });
    c.addEventListener("mouseenter", () => highlightMarker(c.dataset.id, true));
    c.addEventListener("mouseleave", () => highlightMarker(c.dataset.id, false));
  });
}

/* ============================================================
   MAPA
   ============================================================ */
function makePin(p, sc) {
  return L.divIcon({
    className: "", iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28],
    html: `<div class="pin" id="pin-${pid(p)}" style="background:${scoreColor(sc)}"><span>${rank(p)}</span></div>`,
  });
}

function popupHTML(p) {
  const sc = Math.round(composite(p));
  const aviso = safeHref(p.link_aviso_url);
  return `<div class="popup"><h4>${esc(p.direccion || "—")}</h4>
    <div class="barrio" style="color:var(--text-soft);font-size:.78rem">${esc(p.barrio || "")}</div>
    <div class="p-grid">
      <span>Score</span><b style="color:${scoreColor(sc)}">${sc}</b>
      <span>Precio</span><b>${fmtUSD(p.precio)}</b>
      <span>USD/m²</span><b>${fmtInt(p.usd_m2)}</b>
      <span>Superficie</span><b>${fmtM2(p.m2)}${p.ambientes != null ? " · " + fmtInt(p.ambientes) + " amb" : ""}</b>
      <span>Subte</span><b>${p.subte_caminata_min != null ? p.subte_caminata_min + " min (" + esc(p.subte_nombre) + ")" : "s/d"}</b>
    </div>
    <div class="pop-actions">
      <button onclick="openDetail('${pid(p)}')">Ver detalle ▸</button>
      ${aviso ? `<a href="${esc(aviso)}" target="_blank" rel="noopener noreferrer">Ver aviso ↗</a>` : ""}
    </div></div>`;
}

function initMap() {
  const pts = DATA.properties.filter(p => p.geocode_ok);
  map = L.map("map", { scrollWheelZoom: true, zoomControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap",
  }).addTo(map);

  subteLayer = L.layerGroup();
  (DATA.subte_stations || []).forEach(s => {
    L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "", html: `<div class="subte-dot" title="Subte ${s.name}"></div>`, iconSize: [11, 11] }) })
      .bindTooltip("🚇 " + s.name, { direction: "top" })
      .addTo(subteLayer);
  });

  markerLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);   // capa para círculos + recorrido
  pts.forEach(p => {
    const sc = composite(p);
    const mk = L.marker([p.lat, p.lng], { icon: makePin(p, sc) }).bindPopup(popupHTML(p));
    mk.on("click", () => { state.selectedId = pid(p); renderList(); });
    mk.addTo(markerLayer);
    markers[pid(p)] = mk;
  });

  fitToVisible(pts);
}

function fitToVisible(pts) {
  pts = pts || DATA.properties.filter(p => p.geocode_ok);
  if (pts.length) map.fitBounds(L.latLngBounds(pts.map(p => [p.lat, p.lng])).pad(0.18));
  else map.setView([-34.61, -58.44], 12);
}

function refreshMarkers() {
  const visible = new Set(sortedList().map(pid));
  Object.entries(markers).forEach(([id, mk]) => {
    const p = DATA.properties.find(x => pid(x) === id);
    if (!p) return;
    const sc = composite(p);
    mk.setIcon(makePin(p, sc));
    mk.setPopupContent(popupHTML(p));
    if (visible.has(id)) { if (!markerLayer.hasLayer(mk)) markerLayer.addLayer(mk); }
    else markerLayer.removeLayer(mk);
  });
}

function highlightMarker(id, on) {
  const pin = document.getElementById("pin-" + id);
  if (pin) pin.classList.toggle("active", on);
}

function toggleMaximize() {
  const on = $("#map-pane").classList.toggle("fs");
  document.body.classList.toggle("map-fs", on);
  const b = $("#btn-maximize");
  b.classList.toggle("active", on);
  b.setAttribute("aria-pressed", String(on));
  b.textContent = on ? "🗗" : "⛶";
  b.title = on ? "Restaurar el mapa (Esc)" : "Maximizar el mapa (Esc para salir)";
  b.setAttribute("aria-label", on ? "Restaurar el tamaño del mapa" : "Maximizar el mapa a pantalla completa");
  setTimeout(() => map.invalidateSize(), 80);   // Leaflet recalcula tras el cambio de tamaño
}

/* ---------------- recorrido: render sobre el mapa ---------------- */
function toggleRoute() {
  state.routeMode = !state.routeMode;
  const btn = $("#btn-route");
  btn.setAttribute("aria-pressed", String(state.routeMode));
  btn.classList.toggle("active", state.routeMode);
  btn.innerHTML = state.routeMode ? "✕ Salir del recorrido" : "🧭 Planear recorrido";
  $("#route-panel").hidden = !state.routeMode;
  if (state.routeMode) renderRoute(false);
  else { state.routeToken++; state.routeCache = null; routeLayer.clearLayers(); fitToVisible(sortedList().filter(p => p.geocode_ok)); }
}

let _routeOsrmTimer = null;
function renderRouteDebounced() {           // recta instantánea + OSRM al soltar
  renderRoute(true);
  clearTimeout(_routeOsrmTimer);
  _routeOsrmTimer = setTimeout(() => { if (state.routeMode) renderRoute(false); }, 550);
}

function zonePopup(z, stepNo) {
  return `<div class="popup route-pop"><h4>Parada ${stepNo} · ${esc(zoneTitle(z))}</h4>
    <div class="route-pop-sub">${z.members.length} depto(s) · radio ${z.radius} m</div>
    <ul class="route-deptos">${z.members.map(m => {
      const mu = safeHref(m.maps_url);
      return `<li><b>#${rank(m)}</b> ${esc(m.direccion || "")}${mu ? ` <a href="${esc(mu)}" target="_blank" rel="noopener noreferrer" title="Ver en Maps">📍</a>` : ""}</li>`;
    }).join("")}</ul>
    <a class="pop-maps" href="${mapsDir(z, state.travelMode)}" target="_blank" rel="noopener noreferrer">🧭 Cómo llegar a esta zona (Maps)</a>
  </div>`;
}

function useMyLocation() {
  const btn = $("#route-use-loc"); if (btn) btn.textContent = "📍 Obteniendo ubicación…";
  if (!navigator.geolocation) { alert("Tu navegador no permite geolocalización."); return; }
  navigator.geolocation.getCurrentPosition(
    pos => { state.startPoint = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: "Mi ubicación" };
             state.routeCache = null; renderRoute(false); },
    err => { if (btn) btn.textContent = "📍 Usar mi ubicación como inicio";
             alert("No pude obtener tu ubicación: " + err.message); },
    { enableHighAccuracy: true, timeout: 10000 });
}

function fitRouteBounds(zones) {
  if (!zones.length) return;
  const bounds = L.latLngBounds(zones.map(z => [z.lat, z.lng]));
  const wide = window.innerWidth > 900;
  map.fitBounds(bounds, wide
    ? { paddingTopLeft: [40, 40], paddingBottomRight: [350, 50] }
    : { paddingTopLeft: [30, 70], paddingBottomRight: [30, Math.round(window.innerHeight * 0.42)] });
}

async function renderRoute(skipOsrm) {
  if (!state.routeMode) return;
  const token = ++state.routeToken;
  const accent = cssVar("--accent");
  const start = state.startPoint;
  const zones = buildClusters(sortedList(), state.routeRadius);

  if (!zones.length) {
    routeLayer.clearLayers(); state.routeZones = [];
    $("#route-content").innerHTML =
      `<div class="route-head"><b>🧭 Recorrido recomendado</b><button class="drawer-close" id="route-close" aria-label="Cerrar">✕</button></div>
       <p class="route-empty">No hay propiedades geolocalizadas con los filtros actuales.</p>`;
    $("#route-close").onclick = toggleRoute;
    return;
  }

  const nodeList = (start ? [start] : []).concat(zones);
  const startIdx = start ? 0 : -1;
  const sig = JSON.stringify({ r: state.routeRadius, rt: state.roundTrip,
    s: start ? [start.lat.toFixed(5), start.lng.toFixed(5)] : null,
    z: nodeList.map(n => [n.lat.toFixed(5), n.lng.toFixed(5)]) });

  const paint = (order, osrmInfo, status) => {
    if (token !== state.routeToken) return;
    routeLayer.clearLayers();
    const seq = order.map(i => nodeList[i]);
    const lineNodes = state.roundTrip ? seq.concat([seq[0]]) : seq;
    const latlngs = osrmInfo ? osrmInfo.latlngs : lineNodes.map(z => [z.lat, z.lng]);
    if (latlngs.length > 1)
      L.polyline(latlngs, { color: accent, weight: 4, opacity: .85, dashArray: osrmInfo ? null : "2 9", lineCap: "round" }).addTo(routeLayer);
    if (start)
      L.marker([start.lat, start.lng], { zIndexOffset: 1300, icon: L.divIcon({ className: "", iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="route-start" title="Inicio">🏁</div>` }) })
        .bindPopup(`<div class="popup"><h4>🏁 ${esc(start.label || "Inicio")}</h4><div class="route-pop-sub">Punto de partida</div></div>`).addTo(routeLayer);
    let stepNo = 0; const orderedZones = [];
    order.forEach(idx => {
      if (idx === startIdx) return;
      const z = nodeList[idx]; stepNo++; orderedZones.push(z);
      const pop = zonePopup(z, stepNo);
      L.circle([z.lat, z.lng], { radius: z.radius, color: accent, weight: 2, fillColor: accent, fillOpacity: .1 }).bindPopup(pop).addTo(routeLayer);
      L.marker([z.lat, z.lng], { zIndexOffset: 1200, icon: L.divIcon({ className: "", iconSize: [28, 28], iconAnchor: [14, 14], html: `<div class="route-num" style="background:${accent}">${stepNo}</div>` }) }).bindPopup(pop).addTo(routeLayer);
    });
    state.routeZones = orderedZones;
    let straightM = 0; for (let i = 0; i < lineNodes.length - 1; i++) straightM += haversineJS(lineNodes[i].lat, lineNodes[i].lng, lineNodes[i + 1].lat, lineNodes[i + 1].lng);
    fitRouteBounds(start ? orderedZones.concat([start]) : orderedZones);
    renderRoutePanel({ orderedZones, start, deptos: orderedZones.reduce((s, z) => s + z.members.length, 0), osrmInfo, straightM, lineNodes, status });
  };

  // caché por firma: si sólo cambió el modo de Maps, reusar OSRM sin refetch
  const cache = state.routeCache;
  if (cache && cache.sig === sig && cache.osrmInfo) { paint(cache.order, cache.osrmInfo, "ok"); return; }

  // 1) recta inmediata (haversine)
  const hav = nodeList.map(a => nodeList.map(b => haversineJS(a.lat, a.lng, b.lat, b.lng)));
  let order = optimizeOrder(hav, { fixedStart: !!start, roundTrip: state.roundTrip });
  paint(order, null, skipOsrm ? "straight" : "loading");
  if (skipOsrm) return;

  // 2) mejora con OSRM (driving por calle): re-optimiza por tiempo real + geometría
  const table = await osrmTable(nodeList);
  if (token !== state.routeToken || !state.routeMode) return;
  if (table && table.dur) {
    order = optimizeOrder(table.dur, { fixedStart: !!start, roundTrip: state.roundTrip });
    const seq = order.map(i => nodeList[i]);
    const routeSeq = state.roundTrip ? seq.concat([seq[0]]) : seq;
    const rt = await osrmRoute(routeSeq);
    if (token !== state.routeToken || !state.routeMode) return;
    if (rt) { state.routeCache = { sig, order, osrmInfo: rt }; paint(order, rt, "ok"); return; }
  }
  state.routeCache = null;
  paint(order, null, "straight");
}

function renderRoutePanel(d) {
  const { orderedZones, start, deptos, osrmInfo, straightM, lineNodes, status } = d;
  const km = osrmInfo ? (osrmInfo.distance / 1000).toFixed(1) : (straightM / 1000).toFixed(1);
  const kmLbl = osrmInfo ? "km (auto)" : "km (recta)";
  const minVal = osrmInfo ? Math.round(osrmInfo.duration / 60) : (status === "loading" ? "…" : "s/d");
  const modes = TRAVEL_MODES.map(m =>
    `<button class="route-mode ${state.travelMode === m.key ? "on" : ""}" data-mode="${m.key}">${m.label}</button>`).join("");
  const startRow = start
    ? `<div class="route-start-row"><span class="rs-chip">🏁 ${esc(start.label || "Inicio")}</span><button class="link-btn" id="route-clear-start">Quitar</button></div>`
    : `<button class="route-set-start" id="route-use-loc">📍 Usar mi ubicación como inicio</button>`;
  const steps =
    (start ? `<li class="route-step is-start"><span class="route-step-num">🏁</span><span class="route-step-body"><b>Inicio</b><small>${esc(start.label || "Mi ubicación")}</small></span></li>` : "") +
    orderedZones.map((z, i) => `<li class="route-step" data-step="${i}" tabindex="0" role="button">
      <span class="route-step-num">${i + 1}</span>
      <span class="route-step-body"><b>${esc(zoneTitle(z))}</b><small>${z.members.length} depto(s) · ${z.members.map(m => "#" + rank(m)).join(", ")}</small></span></li>`).join("") +
    (state.roundTrip && start ? `<li class="route-step is-start"><span class="route-step-num">🏁</span><span class="route-step-body"><b>Vuelta al inicio</b></span></li>` : "");

  $("#route-content").innerHTML = `
    <div class="route-head"><b>🧭 Recorrido recomendado</b><button class="drawer-close" id="route-close" aria-label="Cerrar">✕</button></div>
    <div class="route-stats">
      <div><span class="rs-val">${orderedZones.length}</span><span class="rs-lbl">zonas</span></div>
      <div><span class="rs-val">${deptos}</span><span class="rs-lbl">deptos</span></div>
      <div><span class="rs-val">${km}</span><span class="rs-lbl">${kmLbl}</span></div>
      <div><span class="rs-val">${minVal}</span><span class="rs-lbl">min</span></div>
    </div>
    <div class="route-controls">
      <label class="route-radius"><span>Radio de zona: <b>${state.routeRadius} m</b></span>
        <input type="range" id="route-radius" min="300" max="1000" step="50" value="${state.routeRadius}" aria-label="Radio de agrupación en metros"></label>
      <div class="route-startbox">
        ${startRow}
        <label class="route-roundtrip"><input type="checkbox" id="route-roundtrip" ${state.roundTrip ? "checked" : ""}> 🔁 Ida y vuelta</label>
      </div>
      <div class="route-modes" role="group" aria-label="Medio de transporte (para el link de Maps)">${modes}</div>
    </div>
    <a class="route-cta" href="${mapsRouteUrl(lineNodes, state.travelMode)}" target="_blank" rel="noopener noreferrer">🗺️ Abrir recorrido en Google Maps</a>
    <ol class="route-steps">${steps}</ol>
    <p class="route-note">${osrmInfo ? "Distancia y tiempo reales por calle (auto · OpenStreetMap/OSRM)." : status === "loading" ? "Calculando la ruta real por calle…" : "Distancia en línea recta (no se pudo rutear por calle)."} El medio de transporte se aplica al abrir en Google Maps.</p>`;

  $("#route-close").onclick = toggleRoute;
  $$("#route-content .route-mode").forEach(b => b.onclick = () => { state.travelMode = b.dataset.mode; renderRoute(false); });
  const rr = $("#route-radius");
  if (rr) rr.oninput = () => { state.routeRadius = +rr.value; state.routeCache = null; renderRouteDebounced(); };
  const rt = $("#route-roundtrip");
  if (rt) rt.onchange = () => { state.roundTrip = rt.checked; state.routeCache = null; renderRoute(false); };
  const ul = $("#route-use-loc"); if (ul) ul.onclick = useMyLocation;
  const cs = $("#route-clear-start"); if (cs) cs.onclick = () => { state.startPoint = null; state.routeCache = null; renderRoute(false); };
  $$("#route-content .route-step:not(.is-start)").forEach(li => {
    const go = () => {
      const z = state.routeZones[+li.dataset.step];
      if (z) { map.setView([z.lat, z.lng], 15, { animate: true });
               routeLayer.eachLayer(l => { if (l.getLatLng && Math.abs(l.getLatLng().lat - z.lat) < 1e-9) l.openPopup(); }); }
    };
    li.onclick = go;
    li.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } };
  });
}

/* ============================================================
   DETALLE (drawer)
   ============================================================ */
function cmp(val, avg, lowerBetter) {
  if (val == null || avg == null) return "";
  const diff = val - avg, pct = Math.round(diff / avg * 100);
  const good = lowerBetter ? diff < 0 : diff > 0;
  return `<span class="dc-cmp ${good ? "cmp-good" : "cmp-bad"}">${pct > 0 ? "+" : ""}${pct}% vs prom</span>`;
}

function openDetail(id) {
  const p = DATA.properties.find(x => pid(x) === id);
  if (!p) return;
  state.selectedId = id;
  const s = DATA.stats || {}, sc = Math.round(composite(p)), col = scoreColor(sc);

  const breakdown = WEIGHT_DEFS.map(w => {
    const v = Math.round((p.scores?.[w.key] || 0) * 100);
    return `<div class="bd-row"><span class="bd-lbl">${w.emoji} ${w.label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${v}%;background:${scoreColor(v)}"></div></div>
      <span class="bd-val">${v}</span></div>`;
  }).join("");

  const cell = (val, lbl, comparison) => `<div class="d-cell"><div class="dc-val">${val}</div><div class="dc-lbl">${esc(lbl)}</div>${comparison || ""}</div>`;

  const extraEntries = Object.entries(p.extra || {});
  const aviso = safeHref(p.link_aviso_url), maps = safeHref(p.maps_url);

  $("#detail-content").innerHTML = `
    <div class="d-head">
      <div class="d-score" style="background:${col}"><div class="ds-num">${sc}</div><div class="ds-lbl">score</div></div>
      <div><div class="d-addr">${esc(p.direccion || "—")}</div>
        <div class="d-barrio">${esc(p.barrio || "")} · Ranking original #${rank(p)}</div></div>
    </div>

    ${p.motivo ? `<div class="d-motivo">“${esc(p.motivo)}”</div>` : ""}
    ${p.faltantes && p.faltantes.length ? `<div class="d-missing" style="margin-top:10px">⚠️ Sin dato: ${esc(p.faltantes.join(", "))}. Completalos en el Excel para afinar el score.</div>` : ""}

    <div class="d-section">
      <h3>Score por dimensión</h3>
      <div class="d-breakdown">${breakdown}</div>
    </div>

    <div class="d-section">
      <h3>Precio</h3>
      <div class="d-grid">
        ${cell(fmtUSD(p.precio), "Precio de lista", cmp(p.precio, s.precio_prom, true))}
        ${p.precio_max != null ? cell(fmtUSD(p.precio_max), "Tope aceptable", p.dif_vs_tope != null ? `<span class="dc-cmp ${p.dif_vs_tope <= 0 ? "cmp-good" : "cmp-bad"}">${p.dif_vs_tope <= 0 ? "dentro del tope" : "U$D " + fmtInt(p.dif_vs_tope) + " sobre tope"}</span>` : "") : ""}
        ${cell("U$D " + fmtInt(p.usd_m2), "USD por m²", cmp(p.usd_m2, s.usd_m2_prom, true))}
        ${p.margen_neg_pct != null ? cell(p.margen_neg_pct + "%", "Margen de negociación", `<span class="dc-cmp">a ${fmtUSD(p.negociar_a)}</span>`) : ""}
        ${cell(fmtUSD(p.p25), "Anticipo 25%")}
        ${cell(fmtUSD(p.p75), "Crédito 75%")}
      </div>
    </div>

    <div class="d-section">
      <h3>Propiedad</h3>
      <div class="d-grid">
        ${cell(fmtM2(p.m2), "Superficie", cmp(p.m2, s.m2_prom, false))}
        ${cell(p.ambientes != null ? fmtInt(p.ambientes) + " amb" : "s/d", "Ambientes")}
        ${cell(p.antiguedad != null ? fmtInt(p.antiguedad) + " años" : "s/d", "Antigüedad", cmp(p.antiguedad, s.antig_prom, true))}
        ${cell(esc(p.orientacion || "s/d"), "Orientación")}
        ${cell(esc(p.posicion || "s/d"), "Posición")}
        ${cell(esc(p.balcon || "—"), "Exterior")}
      </div>
    </div>

    <div class="d-section">
      <h3>Costos mensuales & ubicación</h3>
      <div class="d-grid">
        ${cell(p.expensas != null ? "$ " + fmtInt(p.expensas) : "s/d", "Expensas (ARS)")}
        ${cell(p.costo_mensual_usd != null ? "U$D " + fmtInt(p.costo_mensual_usd) : "s/d", `Expensas (≈USD @${state.rate})`)}
        ${cell(p.subte_caminata_min != null ? p.subte_caminata_min + " min" : "s/d", "Caminata a subte", p.subte_nombre ? `<span class="dc-cmp">${esc(p.subte_nombre)} · ${fmtInt(p.subte_dist_m)} m</span>` : "")}
        ${cell(/^s[ií]$/i.test((p.apto_credito || "").trim()) ? "Sí ✓" : esc(p.apto_credito || "s/d"), "Apto crédito")}
      </div>
    </div>

    ${extraEntries.length ? `<div class="d-section">
      <h3>Otros datos (del Excel)</h3>
      <div class="d-grid">
        ${extraEntries.map(([k, v]) => cell(esc(v), k)).join("")}
      </div>
    </div>` : ""}

    <div class="d-section">
      <div class="d-actions">
        ${aviso ? `<a class="primary" href="${esc(aviso)}" target="_blank" rel="noopener noreferrer">Ver aviso ↗</a>` : ""}
        ${maps ? `<a href="${esc(maps)}" target="_blank" rel="noopener noreferrer">Google Maps 📍</a>` : ""}
        ${p.geocode_ok ? `<button id="d-locate">Ver en el mapa</button>` : ""}
      </div>
    </div>`;

  state.lastFocus = document.activeElement;
  $("#detail-drawer").hidden = false;
  $("#drawer-backdrop").hidden = false;
  $("#drawer-close").focus();
  if (p.geocode_ok) $("#d-locate")?.addEventListener("click", () => {
    closeDetail(); map.setView([p.lat, p.lng], 16, { animate: true });
    markers[id]?.openPopup();
  });
  renderList();
}

function closeDetail() {
  $("#detail-drawer").hidden = true; $("#drawer-backdrop").hidden = true;
  if (state.lastFocus && state.lastFocus.focus) { try { state.lastFocus.focus(); } catch (e) {} }
}

/* ============================================================
   GRÁFICOS (Chart.js)
   ============================================================ */
function renderCharts() {
  if (typeof Chart === "undefined") return;
  const list = DATA.properties;
  const css = getComputedStyle(document.body);
  const grid = css.getPropertyValue("--border") || "#e3e8f0";
  const txt = css.getPropertyValue("--text-soft") || "#5b6678";
  Chart.defaults.color = txt; Chart.defaults.borderColor = grid; Chart.defaults.font.family = "Inter, sans-serif";

  Object.values(charts).forEach(c => c.destroy());

  charts.scatter = new Chart($("#chart-scatter"), {
    type: "scatter",
    data: { datasets: [{
      data: list.filter(p => p.precio && p.m2).map(p => ({ x: p.precio, y: p.m2, p })),
      pointRadius: ctx => 5 + composite(ctx.raw.p) / 100 * 12,
      pointHoverRadius: ctx => 7 + composite(ctx.raw.p) / 100 * 12,
      backgroundColor: ctx => scoreColorA(composite(ctx.raw.p)),
      borderColor: "#fff", borderWidth: 1,
    }] },
    options: { plugins: { legend: { display: false },
      tooltip: { callbacks: { label: c => { const p = c.raw.p; return [`#${fmtInt(p.top)} ${p.barrio}`, `${fmtUSD(p.precio)} · ${fmtM2(p.m2)}`, `Score ${Math.round(composite(p))}`]; } } } },
      scales: { x: { title: { display: true, text: "Precio (U$D)" } }, y: { title: { display: true, text: "Superficie (m²)" } } } },
  });

  const sortedM2 = [...list].filter(p => p.usd_m2).sort((a, b) => a.usd_m2 - b.usd_m2);
  charts.usdm2 = new Chart($("#chart-usdm2"), {
    type: "bar",
    data: { labels: sortedM2.map(p => "#" + fmtInt(p.top)),
      datasets: [{ data: sortedM2.map(p => Math.round(p.usd_m2)),
        backgroundColor: sortedM2.map(p => scoreColorA(composite(p))) }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${sortedM2[c.dataIndex].barrio}: U$D ${fmtInt(c.parsed.y)}/m²` } } },
      scales: { y: { title: { display: true, text: "USD/m²" } } } },
  });

  const sortedSub = [...list].filter(p => p.subte_caminata_min != null).sort((a, b) => a.subte_caminata_min - b.subte_caminata_min);
  charts.subte = new Chart($("#chart-subte"), {
    type: "bar",
    data: { labels: sortedSub.map(p => "#" + fmtInt(p.top)),
      datasets: [{ data: sortedSub.map(p => p.subte_caminata_min),
        backgroundColor: sortedSub.map(p => scoreColorA(composite(p))) }] },
    options: { indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${sortedSub[c.dataIndex].subte_nombre}: ${c.parsed.x} min` } } },
      scales: { x: { title: { display: true, text: "Minutos caminando" } } } },
  });
}

/* ============================================================
   REFRESH + EVENTOS
   ============================================================ */
function refresh() { renderList(); refreshMarkers(); renderKPIs(); if (state.routeMode) { state.routeCache = null; renderRouteDebounced(); } }

function wireEvents() {
  $("#search").addEventListener("input", e => { state.filters.search = e.target.value; refresh(); });
  $("#sort").addEventListener("change", e => { state.sort = e.target.value; renderList(); });

  const toggle = (btn, panel) => $(btn).addEventListener("click", () => {
    const p = $(panel), open = !p.hidden; p.hidden = open;
    $(btn).setAttribute("aria-expanded", String(!open));
  });
  toggle("#btn-weights", "#weights-panel");
  toggle("#btn-filters", "#filters-panel");

  $("#btn-weights-reset").addEventListener("click", () => {
    state.weights = { ...(DATA.weights_default || { precio: .25, ubicacion: .25, tamano: .25, estado: .25 }) };
    renderWeights(); refresh();
  });
  $("#btn-filters-reset").addEventListener("click", () => {
    state.filters = { barrios: new Set(), ambientes: 0, balcon: false, credito: false, precioMax: null, m2Min: null, subteMax: null, search: "" };
    $("#search").value = ""; renderFilters(); refresh();
  });

  const closeAnalysis = () => {
    $("#analysis-backdrop").hidden = true;
    if (state.analysisFocus && state.analysisFocus.focus) { try { state.analysisFocus.focus(); } catch (e) {} }
  };
  $("#btn-analysis").addEventListener("click", () => {
    state.analysisFocus = document.activeElement;
    $("#analysis-backdrop").hidden = false; renderCharts(); $("#analysis-close").focus();
  });
  $("#analysis-close").addEventListener("click", closeAnalysis);
  $("#analysis-backdrop").addEventListener("click", e => { if (e.target.id === "analysis-backdrop") closeAnalysis(); });

  $("#drawer-close").addEventListener("click", closeDetail);
  $("#drawer-backdrop").addEventListener("click", closeDetail);
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (!$("#detail-drawer").hidden) { closeDetail(); return; }
    if (!$("#analysis-backdrop").hidden) { closeAnalysis(); return; }
    if ($("#map-pane").classList.contains("fs")) toggleMaximize();
  });

  $("#toggle-subte").addEventListener("change", e => {
    state.showSubte = e.target.checked;
    if (e.target.checked) subteLayer.addTo(map); else map.removeLayer(subteLayer);
  });

  $("#btn-route").addEventListener("click", toggleRoute);
  $("#btn-maximize").addEventListener("click", toggleMaximize);

  $$("#mobile-tabs button").forEach(b => b.addEventListener("click", () => {
    $$("#mobile-tabs button").forEach(x => x.classList.remove("active"));
    b.classList.add("active");
    $(".layout").className = "layout view-" + b.dataset.view;
    if (b.dataset.view === "map") setTimeout(() => map.invalidateSize(), 60);
  }));
}

/* ---------------- init ---------------- */
function init() {
  if (!DATA.properties.length) {
    $("#cards").innerHTML = `<p class="hint" style="padding:24px">No hay datos. Corré <code>python build.py</code> para generar <code>data.js</code>.</p>`;
    return;
  }
  renderMeta(); renderKPIs(); renderWeights(); renderFilters();
  initMap(); renderList(); wireEvents();
}

document.addEventListener("DOMContentLoaded", init);
window.openDetail = openDetail; // usado desde los popups del mapa
