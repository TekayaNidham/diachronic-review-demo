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
  filter: 'all', themeFilter: 'all', search: '',
  mode: 'explore', reviewStep: 0, reviewComplete: false   // explore (read-only) vs review (guided assessment)
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
function prefersReducedMotion() { return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
/* replay a one-shot CSS animation class on an element (safe if it is null) */
function replayAnim(el, cls) { if (!el || prefersReducedMotion()) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); el.addEventListener('animationend', () => el.classList.remove(cls), { once: true }); }

/* ---------- review accessors ---------- */
function original(id) { return state.originals.get(String(id)); }
function reviewFor(id) {
  const k = String(id);
  if (!state.reviews[k]) state.reviews[k] = { decision: 'pending', comment: '', comments: [], edited: false, theme_answers: {}, period_decisions: {}, source_decisions: {}, entry: clone(original(id)) };
  if (!state.reviews[k].entry) state.reviews[k].entry = clone(original(id));
  if (!state.reviews[k].theme_answers) state.reviews[k].theme_answers = {};
  if (!state.reviews[k].period_decisions) state.reviews[k].period_decisions = {};
  if (!state.reviews[k].source_decisions) state.reviews[k].source_decisions = {};
  return state.reviews[k];
}
function reviewSnapshot(id) { return state.reviews[String(id)] || { decision: 'pending', comment: '', comments: [], edited: false, period_decisions: {}, entry: original(id) }; }

/* ---------- per-period ratings (Likert: 1 incorrect/delete … 5 correct/approve) ---------- */
const LIKERT = [
  { v: 1, label: 'incorrect', end: 'delete' },
  { v: 2, label: 'mostly wrong' },
  { v: 3, label: 'unsure' },
  { v: 4, label: 'mostly right' },
  { v: 5, label: 'correct', end: 'approve' }
];
function likertLabel(v) { const o = LIKERT.find(x => x.v === Number(v)); return o ? o.label : ''; }
function likertClass(v) { return 'lv' + Number(v); }
const YEAR_MIN = 1830, YEAR_MAX = 2030;
function periodDecisions(id) { const r = state.reviews[String(id)]; return (r && r.period_decisions) || {}; }
function periodRating(id, i) { const v = periodDecisions(id)[i]; return v == null ? null : Number(v); }
function periodCount(id) { return (displayEntry(id).periods || []).length; }
function decidedCount(id) { const pd = periodDecisions(id), n = periodCount(id); let c = 0; for (let i = 0; i < n; i++) if (pd[i]) c++; return c; }

/* ---------- theme-level assessment (yes/no on the theme itself) ---------- */
const THEME_QS = [
  { key: 'diachronic', q: 'Is this theme genuinely diachronic?', hint: 'Its meaning actually shifts across historical time, rather than staying constant.' },
  { key: 'important', q: 'Is this theme important?', hint: 'Worth documenting as a meaningful cultural shift.' }
];
function themeAnswers(id) { const r = state.reviews[String(id)]; return (r && r.theme_answers) || {}; }
function themeAnswerVal(id, key) { const v = themeAnswers(id)[key]; return v === 'yes' || v === 'no' ? v : null; }
function themeDoneCount(id) { const ta = themeAnswers(id); return THEME_QS.reduce((c, q) => c + (ta[q.key] === 'yes' || ta[q.key] === 'no' ? 1 : 0), 0); }
/* the guided steps are the PERIODS; the two theme yes/no live in a persistent banner on top
   (so the expert sees the period descriptions immediately, not a theme gate first) */
function assessmentSteps(id) { const s = []; for (let i = 0; i < periodCount(id); i++) s.push({ kind: 'period', i }); return s; }
function nextThemeQ(id) { return THEME_QS.find(q => themeAnswerVal(id, q.key) == null); }
function assessmentTotal(id) { return THEME_QS.length + periodCount(id); }
function assessmentDoneCount(id) { return themeDoneCount(id) + decidedCount(id); }
function assessmentDone(id) { return themeDoneCount(id) === THEME_QS.length && decidedCount(id) === periodCount(id); }
/* first period the expert hasn't rated yet (to resume mid-assessment); theme is handled by the banner */
function firstUnansweredStep(id) {
  const n = periodCount(id);
  for (let i = 0; i < n; i++) if (periodRating(id, i) == null) return i;
  return Math.max(0, n - 1);
}
/* topic lifecycle: 'pending' (untouched) · 'started' (some answered) · 'done' (theme + every era answered) */
function topicStatus(id) {
  const total = assessmentTotal(id); if (!total) return 'pending';
  const done = assessmentDoneCount(id);
  if (done === 0) return 'pending';
  return assessmentDone(id) ? 'done' : 'started';
}
function nextUndecided(id, from) {
  const n = periodCount(id), pd = periodDecisions(id);
  for (let s = 1; s <= n; s++) { const i = (from + s) % n; if (!pd[i]) return i; }
  return -1;
}
/* ---------- per-source relevance ratings (same 1..5 ramp: irrelevant/delete … very relevant/approve) ---------- */
function sourceDecisions(id) { const r = state.reviews[String(id)]; return (r && r.source_decisions) || {}; }
function sourceRating(id, i) { const v = sourceDecisions(id)[i]; return v == null ? null : Number(v); }
const SRC_LABELS = { 1: 'irrelevant', 2: 'mostly irrelevant', 3: 'unsure', 4: 'relevant', 5: 'very relevant' };
function srcLabel(v) { return SRC_LABELS[Number(v)] || ''; }
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
    ui: { selectedId: state.selectedId, filter: state.filter, themeFilter: state.themeFilter, search: state.search, mode: state.mode }
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
  if (c.done + c.started > 0) return true;
  if ((state.suggestions || []).length) return true;
  return Object.values(state.reviews || {}).some(r => r && (
    (r.theme_answers && Object.keys(r.theme_answers).length) ||
    (r.period_decisions && Object.keys(r.period_decisions).length) ||
    (r.source_decisions && Object.keys(r.source_decisions).length) ||
    r.edited ||
    (r.comments && r.comments.length) ||
    (r.comment && String(r.comment).trim())
  ));
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
function setSave(mode, text) {
  if (!els.saveDot) return;
  els.saveDot.dataset.mode = mode;
  if (els.saveText) els.saveText.textContent = text;
  if (mode === 'live' || mode === 'local') replayAnim(els.saveDot, 'just-saved');   // a soft heartbeat each time work settles
}
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
  state.mode = ui.mode === 'review' ? 'review' : 'explore';
}

/* ---------- stats / filter ---------- */
function counts() {
  const ids = state.entries.map(e => e.id);
  const st = ids.map(topicStatus);
  return { total: ids.length, done: st.filter(s => s === 'done').length, started: st.filter(s => s === 'started').length, pending: st.filter(s => s === 'pending').length };
}
function haystack(entry) {
  const e = displayEntry(entry.id);
  return [e.id, e.visual_element, e.category, e.shift_type, e.annotation, ...(e.periods || []).flatMap(p => [p.period, p.context, p.meaning]), ...(e.sources || []).flatMap(s => [s.citation])].join(' ').toLowerCase();
}
function filtered() {
  const q = state.search.trim().toLowerCase();
  return state.entries.filter(entry => {
    const id = entry.id, st = topicStatus(id);
    const themeOk = state.themeFilter === 'all' || themeForEntry(entry) === state.themeFilter;
    const filterOk = state.filter === 'all' || state.filter === st;
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
  renderTop(); renderIndex(true); renderEntry();
}
function renderTop() {
  const c = counts(), pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  if (els.pbarFill) els.pbarFill.style.width = pct + '%';
  if (els.progressLabel) els.progressLabel.textContent = `${c.done} / ${c.total} assessed${c.started ? ` · ${c.started} in progress` : ''}`;
  if (els.menuName) els.menuName.textContent = `${state.expert.first_name} ${state.expert.last_name}`;
  if (els.expertInitials) els.expertInitials.textContent = (state.expert.first_name[0] || '') + (state.expert.last_name[0] || '');
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode));
}
function renderIndex(animate = false) {
  els.search.value = state.search;
  document.querySelectorAll('.chip').forEach(b => b.classList.toggle('active', b.dataset.filter === state.filter));
  const themes = themeOptions();
  if (state.themeFilter !== 'all' && !themes.includes(state.themeFilter)) state.themeFilter = 'all';
  els.themeFilter.innerHTML = `<option value="all">all themes (${state.entries.length})</option>` +
    themes.map(t => `<option value="${esc(t)}">${esc(t)} (${state.entries.filter(e => themeForEntry(e) === t).length})</option>`).join('');
  els.themeFilter.value = state.themeFilter;
  const list = filtered();
  els.entryList.classList.toggle('stagger', animate && !prefersReducedMotion());
  if (!list.length) { els.entryList.innerHTML = '<div class="empty">no diachronics match.</div>'; return; }
  // keep the current selection even if a filter would hide it (e.g. it just moved from "to do" to "in progress"),
  // so a review in progress is never yanked away; only pick a default when nothing is selected yet.
  if (state.selectedId == null) state.selectedId = list[0].id;
  els.entryList.innerHTML = list.map((entry, idx) => {
    const e = displayEntry(entry.id), st = topicStatus(entry.id);
    const n = (e.periods || []).length;
    const sel = String(entry.id) === String(state.selectedId) ? ' selected' : '';
    const progress = st === 'done' ? 'assessed'
      : st === 'started' ? `<span class="edited">${assessmentDoneCount(entry.id)}/${assessmentTotal(entry.id)} answered</span>`
      : `${n} period${n === 1 ? '' : 's'}`;
    const meta = [`#${esc(entry.id)}`, progress];
    if (hasComment(entry.id)) meta.push('noted');
    const tip = idx === 0 ? ' data-tip="Click any diachronic to review it. Use ↑ ↓ (or J / K) to move down the list."' : '';
    return `<button class="entry-item${sel}" data-id="${entry.id}" style="--r:${Math.min(idx, 14)}"${tip}>
      <div class="ei-top"><span class="ei-name">${esc(e.visual_element || 'untitled')}</span><span class="ei-status ${st}"></span></div>
      <div class="ei-meta">${meta.map(m => `<span>${m}</span>`).join('')}</div>
    </button>`;
  }).join('');
}
function renderEntry() {
  if (!state.entries.length) { els.entry.innerHTML = '<div class="empty">load a corpus to begin.</div>'; renderSide(); return; }
  const entry = displayEntry(state.selectedId);
  if (!entry) { els.entry.innerHTML = '<div class="empty">select a diachronic.</div>'; renderSide(); return; }
  const periods = entry.periods || [];
  if (state.selectedPeriod >= periods.length) state.selectedPeriod = 0;
  els.entry.dataset.mode = state.mode;
  if (state.mode === 'review') renderReview(entry); else renderExplore(entry);
  renderSide();
  initRanges();
}
/* shared theme header (title, category, shift, assessment status) */
function topicHead(entry) {
  const id = entry.id, st = topicStatus(id);
  const statusPill = st === 'done' ? '<span class="decided approved">assessed</span>'
    : st === 'started' ? `<span class="decided started">${assessmentDoneCount(id)} / ${assessmentTotal(id)} assessed</span>` : '';
  const tags = [];
  if (entry.category) tags.push(`<span class="k-tag">${esc(entry.category)}</span>`);
  if (entry.shift_type) tags.push(`<span class="k-tag accent">${esc(entry.shift_type)} shift</span>`);
  return `<div class="topic-head">
    <div class="entry-kicker"><span class="k-label">entry #${esc(entry.id)}</span>${tags.join('')}${statusPill}</div>
    <h1 class="entry-title">${esc(entry.visual_element || 'untitled')}</h1>
    ${entry.annotation ? `<p class="entry-lede">${esc(entry.annotation)}</p>` : ''}
  </div>`;
}
/* ---------- EXPLORE mode: read-only, no assessment ---------- */
function renderExplore(entry) {
  const periods = entry.periods || [];
  els.entry.innerHTML = `
    ${topicHead(entry)}
    <div class="tl-rail" data-tip="Each dot is a period of this theme. Click a dot to read what the element meant then.">${periods.map((p, i) => renderNode(p, i)).join('')}</div>
    ${periods.length ? renderExploreFocus(periods[state.selectedPeriod], state.selectedPeriod) : '<div class="empty">no periods recorded for this theme.</div>'}
    <div class="explore-cta">
      <div class="explore-cta-note">explore the theme and its periods freely. when you're ready, assess them one by one.</div>
      <button type="button" class="start-assess-btn" data-action="start-assessment">start assessment <span aria-hidden="true">▸</span></button>
    </div>`;
}
function renderExploreFocus(period, i) {
  return `<div class="period-focus explore">
    <div class="pf-top">
      <div class="pf-index">period ${i + 1} <span>of ${periodCount(state.selectedId)}</span></div>
      <span class="pf-years-read">${esc(yearsLabel(period) || '—')}</span>
    </div>
    ${period.context ? `<div class="pf-ctx-read">${esc(period.context)}</div>` : ''}
    <div class="pf-meaning-wrap">
      <div class="pf-meaning-label">what it meant then</div>
      <div class="pf-meaning">${esc(period.meaning || 'no description recorded for this period.')}</div>
    </div>
  </div>`;
}
/* ---------- REVIEW mode: guided assessment ---------- */
/* builds the review shell once; step-to-step changes are targeted (updateReviewFlow) so the
   title + timeline never rebuild and their entrance animation never replays mid-assessment */
function renderReview(entry) {
  const id = entry.id, periods = entry.periods || [];
  const steps = assessmentSteps(id);
  if (state.reviewStep >= steps.length) state.reviewStep = Math.max(0, steps.length - 1);
  if (state.reviewComplete && assessmentDone(id)) { els.entry.innerHTML = topicHead(entry) + renderReviewComplete(entry); return; }
  const step = steps[state.reviewStep];
  const activePeriod = step ? step.i : -1;
  if (activePeriod >= 0) state.selectedPeriod = activePeriod;
  const done = assessmentDoneCount(id), total = assessmentTotal(id), pct = total ? Math.round((done / total) * 100) : 0;
  els.entry.innerHTML = `
    ${topicHead(entry)}
    <div class="tl-rail" data-tip="Each dot is a period. Its colour shows your rating once you judge it.">${periods.map((p, i) => renderNode(p, i, activePeriod)).join('')}</div>
    <div class="theme-banner-wrap">${renderThemeBanner(id)}</div>
    <div class="assess-flow">
      <div class="assess-progress"><div class="ap-bar"><span style="width:${pct}%"></span></div><div class="ap-count">${progressText(id, steps)}</div></div>
      <div class="assess-body">${stepBodyHTML(id, step)}</div>
      <div class="review-nav">
        <button type="button" class="rv-btn back" data-review="back"${state.reviewStep === 0 ? ' disabled' : ''}>← back</button>
        <button type="button" class="rv-btn next" data-review="next">${state.reviewStep >= steps.length - 1 ? 'finish ✓' : 'next →'}</button>
      </div>
    </div>`;
}
function progressText(id, steps) {
  const n = steps.length, label = n ? `period ${state.reviewStep + 1} of ${n}` : 'theme only';
  return `${label} · ${assessmentDoneCount(id)}/${assessmentTotal(id)} answered`;
}
function stepBodyHTML(id, step) {
  if (!step) return '<div class="empty">no periods to assess — answer the theme questions above.</div>';
  const periods = displayEntry(id).periods || [];
  return renderFocus(periods[step.i], step.i);
}
/* theme yes/no banner: shows the first unanswered theme question on top, until answered */
function renderThemeBanner(id) {
  const q = nextThemeQ(id); if (!q) return '';
  return `<div class="theme-banner" data-key="${q.key}">
    <div class="tb-text">
      <span class="tb-kicker">about the theme · answer to remove</span>
      <span class="tb-q">${esc(q.q)}</span>
      <span class="tb-hint">${esc(q.hint)}</span>
    </div>
    <div class="tb-yesno">
      <button type="button" class="yn-btn sm no" data-theme-ans="no" data-theme-key="${q.key}">no</button>
      <button type="button" class="yn-btn sm yes" data-theme-ans="yes" data-theme-key="${q.key}">yes</button>
    </div>
  </div>`;
}
function updateThemeBanner() {
  const wrap = els.entry.querySelector('.theme-banner-wrap'); if (!wrap) return;
  const html = renderThemeBanner(state.selectedId), existing = wrap.querySelector('.theme-banner');
  if (!html) { if (existing && !prefersReducedMotion()) { existing.classList.add('tb-leave'); setTimeout(() => { wrap.innerHTML = ''; }, 320); } else wrap.innerHTML = ''; return; }
  wrap.innerHTML = html;
  replayAnim(wrap.querySelector('.theme-banner'), 'step-in');
}
function nudgeThemeBanner() { replayAnim(els.entry.querySelector('.theme-banner'), 'nudge'); }
/* commit any year edits still sitting in the slider/inputs so a step change never drops them */
function flushYearEdits() { els.entry.querySelectorAll('.range-dual input[data-path]').forEach(commitField); }
/* keep the shell, swap only the step body + progress + nav + active dot */
function updateReviewFlow() {
  const id = state.selectedId, steps = assessmentSteps(id), step = steps[state.reviewStep];
  flushYearEdits();
  refreshProgress();
  const body = els.entry.querySelector('.assess-body');
  if (body) { body.innerHTML = stepBodyHTML(id, step); replayAnim(body.firstElementChild, 'step-in'); }
  const back = els.entry.querySelector('.rv-btn.back'); if (back) back.disabled = state.reviewStep === 0;
  const next = els.entry.querySelector('.rv-btn.next'); if (next) next.textContent = state.reviewStep === steps.length - 1 ? 'finish ✓' : 'next →';
  setActiveNode(step && step.kind === 'period' ? step.i : -1);
  initRanges();
}
function refreshProgress() {
  const id = state.selectedId, steps = assessmentSteps(id);
  const total = assessmentTotal(id), pct = total ? Math.round((assessmentDoneCount(id) / total) * 100) : 0;
  const bar = els.entry.querySelector('.ap-bar span'); if (bar) bar.style.width = pct + '%';
  const cnt = els.entry.querySelector('.ap-count'); if (cnt) cnt.textContent = progressText(id, steps);
}
function setActiveNode(idx) {
  const nodes = els.entry.querySelectorAll('.tl-node');
  nodes.forEach((n, i) => n.classList.toggle('active', i === idx));
  if (idx >= 0 && nodes[idx] && !prefersReducedMotion()) nodes[idx].scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
}
function renderReviewComplete(entry) {
  const id = entry.id, n = periodCount(id);
  const vals = Object.values(periodDecisions(id)).map(Number).filter(x => !isNaN(x));
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 5;
  const reject = mean < 3;
  const icon = reject
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M6 12.5l4 4 8-8.5"/></svg>';
  return `<div class="assess-complete">
    <div class="ac-mark${reject ? ' reject' : ''}">${icon}</div>
    <div class="ac-title">assessment complete</div>
    <div class="ac-sub">you judged the theme and all ${n} period${n === 1 ? '' : 's'}. your answers are saved.</div>
    <div class="ac-actions">
      <button type="button" class="rv-btn" data-review="revisit">review my answers</button>
      <button type="button" class="rv-btn primary" data-action="next-theme">choose the next theme ▸</button>
    </div>
  </div>`;
}
function renderNode(period, i, activeIdx) {
  const v = periodRating(state.selectedId, i);
  const cls = v != null ? ` rated ${likertClass(v)}` : '';
  const active = i === (activeIdx === undefined ? state.selectedPeriod : activeIdx) ? ' active' : '';
  return `<button class="tl-node${active}${cls}" style="--i:${i}" data-period="${i}">
    <span class="tl-dot"></span>
    <span class="tl-years">${esc(yearsLabel(period))}</span>
    <span class="tl-ctx">${esc(period.context || period.period || 'era ' + (i + 1))}</span>
  </button>`;
}
function renderFocus(period, i) {
  const v = periodRating(state.selectedId, i);
  const badge = v == null ? '<span class="pf-verdict pending">not yet rated</span>'
    : `<span class="pf-verdict ${likertClass(v)}">rated: ${esc(likertLabel(v))}</span>`;
  const a = period.year_start != null ? period.year_start : YEAR_MIN;
  const b = period.year_end != null ? period.year_end : YEAR_MAX;
  const dots = LIKERT.map(o =>
    `<button class="likert-dot ${likertClass(o.v)}${o.v === v ? ' on' : ''}" data-likert="${o.v}" title="${esc(o.label)}" aria-label="${esc(o.label)}"><span></span></button>`
  ).join('');
  return `<div class="period-focus" data-rating="${v || 'pending'}">
    <div class="pf-top">
      <div class="pf-index">era ${i + 1} <span>of ${periodCount(state.selectedId)}</span></div>
      ${badge}
    </div>
    <div class="pf-years" data-tip="Correct the era's start and end year: drag the handles along the timeline (a bubble shows the year), use the − / + buttons, or type into the from / to boxes. This is the only thing on the page you can change.">
      <div class="year-steppers">
        <div class="year-box"><label>from</label><button type="button" class="step-btn" data-step="start" data-dir="-1" aria-label="earlier start">−</button><input type="number" inputmode="numeric" class="yr-input yr-from" data-year="start" min="${YEAR_MIN}" max="${YEAR_MAX}" value="${a}" aria-label="start year"><button type="button" class="step-btn" data-step="start" data-dir="1" aria-label="later start">+</button></div>
        <div class="year-box"><label>to</label><button type="button" class="step-btn" data-step="end" data-dir="-1" aria-label="earlier end">−</button><input type="number" inputmode="numeric" class="yr-input yr-to" data-year="end" min="${YEAR_MIN}" max="${YEAR_MAX}" value="${b}" aria-label="end year"><button type="button" class="step-btn" data-step="end" data-dir="1" aria-label="later end">+</button></div>
      </div>
      <div class="timeline-slider range-dual" data-min="${YEAR_MIN}" data-max="${YEAR_MAX}">
        <div class="range-track"><div class="range-fill"></div></div>
        <div class="ts-ticks">${yearTicks(YEAR_MIN, YEAR_MAX)}</div>
        <div class="range-bubbles" aria-hidden="true">
          <div class="range-bubble range-bubble-lo"></div>
          <div class="range-bubble range-bubble-hi"></div>
        </div>
        <input type="range" class="range-lo" min="${YEAR_MIN}" max="${YEAR_MAX}" step="1" value="${a}" data-path="periods.${i}.year_start" aria-label="start year">
        <input type="range" class="range-hi" min="${YEAR_MIN}" max="${YEAR_MAX}" step="1" value="${b}" data-path="periods.${i}.year_end" aria-label="end year">
      </div>
    </div>
    <div class="pf-meaning-wrap" data-tip="Read how the element's meaning is described for this era, then rate the description below.">
      <div class="pf-meaning-label">what it meant then</div>
      <div class="pf-meaning">${esc(period.meaning || 'no description recorded for this era.')}</div>
    </div>
    <div class="pf-likert" data-tip="Rate how correct this description is, from incorrect (delete) to correct (approve). This judges the description above. Keys 1-5 also work.">
      <div class="likert-q">how accurate is this description?</div>
      <div class="likert-row">
        <span class="likert-anchor left">incorrect<em>delete</em></span>
        <div class="likert-scale"><div class="likert-line"></div>${dots}</div>
        <span class="likert-anchor right">correct<em>approve</em></span>
      </div>
    </div>
  </div>`;
}
function renderSide() {
  if (!els.side) return;
  const id = state.selectedId;
  if (!state.entries.length || id == null) { els.side.innerHTML = ''; return; }
  const sources = (displayEntry(id).sources || []);
  const rateable = state.mode === 'review';
  const srcTip = rateable ? ' data-tip="Rate each source for how relevant it is to this theme, from irrelevant (delete) to very relevant (approve)."' : '';
  els.side.innerHTML = `
    <section class="side-sec">
      <div class="side-head"${srcTip}><h3>sources</h3><span class="sub">${sources.length}</span></div>
      <div class="sources">${sources.length ? sources.map((s, i) => renderSource(s, i, rateable)).join('') : '<div class="side-empty">no sources listed.</div>'}</div>
    </section>
    <section class="side-sec notes-sec" id="notes-sec">${notesInner(id)}</section>`;
}
function renderSource(source, i, rateable) {
  const meta = [];
  if (source.verified) meta.push('<span class="verified">verified</span>');
  if (source.tier != null && source.tier !== '') meta.push(`tier ${esc(source.tier)}`);
  if (source.doi) meta.push(`<a href="${esc(source.doi)}" target="_blank" rel="noopener">DOI</a>`);
  if (source.url) meta.push(`<a href="${esc(source.url)}" target="_blank" rel="noopener">link</a>`);
  const v = sourceRating(state.selectedId, i);
  const dots = LIKERT.map(o =>
    `<button type="button" class="src-dot ${likertClass(o.v)}${o.v === v ? ' on' : ''}" data-src-idx="${i}" data-src-likert="${o.v}" title="${esc(srcLabel(o.v))}" aria-label="${esc(srcLabel(o.v))}"><span></span></button>`
  ).join('');
  const rank = v == null
    ? '<span class="src-rank none">rate relevance</span>'
    : `<span class="src-rank ${likertClass(v)}">${esc(srcLabel(v))}</span>`;
  const rater = rateable ? `<button type="button" class="src-toggle" data-src-toggle="${i}" aria-expanded="false">
      ${rank}<span class="src-caret" aria-hidden="true">›</span>
    </button>
    <div class="src-likert">
      <div class="src-row">
        <span class="src-anchor left">irrelevant<em>delete</em></span>
        <div class="src-scale"><div class="src-line"></div>${dots}</div>
        <span class="src-anchor right">very relevant<em>approve</em></span>
      </div>
    </div>` : '';
  return `<div class="source" data-src="${i}" data-rating="${v || ''}">
    <div class="source-top">
      <span class="source-num">${String(i + 1).padStart(2, '0')}</span>
      <div class="source-body">
        <div class="source-cite">${esc(source.citation || 'untitled source')}</div>
        ${meta.length ? `<div class="source-meta">${meta.join(' · ')}</div>` : ''}
      </div>
    </div>
    ${rater}
  </div>`;
}
function notesInner(id) {
  const comments = commentsRead(id);
  return `<div class="side-head"><h3>user notes</h3><span class="sub">${comments.length} comment${comments.length === 1 ? '' : 's'}</span></div>
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
  if (el.tagName === 'INPUT' && (el.type === 'number' || el.type === 'range')) val = el.value === '' ? null : Number(el.value);
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
function startEditComment(cid) { state.editingComment = cid; refreshNotes(); const box = document.querySelector('.comment.editing .comment-edit-input'); if (box) { box.focus(); box.selectionStart = box.value.length; } }
function saveComment(cid) {
  const box = document.querySelector(`.comment[data-cid="${cid}"] .comment-edit-input`);
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

/* ---------- mode + guided assessment flow ---------- */
function setMode(mode) {
  if (mode !== 'explore' && mode !== 'review') return;
  if (mode === state.mode) return;
  if (mode === 'review') { startAssessment(); return; }
  state.mode = 'explore'; state.reviewComplete = false; persist(); render();
}
/* enter the guide for the current theme, resuming at the first unanswered step */
function startAssessment() {
  const id = state.selectedId;
  state.mode = 'review';
  state.reviewComplete = assessmentDone(id);
  state.reviewStep = firstUnansweredStep(id);
  const s = assessmentSteps(id)[state.reviewStep];
  if (s && s.kind === 'period') state.selectedPeriod = s.i;
  persist(); render();
}
function reviewGoStep(idx) {
  const steps = assessmentSteps(state.selectedId); if (!steps.length) return;
  const wasComplete = state.reviewComplete;
  state.reviewStep = Math.max(0, Math.min(idx, steps.length - 1));
  state.reviewComplete = false;
  const s = steps[state.reviewStep];
  if (s && s.kind === 'period') state.selectedPeriod = s.i;
  // targeted swap when the shell is already up; full render when coming from the completion card
  if (!wasComplete && els.entry.querySelector('.assess-flow')) updateReviewFlow(); else renderEntry();
}
function reviewNext() {
  const steps = assessmentSteps(state.selectedId);
  if (state.reviewStep >= steps.length - 1) { if (assessmentDone(state.selectedId)) finishAssessment(); else nudgeThemeBanner(); return; }
  reviewGoStep(state.reviewStep + 1);
}
function reviewBack() { if (state.reviewStep > 0) reviewGoStep(state.reviewStep - 1); }
function finishAssessment() { state.reviewComplete = true; renderEntry(); celebrateCompletion(); }

/* ---------- ratings & nav ---------- */
/* theme-level yes/no from the top banner; answering swaps the banner to the next question,
   or clears it once both are answered — the period steps are unaffected */
function setThemeAnswer(key, val) {
  const id = state.selectedId, r = reviewFor(id);
  if (r.theme_answers[key] === val) return;
  r.theme_answers[key] = val;
  persist(); renderTop(); renderIndex(); refreshProgress();
  if (assessmentDone(id)) { setTimeout(finishAssessment, 420); return; }
  updateThemeBanner();
}
/* each period gets a Likert rating (1..5) for how correct its description is, then the guide advances */
function setRating(v) {
  if (state.mode !== 'review') return;
  const id = state.selectedId, n = periodCount(id);
  if (!n) return;
  const r = reviewFor(id), i = state.selectedPeriod;
  const set = r.period_decisions[i] !== v;   // false means we are toggling it off
  if (set) r.period_decisions[i] = v; else delete r.period_decisions[i];
  persist(); renderTop(); renderIndex();
  updatePeriodNode(i); updateLikertUI(); refreshProgress();
  if (!set) return;
  replayAnim(els.entry.querySelector(`.likert-dot[data-likert="${v}"]`), 'ripple');
  const steps = assessmentSteps(id);
  if (assessmentDone(id)) setTimeout(finishAssessment, 500);
  else if (state.reviewStep < steps.length - 1) setTimeout(reviewNext, 460);
  else setTimeout(nudgeThemeBanner, 480);   // last period rated but a theme question is still open
}
/* a diachronic just got fully rated: sweep the timeline dots and pop a checkmark before moving on */
function celebrateCompletion() {
  if (prefersReducedMotion()) return;
  // the dots wave with a per-dot stagger, so hold the class for the full sweep
  // (replayAnim would strip it on the first dot's animationend and cut the rest short)
  // the mark reflects the verdict: green check when mostly correct, red ✕ when mostly rejected
  const vals = Object.values(periodDecisions(state.selectedId)).map(Number).filter(n => !isNaN(n));
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 5;
  const reject = mean < 3;
  const rail = els.entry.querySelector('.tl-rail');
  if (rail) { rail.classList.remove('celebrate'); void rail.offsetWidth; rail.classList.add('celebrate'); setTimeout(() => rail.classList.remove('celebrate'), 1900); }
  const burst = document.createElement('div');
  burst.className = 'complete-burst' + (reject ? ' reject' : '');
  burst.innerHTML = reject
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"/><path d="M6 12.5l4 4 8-8.5"/></svg>';
  document.body.appendChild(burst);
  setTimeout(() => burst.remove(), 1650);
}
/* rate a source's relevance (1..5); click the same value again to clear it */
function setSourceRating(i, v) {
  const id = state.selectedId, r = reviewFor(id);
  const set = r.source_decisions[i] !== v;
  if (set) r.source_decisions[i] = v; else delete r.source_decisions[i];
  persist(); updateSourceUI(i);
  if (set) replayAnim(els.side.querySelector(`.src-dot[data-src-idx="${i}"][data-src-likert="${v}"]`), 'ripple');
}
function updateSourceUI(i) {
  const v = sourceRating(state.selectedId, i);
  els.side.querySelectorAll(`.src-dot[data-src-idx="${i}"]`).forEach(d => d.classList.toggle('on', Number(d.dataset.srcLikert) === v));
  const src = els.side.querySelector(`.source[data-src="${i}"]`); if (src) src.dataset.rating = v || '';
  const rank = src && src.querySelector('.src-rank');
  if (rank) { rank.className = 'src-rank ' + (v == null ? 'none' : likertClass(v)); rank.textContent = v == null ? 'rate relevance' : srcLabel(v); }
}
/* explore mode: click a timeline dot to read that period (read-only, no re-render thrash) */
function exploreSelectPeriod(i) {
  state.selectedPeriod = i;
  const nodes = els.entry.querySelectorAll('.tl-node');
  nodes.forEach((n, idx) => n.classList.toggle('active', idx === i));
  if (nodes[i] && !prefersReducedMotion()) nodes[i].scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  const periods = displayEntry(state.selectedId).periods || [];
  const focus = els.entry.querySelector('.period-focus');
  if (periods[i] && focus) { const tmp = document.createElement('div'); tmp.innerHTML = renderExploreFocus(periods[i], i); focus.replaceWith(tmp.firstElementChild); }
}
/* review mode: click a period dot to jump straight to that period's step */
function reviewSelectPeriod(i) {
  const steps = assessmentSteps(state.selectedId);
  const idx = steps.findIndex(s => s.kind === 'period' && s.i === i);
  if (idx >= 0) reviewGoStep(idx);
}
function updatePeriodNode(i) {
  const node = els.entry.querySelectorAll('.tl-node')[i]; if (!node) return;
  const v = periodRating(state.selectedId, i);
  node.classList.remove('rated', 'lv1', 'lv2', 'lv3', 'lv4', 'lv5');
  if (v != null) node.classList.add('rated', likertClass(v));
}
/* refresh the Likert selection + badge for the focused era without re-rendering (no anim thrash) */
function updateLikertUI() {
  const v = periodRating(state.selectedId, state.selectedPeriod);
  els.entry.querySelectorAll('.likert-dot').forEach(d => d.classList.toggle('on', Number(d.dataset.likert) === v));
  const wrap = els.entry.querySelector('.pf-likert'); if (wrap) wrap.classList.toggle('rated', v != null);
  const focus = els.entry.querySelector('.period-focus'); if (focus) focus.dataset.rating = v || 'pending';
  const badge = els.entry.querySelector('.pf-verdict');
  if (badge) { badge.className = 'pf-verdict ' + (v == null ? 'pending' : likertClass(v)); badge.textContent = v == null ? 'not yet rated' : 'rated: ' + likertLabel(v); }
}
/* dual-handle year slider: clamp lo<=hi, paint the fill, sync the readout + timeline label */
function syncRange(input) {
  const dual = input.closest('.range-dual'); if (!dual) return;
  const lo = dual.querySelector('.range-lo'), hi = dual.querySelector('.range-hi');
  let a = Number(lo.value), b = Number(hi.value);
  if (a > b) { if (input === lo) { a = b; lo.value = a; } else { b = a; hi.value = b; } }
  const min = Number(dual.dataset.min), max = Number(dual.dataset.max), span = (max - min) || 1;
  const fill = dual.querySelector('.range-fill');
  const l = ((a - min) / span) * 100, r = ((b - min) / span) * 100;
  if (fill) { fill.style.left = l + '%'; fill.style.width = Math.max(0, r - l) + '%'; }
  const bLo = dual.querySelector('.range-bubble-lo'), bHi = dual.querySelector('.range-bubble-hi');
  if (bLo) { bLo.style.left = l + '%'; bLo.textContent = a; }
  if (bHi) { bHi.style.left = r + '%'; bHi.textContent = b; }
  const card = input.closest('.period-focus');
  if (card) {
    const f = card.querySelector('.yr-from'), t = card.querySelector('.yr-to');
    if (f && f !== document.activeElement) f.value = a;
    if (t && t !== document.activeElement) t.value = b;
  }
  const node = els.entry.querySelectorAll('.tl-node')[state.selectedPeriod];
  if (node) { const s = node.querySelector('.tl-years'); if (s) s.textContent = `${a}-${b}`; }
}
/* floating year bubble above the handle you're dragging (a live readout of where it will settle) */
function bubbleFor(rangeInput) {
  const dual = rangeInput.closest('.range-dual'); if (!dual) return null;
  return dual.querySelector(rangeInput.classList.contains('range-lo') ? '.range-bubble-lo' : '.range-bubble-hi');
}
function showBubble(rangeInput) { const b = bubbleFor(rangeInput); if (b) { syncRange(rangeInput); b.classList.add('show'); } }
function hideBubbles() { els.entry.querySelectorAll('.range-bubble.show').forEach(b => b.classList.remove('show')); }
/* year typed directly into the text field: clamp, push to the slider handle, commit */
function setYearFromText(input) {
  const dual = els.entry.querySelector('.range-dual'); if (!dual) return;
  const range = dual.querySelector(input.dataset.year === 'start' ? '.range-lo' : '.range-hi'); if (!range) return;
  const min = Number(dual.dataset.min), max = Number(dual.dataset.max);
  let v = parseInt(input.value, 10);
  if (isNaN(v)) { syncRange(range); return; }   // gibberish, restore the last good value
  range.value = Math.max(min, Math.min(max, v));
  input.blur();                                  // let syncRange refresh the field to the clamped value
  syncRange(range); commitField(range);
}
function initRanges() { els.entry.querySelectorAll('.range-dual').forEach(dual => { const lo = dual.querySelector('.range-lo'); if (lo) syncRange(lo); }); }
/* year axis: minor tick every 10 years, labelled major every 50 (1850 / 1900 / 1950 / 2000) */
function yearTicks(min, max) {
  const span = (max - min) || 1, out = [];
  for (let y = Math.ceil(min / 10) * 10; y <= max; y += 10) {
    const pct = ((y - min) / span) * 100, major = (y % 50 === 0);
    out.push(`<span class="ts-tick${major ? ' major' : ''}" style="left:${pct}%">${major ? `<b>${y}</b>` : ''}</span>`);
  }
  return out.join('');
}
/* precise single-year nudge from the − / + buttons, mirrors dragging a handle */
function stepYear(which, dir) {
  const dual = els.entry.querySelector('.range-dual'); if (!dual) return;
  const inp = dual.querySelector(which === 'start' ? '.range-lo' : '.range-hi'); if (!inp) return;
  const min = Number(dual.dataset.min), max = Number(dual.dataset.max);
  inp.value = Math.max(min, Math.min(max, Number(inp.value) + dir));
  syncRange(inp); commitField(inp);
}
function stepPeriod(delta) {   // explore-mode period browsing
  const n = periodCount(state.selectedId); if (!n) return;
  const i = Math.min(n - 1, Math.max(0, state.selectedPeriod + delta));
  if (i !== state.selectedPeriod) exploreSelectPeriod(i);
}
/* never discard: leaving a half-answered theme just reminds you it isn't finished; progress is kept */
function remindIfUnfinished(leavingId, targetId) {
  if (leavingId == null || String(leavingId) === String(targetId)) return;
  if (topicStatus(leavingId) !== 'started') return;
  const e = displayEntry(leavingId), left = assessmentTotal(leavingId) - assessmentDoneCount(leavingId);
  toast(`"${e.visual_element}" isn't finished yet · ${left} answer${left === 1 ? '' : 's'} left. your progress is saved.`);
}
function selectEntry(id, { animate = true } = {}) {
  remindIfUnfinished(state.selectedId, id);
  state.selectedId = id; state.selectedPeriod = 0; state.editingComment = null; state.reviewComplete = false;
  if (state.mode === 'review') {
    state.reviewStep = firstUnansweredStep(id);
    const s = assessmentSteps(id)[state.reviewStep];
    if (s && s.kind === 'period') state.selectedPeriod = s.i;
    state.reviewComplete = assessmentDone(id);
  }
  persistLocal();
  renderIndex(); renderEntry();
  if (animate) { els.entry.classList.remove('swap'); void els.entry.offsetWidth; els.entry.classList.add('swap'); }
  hideTip(); if (tour) layoutStep();
}
function goNextPending() {
  const rows = filtered(), i = rows.findIndex(e => String(e.id) === String(state.selectedId));
  const ordered = i >= 0 ? rows.slice(i + 1).concat(rows.slice(0, i + 1)) : rows;
  const next = ordered.find(e => String(e.id) !== String(state.selectedId) && topicStatus(e.id) !== 'done');
  if (!next) { toast('every theme in this view is assessed ✦'); return; }
  selectEntry(next.id);
}
function stepEntry(delta) {
  const rows = filtered(), i = rows.findIndex(e => String(e.id) === String(state.selectedId));
  if (i < 0) return;
  const j = Math.min(rows.length - 1, Math.max(0, i + delta));
  if (rows[j]) selectEntry(rows[j].id);
}

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
  { target: null, title: 'Welcome', body: "Here's a one-minute tour of how it works. There are two modes: Explore first, then Review. You can skip anytime." },
  { target: '.index', title: 'The corpus', body: 'Every theme (one diachronic) is listed here. Search or filter, then click one to open it.' },
  { target: '.entry-title', title: 'The theme', body: 'The visual element, its category, and how its meaning shifted. Nothing here is rewritten: you are here to judge it.' },
  { target: '.tl-rail', title: 'Period by period', body: 'Each dot is one period of this theme. In Explore mode, click a dot to read what the element meant then, with no pressure to assess yet.' },
  { target: '.explore-cta', title: 'Explore, then assess', body: 'Read the theme and its periods freely. When you are ready, press Start assessment to switch into Review mode and be guided through the questions.' },
  { target: '.mode-switch', title: 'Two modes', body: 'Switch between Explore (read-only browsing) and Review (the guided assessment) here at any time.' },
  { target: '#side', title: 'Sources and notes', body: 'The sources sit here for reference (you rate them for relevance while reviewing), and you can leave user notes for the team.' },
  { target: '#help-btn', title: 'Need this again?', body: 'Replay this tour anytime from Help, and hover anything for a one-line hint.' },
  { target: null, title: "You're set", body: "In Review you go period by period: rate each description and confirm its years. A small banner on top asks two yes/no questions about the theme, which you can answer whenever. Happy reviewing." }
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
  els.filters.addEventListener('click', e => { const b = e.target.closest('.chip'); if (!b) return; state.filter = b.dataset.filter; persistLocal(); renderIndex(true); });
  els.themeFilter.addEventListener('change', e => { state.themeFilter = e.target.value || 'all'; persistLocal(); renderIndex(); });
  els.entryList.addEventListener('click', e => { const b = e.target.closest('[data-id]'); if (b) selectEntry(b.dataset.id); });

  // the year slider is the only editable field; live-sync its fill/readout + value bubble while dragging
  els.entry.addEventListener('input', e => {
    if (!e.target.matches('input[data-path]')) return;
    if (e.target.type === 'range') { syncRange(e.target); showBubble(e.target); }
    commitFieldDebounced(e.target);
  });
  // pop the year bubble up while a handle is grabbed or keyboard-focused, hide it on release/blur
  els.entry.addEventListener('pointerdown', e => { const r = e.target.closest('input[type=range]'); if (r) showBubble(r); });
  els.entry.addEventListener('focusin', e => { const r = e.target.closest('input[type=range]'); if (r) showBubble(r); });
  els.entry.addEventListener('focusout', e => { if (e.target.closest('input[type=range]')) hideBubbles(); });
  document.addEventListener('pointerup', hideBubbles);
  document.addEventListener('pointercancel', hideBubbles);
  // year typed into the text box (commit on Enter / blur)
  els.entry.addEventListener('change', e => { const yi = e.target.closest('.yr-input'); if (yi) setYearFromText(yi); });
  els.entry.addEventListener('keydown', e => { if (e.target.classList.contains('yr-input') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
  els.entry.addEventListener('click', e => {
    const step = e.target.closest('[data-step]');
    if (step) { stepYear(step.dataset.step, Number(step.dataset.dir)); return; }
    const yn = e.target.closest('[data-theme-ans]');
    if (yn) { setThemeAnswer(yn.dataset.themeKey, yn.dataset.themeAns); return; }
    const dot = e.target.closest('.likert-dot');
    if (dot) { setRating(Number(dot.dataset.likert)); return; }
    const rv = e.target.closest('[data-review]');
    if (rv) { const a = rv.dataset.review; if (a === 'next') reviewNext(); else if (a === 'back') reviewBack(); else if (a === 'revisit') reviewGoStep(0); return; }
    const act = e.target.closest('[data-action]');
    if (act) { handleAction(act.dataset.action, act); return; }
    const node = e.target.closest('.tl-node');
    if (node) { const i = Number(node.dataset.period); if (state.mode === 'review') reviewSelectPeriod(i); else exploreSelectPeriod(i); }
  });

  // sources + comments live in the side column
  els.side.addEventListener('keydown', e => {
    if (e.target.id === 'comment-input' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(); }
    else if (e.target.classList.contains('comment-edit-input') && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const c = e.target.closest('.comment'); if (c) saveComment(c.dataset.cid); }
  });
  els.side.addEventListener('click', e => {
    const tg = e.target.closest('.src-toggle');
    if (tg) { const src = tg.closest('.source'); const open = src.classList.toggle('expanded'); tg.setAttribute('aria-expanded', String(open)); return; }
    const sd = e.target.closest('.src-dot');
    if (sd) { setSourceRating(Number(sd.dataset.srcIdx), Number(sd.dataset.srcLikert)); return; }
    const btn = e.target.closest('[data-action]'); if (btn) handleAction(btn.dataset.action, btn);
  });

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
  document.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));

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
    if (state.mode === 'review') {
      const q = nextThemeQ(state.selectedId);
      if (q && (k === 'y' || k === 'n')) { e.preventDefault(); setThemeAnswer(q.key, k === 'y' ? 'yes' : 'no'); return; }
      if (/^[1-5]$/.test(e.key)) { e.preventDefault(); setRating(Number(e.key)); return; }
      if (e.key === 'ArrowRight' || k === 'l') { e.preventDefault(); reviewNext(); return; }
      if (e.key === 'ArrowLeft' || k === 'h') { e.preventDefault(); reviewBack(); return; }
    } else {
      if (e.key === 'ArrowRight' || k === 'l') { e.preventDefault(); stepPeriod(1); return; }
      if (e.key === 'ArrowLeft' || k === 'h') { e.preventDefault(); stepPeriod(-1); return; }
      if (e.key === 'Enter') { e.preventDefault(); startAssessment(); return; }
    }
    if (k === 'c') { e.preventDefault(); const t = $('comment-input'); if (t) { t.focus(); } }
    else if (e.key === 'ArrowDown' || k === 'j') { e.preventDefault(); stepEntry(1); }
    else if (e.key === 'ArrowUp' || k === 'k') { e.preventDefault(); stepEntry(-1); }
  });
}
const commitFieldDebounced = debounce(commitField, 300);
function handleAction(action, el) {
  const cid = el.dataset.cid;
  if (action === 'add-comment') addComment();
  else if (action === 'edit-comment') startEditComment(cid);
  else if (action === 'save-comment') saveComment(cid);
  else if (action === 'cancel-comment') cancelEditComment();
  else if (action === 'delete-comment') deleteComment(cid);
  else if (action === 'start-assessment') startAssessment();
  else if (action === 'next-theme') goNextPending();
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
    stage: $('stage'), entry: $('entry'), side: $('side'), toast: $('toast')
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
