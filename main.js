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

  // legend — use STATUS_COLORS + SVG bird path instead of Font Awesome
  const container = document.getElementById('bird-legend');
  Object.entries(STATUS_COLORS).forEach(([status, color]) => {
    const row = document.createElement('div');
    row.className = 'bird-row';
    row.innerHTML = `
      <svg width="20" height="20" viewBox="-14 -10 28 20" style="flex-shrink:0">
        <path d="${BIRD_ICONS[status].path}" fill="${color}" stroke="rgba(255,255,255,0.6)" stroke-width="0.5"/>
      </svg>
      <span>${status}</span>`;
    container.appendChild(row);
  });

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

const BIRD_ICONS = {
  'Least Concern': {
    path: 'M0,-4 C-2,-6 -7,-7 -13,-5 C-9,-4 -5,-2 0,0 C5,-2 9,-4 13,-5 C7,-7 2,-6 0,-4Z M0,0 C-1,2 -1,4 0,5 C1,4 1,2 0,0Z',
    scale: 1.1
  },
  'Near Threatened': {
    path: 'M0,-3 C-2,-5 -7,-5 -11,-3 C-8,-3 -4,-1 0,1 C4,-1 8,-3 11,-5 C7,-6 2,-5 0,-3Z M0,1 C-0.5,3 -0.5,5 0,6 C0.5,5 0.5,3 0,1Z',
    scale: 1.0
  },
  'Vulnerable': {
    path: 'M0,-7 C-2,-7 -3,-5 -3,-3 C-3,-1 -2,0 0,1 C2,0 3,-1 3,-3 C3,-5 2,-7 0,-7Z M-3,-3 C-6,-2 -7,0 -6,2 L-3,1Z M3,-3 C6,-2 7,0 6,2 L3,1Z M-1,1 L-2,5 M1,1 L2,5 M0,1 L0,5',
    scale: 1.05,
    strokeWidth: 0.6
  },
  'Endangered': {
    path: 'M0,-5 C-1,-4 -2,-2 -2,0 C-2,2 -1,3 0,4 C1,3 2,2 2,0 C2,-2 1,-4 0,-5Z M-2,0 C-5,1 -7,3 -7,5 C-5,3 -3,2 -2,0Z M2,0 C5,1 7,3 7,5 C5,3 3,2 2,0Z M-0.5,-5 C-1,-6.5 -0.5,-8 0,-8 C0.5,-8 1,-6.5 0.5,-5',
    scale: 0.95
  },
  'Critically Endangered': {
    path: 'M0,-8 C-4,-8 -5,-5 -5,-3 C-5,-1 -4,1 -2,2 L-2,4 L2,4 L2,2 C4,1 5,-1 5,-3 C5,-5 4,-8 0,-8Z M-2.5,-5 C-3.5,-5 -3.5,-3.5 -2.5,-3.5 C-1.5,-3.5 -1.5,-5 -2.5,-5Z M2.5,-5 C1.5,-5 1.5,-3.5 2.5,-3.5 C3.5,-3.5 3.5,-5 2.5,-5Z M-1,4 L-1.5,7 M1,4 L1.5,7 M-6,-2 C-8,0 -9,2 -8,4 M6,-2 C8,0 9,2 8,4',
    scale: 1.0,
    strokeWidth: 0.7
  }
};

const STATUS_COLORS = {
  'Least Concern':         '#4CAF50',
  'Near Threatened':       '#FFC107',
  'Vulnerable':            '#FF6F00',
  'Endangered':            '#F44336',
  'Critically Endangered': '#8E24AA'
};

let selectedSpecies = null;

function drawBirds(date) {
  if (!date || !birdData.length) return;
  const filtered = birdData.filter(d => d.startDate <= date && d.endDate >= date);

  birdSvg.selectAll('.bird-marker').remove();

  filtered.forEach(d => {
    const pt = map.latLngToContainerPoint(L.latLng(d.lat, d.lon));
    const icon = BIRD_ICONS[d.status] || BIRD_ICONS['Least Concern'];
    const color = STATUS_COLORS[d.status] || '#888';

    const g = birdSvg.append('g')
      .attr('class', 'bird-marker')
      .attr('data-name', d.name)
      .attr('data-status', d.status)
      .attr('transform', `translate(${pt.x},${pt.y})`)
      .style('cursor', 'pointer');

    g.append('ellipse')
      .attr('class', 'bird-shadow')
      .attr('cx', 1).attr('cy', 9 * icon.scale)
      .attr('rx', 5 * icon.scale).attr('ry', 2)
      .attr('fill', 'rgba(0,0,0,0.18)');

    g.append('circle')
      .attr('class', 'bird-glow')
      .attr('r', 14)
      .attr('fill', color)
      .attr('opacity', 0);

    g.append('path')
      .attr('class', 'bird-path')
      .attr('d', icon.path)
      .attr('transform', `scale(${icon.scale})`)
      .attr('fill', color)
      .attr('stroke', 'rgba(255,255,255,0.6)')
      .attr('stroke-width', icon.strokeWidth || 0.5)
      .attr('opacity', 1)
      .style('transition', 'opacity 0.2s, stroke-width 0.15s');

    g.on('click', function(event) {
      event.stopPropagation();
      const name = this.getAttribute('data-name');
      selectedSpecies = (selectedSpecies === name) ? null : name;
      applyHighlight();
    });

    g.on('mouseover', function(event) {
      const name = this.getAttribute('data-name');
      const status = this.getAttribute('data-status');
      const ico = BIRD_ICONS[status] || BIRD_ICONS['Least Concern'];
      d3.select(this).select('.bird-path')
        .attr('transform', `scale(${ico.scale * 1.5})`);
      d3.select('body').append('div').attr('class', 'tooltip')
        .style('left', event.pageX + 12 + 'px')
        .style('top',  event.pageY + 12 + 'px')
        .html(`<b>${name}</b><br>Status: ${status}<br><i>${selectedSpecies === name ? 'click to deselect' : 'click to highlight species'}</i>`);
    })
    .on('mousemove', function(event) {
      d3.select('.tooltip')
        .style('left', event.pageX + 12 + 'px')
        .style('top',  event.pageY + 12 + 'px');
    })
    .on('mouseout', function() {
      const status = this.getAttribute('data-status');
      const ico = BIRD_ICONS[status] || BIRD_ICONS['Least Concern'];
      d3.select(this).select('.bird-path')
        .attr('transform', `scale(${ico.scale})`);
      d3.selectAll('.tooltip').remove();
    });
  });

  d3.select('#map').on('click.birdDeselect', function() {
    if (selectedSpecies !== null) {
      selectedSpecies = null;
      applyHighlight();
    }
  });

  applyHighlight();
}

function applyHighlight() {
  birdSvg.selectAll('.bird-marker').each(function() {
    const g = d3.select(this);
    const name   = this.getAttribute('data-name');
    const status = this.getAttribute('data-status');
    const icon   = BIRD_ICONS[status] || BIRD_ICONS['Least Concern'];
    const isSelected = selectedSpecies === name;
    const hasSel     = selectedSpecies !== null;

    g.select('.bird-path')
      .attr('opacity', hasSel && !isSelected ? 0.15 : 1)
      .attr('stroke', isSelected ? 'white' : 'rgba(255,255,255,0.6)')
      .attr('stroke-width', isSelected ? 1.4 : (icon.strokeWidth || 0.5));

    g.select('.bird-glow')
      .attr('opacity', isSelected ? 0.3 : 0);

    g.select('.bird-shadow')
      .attr('opacity', hasSel && !isSelected ? 0.2 : 0.7);
  });
}

map.on('moveend zoomend', () => drawBirds(currentDate));

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
