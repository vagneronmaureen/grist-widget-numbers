const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const DEFAULTS = {
  tableId: '', aggregation: 'count', field: '',
  filters: [], match: 'all',
  title: '', description: '',
  bg: '#ffffff', color: '#1f2937',
  align: 'left', size: 'M',
  decimals: 'auto', prefix: '', suffix: '',
  thousands: true, compact: false, limitLinked: false, percent: false
};

const AGGS = [
  { id: 'count',    label: 'Nombre de lignes',               field: false },
  { id: 'sum',      label: 'Somme',                          field: true, numeric: true },
  { id: 'avg',      label: 'Moyenne',                        field: true, numeric: true },
  { id: 'median',   label: 'Médiane',                        field: true, numeric: true },
  { id: 'min',      label: 'Minimum',                        field: true, numeric: true },
  { id: 'max',      label: 'Maximum',                        field: true, numeric: true },
  { id: 'filled',   label: 'Nombre de valeurs remplies',     field: true },
  { id: 'empty',    label: 'Nombre de valeurs vides',        field: true },
  { id: 'distinct', label: 'Nombre de valeurs distinctes',   field: true },
  { id: 'pct',      label: 'Pourcentage de valeurs remplies', field: true }
];

const E = ['empty', 'À vide'];
const OPS = {
  text:   [['eq','est'],['neq',"n'est pas"],['contains','contient'],['ncontains','ne contient pas'],['starts','commence par'],['ends','finit par'],['empty','est vide'],['nempty',"n'est pas vide"]],
  number: [['eq','='],['neq','≠'],['gt','>'],['gte','≥'],['lt','<'],['lte','≤'],['empty','est vide'],['nempty',"n'est pas vide"]],
  date:   [['eq','est le'],['neq',"n'est pas le"],['before','avant le'],['after','après le'],['lte',"jusqu'au (inclus)"],['gte','à partir du (inclus)'],['today',"est aujourd'hui"],['pastN','dans les N derniers jours'],['nextN','dans les N prochains jours'],['empty','est vide'],['nempty',"n'est pas vide"]],
  ref:    [['eq','est'],['neq',"n'est pas"],['empty','est vide'],['nempty',"n'est pas vide"]],
  choice: [['eq','est'],['neq',"n'est pas"],['contains','contient'],['ncontains','ne contient pas'],['empty','est vide'],['nempty',"n'est pas vide"]],
  bool:   [['true','est coché'],['false','est décoché']],
  list:   [['contains','contient'],['ncontains','ne contient pas'],['empty','est vide'],['nempty',"n'est pas vide"]]
};
const NOVAL = ['empty', 'nempty', 'true', 'false', 'today'];
const PRESETS = [['#ffffff','#1f2937'],['#1f2937','#ffffff'],['#dbeafe','#1e3a8a'],['#dcfce7','#14532d'],['#fef3c7','#78350f'],['#fee2e2','#7f1d1d'],['#ede9fe','#4c1d95'],['#0f766e','#ffffff']];
const SIZES = { S: 0.6, M: 1, L: 1.25, XL: 1.5 };

let opts = JSON.parse(JSON.stringify(DEFAULTS));
let meta = { tables: [], columns: {} };
let cache = { data: null, error: null };
let panelOpen = false, loaded = false;
let linkedId = null, linkedRows = new Set(), attachedTable = null;

/* ---------- Métadonnées (tables / colonnes / types) ---------- */
async function loadMeta() {
  try {
    const [t, c] = await Promise.all([
      grist.docApi.fetchTable('_grist_Tables'),
      grist.docApi.fetchTable('_grist_Tables_column')
    ]);
    const byRef = {};
    const tables = [];
    t.id.forEach((id, i) => {
      if (t.summarySourceTable && t.summarySourceTable[i]) return;   // ignore les tables de synthèse
      byRef[id] = t.tableId[i];
      tables.push(t.tableId[i]);
    });
    const columns = {};
    tables.forEach(n => columns[n] = []);
    const colIdByRef = {};
    c.id.forEach((id, i) => { colIdByRef[id] = c.colId[i]; });
    const idx = c.id.map((_, i) => i).sort((a, b) => (c.parentPos?.[a] ?? 0) - (c.parentPos?.[b] ?? 0));
    idx.forEach(i => {
      const tn = byRef[c.parentId[i]];
      const colId = c.colId[i];
      if (!tn || colId.startsWith('gristHelper_') || colId === 'manualSort') return;
      let choices = null;
      try { const wo = JSON.parse(c.widgetOptions?.[i] || '{}'); if (Array.isArray(wo.choices)) choices = wo.choices.map(String); } catch (e) {}
      const vc = c.visibleCol?.[i];
      columns[tn].push({ id: colId, label: c.label?.[i] || colId, type: c.type[i] || 'Any', choices, visCol: vc ? (colIdByRef[vc] || '') : '' });
    });
    meta = { tables, columns };
  } catch (e) {
    try {
      const tables = await grist.docApi.listTables();
      const columns = {};
      for (const tn of tables) {
        const d = await grist.docApi.fetchTable(tn);
        columns[tn] = Object.keys(d).filter(k => k !== 'id' && k !== 'manualSort').map(k => ({ id: k, label: k, type: 'Any' }));
      }
      meta = { tables, columns };
    } catch (e2) { console.error(e2); }
  }
}

const colsOf = () => meta.columns[opts.tableId] || [];
const colType = id => (colsOf().find(c => c.id === id) || {}).type || 'Any';
function catOf(t = '') {
  const b = t.split(':')[0];
  if (b === 'Numeric' || b === 'Int') return 'number';
  if (b === 'Ref') return 'ref';
  if (b === 'Choice') return 'choice';
  if (b === 'Bool') return 'bool';
  if (b === 'Date' || b === 'DateTime') return 'date';
  if (b === 'ChoiceList' || b === 'RefList') return 'list';
  return 'text';
}

/* ---------- Saisie des filtres selon le type ---------- */
const refCache = {}, refPending = {};
function refOptions(c) {
  const tbl = c.type.split(':')[1];
  if (!tbl) return [];
  const key = tbl + '|' + (c.visCol || '');
  if (refCache[key]) return refCache[key];
  if (!refPending[key]) {
    refPending[key] = true;
    grist.docApi.fetchTable(tbl).then(d => {
      const labels = c.visCol && d[c.visCol] ? d[c.visCol] : null;
      const out = d.id.slice(0, 1000).map((id, i) => {
        const l = labels ? labels[i] : null;
        return { v: String(id), l: (l !== null && l !== undefined && l !== '' && typeof l !== 'object') ? String(l) : '#' + id };
      });
      out.sort((a, b) => a.l.localeCompare(b.l));
      refCache[key] = out;
      if (panelOpen) renderPanel();
    }).catch(() => { refCache[key] = []; });
  }
  return null;   // en cours de chargement
}
function distinctOptions(colId) {
  const d = cache.data;
  if (!d || !d[colId]) return null;
  const set = new Set();
  for (const v of d[colId]) {
    const items = Array.isArray(v) ? listItems(v) : [v];
    for (const x of items) {
      if (x === null || x === undefined || x === '' || typeof x === 'object') continue;
      set.add(String(x));
      if (set.size >= 300) break;
    }
    if (set.size >= 300) break;
  }
  return [...set].sort((a, b) => a.localeCompare(b)).map(x => ({ v: x, l: x }));
}
function pickOptions(colId) {
  const c = colsOf().find(x => x.id === colId);
  if (!c) return [];
  const b = c.type.split(':')[0];
  if (b === 'Ref' || b === 'RefList') return refOptions(c);
  if ((b === 'Choice' || b === 'ChoiceList') && c.choices && c.choices.length) return c.choices.map(x => ({ v: x, l: x }));
  if (b === 'Choice' || b === 'ChoiceList' || catOf(c.type) === 'text') return distinctOptions(colId) || [];
  return [];
}
function modesFor(colId, op) {
  if (!colId || NOVAL.includes(op) || op === 'pastN' || op === 'nextN') return [];
  const t = colType(colId), b = t.split(':')[0], cat = catOf(t);
  if (b === 'Ref' || b === 'RefList') return ['pick', 'fixed', 'link'];
  const o = pickOptions(colId);
  const hasPick = !!(o && o.length);
  if (b === 'Choice' || b === 'ChoiceList') return hasPick ? ['pick', 'fixed'] : ['fixed'];
  if (cat === 'text') return hasPick ? ['fixed', 'pick', 'link'] : ['fixed', 'link'];
  if (cat === 'number') return ['fixed', 'link'];
  return ['fixed'];
}

/* ---------- Données ---------- */
async function loadData() {
  if (!opts.tableId) { cache = { data: null, error: null }; return; }
  try { cache = { data: await grist.docApi.fetchTable(opts.tableId), error: null }; }
  catch (e) { cache = { data: null, error: 'Table introuvable : ' + opts.tableId }; }
}
async function refresh() { await loadData(); render(); }
let rt; const refreshSoon = () => { clearTimeout(rt); rt = setTimeout(refresh, 250); };

/* ---------- Évaluation des filtres ---------- */
function listItems(v) { return Array.isArray(v) ? (v[0] === 'L' ? v.slice(1) : v) : []; }
function isEmpty(v, type) {
  const b = (type || '').split(':')[0];
  if (b === 'Bool') return !v;
  if (v === null || v === undefined || v === '') return true;
  if (b === 'Ref' && v === 0) return true;
  if (Array.isArray(v)) return v[0] === 'E' || listItems(v).length === 0;
  return false;
}
const dayOfStr = s => { const [y, m, d] = String(s).split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 864e5); };
const todayNum = () => { const d = new Date(); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5); };
function cellDay(v, type) {
  if ((type || '').startsWith('DateTime')) { const d = new Date(v * 1000); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5); }
  return Math.floor(v / 86400);
}
function activeFilter(f) {
  if (!f.col || !f.op) return false;
  if (NOVAL.includes(f.op)) return true;
  if (f.src === 'link') return true;
  return f.value !== '' && f.value !== undefined && f.value !== null;
}
function passes(f, v, type) {
  const cat = catOf(type), op = f.op;
  if (cat === 'bool') return op === 'true' ? v === true : !v;
  const empty = isEmpty(v, type);
  if (op === 'empty') return empty;
  if (op === 'nempty') return !empty;
  if (cat === 'ref') {
    if (typeof v !== 'number') return op === 'neq';
    const x = Number(f.value);
    return op === 'eq' ? v === x : v !== x;
  }
  if (cat === 'number') {
    if (typeof v !== 'number') return op === 'neq';
    const x = Number(f.value);
    switch (op) { case 'eq': return v === x; case 'neq': return v !== x; case 'gt': return v > x; case 'gte': return v >= x; case 'lt': return v < x; case 'lte': return v <= x; }
    return true;
  }
  if (cat === 'date') {
    if (typeof v !== 'number') return op === 'neq';
    const day = cellDay(v, type), t = todayNum();
    if (op === 'today') return day === t;
    if (op === 'pastN') return day <= t && day >= t - Number(f.value);
    if (op === 'nextN') return day >= t && day <= t + Number(f.value);
    const x = dayOfStr(f.value);
    switch (op) { case 'eq': return day === x; case 'neq': return day !== x; case 'before': return day < x; case 'after': return day > x; case 'lte': return day <= x; case 'gte': return day >= x; }
    return true;
  }
  const b = String(f.value).toLowerCase();
  if (cat === 'list') {
    const items = listItems(v).map(x => String(x).toLowerCase());
    return op === 'contains' ? items.includes(b) : !items.includes(b);
  }
  const a = String(v ?? '').toLowerCase();
  switch (op) {
    case 'eq': return a === b; case 'neq': return a !== b;
    case 'contains': return a.includes(b); case 'ncontains': return !a.includes(b);
    case 'starts': return a.startsWith(b); case 'ends': return a.endsWith(b);
  }
  return true;
}

/* ---------- Arbre de filtres (groupes ET/OU imbriqués) ---------- */
function compileGroup(g, d) {
  const parts = [];
  for (const it of (g.items || [])) {
    if (it.group) { const c = compileGroup(it, d); if (c) parts.push(c); }
    else if (activeFilter(it) && d[it.col]) {
      parts.push(it.src === 'link'
        ? { f: { ...it, value: String(linkedId) }, arr: d[it.col], type: colType(it.col), never: linkedId == null }
        : { f: it, arr: d[it.col], type: colType(it.col) });
    }
  }
  return parts.length ? { any: g.match === 'any', parts } : null;
}
function evalNode(n, i) {
  if (n.parts) { const t = x => evalNode(x, i); return n.any ? n.parts.some(t) : n.parts.every(t); }
  return !n.never && passes(n.f, n.arr[i], n.type);
}
function itemsAt(path) {            // tableau d'éléments du groupe situé à `path` ('' = racine)
  let arr = opts.filters;
  if (path === '') return arr;
  for (const k of path.split('.').map(Number)) arr = arr[k].items;
  return arr;
}
function nodeAt(path) {
  const ps = path.split('.').map(Number), idx = ps.pop();
  const arr = itemsAt(ps.join('.'));
  return { arr, idx, node: arr[idx] };
}

function compute() {
  if (!opts.tableId) return { msg: 'Choisissez une table dans la configuration.' };
  if (cache.error) return { msg: cache.error };
  const d = cache.data;
  if (!d) return { msg: 'Chargement…' };
  const agg = AGGS.find(a => a.id === opts.aggregation) || AGGS[0];
  let farr = null, ftype = 'Any';
  if (agg.field) {
    if (!opts.field) return { msg: 'Choisissez un champ dans la configuration.' };
    farr = d[opts.field];
    if (!farr) return { msg: 'Champ introuvable : ' + opts.field };
    ftype = colType(opts.field);
  }
  const tree = compileGroup({ match: opts.match, items: opts.filters }, d);
  const n = (d.id || []).length;
  const limit = opts.limitLinked && attachedTable === opts.tableId;
  let count = 0, filled = 0, sum = 0; const nums = [], set = new Set();
  for (let i = 0; i < n; i++) {
    if (limit && !linkedRows.has(d.id[i])) continue;
    let ok = true;
    if (tree) ok = evalNode(tree, i);
    if (!ok) continue;
    count++;
    if (farr) {
      const v = farr[i];
      if (!isEmpty(v, ftype)) {
        filled++;
        if (agg.id === 'distinct') set.add(JSON.stringify(v));
        if (typeof v === 'number') { nums.push(v); sum += v; }
      }
    }
  }
  let value = null;
  switch (agg.id) {
    case 'count': value = count; break;
    case 'sum': value = sum; break;
    case 'avg': value = nums.length ? sum / nums.length : null; break;
    case 'min': value = nums.length ? Math.min(...nums) : null; break;
    case 'max': value = nums.length ? Math.max(...nums) : null; break;
    case 'median': if (nums.length) { nums.sort((a, b) => a - b); const m = nums.length >> 1; value = nums.length % 2 ? nums[m] : (nums[m - 1] + nums[m]) / 2; } break;
    case 'filled': value = filled; break;
    case 'empty': value = count - filled; break;
    case 'distinct': value = set.size; break;
    case 'pct': value = count ? (filled / count) * 100 : null; break;
  }
  return { value, pct: agg.id === 'pct' };
}

/* ---------- Rendu ---------- */
function formatValue(r) {
  if (r.value === null || r.value === undefined || isNaN(r.value)) return '—';
  const dec = opts.decimals === 'auto' ? null : Number(opts.decimals);
  let s;
  const asPct = !!opts.percent && !r.pct;   // le calcul « pourcentage rempli » est déjà en %
  try {
    s = new Intl.NumberFormat(navigator.language || 'fr-FR', {
      style: asPct ? 'percent' : 'decimal',
      useGrouping: !!opts.thousands,
      notation: opts.compact ? 'compact' : 'standard',
      minimumFractionDigits: dec === null ? 0 : dec,
      maximumFractionDigits: dec === null ? 2 : dec
    }).format(r.value);
  } catch (e) { s = String(r.value); }
  return (opts.prefix || '') + s + (r.pct ? ' %' : '') + (opts.suffix || '');
}

function render() {
  const card = $('#card');
  card.style.background = opts.bg; card.style.color = opts.color;
  card.style.textAlign = opts.align;
  $('#content').style.alignItems = opts.align === 'center' ? 'center' : opts.align === 'right' ? 'flex-end' : 'flex-start';
  $('#title').textContent = opts.title || '';
  $('#desc').textContent = opts.description || '';
  const r = compute();
  if (r.msg) { $('#val').textContent = ''; $('#err').textContent = r.msg; }
  else { $('#err').textContent = ''; $('#val').textContent = formatValue(r); }
  fit();
}
function fit() {
  const card = $('#card'), val = $('#val'), content = $('#content');
  if (!val.textContent) return;
  const w = card.clientWidth - 40, h = card.clientHeight - 32;
  let fs = Math.max(14, Math.min(w * 0.2, h * 0.34) * (SIZES[opts.size] || 1));
  val.style.fontSize = fs + 'px';
  let guard = 40;
  while (guard-- > 0 && fs > 12 && (val.scrollWidth > w || content.scrollHeight > h)) { fs *= 0.92; val.style.fontSize = fs + 'px'; }
}
new ResizeObserver(fit).observe(document.body);

/* ---------- Panneau de configuration ---------- */
const optHtml = (v, l, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(l)}</option>`;

function renderPanel() {
  const cols = colsOf();
  const agg = AGGS.find(a => a.id === opts.aggregation) || AGGS[0];
  const fieldCols = agg.numeric ? cols.filter(c => ['Numeric', 'Int'].includes(c.type.split(':')[0])) : cols;

  const renderCond = (f, i) => {
    const type = colType(f.col), cat = catOf(type), b = type.split(':')[0];
    const ops = OPS[cat] || OPS.text;
    const needVal = !NOVAL.includes(f.op);
    const modes = modesFor(f.col, f.op);
    const src = modes.includes(f.src) ? f.src : (modes[0] || 'fixed');
    const relN = ['pastN', 'nextN'].includes(f.op);
    const isRef = b === 'Ref' || b === 'RefList';
    const isChoice = b === 'Choice' || b === 'ChoiceList';
    const numericIn = cat === 'number' || cat === 'ref' || b === 'RefList' || relN;
    const itype = (cat === 'date' && !relN) ? 'date' : numericIn ? 'number' : 'text';
    const refName = type.split(':')[1];
    const colMeta = colsOf().find(c => c.id === f.col);
    const modeLabel = m => m === 'pick'
      ? (isRef ? 'Choisir une ligne' + (refName ? ' de « ' + refName + ' »' : '')
        : (colMeta && colMeta.choices && colMeta.choices.length ? 'Choisir dans la liste' : 'Choisir une valeur existante'))
      : m === 'link' ? 'Id de la ligne liée' + (linkedId != null ? ' (actuel : ' + linkedId + ')' : ' (aucune ligne)')
      : (isRef ? 'Id brut' : isChoice ? 'Valeur brute' : 'Valeur fixe');
    let valueCtl = '';
    if (needVal && src !== 'link') {
      if (src === 'pick') {
        const o = pickOptions(f.col);
        if (!o) valueCtl = '<select disabled><option>chargement…</option></select>';
        else {
          const cur = String(f.value ?? '');
          const extra = cur && !o.some(x => x.v === cur) ? [{ v: cur, l: cur }] : [];
          valueCtl = `<select data-fi="${i}" data-fk="value">${optHtml('', '— choisir —', !cur)}${extra.concat(o).map(x => optHtml(x.v, x.l, x.v === cur)).join('')}</select>`;
        }
      } else {
        valueCtl = `<input type="${itype}" data-fi="${i}" data-fk="value" value="${esc(f.value)}" placeholder="${isRef ? 'id de la ligne' : 'valeur'}">`;
      }
    }
    return `<div class="flt">
      <div class="row">
        <select data-fi="${i}" data-fk="col" data-rr="1">${optHtml('', '— colonne —', !f.col)}${cols.map(c => optHtml(c.id, c.label, c.id === f.col)).join('')}</select>
        <button class="btn x" data-act="delf" data-i="${i}" title="Supprimer">✕</button>
      </div>
      <div class="row">
        <select data-fi="${i}" data-fk="op" data-rr="1">${ops.map(o => optHtml(o[0], o[1], o[0] === f.op)).join('')}</select>
      </div>
      ${modes.length > 1 ? `<div class="row"><select data-fi="${i}" data-fk="src" data-rr="1">${modes.map(m => optHtml(m, modeLabel(m), m === src)).join('')}</select></div>` : ''}
      ${valueCtl ? `<div class="row">${valueCtl}</div>` : ''}
    </div>`;
  };

  const MAX_DEPTH = 3;
  const renderGroup = (g, path, depth) => {
    const items = path === '' ? opts.filters : g.items;
    const match = path === '' ? opts.match : g.match;
    const rows = items.map((it, idx) => {
      const p = path === '' ? String(idx) : path + '.' + idx;
      const lead = idx === 0 ? 'Où'
        : idx === 1 ? `<select data-gp="${path}" data-rr="1">${optHtml('all', 'Et', match !== 'any')}${optHtml('any', 'Ou', match === 'any')}</select>`
        : (match === 'any' ? 'Ou' : 'Et');
      return `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px">
        <div style="flex:0 0 58px;padding-top:6px;color:#6b7280">${lead}</div>
        <div style="flex:1;min-width:0">${it.group ? renderGroup(it, p, depth + 1) : renderCond(it, p)}</div></div>`;
    }).join('');
    const btns = `<div style="display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn" data-act="addf" data-p="${path}" ${opts.tableId ? '' : 'disabled'}>+ Condition</button>
      ${depth < MAX_DEPTH ? `<button class="btn" data-act="addg" data-p="${path}" ${opts.tableId ? '' : 'disabled'}>+ Groupe</button>` : ''}</div>`;
    if (path === '') return rows + btns;
    return `<div style="border:1px solid #bfdbfe;border-left:4px solid #60a5fa;border-radius:8px;padding:8px;background:#f0f7ff">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <b style="font-size:12px;color:#1d4ed8">Groupe — ${match === 'any' ? 'au moins une condition (OU)' : 'toutes les conditions (ET)'}</b>
        <button class="btn x" data-act="delf" data-i="${path}" title="Supprimer le groupe">✕</button></div>
      ${rows}${btns}</div>`;
  };
  const filters = renderGroup(null, '', 0);

  $('#panel').innerHTML = `
    <div class="ph"><b>Configuration</b><button class="btn primary" data-act="close">Terminé</button></div>
    <div class="pb">
      <div class="sec"><h4>Source</h4>
        <label class="f"><span>Table</span>
          <select data-k="tableId" data-rr="1">${optHtml('', '— choisir —', !opts.tableId)}${meta.tables.map(t => optHtml(t, t, t === opts.tableId)).join('')}</select></label>
        <label class="f"><span>Calcul</span>
          <select data-k="aggregation" data-rr="1">${AGGS.map(a => optHtml(a.id, a.label, a.id === opts.aggregation)).join('')}</select></label>
        ${agg.field ? `<label class="f"><span>Champ</span>
          <select data-k="field" data-rr="1">${optHtml('', '— choisir —', !opts.field)}${fieldCols.map(c => optHtml(c.id, c.label, c.id === opts.field)).join('')}</select></label>` : ''}
      </div>

      <div class="sec"><h4>Filtres</h4>
        <label class="chk"><input type="checkbox" data-k="limitLinked" ${opts.limitLinked ? 'checked' : ''}> Limiter aux lignes de la vue liée</label>
        <p class="hint">${attachedTable === opts.tableId ? 'Actif : le widget est rattaché à cette table.' : 'Sans effet : le widget est rattaché à ' + esc(attachedTable || '?') + ', pas à cette table.'}</p>
        ${filters}
        <p class="hint">Le sélecteur Et / Ou de la 2e ligne s'applique à tout le groupe. Les conditions incomplètes sont ignorées.</p>
      </div>

      <div class="sec"><h4>Texte</h4>
        <label class="f"><span>Titre</span><input type="text" data-k="title" value="${esc(opts.title)}"></label>
        <label class="f"><span>Description</span><textarea data-k="description">${esc(opts.description)}</textarea></label>
      </div>

      <div class="sec"><h4>Couleurs</h4>
        <div class="sw">${PRESETS.map((p, i) => `<button data-act="preset" data-i="${i}" style="background:${p[0]};color:${p[1]}" title="${p[0]} / ${p[1]}">12</button>`).join('')}</div>
        <div class="row">
          <label class="f"><span>Fond</span><input type="color" data-k="bg" value="${esc(opts.bg)}"></label>
          <label class="f"><span>Texte</span><input type="color" data-k="color" value="${esc(opts.color)}"></label>
        </div>
      </div>

      <div class="sec"><h4>Affichage</h4>
        <div class="row">
          <label class="f"><span>Alignement</span><select data-k="align" data-rr="0">${[['left','Gauche'],['center','Centre'],['right','Droite']].map(o => optHtml(o[0], o[1], o[0] === opts.align)).join('')}</select></label>
          <label class="f"><span>Taille</span><select data-k="size" data-rr="0">${Object.keys(SIZES).map(k => optHtml(k, k, k === opts.size)).join('')}</select></label>
        </div>
        <div class="row">
          <label class="f"><span>Décimales</span><select data-k="decimals" data-rr="0">${['auto', '0', '1', '2', '3', '4'].map(k => optHtml(k, k === 'auto' ? 'Auto' : k, k === String(opts.decimals))).join('')}</select></label>
        </div>
        <div class="row">
          <label class="f"><span>Préfixe</span><input type="text" data-k="prefix" value="${esc(opts.prefix)}" placeholder="ex. €"></label>
          <label class="f"><span>Suffixe</span><input type="text" data-k="suffix" value="${esc(opts.suffix)}" placeholder="ex. €, kg"></label>
        </div>
        <label class="chk"><input type="checkbox" data-k="percent" ${opts.percent ? 'checked' : ''}> Afficher en pourcentage (0,25 → 25 %)</label>
        <label class="chk"><input type="checkbox" data-k="thousands" ${opts.thousands ? 'checked' : ''}> Séparateur de milliers</label>
        <label class="chk"><input type="checkbox" data-k="compact" ${opts.compact ? 'checked' : ''}> Notation compacte (1,2 k)</label>
      </div>
    </div>`;
}

// setOption (et non setOptions) fusionne : les autres clés du widget, dont le code du builder, restent intactes
let st;
function queueSave() {
  clearTimeout(st);
  st = setTimeout(() => { try { grist.setOption('cfg_nombre', JSON.parse(JSON.stringify(opts))); } catch (e) { console.error(e); } }, 250);
}
async function commit(rerenderPanel, reload) {
  if (reload) await loadData();
  render();
  if (rerenderPanel) renderPanel();
  queueSave();
}

function handle(t) {
  const rr = t.dataset.rr === '1';
  if (t.dataset.k) {
    const k = t.dataset.k;
    opts[k] = t.type === 'checkbox' ? t.checked : t.value;
    let reload = false;
    if (k === 'tableId') { opts.field = ''; opts.filters = []; reload = true; }
    if (k === 'aggregation') {
      const a = AGGS.find(x => x.id === opts.aggregation);
      if (!a.field) opts.field = '';
      else if (a.numeric && opts.field && !['Numeric', 'Int'].includes(colType(opts.field).split(':')[0])) opts.field = '';
    }
    commit(rr, reload);
  } else if (t.dataset.gp !== undefined) {
    if (t.dataset.gp === '') opts.match = t.value; else nodeAt(t.dataset.gp).node.match = t.value;
    commit(true, false);
  } else if (t.dataset.fi !== undefined) {
    const f = nodeAt(t.dataset.fi).node, key = t.dataset.fk;
    f[key] = t.value;
    if (key === 'col') { const ops = OPS[catOf(colType(f.col))] || OPS.text; f.op = ops[0][0]; f.value = ''; f.src = modesFor(f.col, f.op)[0] || 'fixed'; }
    if (key === 'op') { const m = modesFor(f.col, f.op); if (NOVAL.includes(f.op)) f.value = ''; if (!m.includes(f.src)) { f.src = m[0] || 'fixed'; f.value = ''; } }
    if (key === 'src') f.value = '';
    commit(rr, false);
  }
}
$('#panel').addEventListener('input', e => { if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') handle(e.target); });
$('#panel').addEventListener('change', e => { if (e.target.tagName === 'SELECT') handle(e.target); });
$('#panel').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  if (a === 'close') closePanel();
  if (a === 'addf') { itemsAt(b.dataset.p).push({ col: '', op: '', value: '' }); commit(true, false); }
  if (a === 'addg') { itemsAt(b.dataset.p).push({ group: true, match: 'all', items: [{ col: '', op: '', value: '' }] }); commit(true, false); }
  if (a === 'delf') { const n = nodeAt(b.dataset.i); n.arr.splice(n.idx, 1); commit(true, false); }
  if (a === 'preset') { const p = PRESETS[+b.dataset.i]; opts.bg = p[0]; opts.color = p[1]; commit(true, false); }
});

async function openPanel() {
  await loadMeta();
  Object.keys(refCache).forEach(k => delete refCache[k]);
  Object.keys(refPending).forEach(k => delete refPending[k]);
  panelOpen = true; renderPanel(); $('#panel').classList.add('open');
}
function closePanel() { panelOpen = false; $('#panel').classList.remove('open'); }
$('#gear').addEventListener('click', openPanel);

/* ---------- Initialisation ---------- */
grist.ready({ requiredAccess: 'full', onEditOptions: openPanel });
grist.onOptions(async o => {
  if (panelOpen && loaded) return;            // évite d'écraser la saisie en cours
  const src = (o && o.cfg_nombre) ? o.cfg_nombre : (o || {});
  opts = JSON.parse(JSON.stringify(DEFAULTS));
  Object.keys(DEFAULTS).forEach(k => { if (k in src) opts[k] = src[k]; });
  if (!Array.isArray(opts.filters)) opts.filters = [];
  const first = !loaded; loaded = true;
  if (first) await loadMeta();
  await refresh();
  if (first && !opts.tableId) openPanel();
});
grist.onRecord(rec => { linkedId = rec && rec.id != null ? rec.id : null; render(); });
grist.onRecords(recs => { linkedRows = new Set((recs || []).map(r => r.id)); refreshSoon(); });
try { grist.getTable().getTableId().then(t => { attachedTable = t; render(); }).catch(() => {}); } catch (e) {}
setInterval(() => { if (!document.hidden && opts.tableId) refresh(); }, 15000);
