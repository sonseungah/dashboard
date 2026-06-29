'use strict';

/* ── Constants ── */
const GAUGE_CIRC = 267;   // π * r = π * 85 ≈ 267

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const COLORS = {
  cpu:     '#5397F5',
  memory:  '#F5A623',
  gpu:     '#00C2E0',
  disk:    '#FF6B6B',
  network: '#36D399',
};

/* ── State ── */
let currentMetric   = 'cpu';
let currentTimeframe = 60;
let chart           = null;
let localHistory = {
  timestamps: [], cpu: [], memory: [], gpu: [],
  net_download: [], net_upload: [], disk_read: [], disk_write: [],
};

let currentView     = 'dashboard';
const detailCharts  = {};
const detailTimeframes = { cpu: 60, memory: 60, gpu: 60, disk: 60, network: 60 };
const detailInited  = {};
let lastProcessData = null;
let longTermCache   = {};   // { 'dashboard': data, 'cpu': data, ... }

/* ──────────────────────────────
   Gauge
────────────────────────────── */
function injectGaugeTicks() {
  const svg = document.getElementById('gauge-svg');
  const cx = 110, cy = 110, r = 85;

  for (let i = 0; i <= 20; i++) {
    const deg = 180 + i * 9;
    const rad = deg * Math.PI / 180;
    const isLong = i % 5 === 0;
    const r1 = r + 4, r2 = r + (isLong ? 13 : 8);
    const x1 = cx + r1 * Math.cos(rad), y1 = cy + r1 * Math.sin(rad);
    const x2 = cx + r2 * Math.cos(rad), y2 = cy + r2 * Math.sin(rad);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1.toFixed(2)); line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2)); line.setAttribute('y2', y2.toFixed(2));
    line.setAttribute('stroke', '#D8E4F8');
    line.setAttribute('stroke-width', isLong ? '2' : '1');
    svg.insertBefore(line, svg.firstChild);
  }
}

function setGauge(value, maxVal, color) {
  const arc = document.getElementById('gauge-arc');
  const ratio = Math.min(Math.max(value / maxVal, 0), 1);
  arc.style.strokeDashoffset = (GAUGE_CIRC * (1 - ratio)).toFixed(2);
  arc.style.stroke = color;
}

function updateGaugeDisplay(data) {
  const gcVal = document.getElementById('gc-val');
  const gcLbl = document.getElementById('gc-lbl');
  const maxLbl = document.getElementById('gauge-max-lbl');

  switch (currentMetric) {
    case 'cpu':
      setGauge(data.cpu.usage, 100, statusColor(data.cpu.usage, 80, 95));
      gcVal.textContent = data.cpu.usage.toFixed(1) + '%';
      gcLbl.textContent = '사용률';
      maxLbl.textContent = '100%';
      break;
    case 'memory':
      setGauge(data.memory.usage, 100, statusColor(data.memory.usage, 80, 90));
      gcVal.textContent = data.memory.usage.toFixed(1) + '%';
      gcLbl.textContent = '사용률';
      maxLbl.textContent = '100%';
      break;
    case 'gpu':
      if (data.gpu.available) {
        setGauge(data.gpu.usage, 100, statusColor(data.gpu.usage, 85, 95));
        gcVal.textContent = data.gpu.usage.toFixed(1) + '%';
        gcLbl.textContent = '사용률';
      } else {
        setGauge(0, 100, '#ccc');
        gcVal.textContent = 'N/A';
        gcLbl.textContent = '지원 안됨';
      }
      maxLbl.textContent = '100%';
      break;
    case 'disk': {
      const p = data.disk.partitions[0] || { usage: 0 };
      setGauge(p.usage, 100, statusColor(p.usage, 80, 95));
      gcVal.textContent = p.usage.toFixed(1) + '%';
      gcLbl.textContent = '사용률';
      maxLbl.textContent = '100%';
      break;
    }
    case 'network': {
      const dl = data.network.download_mbps;
      const ref = 100;
      setGauge(dl, ref, COLORS.network);
      gcVal.textContent = formatSpeed(dl);
      gcLbl.textContent = '다운로드 속도';
      maxLbl.textContent = '100 MB/s';
      break;
    }
  }
}

/* ──────────────────────────────
   Chart
────────────────────────────── */
function initChart() {
  const ctx = document.getElementById('history-chart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'CPU',
        data: [],
        borderColor: COLORS.cpu,
        backgroundColor: COLORS.cpu + '18',
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 0,
        pointHoverRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: {
        mode: 'index', intersect: false,
        callbacks: {
          label: (ctx) => {
            const v = ctx.parsed.y;
            return currentMetric === 'network' ? ` ${formatSpeed(v)}` : ` ${v.toFixed(1)}%`;
          }
        }
      }},
      scales: {
        y: {
          min: 0,
          suggestedMax: 100,
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: {
            font: { size: 10 }, color: '#6B82B8',
            callback: (v) => currentMetric === 'network' ? v.toFixed(0) + ' MB/s' : v + '%',
          },
        },
        x: {
          grid: { display: false },
          ticks: {
            font: { size: 9 }, color: '#6B82B8',
            maxTicksLimit: 8, maxRotation: 0,
          },
        },
      },
    },
  });
}

function updateChart() {
  if (!chart) return;

  const lt = longTermCache['dashboard'];
  if (lt) {
    applyLongTermToChart(chart, lt, currentMetric);
    return;
  }

  const n = currentTimeframe;
  const labels = localHistory.timestamps.slice(-n);
  let vals, label, color;

  switch (currentMetric) {
    case 'cpu':     vals = localHistory.cpu.slice(-n);          label = 'CPU 사용률';       color = COLORS.cpu;     break;
    case 'memory':  vals = localHistory.memory.slice(-n);       label = '메모리 사용률';    color = COLORS.memory;  break;
    case 'gpu':     vals = localHistory.gpu.slice(-n);          label = 'GPU 사용률';       color = COLORS.gpu;     break;
    case 'disk':    vals = localHistory.disk_read.slice(-n);    label = '디스크 읽기 MB/s'; color = COLORS.disk;    break;
    case 'network': vals = localHistory.net_download.slice(-n); label = '다운로드 MB/s';    color = COLORS.network; break;
    default:        vals = localHistory.cpu.slice(-n);          label = 'CPU 사용률';       color = COLORS.cpu;
  }

  chart.data.labels = labels;
  chart.data.datasets[0].data = vals;
  chart.data.datasets[0].label = label;
  chart.data.datasets[0].borderColor = color;
  chart.data.datasets[0].backgroundColor = color + '18';

  if (currentMetric === 'network' || currentMetric === 'disk') {
    chart.options.scales.y.suggestedMax = undefined;
    chart.options.scales.y.min = 0;
  } else {
    chart.options.scales.y.suggestedMax = 100;
    chart.options.scales.y.min = 0;
  }

  chart.update('none');
}

/* ──────────────────────────────
   Health Ring
────────────────────────────── */
function calcHealth(data) {
  let s = 100;
  const cpu = data.cpu.usage;
  const mem = data.memory.usage;
  const gpu = data.gpu.available ? data.gpu.usage : 0;

  if (cpu > 95) s -= 30; else if (cpu > 80) s -= 15; else if (cpu > 60) s -= 5;
  if (mem > 90) s -= 25; else if (mem > 80) s -= 12; else if (mem > 70) s -= 5;
  if (gpu > 95) s -= 15; else if (gpu > 85) s -= 7;
  if (data.disk.partitions.length) {
    const u = data.disk.partitions[0].usage;
    if (u > 95) s -= 20; else if (u > 85) s -= 8;
  }
  return Math.max(0, Math.min(100, Math.round(s)));
}

function updateHealthRing(score) {
  const circ = 314;
  document.getElementById('health-circle').style.strokeDashoffset = circ * (1 - score / 100);
  document.getElementById('health-val').textContent = score;
}

/* ──────────────────────────────
   Status helpers
────────────────────────────── */
function statusColor(v, w, d) {
  if (v >= d) return '#F44336';
  if (v >= w) return '#FFC107';
  return COLORS[currentMetric] || '#5397F5';
}

function dotClass(v, w, d) {
  if (v >= d) return 'rc-dot danger';
  if (v >= w) return 'rc-dot warn';
  return 'rc-dot';
}

function formatSpeed(mbps) {
  if (mbps >= 1) return mbps.toFixed(2) + ' MB/s';
  return (mbps * 1024).toFixed(0) + ' KB/s';
}

/* ──────────────────────────────
   Alerts
────────────────────────────── */
function buildAlerts(data) {
  const list = [];
  const add = (type, msg) => list.push({ type, msg });

  if (data.cpu.usage >= 95) add('danger', `CPU 위험: ${data.cpu.usage.toFixed(0)}%`);
  else if (data.cpu.usage >= 80) add('warn', `CPU 주의: ${data.cpu.usage.toFixed(0)}%`);

  if (data.memory.usage >= 90) add('danger', `메모리 위험: ${data.memory.usage.toFixed(0)}%`);
  else if (data.memory.usage >= 80) add('warn', `메모리 주의: ${data.memory.usage.toFixed(0)}%`);

  if (data.gpu.available) {
    if (data.gpu.usage >= 95) add('danger', `GPU 위험: ${data.gpu.usage.toFixed(0)}%`);
    else if (data.gpu.usage >= 85) add('warn', `GPU 주의: ${data.gpu.usage.toFixed(0)}%`);
    if (data.gpu.temperature >= 90) add('danger', `GPU 온도 위험: ${data.gpu.temperature}°C`);
    else if (data.gpu.temperature >= 80) add('warn', `GPU 온도 주의: ${data.gpu.temperature}°C`);
  }

  data.disk.partitions.forEach(p => {
    if (p.usage >= 95) add('danger', `${p.device} 용량 부족: ${(100-p.usage).toFixed(0)}% 남음`);
    else if (p.usage >= 85) add('warn', `${p.device} 용량 주의: ${(100-p.usage).toFixed(0)}% 남음`);
  });

  return list;
}

function renderAlerts(list) {
  const el = document.getElementById('alert-list');
  const badge = document.getElementById('alert-badge');

  if (!list.length) {
    el.innerHTML = '<div class="no-alert"><i class="fas fa-check-circle"></i><p>이상 없음</p></div>';
    badge.style.display = 'none';
    return;
  }

  badge.textContent = list.length;
  badge.style.display = 'flex';
  el.innerHTML = list.map(a =>
    `<div class="a-item ${a.type==='danger'?'danger':'warn'}"><i class="fas fa-${a.type==='danger'?'exclamation-circle':'exclamation-triangle'}"></i><span>${esc(a.msg)}</span></div>`
  ).join('');
}

/* ──────────────────────────────
   Main stats update
────────────────────────────── */
async function updateStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const d = await res.json();

    /* System */
    const hn = d.system.hostname;
    document.getElementById('top-hostname').textContent = hn;
    document.getElementById('w-hostname').textContent = hn;
    document.getElementById('w-os').textContent = d.system.os;
    document.getElementById('w-uptime').textContent = d.system.uptime;
    document.getElementById('w-cpu-name').textContent = d.cpu.name || '-';

    /* Health */
    const health = calcHealth(d);
    updateHealthRing(health);

    const tag = document.getElementById('overall-tag');
    if (health >= 80) {
      document.getElementById('w-status').textContent = '시스템이 정상적으로 작동 중입니다.';
      tag.className = 'status-tag'; tag.textContent = '정상';
    } else if (health >= 60) {
      document.getElementById('w-status').textContent = '일부 리소스 사용률이 높습니다. 확인이 필요합니다.';
      tag.className = 'status-tag warn'; tag.textContent = '주의';
    } else {
      document.getElementById('w-status').textContent = '리소스 사용률이 매우 높습니다. 즉시 확인하세요.';
      tag.className = 'status-tag danger'; tag.textContent = '위험';
    }

    /* Freq / temp header pills */
    if (d.cpu.freq_ghz)
      document.getElementById('pill-freq').textContent = d.cpu.freq_ghz + ' GHz';
    if (d.gpu.temperature)
      document.getElementById('pill-temp').textContent = d.gpu.temperature + '°C';

    /* ── CPU card ── */
    const cpu = d.cpu.usage;
    document.getElementById('rc-cpu').textContent = cpu.toFixed(1) + '%';
    document.getElementById('bar-cpu').style.width = cpu + '%';
    document.getElementById('dot-cpu').className = dotClass(cpu, 80, 95);
    document.getElementById('sub-cpu').textContent = `${d.cpu.cores}코어 ${d.cpu.threads}스레드`;
    document.getElementById('qs-cpu').textContent = cpu.toFixed(0) + '%';

    /* ── Memory card ── */
    const mem = d.memory.usage;
    document.getElementById('rc-mem').textContent = mem.toFixed(1) + '%';
    document.getElementById('bar-mem').style.width = mem + '%';
    document.getElementById('dot-mem').className = dotClass(mem, 80, 90);
    document.getElementById('sub-mem').textContent = `${d.memory.used_gb} / ${d.memory.total_gb} GB`;
    document.getElementById('qs-mem').textContent = mem.toFixed(0) + '%';

    /* ── GPU card ── */
    if (d.gpu.available) {
      const gpu = d.gpu.usage;
      document.getElementById('rc-gpu').textContent = gpu.toFixed(1) + '%';
      document.getElementById('bar-gpu').style.width = gpu + '%';
      document.getElementById('dot-gpu').className = dotClass(gpu, 85, 95);
      document.getElementById('sub-gpu').textContent = `${d.gpu.memory_used} / ${d.gpu.memory_total} MB`;
    } else {
      document.getElementById('rc-gpu').textContent = 'N/A';
      document.getElementById('sub-gpu').textContent = d.gpu.name;
    }

    /* ── Disk card ── */
    if (d.disk.partitions.length) {
      const p0 = d.disk.partitions[0];
      document.getElementById('rc-disk').textContent = p0.usage.toFixed(1) + '%';
      document.getElementById('bar-disk').style.width = p0.usage + '%';
      document.getElementById('dot-disk').className = dotClass(p0.usage, 80, 95);
      document.getElementById('qs-disk').textContent = p0.usage.toFixed(0) + '%';
    }
    document.getElementById('sub-disk').textContent =
      `R:${d.disk.read_mbps.toFixed(1)} W:${d.disk.write_mbps.toFixed(1)} MB/s`;

    /* ── Network card ── */
    const dl = d.network.download_mbps;
    const ul = d.network.upload_mbps;
    document.getElementById('rc-net').textContent = '↓ ' + formatSpeed(dl);
    document.getElementById('bar-net').style.width = Math.min(dl / 10 * 100, 100) + '%';
    document.getElementById('sub-net').textContent = `↑ ${formatSpeed(ul)}  ↓ ${formatSpeed(dl)}`;
    document.getElementById('qs-net').textContent = formatSpeed(dl);

    /* ── Alerts ── */
    renderAlerts(buildAlerts(d));

    /* ── History ── */
    const now = new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const push = (k, v) => { localHistory[k].push(v); if (localHistory[k].length > 1800) localHistory[k].shift(); };
    push('timestamps', now);
    push('cpu', d.cpu.usage);
    push('memory', d.memory.usage);
    push('gpu', d.gpu.available ? d.gpu.usage : 0);
    push('net_download', d.network.download_mbps);
    push('net_upload', d.network.upload_mbps);
    push('disk_read', d.disk.read_mbps);
    push('disk_write', d.disk.write_mbps);

    updateChart();
    updateGaugeDisplay(d);

    /* Detail views */
    if (currentView === 'cpu')     updateCpuDetail(d, lastProcessData);
    else if (currentView === 'memory')  updateMemDetail(d, lastProcessData);
    else if (currentView === 'gpu')     updateGpuDetail(d);
    else if (currentView === 'disk')    updateDiskDetail(d);
    else if (currentView === 'network') updateNetDetail(d);

  } catch (e) {
    console.warn('Stats fetch failed:', e);
  }
}

/* ──────────────────────────────
   Processes
────────────────────────────── */
async function updateProcesses() {
  try {
    const res = await fetch('/api/processes');
    if (!res.ok) return;
    const data = await res.json();
    lastProcessData = data;

    const sortKey = document.getElementById('proc-sort').value;
    const list = sortKey === 'cpu' ? data.cpu_top : data.memory_top;
    const maxV = list.length ? (sortKey === 'cpu' ? list[0].cpu : list[0].memory_pct) : 1;

    document.getElementById('proc-list').innerHTML = list.map((p, i) => {
      const v = sortKey === 'cpu' ? p.cpu : p.memory_pct;
      const w = maxV > 0 ? (v / maxV * 100).toFixed(0) : 0;
      return `
        <div class="p-item">
          <div class="p-rank">${i+1}</div>
          <div class="p-info">
            <div class="p-name" title="${esc(p.name)}">${esc(p.name)}</div>
            <div class="p-bar-bg"><div class="p-bar" style="width:${w}%"></div></div>
          </div>
          <div class="p-val">${v.toFixed(1)}%</div>
        </div>`;
    }).join('') || '<div class="proc-loading">데이터 없음</div>';

  } catch (e) {
    console.warn('Process fetch failed:', e);
  }
}

/* ──────────────────────────────
   UI controls
────────────────────────────── */
function selectMetric(m) {
  currentMetric = m;

  document.querySelectorAll('.rcard').forEach(c => c.classList.remove('active'));
  const card = document.getElementById('card-' + m);
  if (card) card.classList.add('active');

  const sel = document.getElementById('metric-sel');
  if (sel) sel.value = m;

  /* Update detail panel header */
  const icons = { cpu:'fa-microchip', memory:'fa-memory', gpu:'fa-tv', disk:'fa-hdd', network:'fa-wifi' };
  const titles = { cpu:'CPU 상세 정보', memory:'메모리 상세 정보', gpu:'GPU 상세 정보', disk:'디스크 상세 정보', network:'네트워크 상세 정보' };
  document.getElementById('dp-icon').className = `fas ${icons[m]||'fa-microchip'}`;
  document.getElementById('dp-title').textContent = titles[m] || '';

  // 장기 모드였다면 장기 데이터로 바로 업데이트, 아니면 로컬 히스토리로
  if (longTermCache['dashboard']) {
    applyLongTermToChart(chart, longTermCache['dashboard'], 'dashboard');
  } else {
    updateChart();
  }
}

async function setTimeframe(secs, btn) {
  document.querySelectorAll('#view-dashboard .ct').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  if (typeof secs === 'string') {
    // 장기 모드: '1d' / '3d' / '7d'
    currentTimeframe = secs;
    const days = parseInt(secs);
    const data = await fetchLongTerm(days);
    longTermCache['dashboard'] = data;
  } else {
    currentTimeframe = secs;
    longTermCache['dashboard'] = null;
  }
  updateChart();
}

/* ──────────────────────────────
   Long-Term History (SQLite)
────────────────────────────── */
async function fetchLongTerm(days) {
  try {
    const res = await fetch(`/api/history/long?days=${days}`);
    return await res.json();
  } catch (e) {
    console.error('[LongTerm] 조회 실패:', e);
    return null;
  }
}

function applyLongTermToChart(ch, data, view) {
  if (!data || !ch) return;
  ch.data.labels = data.timestamps;

  if (view === 'network') {
    ch.data.datasets[0].data = data.net_download;
    ch.data.datasets[1].data = data.net_upload;
  } else if (view === 'disk') {
    ch.data.datasets[0].data = data.disk_read;
    ch.data.datasets[1].data = data.disk_write;
  } else if (view === 'cpu') {
    ch.data.datasets[0].data = data.cpu;
  } else if (view === 'memory') {
    ch.data.datasets[0].data = data.memory;
  } else if (view === 'gpu') {
    ch.data.datasets[0].data = data.gpu;
  } else {
    const keyMap = {
      cpu: 'cpu', memory: 'memory', gpu: 'gpu',
      disk: 'disk_read', network: 'net_download',
    };
    ch.data.datasets[0].data = data[keyMap[currentMetric]] || data.cpu;
  }
  ch.update('none');
}

/* ──────────────────────────────
   View Management
────────────────────────────── */
function switchView(view) {
  currentView = view;

  document.querySelectorAll('.main .content').forEach(el => el.style.display = 'none');
  document.getElementById('view-' + view).style.display = 'flex';

  document.querySelectorAll('.sb-item[data-view]').forEach(el => el.classList.remove('active'));
  const sbi = document.querySelector(`.sb-item[data-view="${view}"]`);
  if (sbi) sbi.classList.add('active');

  document.querySelector('.rpanel').style.display = view === 'dashboard' ? '' : 'none';

  if (view !== 'dashboard' && !detailInited[view]) {
    detailInited[view] = true;
    injectDetailTicks('dv-' + view + '-gauge-svg');
    initDetailChart(view);
  }
}

function injectDetailTicks(svgId) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  const cx = 110, cy = 110, r = 85;
  for (let i = 0; i <= 20; i++) {
    const deg = 180 + i * 9;
    const rad = deg * Math.PI / 180;
    const isLong = i % 5 === 0;
    const r1 = r + 4, r2 = r + (isLong ? 13 : 8);
    const x1 = cx + r1 * Math.cos(rad), y1 = cy + r1 * Math.sin(rad);
    const x2 = cx + r2 * Math.cos(rad), y2 = cy + r2 * Math.sin(rad);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x1.toFixed(2)); line.setAttribute('y1', y1.toFixed(2));
    line.setAttribute('x2', x2.toFixed(2)); line.setAttribute('y2', y2.toFixed(2));
    line.setAttribute('stroke', '#D8E4F8');
    line.setAttribute('stroke-width', isLong ? '2' : '1');
    svg.insertBefore(line, svg.firstChild);
  }
}

function initDetailChart(view) {
  const canvas = document.getElementById('dv-' + view + '-chart');
  if (!canvas || detailCharts[view]) return;

  const isDual = view === 'network' || view === 'disk';
  let datasets;

  if (view === 'network') {
    datasets = [
      { label: '다운로드', data: [], borderColor: COLORS.network, backgroundColor: COLORS.network + '18', borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0 },
      { label: '업로드',   data: [], borderColor: '#9B59B6',      backgroundColor: '#9B59B618',             borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0 },
    ];
  } else if (view === 'disk') {
    datasets = [
      { label: '읽기', data: [], borderColor: COLORS.disk,   backgroundColor: COLORS.disk   + '18', borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0 },
      { label: '쓰기', data: [], borderColor: COLORS.memory, backgroundColor: COLORS.memory + '18', borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0 },
    ];
  } else {
    const col = COLORS[view] || COLORS.cpu;
    datasets = [
      { label: view, data: [], borderColor: col, backgroundColor: col + '18', borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0 },
    ];
  }

  detailCharts[view] = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: [], datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: isDual, position: 'top', labels: { font: { size: 11 } } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        y: {
          min: 0,
          suggestedMax: isDual ? undefined : 100,
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { font: { size: 10 }, color: '#6B82B8', callback: (v) => isDual ? v.toFixed(1) + ' MB/s' : v + '%' },
        },
        x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#6B82B8', maxTicksLimit: 8, maxRotation: 0 } },
      },
    },
  });
}

async function setDetailTimeframe(view, secs, btn) {
  document.querySelectorAll('#view-' + view + ' .ct').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  detailTimeframes[view] = secs;

  if (typeof secs === 'string') {
    const days = parseInt(secs);
    const data = await fetchLongTerm(days);
    longTermCache[view] = data;
  } else {
    longTermCache[view] = null;
  }
  updateDetailChart(view);
}

function updateDetailChart(view) {
  const ch = detailCharts[view];
  if (!ch) return;

  const lt = longTermCache[view];
  if (lt) {
    applyLongTermToChart(ch, lt, view === 'network' ? 'network' : view);
    return;
  }

  const n = detailTimeframes[view];
  const labels = localHistory.timestamps.slice(-n);
  if (view === 'network') {
    ch.data.labels = labels;
    ch.data.datasets[0].data = localHistory.net_download.slice(-n);
    ch.data.datasets[1].data = localHistory.net_upload.slice(-n);
  } else if (view === 'disk') {
    ch.data.labels = labels;
    ch.data.datasets[0].data = localHistory.disk_read.slice(-n);
    ch.data.datasets[1].data = localHistory.disk_write.slice(-n);
  } else {
    ch.data.labels = labels;
    ch.data.datasets[0].data = localHistory[view === 'memory' ? 'memory' : view].slice(-n);
  }
  ch.update('none');
}

function statusColorFor(v, w, d, col) {
  if (v >= d) return '#F44336';
  if (v >= w) return '#FFC107';
  return col;
}

function setDetailGauge(arcId, gcId, value, maxVal, col) {
  const arc = document.getElementById(arcId);
  const gcEl = document.getElementById(gcId);
  if (!arc || !gcEl) return;
  const ratio = Math.min(Math.max(value / maxVal, 0), 1);
  arc.style.strokeDashoffset = (GAUGE_CIRC * (1 - ratio)).toFixed(2);
  arc.style.stroke = col;
  gcEl.textContent = maxVal === 100 ? value.toFixed(1) + '%' : value.toFixed(2);
}

function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function setStyle(id, prop, val) { const el = document.getElementById(id); if (el) el.style[prop] = val; }

/* ──────────────────────────────
   Detail View Updaters
────────────────────────────── */
function updateCpuDetail(data, procs) {
  const cpu = data.cpu;
  setText('dv-cpu-model', cpu.name || '-');
  setText('dv-cpu-kpi-usage', cpu.usage.toFixed(1) + '%');
  setText('dv-cpu-kpi-freq', cpu.freq_ghz ? cpu.freq_ghz + ' GHz' : '--');
  setText('dv-cpu-kpi-cores', cpu.cores + '코어');
  setText('dv-cpu-kpi-threads', cpu.threads + '스레드');
  setDetailGauge('dv-cpu-arc', 'dv-cpu-gc', cpu.usage, 100, statusColorFor(cpu.usage, 80, 95, COLORS.cpu));

  if (cpu.per_core) {
    document.getElementById('dv-cores-list').innerHTML = cpu.per_core.map((pct, i) => `
      <div class="core-bar-item">
        <span class="core-label">Core ${i}</span>
        <div class="core-bar-bg"><div class="core-bar-fill" style="width:${pct}%"></div></div>
        <span class="core-pct">${pct.toFixed(0)}%</span>
      </div>`).join('');
  }

  if (procs && procs.cpu_top) {
    const maxV = procs.cpu_top[0] ? procs.cpu_top[0].cpu : 1;
    document.getElementById('dv-cpu-proc-list').innerHTML = procs.cpu_top.map((p, i) => `
      <div class="p-item">
        <div class="p-rank">${i+1}</div>
        <div class="p-info">
          <div class="p-name" title="${esc(p.name)}">${esc(p.name)}</div>
          <div class="p-bar-bg"><div class="p-bar" style="width:${maxV>0?(p.cpu/maxV*100).toFixed(0):0}%"></div></div>
        </div>
        <div class="p-val">${p.cpu.toFixed(1)}%</div>
      </div>`).join('');
  }
  updateDetailChart('cpu');
}

function updateMemDetail(data, procs) {
  const mem = data.memory;
  setText('dv-mem-kpi-usage', mem.usage.toFixed(1) + '%');
  setText('dv-mem-kpi-used', mem.used_gb + ' GB');
  setText('dv-mem-kpi-avail', mem.available_gb + ' GB');
  setText('dv-mem-kpi-total', mem.total_gb + ' GB');
  setText('dv-mem-swap', `${mem.swap_used_gb} / ${mem.swap_total_gb} GB (${mem.swap_usage}%)`);
  setDetailGauge('dv-mem-arc', 'dv-mem-gc', mem.usage, 100, statusColorFor(mem.usage, 80, 90, COLORS.memory));

  if (procs && procs.memory_top) {
    const maxV = procs.memory_top[0] ? procs.memory_top[0].memory_pct : 1;
    document.getElementById('dv-mem-proc-list').innerHTML = procs.memory_top.map((p, i) => `
      <div class="p-item">
        <div class="p-rank">${i+1}</div>
        <div class="p-info">
          <div class="p-name" title="${esc(p.name)}">${esc(p.name)}</div>
          <div class="p-bar-bg"><div class="p-bar" style="width:${maxV>0?(p.memory_pct/maxV*100).toFixed(0):0}%;background:var(--mem)"></div></div>
        </div>
        <div class="p-val" style="color:var(--mem)">${p.memory_mb.toFixed(0)} MB</div>
      </div>`).join('');
  }
  updateDetailChart('memory');
}

function updateGpuDetail(data) {
  const gpu = data.gpu;
  setText('dv-gpu-model', gpu.name || '-');

  if (gpu.available) {
    setText('dv-gpu-kpi-usage', gpu.usage.toFixed(1) + '%');
    setText('dv-gpu-kpi-temp', (gpu.temperature != null ? gpu.temperature : '--') + '°C');
    setText('dv-gpu-kpi-vram', gpu.memory_used + ' MB');
    setText('dv-gpu-kpi-vram-total', gpu.memory_total + ' MB');
    setDetailGauge('dv-gpu-arc', 'dv-gpu-gc', gpu.usage, 100, statusColorFor(gpu.usage, 85, 95, COLORS.gpu));

    const vramPct = gpu.memory_total > 0 ? gpu.memory_used / gpu.memory_total * 100 : 0;
    setStyle('dv-gpu-vram-bar', 'width', vramPct.toFixed(1) + '%');
    setText('dv-gpu-vram-text', `${gpu.memory_used} / ${gpu.memory_total} MB  (${vramPct.toFixed(1)}%)`);

    const tempPct = gpu.temperature != null ? Math.min(gpu.temperature, 100) : 0;
    const tempCol = gpu.temperature >= 90 ? '#F44336' : gpu.temperature >= 80 ? '#FFC107' : '#4CAF50';
    setStyle('dv-gpu-temp-bar', 'width', tempPct + '%');
    setStyle('dv-gpu-temp-bar', 'background', tempCol);
    setText('dv-gpu-temp-text', (gpu.temperature != null ? gpu.temperature : '--') + '°C');
  } else {
    ['dv-gpu-kpi-usage','dv-gpu-kpi-temp','dv-gpu-kpi-vram','dv-gpu-kpi-vram-total'].forEach(id => setText(id, 'N/A'));
    const arc = document.getElementById('dv-gpu-arc');
    if (arc) arc.style.stroke = '#ccc';
    setText('dv-gpu-gc', 'N/A');
  }
  updateDetailChart('gpu');
}

function updateDiskDetail(data) {
  const disk = data.disk;
  setText('dv-disk-kpi-read', formatSpeed(disk.read_mbps));
  setText('dv-disk-kpi-write', formatSpeed(disk.write_mbps));
  setText('dv-disk-kpi-count', disk.partitions.length + '개');

  if (disk.partitions.length) {
    const p0 = disk.partitions[0];
    setText('dv-disk-kpi-c', p0.usage.toFixed(1) + '%');
    setDetailGauge('dv-disk-arc', 'dv-disk-gc', p0.usage, 100, statusColorFor(p0.usage, 80, 95, COLORS.disk));
  }

  document.getElementById('dv-disk-drives').innerHTML = disk.partitions.map(p => `
    <div class="drive-item">
      <div class="drive-hdr">
        <span class="drive-name">${esc(p.device)}</span>
        <span class="drive-sizes">${p.used_gb} / ${p.total_gb} GB</span>
      </div>
      <div class="drive-bar-bg">
        <div class="drive-bar-fill" style="width:${p.usage}%;background:${p.usage>=95?'var(--danger)':p.usage>=80?'var(--warn)':'var(--disk)'}"></div>
      </div>
      <div class="drive-pct">${p.usage}% 사용</div>
    </div>`).join('');
  updateDetailChart('disk');
}

function updateNetDetail(data) {
  const net = data.network;
  setText('dv-net-kpi-dl', formatSpeed(net.download_mbps));
  setText('dv-net-kpi-ul', formatSpeed(net.upload_mbps));
  setText('dv-net-kpi-recv', net.total_recv_gb.toFixed(2) + ' GB');
  setText('dv-net-kpi-sent', net.total_sent_gb.toFixed(2) + ' GB');

  const dlPct = Math.min(net.download_mbps, 100);
  setDetailGauge('dv-net-arc', 'dv-net-gc', dlPct, 100, COLORS.network);
  setText('dv-net-gc', formatSpeed(net.download_mbps));

  document.getElementById('dv-net-ifaces').innerHTML = (net.interfaces || []).map(iface => `
    <div class="iface-item">
      <div class="iface-dot"></div>
      <span class="iface-name">${esc(iface.name)}</span>
      <span class="iface-ip">${esc(iface.ip || '-')}</span>
      <span class="iface-speed">${iface.speed_mbps ? esc(iface.speed_mbps) + ' Mbps' : '-'}</span>
    </div>`).join('');
  updateDetailChart('network');
}

/* ──────────────────────────────
   Init
────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  injectGaugeTicks();
  initChart();
  selectMetric('cpu');

  updateStats();
  updateProcesses();

  setInterval(updateStats, 1000);
  setInterval(updateProcesses, 3000);

  document.getElementById('refresh-btn').addEventListener('click', () => {
    const icon = document.querySelector('#refresh-btn i');
    icon.classList.add('spinning');
    updateStats();
    updateProcesses();
    setTimeout(() => icon.classList.remove('spinning'), 800);
  });
});
