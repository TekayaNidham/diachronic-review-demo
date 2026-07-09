/* ============================================================
   Diachronic Expert Review: app logic (Gallery skin)
   Inline editing, fast keyboard flow, server autosave with
   browser-storage + single-file fallbacks. Add-diachronic lives
   on its own page (add.html). Comment threads + onboarding tips.
   ============================================================ */

const APP_VERSION = '2026-07-09-gallery';
const STORAGE_KEY = 'diachronic_review_v2';
const BACKUP_KEY = 'diachronic_review_backup';
const FLASH_KEY = 'diachronic_review_flash';
const ONBOARD_KEY = 'diachronic_review_onboarded';
const DEFAULT_CORPUS = 'approved_diachronics.json';
// Where autosaves are POSTed. Adapts to the host:
//  - a collector you configure (window.REVIEW_SAVE_URL or ?collector=<url>) wins
//  - on localhost, the local server.py (+ :8000 fallback)
//  - on a static host (e.g. GitHub Pages) with no collector, same-origin only;
//    if that 404s the app just keeps everything in the browser (no data lost)
function saveEndpoints() {
  const configured = (typeof window !== 'undefined' && window.REVIEW_SAVE_URL) ||
    new URLSearchParams(location.search).get('collector');
  if (configured) return [configured];
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || h === '') return ['/api/save-review', 'http://localhost:8000/api/save-review'];
  return ['/api/save-review'];
}

const state = {
  studyId: null, expert: null, corpusMeta: {}, entries: [], originals: new Map(),
  reviews: {}, suggestions: [], selectedId: null, selectedPeriod: 0, editingComment: null,
  filter: 'all', themeFilter: 'all', search: ''
};
const els = {};
const saver = { timer: null, inFlight: false, again: false, serverOk: null };
const tipUI = {}, gEls = {};
let hoverTimer = null, curHoverEl = null, suppressedEl = null, activeTipEl = null, tour = null;

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
const nowIso = () => new Date().toISOString();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const padId = id => String(id).padStart(3, '0');
function slug(v) { return String(v || 'expert').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'expert'; }
function esc(v) { const d = document.createElement('div'); d.textContent = v == null ? '' : String(v); return d.innerHTML; }
function getPath(obj, path) { return String(path).split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj); }
function setPath(obj, path, val) {
  const parts = String(path).split('.'); let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { const k = parts[i]; if (cur[k] == null) cur[k] = /^\d+$/.test(parts[i + 1]) ? [] : {}; cur = cur[k]; }
  cur[parts[parts.length - 1]] = val;
}
function toast(msg) { els.toast.textContent = msg; els.toast.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => els.toast.classList.remove('show'), 2600); }
function debounce(fn, ms) { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; }
function fmtTime(iso) { try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } }
function expertName() { return state.expert ? `${state.expert.first_name} ${state.expert.last_name}` : 'Reviewer'; }

/* ---------- review accessors ---------- */
function original(id) { return state.originals.get(String(id)); }
function reviewFor(id) {
  const k = String(id);
  if (!state.reviews[k]) state.reviews[k] = { decision: 'pending', comment: '', comments: [], edited: false, entry: clone(original(id)) };
  if (!state.reviews[k].entry) state.reviews[k].entry = clone(original(id));
  return state.reviews[k];
}
function reviewSnapshot(id) { return state.reviews[String(id)] || { decision: 'pending', comment: '', comments: [], edited: false, entry: original(id) }; }
function workingEntry(id) { return reviewFor(id).entry; }
function displayEntry(id) { const r = state.reviews[String(id)]; return (r && r.entry) || original(id); }
function statusFor(id) { return reviewSnapshot(id).decision || 'pending'; }
function isEdited(id) { const r = state.reviews[String(id)]; if (!r || !r.entry) return false; return !same(original(id), r.entry); }
function markEdited(id) { reviewFor(id).edited = isEdited(id); }
function themeForEntry(entry) { const e = displayEntry(entry.id); return String(e.theme || e.category || 'Uncategorized'); }
function commentsFor(id) {
  const r = reviewFor(id);
  if (!Array.isArray(r.comments)) r.comments = r.comment ? [{ id: 'c_' + Date.now().toString(36), author: expertName(), text: r.comment, created_at: nowIso(), updated_at: nowIso() }] : [];
  return r.comments;
}
/* non-mutating read for rendering; never creates a phantom review */
function commentsRead(id) {
  const r = state.reviews[String(id)];
  if (!r) return [];
  if (Array.isArray(r.comments)) return r.comments;
  return commentsFor(id); // r already exists (real work), safe to migrate
}
function syncCommentString(id) { const r = reviewFor(id); r.comment = (r.comments || []).map(c => c.text).join('\n\n'); }
function hasComment(id) { const r = state.reviews[String(id)]; if (!r) return false; if (Array.isArray(r.comments)) return r.comments.length > 0; return Boolean(r.comment && r.comment.trim()); }

/* ---------- persistence ---------- */
function snapshot() {
  return {
    schema_version: 'diachronic_expert_study_v2', app_version: APP_VERSION, study_id: state.studyId, saved_at: nowIso(),
    expert: state.expert, corpus: { name: DEFAULT_CORPUS, title: state.corpusMeta.title || null, entry_count: state.entries.length },
    counts: counts(), reviews: state.reviews, suggestions: state.suggestions,
    ui: { selectedId: state.selectedId, filter: state.filter, themeFilter: state.themeFilter, search: state.search }
  };
}
function persistLocal() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot())); return true; } catch (e) { console.warn('local save failed', e); return false; } }
function persist() {
  const ok = persistLocal();
  if (ok) { hideDangerBanner(); setSave('local', 'saved'); } else { showDangerBanner(); setSave('error', 'not saved'); }
  scheduleServerSave();
}
function hasWork() {
  const c = counts();
  if (c.approved + c.rejected + c.edited > 0) return true;
  if ((state.suggestions || []).length) return true;
  return Object.values(state.reviews || {}).some(r => r && ((r.comments && r.comments.length) || (r.comment && String(r.comment).trim())));
}
function backupNow(reason) { try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ reason, at: nowIso(), snapshot: snapshot() })); } catch (_) {} }
function hasBackup() { try { return Boolean(localStorage.getItem(BACKUP_KEY)); } catch { return false; } }
function updateRestoreButton() { const b = $('restore-backup-btn'); if (b) b.hidden = !hasBackup(); }
function showDangerBanner() { const b = $('save-banner'); if (b) b.hidden = false; }
function hideDangerBanner() { const b = $('save-banner'); if (b) b.hidden = true; }
/* final best-effort save on tab close / hide: survives unload via sendBeacon */
function flushSave() {
  if (!state.expert) return;
  persistLocal();
  try { if (navigator.sendBeacon) navigator.sendBeacon(saveEndpoints()[0], new Blob([JSON.stringify(snapshot())], { type: 'application/json' })); } catch (_) {}
}
function setSave(mode, text) { if (!els.saveDot) return; els.saveDot.dataset.mode = mode; if (els.saveText) els.saveText.textContent = text; }
function scheduleServerSave() { clearTimeout(saver.timer); saver.timer = setTimeout(serverSave, 900); }
async function serverSave() {
  if (saver.inFlight) { saver.again = true; return; }
  saver.inFlight = true; setSave('saving', 'saving…');
  const payload = JSON.stringify(snapshot());
  let ok = false;
  for (const url of saveEndpoints()) { try { const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }); if (res.ok) { ok = true; break; } } catch (_) {} }
  saver.serverOk = ok; saver.inFlight = false;
  setSave(ok ? 'live' : 'local', ok ? 'saved to study folder' : 'saved in browser');
  if (saver.again) { saver.again = false; scheduleServerSave(); }
}

/* ---------- corpus ---------- */
function normalizeCorpus(data) {
  const entries = Array.isArray(data) ? data : Array.isArray(data.entries) ? data.entries : Object.values(data.entries || {});
  const meta = Array.isArray(data) ? {} : (data.metadata || {});
  return { meta, entries: entries.map(clone).sort((a, b) => Number(a.id) - Number(b.id)) };
}
async function loadCorpus() {
  try {
    const res = await fetch(DEFAULT_CORPUS, { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const { meta, entries } = normalizeCorpus(await res.json());
    state.corpusMeta = meta; state.entries = entries;
    state.originals = new Map(entries.map(e => [String(e.id), clone(e)]));
    if (els.introCount) els.introCount.textContent = String(entries.length);
    if (!state.entries.some(e => String(e.id) === String(state.selectedId))) state.selectedId = entries[0] ? entries[0].id : null;
  } catch (e) {
    console.error('corpus load failed', e);
    if (els.introCount) els.introCount.textContent = '?';
    if (els.introStatus) els.introStatus.textContent = 'could not load the corpus. serve this folder over http (see readme).';
  }
}
function restoreLocal() {
  try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); if (s) { applyStudy(s); return; } } catch (e) { console.warn('restore failed', e); }
  // fall back to the safety backup if the main store is missing or corrupt
  try { const b = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null'); if (b && b.snapshot) applyStudy(b.snapshot); } catch (_) {}
}
function restoreBackup() {
  let b;
  try { b = JSON.parse(localStorage.getItem(BACKUP_KEY) || 'null'); } catch (_) {}
  if (!b || !b.snapshot) { toast('no backup found in this browser.'); return; }
  applyStudy(b.snapshot);
  if (!state.expert) state.expert = { first_name: 'Restored', last_name: 'Study', expertise_or_credentials: '', started_at: nowIso() };
  render(); persist();
  toast('previous study restored.');
}
function applyStudy(data) {
  if (!data || typeof data !== 'object') return;
  state.studyId = data.study_id || state.studyId;
  state.expert = data.expert || state.expert;
  state.reviews = data.reviews || {};
  state.suggestions = data.suggestions || [];
  const ui = data.ui || {};
  state.selectedId = ui.selectedId != null ? ui.selectedId : state.selectedId;
  state.filter = ui.filter || 'all'; state.themeFilter = ui.themeFilter || 'all'; state.search = ui.search || '';
}

/* ---------- stats / filter ---------- */
function counts() {
  const ids = state.entries.map(e => e.id);
  return { total: ids.length, approved: ids.filter(id => statusFor(id) === 'approved').length, rejected: ids.filter(id => statusFor(id) === 'rejected').length, pending: ids.filter(id => statusFor(id) === 'pending').length, edited: ids.filter(isEdited).length };
}
function haystack(entry) {
  const e = displayEntry(entry.id);
  return [e.id, e.visual_element, e.category, e.shift_type, e.annotation, ...(e.periods || []).flatMap(p => [p.period, p.context, p.meaning]), ...(e.sources || []).flatMap(s => [s.citation])].join(' ').toLowerCase();
}
function filtered() {
  const q = state.search.trim().toLowerCase();
  return state.entries.filter(entry => {
    const id = entry.id, st = statusFor(id);
    const themeOk = state.themeFilter === 'all' || themeForEntry(entry) === state.themeFilter;
    const filterOk = state.filter === 'all' || state.filter === st || (state.filter === 'changed' && isEdited(id));
    const searchOk = !q || haystack(entry).includes(q);
    return themeOk && filterOk && searchOk;
  });
}
function themeOptions() { return Array.from(new Set(state.entries.map(themeForEntry))).filter(Boolean).sort((a, b) => a.localeCompare(b)); }

/* ---------- render ---------- */
function render() {
  const loggedIn = Boolean(state.expert);
  document.body.dataset.screen = loggedIn ? 'app' : 'intro';
  els.app.hidden = !loggedIn;
  if (!loggedIn) return;
  renderTop(); renderIndex(); renderEntry();
}
function renderTop() {
  const c = counts(), decided = c.approved + c.rejected, pct = c.total ? Math.round((decided / c.total) * 100) : 0;
  if (els.pbarFill) els.pbarFill.style.width = pct + '%';
  if (els.progressLabel) els.progressLabel.textContent = `${decided} / ${c.total} decided · ${c.edited} edited`;
  if (els.menuName) els.menuName.textContent = `${state.expert.first_name} ${state.expert.last_name}`;
  if (els.expertInitials) els.expertInitials.textContent = (state.expert.first_name[0] || '') + (state.expert.last_name[0] || '');
}
function renderIndex() {
  els.search.value = state.search;
  document.querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.filter === state.filter));
  const themes = themeOptions();
  if (state.themeFilter !== 'all' && !themes.includes(state.themeFilter)) state.themeFilter = 'all';
  els.themeFilter.innerHTML = `<option value="all">all themes (${state.entries.length})</option>` +
    themes.map(t => `<option value="${esc(t)}">${esc(t)} (${state.entries.filter(e => themeForEntry(e) === t).length})</option>`).join('');
  els.themeFilter.value = state.themeFilter;
  const list = filtered();
  if (!list.length) { els.entryList.innerHTML = '<div class="empty">no diachronics match.</div>'; return; }
  if (!list.some(e => String(e.id) === String(state.selectedId))) state.selectedId = list[0].id;
  els.entryList.innerHTML = list.map((entry, idx) => {
    const e = displayEntry(entry.id), st = statusFor(entry.id);
    const sel = String(entry.id) === String(state.selectedId) ? ' selected' : '';
    const meta = [`#${esc(entry.id)}`, `${(e.periods || []).length} periods`];
    if (isEdited(entry.id)) meta.push('<span class="edited">edited</span>');
    if (hasComment(entry.id)) meta.push('noted');
    const tip = idx === 0 ? ' data-tip="Click any diachronic to review it. Use ↑ ↓ (or J / K) to move down the list."' : '';
    return `<button class="entry-item${sel}" data-id="${entry.id}"${tip}>
      <div class="ei-top"><span class="ei-name">${esc(e.visual_element || 'untitled')}</span><span class="ei-status ${st}"></span></div>
      <div class="ei-meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>
    </button>`;
  }).join('');
}
function renderEntry() {
  if (!state.entries.length) { els.entry.innerHTML = '<div class="empty">load a corpus to begin.</div>'; return; }
  const entry = displayEntry(state.selectedId);
  if (!entry) { els.entry.innerHTML = '<div class="empty">select a diachronic.</div>'; return; }
  const review = reviewSnapshot(state.selectedId);
  const periods = entry.periods || [], sources = entry.sources || [];
  if (state.selectedPeriod >= periods.length) state.selectedPeriod = 0;
  const decided = review.decision === 'approved' ? '<span class="decided approved">approved</span>'
    : review.decision === 'rejected' ? '<span class="decided rejected">rejected</span>' : '';
  els.entry.innerHTML = `
    <div class="entry-kicker">
      <span class="k-label">entry #${esc(entry.id)}</span>
      <input class="k-input" data-path="category" list="cat-list" value="${esc(entry.category || '')}" placeholder="category" data-tip="Set the category, e.g. Fashion & Clothing. Editable, saves automatically.">
      <select class="k-select" data-path="shift_type" data-tip="Pick the type of shift: how the meaning changed over time (linear, cyclical, u-shaped, accumulative).">${shiftOptions(entry.shift_type)}</select>
      ${decided}
    </div>
    <datalist id="cat-list">${categoryDatalist()}</datalist>
    <h1 class="entry-title" contenteditable data-path="visual_element" data-placeholder="visual phenomenon" data-tip="Click to rename this phenomenon. Edits save automatically.">${esc(entry.visual_element || '')}</h1>
    <p class="entry-lede" contenteditable data-path="annotation" data-placeholder="how the meaning shifted overall" data-tip="The overall summary: click to edit how the meaning shifted across the whole timeline.">${esc(entry.annotation || '')}</p>

    <section class="sec periods-sec">
      <div class="sec-head"><h3>how the meaning changed over time</h3><div class="sec-head-right"><span class="sub">${periods.length} periods</span><button class="mini-add" data-action="add-period">+ period</button></div></div>
      <div class="tl-rail" data-tip="Each dot is an era. Click one to read and edit what the element meant then.">${periods.map(renderNode).join('')}</div>
      ${periods.length ? renderFocus(periods[state.selectedPeriod], state.selectedPeriod) : '<div class="empty">no periods yet, add one.</div>'}
    </section>

    <section class="sec">
      <div class="sec-head"><h3>sources</h3><div class="sec-head-right"><span class="sub">${sources.length} listed</span><button class="mini-add" data-action="add-source">+ source</button></div></div>
      <div class="sources">${sources.length ? sources.map(renderSource).join('') : '<div class="empty">no sources listed.</div>'}</div>
    </section>

    <section class="sec" id="notes-sec">${notesInner(state.selectedId)}</section>`;
}
function renderNode(period, i) {
  const changed = isPeriodChanged(state.selectedId, i) ? ' changed' : '';
  const active = i === state.selectedPeriod ? ' active' : '';
  return `<button class="tl-node${active}${changed}" style="--i:${i}" data-period="${i}">
    <span class="tl-dot"></span>
    <span class="tl-years">${esc(yearsLabel(period))}</span>
    <span class="tl-period">${esc(period.period || '')}</span>
    <span class="tl-ctx">${esc(period.context || 'period ' + (i + 1))}</span>
  </button>`;
}
function renderFocus(period, i) {
  return `<div class="period-focus">
    <div class="pf-index">${String(i + 1).padStart(2, '0')}</div>
    <div class="pf-grid">
      <div class="pf-field pf-year"><label>from</label><input type="number" data-path="periods.${i}.year_start" value="${period.year_start ?? ''}"></div>
      <div class="pf-field pf-year"><label>to</label><input type="number" data-path="periods.${i}.year_end" value="${period.year_end ?? ''}"></div>
      <div class="pf-field wide"><label>era label</label><input data-path="periods.${i}.period" value="${esc(period.period || '')}"></div>
    </div>
    <div class="pf-field pf-context-field"><label>context</label><input data-path="periods.${i}.context" value="${esc(period.context || '')}"></div>
    <div class="pf-meaning-wrap">
      <div class="pf-meaning-label">what it meant then</div>
      <div class="pf-meaning" contenteditable data-path="periods.${i}.meaning" data-placeholder="describe the meaning in this era" data-tip="This is the heart of the review: click to refine how the meaning read in this era.">${esc(period.meaning || '')}</div>
    </div>
    <div class="pf-actions">
      <button class="pf-btn" data-action="move-period" data-index="${i}" data-dir="up">← earlier</button>
      <button class="pf-btn" data-action="move-period" data-index="${i}" data-dir="down">later →</button>
      <button class="pf-btn danger" data-action="remove-period" data-index="${i}">remove period</button>
    </div>
  </div>`;
}
function renderSource(source, i) {
  const links = [];
  if (source.doi) links.push(`<a href="${esc(source.doi)}" target="_blank" rel="noopener">DOI</a>`);
  if (source.url) links.push(`<a href="${esc(source.url)}" target="_blank" rel="noopener">link</a>`);
  const bits = [];
  if (source.verified) bits.push('<span class="verified">verified</span>');
  if (source.tier != null && source.tier !== '') bits.push(`tier ${esc(source.tier)}`);
  return `<div class="source">
    <span class="source-num">${String(i + 1).padStart(2, '0')}</span>
    <div class="source-body">
      <div class="source-cite" contenteditable data-path="sources.${i}.citation" data-placeholder="citation">${esc(source.citation || '')}</div>
      <div class="source-meta"><span contenteditable data-path="sources.${i}.url" data-placeholder="url">${esc(source.url || '')}</span>${bits.length ? ' · ' + bits.join(' · ') : ''}${links.length ? ' · ' + links.join(' · ') : ''}</div>
    </div>
    <button class="source-del" data-action="remove-source" data-index="${i}" title="Remove source">×</button>
  </div>`;
}
function notesInner(id) {
  const comments = commentsRead(id);
  return `<div class="sec-head"><h3>reviewer notes</h3><span class="sub">${comments.length} comment${comments.length === 1 ? '' : 's'}</span></div>
    <div class="comment-list">${comments.map(renderComment).join('')}</div>
    <div class="comment-compose" data-tip="Write a note, then press Comment or Enter (Shift+Enter for a new line). You can edit or delete your own comments.">
      <textarea id="comment-input" placeholder="add a note on this diachronic…"></textarea>
      <div class="comment-compose-foot"><span class="hint">enter to comment · shift+enter for a new line</span><button class="comment-submit" data-action="add-comment">comment</button></div>
    </div>`;
}
function renderComment(c) {
  if (state.editingComment === c.id) {
    return `<div class="comment editing" data-cid="${c.id}">
      <textarea class="comment-edit-input">${esc(c.text)}</textarea>
      <div class="comment-actions"><button data-action="save-comment" data-cid="${c.id}">save</button><button data-action="cancel-comment">cancel</button></div>
    </div>`;
  }
  const mine = c.author === expertName();
  const edited = c.updated_at && c.updated_at !== c.created_at ? ' · edited' : '';
  return `<div class="comment" data-cid="${c.id}">
    <div class="comment-head"><span class="comment-author">${esc(c.author)}</span><span class="comment-time">${fmtTime(c.updated_at || c.created_at)}${edited}</span></div>
    <div class="comment-text">${esc(c.text)}</div>
    ${mine ? `<div class="comment-actions"><button data-action="edit-comment" data-cid="${c.id}">edit</button><button data-action="delete-comment" data-cid="${c.id}">delete</button></div>` : ''}
  </div>`;
}
function refreshNotes(focusInput) {
  const sec = $('notes-sec');
  if (!sec) return;
  sec.innerHTML = notesInner(state.selectedId);
  if (focusInput) { const t = $('comment-input'); if (t) t.focus(); }
}
function shiftOptions(cur) {
  const base = ['linear', 'cyclical', 'u-shaped', 'accumulative'];
  const list = !cur || base.includes(cur) ? base : [cur, ...base];
  return `<option value="">select shift type</option>` + list.map(o => `<option value="${esc(o)}"${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('');
}
function categoryDatalist() {
  const cats = Array.from(new Set(state.entries.map(e => { const d = displayEntry(e.id); return d && d.category; }).filter(Boolean))).sort();
  return cats.map(c => `<option value="${esc(c)}"></option>`).join('');
}
function yearsLabel(p) { if (!p) return ''; if (p.year_start != null && p.year_end != null) return `${p.year_start}-${p.year_end}`; return p.period || ''; }
function isPeriodChanged(id, i) { const o = original(id), r = state.reviews[String(id)]; if (!o || !r || !r.entry) return false; return !same((o.periods || [])[i], (r.entry.periods || [])[i]); }

/* ---------- editing ---------- */
function commitField(el) {
  const id = state.selectedId, entry = workingEntry(id), path = el.dataset.path;
  let val;
  if (el.tagName === 'INPUT' && el.type === 'number') val = el.value === '' ? null : Number(el.value);
  else if (el.isContentEditable) val = el.textContent;
  else val = el.value;
  setPath(entry, path, val); markEdited(id); persist();
}

/* ---------- comments ---------- */
function addComment() {
  const input = $('comment-input'); if (!input) return;
  const text = input.value.trim(); if (!text) return;
  const t = nowIso();
  commentsFor(state.selectedId).push({ id: 'c_' + Date.now().toString(36), author: expertName(), text, created_at: t, updated_at: t });
  syncCommentString(state.selectedId);
  persist(); refreshNotes(true); renderIndex();
}
function startEditComment(cid) { state.editingComment = cid; refreshNotes(); const box = els.entry.querySelector('.comment.editing .comment-edit-input'); if (box) { box.focus(); box.selectionStart = box.value.length; } }
function saveComment(cid) {
  const box = els.entry.querySelector(`.comment[data-cid="${cid}"] .comment-edit-input`);
  const list = commentsFor(state.selectedId), c = list.find(x => x.id === cid);
  if (box && c) {
    const text = box.value.trim();
    if (!text) { list.splice(list.indexOf(c), 1); } else { c.text = text; c.updated_at = nowIso(); }
  }
  state.editingComment = null; syncCommentString(state.selectedId);
  persist(); refreshNotes(); renderIndex();
}
function cancelEditComment() { state.editingComment = null; refreshNotes(); }
function deleteComment(cid) {
  const list = commentsFor(state.selectedId), i = list.findIndex(x => x.id === cid);
  if (i < 0) return;
  if (!confirm('Delete this comment?')) return;
  list.splice(i, 1); syncCommentString(state.selectedId);
  persist(); refreshNotes(); renderIndex();
}

/* ---------- decisions & nav ---------- */
function setDecision(decision) {
  const id = state.selectedId, r = reviewFor(id);
  const btn = els.decisionbar.querySelector(`.verdict.${decision === 'approved' ? 'approve' : 'reject'}`);
  r.decision = r.decision === decision ? 'pending' : decision;
  if (btn && r.decision !== 'pending') { btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash'); }
  persist(); renderTop(); renderIndex();
  const kicker = els.entry.querySelector('.entry-kicker');
  if (kicker) {
    kicker.querySelectorAll('.decided').forEach(n => n.remove());
    if (r.decision === 'approved') kicker.insertAdjacentHTML('beforeend', '<span class="decided approved">approved</span>');
    if (r.decision === 'rejected') kicker.insertAdjacentHTML('beforeend', '<span class="decided rejected">rejected</span>');
  }
  if (r.decision !== 'pending') setTimeout(goNextPending, 260);
}
function selectPeriod(i) {
  state.selectedPeriod = i;
  els.entry.querySelectorAll('.tl-node').forEach((n, idx) => n.classList.toggle('active', idx === i));
  const periods = displayEntry(state.selectedId).periods || [];
  const focus = els.entry.querySelector('.period-focus');
  if (periods[i] && focus) { const tmp = document.createElement('div'); tmp.innerHTML = renderFocus(periods[i], i); focus.replaceWith(tmp.firstElementChild); }
}
function selectEntry(id, { animate = true } = {}) {
  state.selectedId = id; state.selectedPeriod = 0; state.editingComment = null; persistLocal();
  renderIndex(); renderEntry();
  if (animate) { els.entry.classList.remove('swap'); void els.entry.offsetWidth; els.entry.classList.add('swap'); }
  window.scrollTo({ top: 0, behavior: 'smooth' });
  hideTip(); if (tour) layoutStep();
}
function goNextPending() {
  const rows = filtered(), i = rows.findIndex(e => String(e.id) === String(state.selectedId));
  const ordered = i >= 0 ? rows.slice(i + 1).concat(rows.slice(0, i + 1)) : rows;
  const next = ordered.find(e => statusFor(e.id) === 'pending');
  if (!next) { toast('no pending diachronics left in this view ✦'); return; }
  selectEntry(next.id);
}
function stepEntry(delta) {
  const rows = filtered(), i = rows.findIndex(e => String(e.id) === String(state.selectedId));
  if (i < 0) return;
  const j = Math.min(rows.length - 1, Math.max(0, i + delta));
  if (rows[j]) selectEntry(rows[j].id);
}

/* ---------- period / source ops ---------- */
function addPeriod() { const e = workingEntry(state.selectedId); if (!Array.isArray(e.periods)) e.periods = []; e.periods.push({ period: 'new era', year_start: null, year_end: null, context: '', meaning: '' }); state.selectedPeriod = e.periods.length - 1; markEdited(state.selectedId); persist(); renderEntry(); }
function removePeriod(i) { const e = workingEntry(state.selectedId); if (!e.periods || !e.periods[i]) return; if (!confirm('Remove this period?')) return; e.periods.splice(i, 1); state.selectedPeriod = Math.max(0, i - 1); markEdited(state.selectedId); persist(); renderEntry(); }
function movePeriod(i, dir) { const e = workingEntry(state.selectedId), j = dir === 'up' ? i - 1 : i + 1; if (!e.periods || j < 0 || j >= e.periods.length) return; const [p] = e.periods.splice(i, 1); e.periods.splice(j, 0, p); state.selectedPeriod = j; markEdited(state.selectedId); persist(); renderEntry(); }
function addSource() { const e = workingEntry(state.selectedId); if (!Array.isArray(e.sources)) e.sources = []; e.sources.push({ citation: '', doi: null, url: '', tier: null, verified: false }); markEdited(state.selectedId); persist(); renderEntry(); }
function removeSource(i) { const e = workingEntry(state.selectedId); if (!e.sources || !e.sources[i]) return; e.sources.splice(i, 1); markEdited(state.selectedId); persist(); renderEntry(); }

/* ---------- import / export / study ---------- */
function downloadStudy() {
  const blob = new Blob([JSON.stringify(snapshot(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `diachronic_study_${slug(state.expert.last_name)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function importStudyFile(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.expert && !data.reviews) { toast('that is not a study file.'); return; }
    if (state.expert && hasWork() && !confirm('Load this study file? It replaces the work open in this browser. That work is backed up first and stays on the server.')) return;
    if (state.expert && hasWork()) { backupNow('before_import'); flushSave(); }
    applyStudy(data);
    if (!state.expert) state.expert = { first_name: 'Restored', last_name: 'Study', expertise_or_credentials: '', started_at: nowIso() };
    render(); persist(); updateRestoreButton(); toast('study resumed.');
  } catch (e) { console.error(e); toast('could not read that file.'); }
}
function newStudy() {
  if (state.expert && hasWork() &&
      !confirm('Start a new study? Your current work is kept (saved on the server and backed up in this browser), but this browser starts fresh.')) return;
  if (state.expert && hasWork()) { backupNow('new_study'); flushSave(); }
  state.studyId = null; state.expert = null; state.reviews = {}; state.suggestions = [];
  state.selectedPeriod = 0; state.editingComment = null; state.filter = 'all'; state.themeFilter = 'all'; state.search = '';
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  ['first-name', 'last-name', 'expertise'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  initVideoBg();
  render();
  updateRestoreButton();
}

/* ============================================================
   GUIDANCE: spotlight tour + non-modal hover tooltips
   ============================================================ */
const TOUR = [
  { target: null, title: 'Welcome', body: "Here's a quick tour of how to review the corpus. It takes about a minute, and you can skip anytime." },
  { target: '.index', title: 'The corpus', body: 'Every diachronic is listed here. Search, filter by status or theme, and click one to open it.' },
  { target: '.entry-title', title: 'The diachronic', body: 'Its name, category, and shift type sit up top. Click any of them to edit, and changes save on their own.' },
  { target: '.tl-rail', title: 'Its timeline', body: 'How the meaning moved across eras. Click a dot to jump to that era.' },
  { target: '.pf-meaning', title: 'What it meant', body: 'The heart of the review: the meaning in the selected era. Click the text to refine it.' },
  { target: '#notes-sec', title: 'Your notes', body: 'Leave comments on a diachronic. Press Comment or Enter. You can edit or delete your own.' },
  { target: '.db-inner', title: 'Your verdict', body: 'Approve (A), Reject (R), or Skip (S). Approving or rejecting jumps you to the next pending one.' },
  { target: '.add-link', title: 'Add a diachronic', body: 'Missing something? Propose a new one: a quick free-text note or a full era-by-era breakdown.' },
  { target: '#help-btn', title: 'Need this again?', body: 'Replay this tour anytime from Help. And hover anything for a one-line hint.' },
  { target: null, title: "You're set", body: 'That’s everything. Happy reviewing!' }
];
function isOnboarded() { try { return localStorage.getItem(ONBOARD_KEY) === '1'; } catch { return false; } }
function markOnboarded() { try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (_) {} }
function maybeOnboard() { if (state.expert && !isOnboarded()) setTimeout(startTour, 650); }

function initGuide() {
  tipUI.tip = $('tip');
  Object.assign(gEls, { guide: $('guide'), hole: $('guide-hole'), pop: $('guide-pop'), step: $('guide-step'), title: $('guide-title'), body: $('guide-body'), dots: $('guide-dots'), back: $('guide-back'), next: $('guide-next') });
  gEls.pop.addEventListener('click', e => {
    const b = e.target.closest('[data-guide]'); if (!b) return;
    const a = b.dataset.guide;
    if (a === 'next') tourAdvance(); else if (a === 'back') tourBack(); else if (a === 'skip') endTour();
  });
  document.addEventListener('mouseover', onHoverIn);
  document.addEventListener('mouseout', onHoverOut);
  document.addEventListener('focusin', e => { if (tour) return; const el = e.target.closest('[data-tip]'); if (el && el !== suppressedEl) showHoverTip(el); });
  document.addEventListener('focusout', () => { if (!tour) scheduleHide(); });
  window.addEventListener('scroll', () => { if (tour) layoutStep(); else hideTip(); }, true);
  window.addEventListener('resize', () => { if (tour) layoutStep(); });
  tipUI.tip.addEventListener('click', onTipClick);
  tipUI.tip.addEventListener('mouseenter', () => clearTimeout(hideTip.t));
  tipUI.tip.addEventListener('mouseleave', () => { if (!tour) scheduleHide(); });
}

/* ---- guided tour ---- */
function startTour() {
  hideTip();
  const steps = TOUR.filter(s => !s.target || document.querySelector(s.target));
  if (!steps.length) return;
  tour = { steps, i: 0 };
  gEls.guide.hidden = false;
  document.body.classList.add('guiding');
  showStep(0);
}
function showStep(i) {
  if (!tour) return;
  tour.i = Math.max(0, Math.min(i, tour.steps.length - 1));
  const step = tour.steps[tour.i];
  const el = step.target ? document.querySelector(step.target) : null;
  gEls.step.textContent = `${tour.i + 1} of ${tour.steps.length}`;
  gEls.title.textContent = step.title;
  gEls.body.textContent = step.body;
  gEls.back.disabled = tour.i === 0;
  gEls.next.textContent = tour.i === tour.steps.length - 1 ? 'Done' : 'Next';
  gEls.dots.innerHTML = tour.steps.map((_, k) => `<span class="guide-dot${k === tour.i ? ' on' : ''}"></span>`).join('');
  if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  layoutStep();
  clearTimeout(showStep.t); showStep.t = setTimeout(layoutStep, 300);
}
function layoutStep() {
  if (!tour) return;
  const step = tour.steps[tour.i];
  const el = step.target ? document.querySelector(step.target) : null;
  const hole = gEls.hole, pop = gEls.pop, pr = pop.getBoundingClientRect();
  if (el) {
    const r = el.getBoundingClientRect(), pad = 6;
    hole.style.left = (r.left - pad) + 'px'; hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + pad * 2) + 'px'; hole.style.height = (r.height + pad * 2) + 'px';
    let top = r.bottom + 14;
    if (top + pr.height > window.innerHeight - 12) top = Math.max(12, r.top - 14 - pr.height);
    const left = Math.min(Math.max(12, r.left), window.innerWidth - pr.width - 12);
    pop.style.top = top + 'px'; pop.style.left = left + 'px';
  } else {
    hole.style.left = '50%'; hole.style.top = '50%'; hole.style.width = '0px'; hole.style.height = '0px';
    pop.style.top = Math.max(12, (window.innerHeight - pr.height) / 2) + 'px';
    pop.style.left = ((window.innerWidth - pr.width) / 2) + 'px';
  }
}
function tourAdvance() { if (!tour) return; if (tour.i >= tour.steps.length - 1) endTour(); else showStep(tour.i + 1); }
function tourBack() { if (tour) showStep(tour.i - 1); }
function endTour() { tour = null; gEls.guide.hidden = true; document.body.classList.remove('guiding'); markOnboarded(); }

/* ---- hover tooltips (non-modal, one at a time) ---- */
function onHoverIn(e) {
  if (tour) return;
  const el = e.target.closest('[data-tip]');
  if (!el || el === curHoverEl || el === suppressedEl) return;
  curHoverEl = el;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => { if (curHoverEl === el) showHoverTip(el); }, 320);
}
function onHoverOut(e) {
  if (tour) return;
  const el = e.target.closest('[data-tip]');
  if (!el || el !== curHoverEl) return;
  if (e.relatedTarget && (el.contains(e.relatedTarget) || tipUI.tip.contains(e.relatedTarget))) return;
  clearTimeout(hoverTimer);
  curHoverEl = null;
  if (suppressedEl === el) suppressedEl = null;
  scheduleHide();
}
function scheduleHide() { clearTimeout(hideTip.t); hideTip.t = setTimeout(() => { if (!tipUI.tip.matches(':hover')) hideTip(); }, 140); }
function showHoverTip(el) {
  const text = el.getAttribute('data-tip'); if (!text) return;
  activeTipEl = el;
  tipUI.tip.innerHTML = `<div class="cp-text"><span>${esc(text)}</span></div><button class="cp-x" data-tip-act="dismiss" aria-label="dismiss">×</button>`;
  tipUI.tip.hidden = false;
  positionTip(el);
  requestAnimationFrame(() => tipUI.tip.classList.add('show'));
}
function hideTip() {
  if (!tipUI.tip) return;
  tipUI.tip.classList.remove('show');
  clearTimeout(hideTip.h); hideTip.h = setTimeout(() => { if (!tipUI.tip.classList.contains('show')) tipUI.tip.hidden = true; }, 200);
}
function positionTip(el) {
  const tip = tipUI.tip, r = el.getBoundingClientRect(), pr = tip.getBoundingClientRect();
  let top = r.bottom + 10;
  if (top + pr.height > window.innerHeight - 10) top = Math.max(10, r.top - pr.height - 10);
  const left = Math.min(Math.max(10, r.left), window.innerWidth - pr.width - 10);
  tip.style.top = top + 'px'; tip.style.left = left + 'px';
}
function onTipClick(e) {
  const act = e.target.closest('[data-tip-act]'); if (!act) return;
  if (act.getAttribute('data-tip-act') === 'dismiss') { suppressedEl = activeTipEl; hideTip(); }
}

/* ---------- events ---------- */
function bind() {
  els.introForm.addEventListener('submit', e => {
    e.preventDefault();
    const first = $('first-name').value.trim(), last = $('last-name').value.trim();
    if (!first || !last) { els.introStatus.textContent = !first ? 'please enter your first name.' : 'please enter your last name.'; (!first ? $('first-name') : $('last-name')).focus(); return; }
    state.expert = { first_name: first, last_name: last, expertise_or_credentials: $('expertise').value.trim(), started_at: nowIso() };
    state.studyId = `${slug(first)}-${slug(last)}-${Date.now().toString(36)}`;
    document.body.classList.add('leaving');
    setTimeout(() => {
      document.body.classList.remove('leaving'); render(); els.app.classList.add('app-enter'); persist();
      setTimeout(startTour, 700);   // every person who signs in gets the tour (after the entrance animation)
    }, 460);
  });
  $('resume-file-btn').addEventListener('click', () => els.studyFile.click());
  $('restore-backup-btn').addEventListener('click', restoreBackup);
  $('save-banner-dl').addEventListener('click', downloadStudy);

  els.search.addEventListener('input', e => { state.search = e.target.value; persistLocal(); renderIndex(); });
  els.filters.addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; state.filter = b.dataset.filter; persistLocal(); renderIndex(); });
  els.themeFilter.addEventListener('change', e => { state.themeFilter = e.target.value || 'all'; persistLocal(); renderIndex(); });
  els.entryList.addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) selectEntry(b.dataset.id); });

  els.entry.addEventListener('input', e => { if (e.target.matches('[data-path]')) commitFieldDebounced(e.target); });
  els.entry.addEventListener('change', e => { if (e.target.matches('select[data-path], input[data-path]')) commitField(e.target); });
  els.entry.addEventListener('blur', e => { if (e.target.matches('[data-path]')) { commitField(e.target); renderIndex(); } }, true);
  els.entry.addEventListener('keydown', e => {
    if (e.target.id === 'comment-input' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); }
    else if (e.target.classList.contains('comment-edit-input') && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const c = e.target.closest('.comment'); if (c) saveComment(c.dataset.cid); }
  });
  els.entry.addEventListener('click', e => {
    const node = e.target.closest('.tl-node');
    if (node) { selectPeriod(Number(node.dataset.period)); return; }
    const btn = e.target.closest('[data-action]'); if (btn) handleAction(btn.dataset.action, btn);
  });

  els.decisionbar.addEventListener('click', e => { const b = e.target.closest('[data-action]'); if (!b) return; if (b.dataset.action === 'decision') setDecision(b.dataset.decision); if (b.dataset.action === 'next') goNextPending(); });

  els.menuBtn.addEventListener('click', () => { const open = els.menuPop.hidden; els.menuPop.hidden = !open; els.menuBtn.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', e => { if (!els.menuPop.hidden && !e.target.closest('.menu')) els.menuPop.hidden = true; });
  els.menuPop.addEventListener('click', e => {
    const b = e.target.closest('[data-menu]'); if (!b) return;
    els.menuPop.hidden = true;
    if (b.dataset.menu === 'download') downloadStudy();
    if (b.dataset.menu === 'resume') els.studyFile.click();
    if (b.dataset.menu === 'new') newStudy();
  });
  els.studyFile.addEventListener('change', async e => { await importStudyFile(e.target.files[0]); e.target.value = ''; });
  $('help-btn').addEventListener('click', startTour);
  $('brand').addEventListener('click', e => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });

  document.addEventListener('keydown', e => {
    if (tour) {
      if (e.key === 'Escape') endTour();
      else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); tourAdvance(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); tourBack(); }
      return;
    }
    if (!state.expert) return;
    if (e.key === 'Escape' && tipUI.tip && tipUI.tip.classList.contains('show')) { suppressedEl = activeTipEl; hideTip(); return; }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === '/' && !typing) { e.preventDefault(); els.search.focus(); return; }
    if (e.key === 'Escape' && state.editingComment) { cancelEditComment(); return; }
    if (typing) return;
    const k = e.key.toLowerCase();
    if (k === 'a') { e.preventDefault(); setDecision('approved'); }
    else if (k === 'r') { e.preventDefault(); setDecision('rejected'); }
    else if (k === 's') { e.preventDefault(); goNextPending(); }
    else if (k === 'c') { e.preventDefault(); const t = $('comment-input'); if (t) { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); t.focus(); } }
    else if (k === 'enter') { e.preventDefault(); goNextPending(); }
    else if (e.key === 'ArrowDown' || k === 'j') { e.preventDefault(); stepEntry(1); }
    else if (e.key === 'ArrowUp' || k === 'k') { e.preventDefault(); stepEntry(-1); }
  });
}
const commitFieldDebounced = debounce(commitField, 300);
function handleAction(action, el) {
  const i = Number(el.dataset.index), cid = el.dataset.cid;
  if (action === 'add-period') addPeriod();
  else if (action === 'remove-period') removePeriod(i);
  else if (action === 'move-period') movePeriod(i, el.dataset.dir);
  else if (action === 'add-source') addSource();
  else if (action === 'remove-source') removeSource(i);
  else if (action === 'add-comment') addComment();
  else if (action === 'edit-comment') startEditComment(cid);
  else if (action === 'save-comment') saveComment(cid);
  else if (action === 'cancel-comment') cancelEditComment();
  else if (action === 'delete-comment') deleteComment(cid);
}

/* ---------- video login background ---------- */
function initVideoBg() {
  const VIDEOS = [
    'https://archive.org/download/twitter-885518243779235840/885518243779235840.mp4',
    'https://archive.org/download/twitter-1283302780741070852/1283302780741070852.mp4',
    'https://archive.org/download/10-suffragette/10__SUFFRAGETTE.ia.mp4',
    'https://archive.org/download/rocny-Suffragist_Mary_S._Anthony_1827-1907/Suffragist_Mary_S._Anthony_1827-1907.mp4',
    'https://archive.org/download/silent-a-busy-day-aka-the-militant-suffragette/A%20Busy%20Day%20AKA%20The%20Militant%20Suffragette.mp4',
    'https://archive.org/download/IntlWomensDayMarchDOL382017540p/Intl_Womens_Day_March_DOL_3-8-2017_540p.mp4',
    'https://archive.org/download/twitter-929866396619689984/929866396619689984.mp4',
    'https://archive.org/download/scacca-2018_WOMENS_MARCH_PROMO/2018_WOMENS_MARCH_PROMO.mp4',
    'https://archive.org/download/nctv18ma-Womens_March_on_Nantucket_2018/Womens_March_on_Nantucket_2018.mp4',
    'https://archive.org/download/HappyInternationalWomensDay2015/Happy%20%23InternationalWomensDay2015.mp4',
    'https://archive.org/download/chicago-grande-roue-in-1896/Chicago%2C%20Grande%20Roue%20in%201896.mp4',
    'https://archive.org/download/NewYorkCityConeyIslandAmusementPark1903/New%20York%20City%20-%20Coney%20Island%20Amusement%20Park%20-%201903.mp4',
    'https://archive.org/download/SF129/SF129_512kb.mp4'
  ];
  const grid = $('video-grid'); if (!grid) return;
  const cells = grid.querySelectorAll('.video-cell video');
  if (cells[0] && cells[0].src) return; // already initialised
  const shuffled = VIDEOS.slice().sort(() => Math.random() - 0.5);
  cells.forEach((v, i) => {
    const src = shuffled[i % shuffled.length];
    v.preload = 'auto';
    v.addEventListener('loadedmetadata', () => { if (v.duration > 3) v.currentTime = Math.random() * v.duration * 0.5; }, { once: true });
    v.addEventListener('canplay', () => { v.classList.add('loaded'); v.play().catch(() => {}); }, { once: true });
    v.src = src; v.load();
  });
}

/* ---------- boot ---------- */
function initEls() {
  Object.assign(els, {
    app: $('app'), intro: $('intro'), introForm: $('intro-form'), introStatus: $('intro-status'), introCount: $('intro-count'),
    studyFile: $('study-file'), pbarFill: $('pbar-fill'), progressLabel: $('progress-label'),
    saveDot: $('save-dot'), saveText: $('save-text'), menuBtn: $('menu-btn'), menuPop: $('menu-pop'), menuName: $('menu-name'), expertInitials: $('expert-initials'),
    search: $('search'), filters: $('filters'), themeFilter: $('theme-filter'), entryList: $('entry-list'),
    stage: $('stage'), entry: $('entry'), decisionbar: $('decisionbar'), toast: $('toast')
  });
}
function checkFlash() {
  try { const f = localStorage.getItem(FLASH_KEY); if (f) { localStorage.removeItem(FLASH_KEY); setTimeout(() => toast(f), 400); } } catch (_) {}
}
async function init() {
  initEls(); restoreLocal(); bind(); initGuide();
  if (!state.expert) initVideoBg();
  await loadCorpus(); render(); checkFlash(); maybeOnboard(); updateRestoreButton();
  if (state.expert && hasWork()) serverSave();   // re-sync browser -> server whenever the server is reachable
  window.addEventListener('beforeunload', flushSave);
  window.addEventListener('pagehide', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
}
document.addEventListener('DOMContentLoaded', init);
