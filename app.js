// ─── Config ──────────────────────────────────────────────────────────
const PAGE_SIZE = 50;
const PREVIEW_ROWS = 8;
const SAMPLE_SCAN_LIMIT = 10;
const DEMO_RECORDS = 500;
const QR_CACHE_MAX = 2000;
const COLORS = { transit:'#448aff', delivered:'#00e676', pending:'#f5a623', hold:'#ff1744', unknown:'#4a6275' };
const STATUS_LABEL = { transit:'In Transit', delivered:'Delivered', pending:'Pending', hold:'On Hold', unknown:'Unknown' };
const SEARCH_FIELDS = ['tracking', 'item', 'sku', 'dest', 'carrier', 'category', 'priority'];

// field definitions: id, sampleId, autoHints
const FIELD_DEFS = [
  { id:'m-tracking', sid:'s-tracking', hints:['track','number','no','id','ref'] },
  { id:'m-item', sid:'s-item', hints:['item','desc','name','product','goods'] },
  { id:'m-dest', sid:'s-dest', hints:['dest','location','bay','shelf','warehouse','loc','place'] },
  { id:'m-status', sid:'s-status', hints:['status','state','stage','condition'] },
  { id:'m-weight', sid:'s-weight', hints:['weight','kg','mass','lbs','gram'] },
  { id:'m-date', sid:'s-date', hints:['date','time','created','updated','dispatched'] },
  { id:'m-category', sid:'s-category', hints:['cat','category','type','class','group'] },
  { id:'m-sku', sid:'s-sku', hints:['sku','barcode','bar','code','upc','part'] },
  { id:'m-qty', sid:'s-qty', hints:['qty','quant','count','units','amount','pcs'] },
  { id:'m-carrier', sid:'s-carrier', hints:['carrier','courier','ship','transport','provider'] },
  { id:'m-priority', sid:'s-priority', hints:['prior','urgent','level','importance'] },
];

// ─── State ───────────────────────────────────────────────────────────
let parsedRows = [];
let fileHeaders = [];
let allRecords = [];
let filtered = [];
let currentPage = 1;
let activeFilter = 'all';
let searchVal = '';
let loadedWorkbook = null;
let qrObserver = null;
const pendingQRRenders = new Map();
const qrCache = new Map();

// ─── Helpers ─────────────────────────────────────────────────────────
function escapeHtml(v) {
  return String(v)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function hasValue(v) {
  return v !== null && v !== undefined && !(typeof v === 'string' && v.trim() === '');
}

function asText(v, fallback = '—') {
  return hasValue(v) ? String(v) : fallback;
}

function showUploadStatus(message, isError = false) {
  const st = document.getElementById('upload-status');
  st.style.display = 'block';
  st.className = isError ? 'error' : '';
  st.textContent = message;
}

function checkDependencies() {
  const missing = [];
  if (typeof XLSX === 'undefined') missing.push('XLSX parser');
  if (typeof QRCode === 'undefined') missing.push('QR renderer');
  return missing;
}

function setControlsDisabled(disabled) {
  ['file-input', 'btn-demo', 'btn-load-sheet', 'btn-generate'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
}

function hideSheetPicker() {
  document.getElementById('sheet-picker').style.display = 'none';
}

function showSheetPicker(sheetNames) {
  const picker = document.getElementById('sheet-picker');
  const sel = document.getElementById('sheet-select');
  sel.innerHTML = '';
  sheetNames.forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  picker.style.display = 'block';
}

function goStep(n) {
  document.querySelectorAll('.step-panel').forEach((p, i) => {
    const isActive = i + 1 === n;
    p.classList.toggle('active', isActive);
    p.setAttribute('aria-hidden', String(!isActive));
  });
  [1,2,3].forEach(i => {
    const si = document.getElementById('si-' + i);
    si.classList.toggle('active', i === n);
    si.classList.toggle('done', i < n);
  });
  [1,2].forEach(i => {
    document.getElementById('sl-' + i).classList.toggle('done', i < n);
  });
  const panel = document.getElementById('step-' + n);
  if (panel) {
    const focusTarget = panel.querySelector('.upload-heading, .panel-title, .search-input, select, button, input');
    if (focusTarget) {
      focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus();
    }
  }
}

function parseWorksheet(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  parsedRows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!parsedRows.length) throw new Error(`No data rows found in "${sheetName}".`);
  fileHeaders = Object.keys(parsedRows[0]);
  hideSheetPicker();
  showUploadStatus(`✓ ${parsedRows.length} rows loaded from "${sheetName}"`);
  populateMapper();
  goStep(2);
}

function handleFile(file) {
  const missing = checkDependencies();
  if (missing.length) {
    showUploadStatus(`✗ Missing dependencies: ${missing.join(', ')}. Ensure CDN access is available.`, true);
    return;
  }
  showUploadStatus('⟳ Reading file…');
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true });
      loadedWorkbook = wb;
      if (wb.SheetNames.length > 1) {
        showSheetPicker(wb.SheetNames);
        showUploadStatus(`✓ Workbook loaded with ${wb.SheetNames.length} sheets. Select one to continue.`);
        return;
      }
      parseWorksheet(wb, wb.SheetNames[0]);
    } catch (err) {
      showUploadStatus('✗ ' + err.message, true);
    }
  };
  reader.onerror = () => showUploadStatus('✗ Failed to read file.', true);
  reader.readAsArrayBuffer(file);
}

function populateMapper() {
  FIELD_DEFS.forEach(f => {
    const sel = document.getElementById(f.id);
    sel.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '(not mapped)';
    sel.appendChild(none);
    fileHeaders.forEach(h => {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = h;
      sel.appendChild(opt);
    });
    const match = fileHeaders.find(h => f.hints.some(k => h.toLowerCase().includes(k)));
    if (match) sel.value = match;
    updateSample(f);
    sel.onchange = () => { updateSample(f); renderPreviewTable(); };
  });
  document.getElementById('preview-total').textContent = parsedRows.length + ' rows total';
  renderPreviewTable();
}

function updateSample(f) {
  const sel = document.getElementById(f.id);
  const sid = document.getElementById(f.sid);
  const col = sel.value;
  if (!col || !parsedRows.length) {
    sid.textContent = '—';
    sid.className = 'sample-val empty';
    return;
  }
  const sample = parsedRows.slice(0, SAMPLE_SCAN_LIMIT).map(r => r[col]).find(v => hasValue(v));
  sid.textContent = sample !== undefined ? String(sample) : '(empty)';
  sid.className = 'sample-val' + (sample === undefined ? ' empty' : '');
}

function getMappedCols() {
  return FIELD_DEFS.map(f => document.getElementById(f.id).value).filter(Boolean);
}

function renderPreviewTable() {
  const wrap = document.getElementById('preview-wrap');
  if (!fileHeaders.length) {
    wrap.innerHTML = '';
    return;
  }
  const mapped = new Set(getMappedCols());
  const rows = parsedRows.slice(0, PREVIEW_ROWS);
  let html = '<table class="preview-table"><thead><tr>';
  fileHeaders.forEach(h => {
    const safeHeader = escapeHtml(h);
    html += `<th style="${mapped.has(h) ? 'color:var(--cyan);border-color:rgba(0,229,255,.3)' : ''}">${safeHeader}</th>`;
  });
  html += '</tr></thead><tbody>';
  rows.forEach(row => {
    html += '<tr>';
    fileHeaders.forEach(h => {
      const isMapped = mapped.has(h);
      const val = asText(row[h], '');
      const safeVal = escapeHtml(val);
      html += `<td class="${isMapped ? 'mapped' : ''}" title="${safeVal}">${safeVal}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

function normalizeStatus(v) {
  if (!hasValue(v)) return 'unknown';
  const s = String(v).trim().toLowerCase().replace(/[\s_-]+/g, ' ');
  const exact = {
    it: 'transit', intransit: 'transit', transit: 'transit', tr: 'transit',
    dlv: 'delivered', delivered: 'delivered', complete: 'delivered', completed: 'delivered', done: 'delivered',
    pend: 'pending', pending: 'pending', queue: 'pending',
    hold: 'hold', onhold: 'hold', blocked: 'hold', delayed: 'hold',
  };
  if (exact[s]) return exact[s];
  if (s.includes('transit') || s.includes('ship') || s.includes('move') || s.includes('dispatch')) return 'transit';
  if (s.includes('deliver') || s.includes('done') || s.includes('complet') || s.includes('arriv')) return 'delivered';
  if (s.includes('hold') || s.includes('stop') || s.includes('block') || s.includes('delay')) return 'hold';
  if (s.includes('pend') || s.includes('wait') || s.includes('queue') || s.includes('process')) return 'pending';
  return 'unknown';
}

function gv(id) {
  return document.getElementById(id).value;
}

function getMappedValue(id, row) {
  const col = gv(id);
  if (!col) return null;
  return asText(row[col]);
}

function buildRecords() {
  const tCol = gv('m-tracking');
  if (!tCol) return null;
  let idx = 1;
  return parsedRows
    .filter(r => hasValue(r[tCol]))
    .map(row => {
      const extra = {};
      ['category', 'sku', 'qty', 'carrier', 'priority'].forEach(k => {
        const col = gv('m-' + k);
        if (col) extra[k] = asText(row[col]);
      });
      return {
        tracking: String(row[tCol]).trim(),
        item: getMappedValue('m-item', row),
        dest: getMappedValue('m-dest', row),
        status: gv('m-status') ? normalizeStatus(row[gv('m-status')]) : 'unknown',
        weight: getMappedValue('m-weight', row),
        date: getMappedValue('m-date', row),
        ...extra,
        idx: idx++,
      };
    });
}

function generateDemo() {
  const rnd = a => a[Math.floor(Math.random() * a.length)];
  const ITEMS = ['Industrial Motor Pump', 'Safety Helmets (x50)', 'Steel Cable Spool', 'Electronic Control Box', 'Hydraulic Fluid (x10)', 'Conveyor Belt Roll', 'Pneumatic Actuator', 'Forklift Battery Pack', 'PPE Gloves (x200)', 'Fire Suppression Unit', 'Pressure Relief Valve', 'Signal Junction Box', 'Stainless Steel Pipe', 'Air Compressor Unit', 'Lubricant Drums (x5)', 'Circuit Breaker Panel', 'Optical Sensor Array', 'Emergency Stop Switch', 'Modular Shelving Kit', 'Industrial Fan Motor'];
  const BAYS = ['Bay 1', 'Bay 2', 'Bay 3', 'Bay 4', 'Bay 5', 'Bay 6', 'Bay 7', 'Bay 8'];
  const SHELVES = ['Shelf A1', 'Shelf A2', 'Shelf B1', 'Shelf B2', 'Shelf C1', 'Shelf C2', 'Floor', 'Rack D1'];
  const CATS = ['Machinery', 'PPE', 'Electronics', 'Raw Material', 'Chemicals', 'Structural', 'Safety', 'Electrical'];
  const CARRIERS = ['DHL Freight', 'FedEx Supply', 'UPS Logistics', 'J&T Express', 'Local Fleet'];
  const PRIORITIES = ['High', 'High', 'Normal', 'Normal', 'Normal', 'Low'];
  const STATUSES = ['transit', 'transit', 'delivered', 'pending', 'hold'];
  return Array.from({ length: DEMO_RECORDS }, (_, i) => {
    const d = new Date(2025, 0, 1 + Math.floor(i / 3));
    return {
      tracking: `WH-2025-TRK-${String(1000 + i).padStart(6, '0')}`,
      item: rnd(ITEMS),
      dest: `${rnd(BAYS)} — ${rnd(SHELVES)}`,
      weight: (Math.random() * 49 + 1).toFixed(1) + ' kg',
      status: rnd(STATUSES),
      date: d.toISOString().slice(0, 10),
      category: rnd(CATS),
      sku: `SKU-${Math.floor(Math.random() * 90000 + 10000)}`,
      qty: String(Math.floor(Math.random() * 50 + 1)),
      carrier: rnd(CARRIERS),
      priority: rnd(PRIORITIES),
      idx: i + 1,
    };
  });
}

function clearQRObserver() {
  if (qrObserver) {
    qrObserver.disconnect();
    qrObserver = null;
  }
  pendingQRRenders.clear();
}

function ensureQRObserver() {
  if (qrObserver) return qrObserver;
  qrObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const render = pendingQRRenders.get(entry.target);
      if (render) {
        render();
        pendingQRRenders.delete(entry.target);
      }
      qrObserver.unobserve(entry.target);
    });
  }, { threshold: 0.05 });
  return qrObserver;
}

function setQrCache(tracking, markup) {
  if (qrCache.has(tracking)) qrCache.delete(tracking);
  qrCache.set(tracking, markup);
  if (qrCache.size > QR_CACHE_MAX) {
    const oldest = qrCache.keys().next().value;
    qrCache.delete(oldest);
  }
}

function launch(records) {
  allRecords = records;
  filtered = [...records];
  currentPage = 1;
  activeFilter = 'all';
  searchVal = '';

  const s3 = document.getElementById('step-3');
  s3.innerHTML = `
    <div class="stats-row" id="stats-row"></div>
    <div class="controls" id="controls">
      <div class="search-wrap">
        <span class="search-icon">⌕</span>
        <input class="search-input" id="search" placeholder="Search tracking, item, SKU, location…" autocomplete="off" aria-label="Search records"/>
      </div>
      <div class="filter-group" id="filters">
        <button class="filter-btn active" data-filter="all">All</button>
        <button class="filter-btn f-transit" data-filter="transit">Transit</button>
        <button class="filter-btn f-delivered" data-filter="delivered">Delivered</button>
        <button class="filter-btn f-pending" data-filter="pending">Pending</button>
        <button class="filter-btn f-hold" data-filter="hold">Hold</button>
      </div>
      <div class="results-count">Showing <span id="rec-count">0</span> records</div>
      <button class="btn-remap" id="btn-remap">⚙ Remap</button>
    </div>
    <div class="grid-wrap"><div class="grid" id="grid"></div></div>
    <div class="pagination" id="pagination"></div>
  `;

  buildStats();
  goStep(3);

  document.getElementById('search').addEventListener('input', e => {
    searchVal = e.target.value;
    applyFilters();
  });
  document.getElementById('filters').addEventListener('click', e => {
    const b = e.target.closest('.filter-btn');
    if (!b) return;
    document.querySelectorAll('.filter-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    activeFilter = b.dataset.filter;
    applyFilters();
  });
  document.getElementById('btn-remap')?.addEventListener('click', () => goStep(2));

  applyFilters();
}

function buildStats() {
  const counts = { transit: 0, delivered: 0, pending: 0, hold: 0 };
  allRecords.forEach(r => {
    if (counts[r.status] !== undefined) counts[r.status] += 1;
  });
  const defs = [
    { label: 'Total', key: 'all', color: '#dce8f0' },
    { label: 'Transit', key: 'transit', color: COLORS.transit },
    { label: 'Delivered', key: 'delivered', color: COLORS.delivered },
    { label: 'Pending', key: 'pending', color: COLORS.pending },
    { label: 'On Hold', key: 'hold', color: COLORS.hold },
  ];
  document.getElementById('stats-row').innerHTML = defs.map(d => `
    <div class="stat-cell">
      <div class="stat-dot" style="background:${d.color}"></div>
      <div>
        <div class="stat-num" style="color:${d.color}">${d.key === 'all' ? allRecords.length : counts[d.key]}</div>
        <div class="stat-lbl">${d.label}</div>
      </div>
    </div>`).join('');
}

function applyFilters() {
  const q = searchVal.trim().toLowerCase();
  filtered = allRecords.filter(r => {
    const matchesStatus = activeFilter === 'all' || r.status === activeFilter;
    const matchesQuery = !q || SEARCH_FIELDS.some(k => hasValue(r[k]) && String(r[k]).toLowerCase().includes(q));
    return matchesStatus && matchesQuery;
  });
  currentPage = 1;
  renderPage();
}

function renderPage() {
  clearQRObserver();
  const grid = document.getElementById('grid');
  const slice = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  document.getElementById('rec-count').textContent = filtered.length;
  grid.innerHTML = '';

  if (!slice.length) {
    grid.innerHTML = '<div class="empty"><span class="big">◈</span>NO RECORDS FOUND</div>';
    renderPagination();
    return;
  }

  slice.forEach((r, li) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.animationDelay = (li * 0.016) + 's';
    const color = COLORS[r.status] || COLORS.unknown;
    const label = STATUS_LABEL[r.status] || 'Unknown';

    const metaFields = [
      { key: 'item', label: 'Item' },
      { key: 'dest', label: 'Location' },
      { key: 'sku', label: 'SKU' },
      { key: 'category', label: 'Category' },
      { key: 'qty', label: 'Qty' },
      { key: 'weight', label: 'Weight' },
      { key: 'carrier', label: 'Carrier' },
      { key: 'priority', label: 'Priority' },
      { key: 'date', label: 'Date' },
    ];
    const metaHTML = metaFields
      .filter(f => hasValue(r[f.key]) && r[f.key] !== '—')
      .map(f => {
        const value = escapeHtml(r[f.key]);
        return `<div class="meta-row"><span class="meta-label">${escapeHtml(f.label)}</span><span class="meta-val" title="${value}">${value}</span></div>`;
      })
      .join('');

    card.innerHTML = `
      <div class="card-stripe" style="background:${color}"></div>
      <div class="card-top">
        <span class="card-idx">#${String(r.idx).padStart(4, '0')}</span>
        <span class="badge badge-${r.status}">${label}</span>
      </div>
      <div class="qr-box">
        <div class="c3"></div><div class="c4"></div>
        <div class="qr-placeholder">LOADING…</div>
      </div>
      <div class="card-meta">
        <div class="tracking-id">${escapeHtml(r.tracking)}</div>
        ${metaHTML}
      </div>`;

    grid.appendChild(card);
    const box = card.querySelector('.qr-box');
    const cached = qrCache.get(r.tracking);
    const renderQR = () => {
      box.innerHTML = '';
      const wrap = document.createElement('div');
      new QRCode(wrap, { text: r.tracking, width: 148, height: 148, colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M });
      box.appendChild(wrap);
      const c3 = document.createElement('div');
      c3.className = 'c3';
      const c4 = document.createElement('div');
      c4.className = 'c4';
      box.appendChild(c3);
      box.appendChild(c4);
      setQrCache(r.tracking, wrap.innerHTML);
    };
    if (cached) {
      box.innerHTML = `<div>${cached}</div><div class="c3"></div><div class="c4"></div>`;
    } else {
      ensureQRObserver();
      pendingQRRenders.set(box, renderQR);
      qrObserver.observe(box);
    }
  });

  renderPagination();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderPagination() {
  const total = Math.ceil(filtered.length / PAGE_SIZE);
  const pag = document.getElementById('pagination');
  pag.innerHTML = '';
  if (total <= 1) return;

  const btn = (label, page, cls = '') => {
    const b = document.createElement('button');
    b.className = 'page-btn ' + cls;
    b.textContent = label;
    if (page !== null) b.onclick = () => { currentPage = page; renderPage(); };
    return b;
  };

  const prev = btn('← PREV', currentPage - 1);
  if (currentPage === 1) prev.disabled = true;
  pag.appendChild(prev);

  const pages = [];
  for (let p = 1; p <= total; p += 1) {
    if (p === 1 || p === total || (p >= currentPage - 2 && p <= currentPage + 2)) pages.push(p);
    else if (pages[pages.length - 1] !== '…') pages.push('…');
  }
  pages.forEach(p => {
    if (p === '…') {
      const s = document.createElement('span');
      s.className = 'page-ellipsis';
      s.textContent = '…';
      pag.appendChild(s);
    } else {
      pag.appendChild(btn(p, p, p === currentPage ? 'active' : ''));
    }
  });

  const next = btn('NEXT →', currentPage + 1);
  if (currentPage === total) next.disabled = true;
  pag.appendChild(next);

  const info = document.createElement('span');
  info.className = 'page-info';
  const from = (currentPage - 1) * PAGE_SIZE + 1;
  const to = Math.min(currentPage * PAGE_SIZE, filtered.length);
  info.innerHTML = `&nbsp;<span style="color:var(--cyan)">${from}–${to}</span> of ${filtered.length}`;
  pag.appendChild(info);
}

document.getElementById('file-input').addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

const dz = document.getElementById('drop-zone');
dz.addEventListener('dragover', e => {
  e.preventDefault();
  dz.classList.add('drag-over');
});
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => {
  e.preventDefault();
  dz.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) handleFile(f);
});

document.getElementById('btn-load-sheet').addEventListener('click', () => {
  const sheetName = document.getElementById('sheet-select').value;
  const err = document.getElementById('map-error');
  if (!loadedWorkbook || !sheetName) return;
  try {
    parseWorksheet(loadedWorkbook, sheetName);
    err.style.display = 'none';
  } catch (e) {
    err.style.display = 'block';
    err.textContent = '✗ ' + e.message;
  }
});

document.getElementById('btn-demo').addEventListener('click', () => {
  const missing = checkDependencies();
  if (missing.length) {
    showUploadStatus(`✗ Missing dependencies: ${missing.join(', ')}. Ensure CDN access is available.`, true);
    return;
  }
  launch(generateDemo());
});
document.getElementById('btn-back').addEventListener('click', () => goStep(1));

document.getElementById('btn-generate').addEventListener('click', () => {
  const err = document.getElementById('map-error');
  if (!gv('m-tracking')) {
    err.style.display = 'block';
    err.textContent = '✗ Tracking Number column is required.';
    return;
  }
  err.style.display = 'none';
  const records = buildRecords();
  if (records && records.length) launch(records);
  else {
    err.style.display = 'block';
    err.textContent = '✗ No valid rows found after mapping.';
  }
});

document.getElementById('ts').textContent = new Date().toLocaleString();
document.getElementById('batch').textContent = 'BCH-' + Math.floor(Math.random() * 90000 + 10000);
hideSheetPicker();
const missing = checkDependencies();
if (missing.length) {
  setControlsDisabled(true);
  showUploadStatus(`✗ Missing dependencies: ${missing.join(', ')}. This page requires CDN access for full functionality.`, true);
}
