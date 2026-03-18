// ─────────────────────────────────────────────────────────────
// 1. map initialization
// ─────────────────────────────────────────────────────────────
const map = L.map('map', {
  worldCopyJump: false,
  maxBounds: [[-85, -180], [85, 180]],
  maxBoundsViscosity: 1.0,
  minZoom: 2,
  zoomControl: true
}).setView([20, 0], 2);

L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  {
    attribution: '© <a href="https://www.openstreetmap.org/">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
    noWrap: true
  }
).addTo(map);

// ─────────────────────────────────────────────────────────────
// 2. color tools
// ─────────────────────────────────────────────────────────────
const COLOR_STOPS = [
  { v: -40, r: 148, g:  71, b: 189 },
  { v: -10, r:  31, g: 119, b: 180 },
  { v:  10, r: 255, g: 255, b:   0 },
  { v:  25, r: 255, g: 127, b:  14 },
  { v:  40, r: 214, g:  39, b:  40 }
];

function tempToRGB(temp) {
  const stops = COLOR_STOPS;
  if (temp <= stops[0].v) return [stops[0].r, stops[0].g, stops[0].b];
  if (temp >= stops[stops.length - 1].v) {
    const s = stops[stops.length - 1];
    return [s.r, s.g, s.b];
  }
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i], b = stops[i + 1];
    if (temp >= a.v && temp <= b.v) {
      const t = (temp - a.v) / (b.v - a.v);
      return [
        Math.round(a.r + (b.r - a.r) * t),
        Math.round(a.g + (b.g - a.g) * t),
        Math.round(a.b + (b.b - a.b) * t)
      ];
    }
  }
  return [200, 200, 200];
}

// ─────────────────────────────────────────────────────────────
// 3. canvas heatmap layer
// ─────────────────────────────────────────────────────────────
const RADIUS = 22;
const BLUR   = 14;

function buildWeightTable(radius) {
  const size = radius * 2;
  const table = new Float32Array(size * size);
  for (let dy = -radius; dy < radius; dy++) {
    for (let dx = -radius; dx < radius; dx++) {
      const dist = Math.sqrt(dx * dx + dy * dy) / radius;
      if (dist < 1) {
        const w = Math.max(0, 1 - dist * dist);
        table[(dy + radius) * size + (dx + radius)] = w;
      }
    }
  }
  return table;
}
const WEIGHT_TABLE = buildWeightTable(RADIUS);
const STAMP_SIZE   = RADIUS * 2;

const HeatLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._canvas = document.createElement('canvas');
    this._canvas.style.cssText =
      'position:absolute;top:0;left:0;pointer-events:none;opacity:0.75;z-index:400;';
    map.getPanes().overlayPane.appendChild(this._canvas);
    map.on('moveend zoomend resize', this._redraw, this);
    map.on('move', this._onMove, this);
    this._redraw();
  },

  onRemove(map) {
    this._canvas.remove();
    map.off('moveend zoomend resize', this._redraw, this);
    map.off('move', this._onMove, this);
  },

  _onMove() {
    const tl = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, tl);
  },

  setData(points) {
    this._points = points;
    this._redraw();
  },

  _redraw() {
    if (!this._points || !this._points.length) return;
    const map  = this._map;
    const size = map.getSize();
    const W = size.x, H = size.y;

    this._canvas.width  = W;
    this._canvas.height = H;
    this._canvas.style.width  = W + 'px';
    this._canvas.style.height = H + 'px';
    L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));

    const accR = new Float32Array(W * H);
    const accG = new Float32Array(W * H);
    const accB = new Float32Array(W * H);
    const accW = new Float32Array(W * H);

    this._points.forEach(([lat, lon, temp]) => {
      const pt = map.latLngToContainerPoint(L.latLng(lat, lon));
      const cx = Math.round(pt.x);
      const cy = Math.round(pt.y);

      if (cx + RADIUS < 0 || cx - RADIUS >= W ||
          cy + RADIUS < 0 || cy - RADIUS >= H) return;

      const [r, g, b] = tempToRGB(temp);

      for (let dy = -RADIUS; dy < RADIUS; dy++) {
        const py = cy + dy;
        if (py < 0 || py >= H) continue;
        for (let dx = -RADIUS; dx < RADIUS; dx++) {
          const px = cx + dx;
          if (px < 0 || px >= W) continue;
          const w = WEIGHT_TABLE[(dy + RADIUS) * STAMP_SIZE + (dx + RADIUS)];
          if (w === 0) continue;
          const idx = py * W + px;
          accR[idx] += r * w;
          accG[idx] += g * w;
          accB[idx] += b * w;
          accW[idx] += w;
        }
      }
    });

    const ctx       = this._canvas.getContext('2d');
    const imageData = ctx.createImageData(W, H);
    const data      = imageData.data;

    for (let i = 0; i < W * H; i++) {
      const w = accW[i];
      if (w > 0) {
        const idx = i * 4;
        data[idx]     = Math.round(accR[i] / w);   // R
        data[idx + 1] = Math.round(accG[i] / w);   // G
        data[idx + 2] = Math.round(accB[i] / w);   // B
        data[idx + 3] = Math.min(255, Math.round(w * 180)); // A
      }
    }

    ctx.putImageData(imageData, 0, 0);

    const blurred = document.createElement('canvas');
    blurred.width = W; blurred.height = H;
    const bctx = blurred.getContext('2d');
    bctx.filter = `blur(${BLUR}px)`;
    bctx.drawImage(this._canvas, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(blurred, 0, 0);
  }
});

const heatLayer = new HeatLayer().addTo(map);

// ─────────────────────────────────────────────────────────────
// 4. D3 bird data layer
// ─────────────────────────────────────────────────────────────
const birdSvg = d3.select('#bird-svg');

const birdColor = d3.scaleOrdinal()
  .domain(['Least Concern', 'Near Threatened', 'Vulnerable', 'Endangered', 'Critically Endangered'])
  .range(['#4CAF50', '#FFC107', '#FF9800', '#F44336', '#8E24AA']);

function syncSvgSize() {
  const size = map.getSize();
  birdSvg.attr('width', size.x).attr('height', size.y);
}
syncSvgSize();
map.on('resize', syncSvgSize);

// ─────────────────────────────────────────────────────────────
// 5. overall data variables
// ─────────────────────────────────────────────────────────────
let allTempData = [];
let birdData    = [];
let currentDate = null;
let minDate     = null;

// ─────────────────────────────────────────────────────────────
// 6. temperature data
// ─────────────────────────────────────────────────────────────
d3.csv('data/temperature.csv').then(raw => {
  raw.forEach(d => {
    d.temp = +d.AverageTemperature;
    let lat = parseFloat(d.Latitude);
    if (d.Latitude && d.Latitude.includes('S')) lat = -lat;
    d.lat = lat;
    let lon = parseFloat(d.Longitude);
    if (d.Longitude && d.Longitude.includes('W')) lon = -lon;
    d.lon = lon;
    d.date    = new Date(d.dt);
    d.city    = d.City;
    d.country = d.Country;
  });

  allTempData = raw.filter(d =>
    !isNaN(d.temp) && !isNaN(d.lat) && !isNaN(d.lon) &&
    d.AverageTemperature !== '' && d.dt !== '2013-09-01'
  );

  if (currentDate) updateHeatmap(currentDate);
}).catch(err => console.error('temperature data loading failed:', err));

// ─────────────────────────────────────────────────────────────
// 7. bird data
// ─────────────────────────────────────────────────────────────
d3.csv('data/bird.csv').then(raw => {
  raw.forEach(d => {
    d.lat = +d.GPS_yy;
    d.lon = +d.GPS_xx;
    const sY = +d['Migration start year'],  sM = +d['Migration start month'];
    const eY = +d['Migration end year'],    eM = +d['Migration end month'];
    if (!isNaN(sY) && !isNaN(sM)) d.startDate = new Date(sY, sM - 1);
    if (!isNaN(eY) && !isNaN(eM)) d.endDate   = new Date(eY, eM - 1);
    d.status = d['The IUCN Red List (2023)'];
    d.name   = d['English Name'];
  });

  birdData = raw.filter(d =>
    !isNaN(d.lat) && !isNaN(d.lon) && d.startDate && d.endDate
  );

  const allStarts = birdData.map(d => d.startDate);
  const allEnds   = birdData.map(d => d.endDate);
  minDate       = new Date(Math.min(...allStarts));
  const maxDate = new Date(Math.max(...allEnds));
  currentDate   = new Date(minDate);

  initSlider(minDate, maxDate);
  updateHeatmap(currentDate);
  drawBirds(currentDate);

  // 填充图例
  const container = document.getElementById('bird-legend');
  birdColor.domain().forEach(status => {
    const row = document.createElement('div');
    row.className = 'bird-row';
    row.innerHTML = `<span class="bird-icon fa" style="color:${birdColor(status)}">&#xf1d8;</span><span>${status}</span>`;
    container.appendChild(row);
  });

  map.on('moveend zoomend', () => drawBirds(currentDate));
}).catch(err => console.error('bird data loading failed:', err));

// ─────────────────────────────────────────────────────────────
// 8. update heatmap based on selected date
// ─────────────────────────────────────────────────────────────
function updateHeatmap(date) {
  if (!date) return;
  const pts = allTempData
    .filter(d =>
      d.date.getFullYear() === date.getFullYear() &&
      d.date.getMonth()    === date.getMonth()
    )
    .map(d => [d.lat, d.lon, d.temp]);

  heatLayer.setData(pts);
  document.getElementById('current-date').textContent =
    date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}

// ─────────────────────────────────────────────────────────────
// 9. plot birds based on selected date
// ─────────────────────────────────────────────────────────────
function drawBirds(date) {
  if (!date || !birdData.length) return;
  const filtered = birdData.filter(d => d.startDate <= date && d.endDate >= date);
  const birds = birdSvg.selectAll('.bird').data(filtered, d => d.ID || (d.name + d.lat + d.lon));
  birds.exit().remove();

  const enter = birds.enter()
    .append('text')
    .attr('class', 'bird fa')
    .style('font-size', '14px')
    .text('\uf1d8')
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'central')
    .on('mouseover', function(event, d) {
      d3.select(this).style('font-size', '22px');
      d3.select('body').append('div').attr('class', 'tooltip')
        .style('left', event.pageX + 12 + 'px')
        .style('top',  event.pageY + 12 + 'px')
        .html(`<b>${d.name}</b><br>Status: ${d.status}`);
    })
    .on('mousemove', function(event) {
      d3.select('.tooltip')
        .style('left', event.pageX + 12 + 'px')
        .style('top',  event.pageY + 12 + 'px');
    })
    .on('mouseout', function() {
      d3.select(this).style('font-size', '14px');
      d3.selectAll('.tooltip').remove();
    });

  enter.merge(birds)
    .attr('fill', d => birdColor(d.status))
    .attr('x', d => map.latLngToContainerPoint(L.latLng(d.lat, d.lon)).x)
    .attr('y', d => map.latLngToContainerPoint(L.latLng(d.lat, d.lon)).y);
}

// ─────────────────────────────────────────────────────────────
// 10. time slider initialization
// ─────────────────────────────────────────────────────────────
function initSlider(min, max) {
  const slider = document.getElementById('temp-slider');
  slider.max   = d3.timeMonth.count(min, max);
  slider.value = 0;
  slider.addEventListener('input', function() {
    const d = new Date(min);
    d.setMonth(d.getMonth() + +this.value);
    currentDate = d;
    updateHeatmap(d);
    drawBirds(d);
  });
}
