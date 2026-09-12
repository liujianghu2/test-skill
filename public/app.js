/* Skill Lab 前端：状态、渲染与交互。 */

import { renderMarkdown, escapeHtml } from './markdown.js';
import { StreamRenderer } from './stream-render.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const RUNS_KEY = 'skill-lab.runs.v1';
const MAX_RUNS = 40;

const state = {
  meta: { presets: [] },
  config: { providers: [], activeProviderId: '', settings: {} },
  skills: [],
  selectedSkillId: '',
  editingProviderId: '',
  draftModels: [],
  mode: 'instructions',
  attachments: [],
  runs: [],
  busy: false,
  controller: null,
  autorun: null,
};

const api = {
  async get(path) {
    const res = await fetch(path);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
  async send(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
  post(path, body) { return this.send('POST', path, body); },
  patch(path, body) { return this.send('PATCH', path, body); },
};

/* ============================== 工具函数 ============================== */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3200);
}

function fmtMs(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function copyText(text, okMsg = '已复制') {
  if (!text) return toast('没有可复制的内容', 'err');
  navigator.clipboard?.writeText(text).then(() => toast(okMsg, 'ok')).catch(() => toast('复制失败', 'err'));
}

function downloadImage(url) {
  const name = `skill-lab-${Date.now()}.${(url.match(/\.(png|jpe?g|gif|webp|svg|bmp)/i)?.[1] || 'png').toLowerCase()}`;
  if (url.startsWith('data:')) {
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    return;
  }
  fetch(url).then((r) => r.blob()).then((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  }).catch(() => window.open(url, '_blank', 'noopener'));
}

/* ============================== 启动 ============================== */

async function boot() {
  try {
    const [meta, config, skillRes] = await Promise.all([
      api.get('/api/meta'),
      api.get('/api/config'),
      api.get('/api/skills'),
    ]);
    state.meta = meta;
    state.config = config;
    state.skills = skillRes.skills;
    setHealth(true);
  } catch (err) {
    setHealth(false);
    toast(`无法连接后端：${err.message}`, 'err');
    return;
  }
  loadRuns();
  renderPresets();
  renderSkills();
  renderProviders();
  renderProviderSelect();
  renderSettings();
  renderEnvInfo();
  renderAttachments();
  renderRuns();
  renderRecentPaths();
  bindEvents();
  autoGrowInput();

  if (state.autorun) {
    const { input, mode } = state.autorun;
    if (input) $('#input').value = input;
    state.mode = mode;
    $$('#mode-seg .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    autoGrowInput();
    if (state.autorun.autorun) runTest();
  }
}

function setHealth(ok) {
  $('#health-dot').className = `dot ${ok ? 'ok' : 'err'}`;
  $('#health-text').textContent = ok ? '已连接' : '未连接';
}

function renderEnvInfo() {
  const m = state.meta;
  $('#env-info').innerHTML = [
    `数据目录  ${escapeHtml(m.dataDir || '—')}`,
    `Node     ${escapeHtml(m.node || '—')}`,
    '配置     模型服务与 API Key 仅保存在本机 data/config.json',
    '记录     最近 40 次测试记录保存在浏览器本地（不含图片内容）',
  ].join('<br />');
}

/* ============================== 运行记录 ============================== */

/** 记录只保留可重建界面的最小字段；图片以 URL 列表保存，超长的 data URL 丢弃。 */
function compactRun(run) {
  const images = (run.images || [])
    .map((i) => ({ url: String(i.url || '').slice(0, 300), alt: i.alt || '', source: i.source || '' }))
    .filter((i) => i.url && !i.url.startsWith('data:'))
    .slice(0, 12);
  return {
    id: run.id,
    at: run.at,
    skillId: run.skillId || '',
    skillName: run.skillName || '',
    providerId: run.providerId || '',
    providerName: run.providerName || '',
    model: run.model || '',
    mode: run.mode || 'instructions',
    input: (run.input || '').slice(0, 4000),
    attachments: (run.attachments || []).map((a) => ({ name: a.name, kind: a.kind, size: a.size })),
    temperature: run.temperature,
    maxTokens: run.maxTokens,
    status: run.status,
    error: run.error ? String(run.error).slice(0, 500) : '',
    elapsedMs: run.elapsedMs ?? null,
    usage: run.usage || {},
    stopReason: run.stopReason || '',
    text: (run.text || '').slice(0, 20000),
    reasoning: (run.reasoning || '').slice(0, 8000),
    toolCalls: (run.toolCalls || []).slice(0, 20),
    images,
  };
}

function saveRuns() {
  try {
    const payload = JSON.stringify(state.runs.slice(0, MAX_RUNS).map(compactRun));
    if (payload.length > 4_000_000) {
      state.runs = state.runs.slice(0, 10);
      localStorage.setItem(RUNS_KEY, JSON.stringify(state.runs.map(compactRun)));
      return;
    }
    localStorage.setItem(RUNS_KEY, payload);
  } catch (err) {
    // 配额不足时降级保存
    try {
      state.runs = state.runs.slice(0, 8);
      localStorage.setItem(RUNS_KEY, JSON.stringify(state.runs.map(compactRun)));
    } catch { /* 放弃保存 */ }
  }
}

function loadRuns() {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) state.runs = parsed;
  } catch { state.runs = []; }
}

/* ============================== Skill 面板 ============================== */

function renderSkills() {
  const filter = ($('#skill-filter').value || '').trim().toLowerCase();
  const list = $('#skill-list');
  const items = state.skills.filter((s) => !filter
    || s.name.toLowerCase().includes(filter)
    || (s.description || '').toLowerCase().includes(filter)
    || (s.source || '').toLowerCase().includes(filter));

  $('#skill-count').textContent = String(state.skills.length);
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = `<li class="hint" style="padding:8px 2px">${state.skills.length ? '没有匹配的 skill' : '还没有导入 skill'}</li>`;
    renderSkillSelect();
    return;
  }

  for (const skill of items) {
    const li = document.createElement('li');
    li.className = `list-item${skill.id === state.selectedSkillId ? ' selected' : ''}`;
    const badge = skill.sourceType === 'git' ? '仓库' : (skill.sourceType === 'local' || skill.sourceType === 'local-file') ? '本地' : '粘贴';
    li.innerHTML = `
      <div class="li-top">
        <span class="li-name" title="${escapeHtml(skill.name)}">${escapeHtml(skill.name)}</span>
        <span class="li-actions">
          <button class="icon-btn" data-act="refresh" title="重新拉取来源">↻</button>
          <button class="icon-btn danger" data-act="delete" title="删除">✕</button>
        </span>
      </div>
      <div class="li-desc">${escapeHtml(skill.description || '（无描述）')}</div>
      <div class="li-meta">
        <span class="chip">${badge}</span>
        <span>${skill.instructionsLength || 0} 字</span>
        ${skill.version ? `<span>v${escapeHtml(skill.version)}</span>` : ''}
        ${skill.allowedTools?.length ? `<span>工具 ${skill.allowedTools.length}</span>` : ''}
        ${skill.files?.length ? `<span>附件 ${skill.files.length}</span>` : ''}
      </div>`;
    li.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'delete') { e.stopPropagation(); deleteSkill(skill); return; }
      if (act === 'refresh') { e.stopPropagation(); refreshSkill(skill); return; }
      state.selectedSkillId = skill.id;
      renderSkills();
    });
    list.append(li);
  }
  renderSkillSelect();
}

function renderSkillSelect() {
  const sel = $('#m-skill');
  const current = state.selectedSkillId;
  sel.innerHTML = '<option value="">（不使用 Skill）</option>'
    + state.skills.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
  sel.value = state.skills.some((s) => s.id === current) ? current : '';
  state.selectedSkillId = sel.value;
}

async function importGit() {
  const url = $('#git-url').value.trim();
  if (!url) return toast('请填写仓库地址', 'err');
  const btn = $('#btn-import-git');
  btn.disabled = true;
  btn.textContent = '导入中…';
  try {
    const res = await api.post('/api/skills/import/git', { url });
    state.skills = res.skills;
    state.selectedSkillId = res.skill.id;
    $('#git-url').value = '';
    renderSkills();
    toast(`已导入：${res.skill.name}`, 'ok');
  } catch (err) {
    toast(`导入失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '导入仓库';
  }
}

async function importLocal() {
  const p = $('#local-path').value.trim();
  if (!p) return toast('请填写本地路径，或点「浏览…」挑选', 'err');
  const btn = $('#btn-import-local');
  btn.disabled = true;
  btn.textContent = '导入中…';
  try {
    const res = await api.post('/api/skills/import/local', { path: p });
    state.skills = res.skills;
    state.selectedSkillId = res.skill.id;
    $('#local-path').value = '';
    rememberPath(p);
    renderSkills();
    toast(`已导入：${res.skill.name}`, 'ok');
  } catch (err) {
    toast(`导入失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '导入';
  }
}

/* ---------------------- 本地路径：选择器与最近记录 ---------------------- */

const RECENT_KEY = 'skill-lab.localPaths.v1';

function recentPaths() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(raw) ? raw.slice(0, 5) : [];
  } catch { return []; }
}

function rememberPath(p) {
  const value = String(p || '').trim();
  if (!value) return;
  const next = [value, ...recentPaths().filter((x) => x !== value)].slice(0, 5);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 忽略配额错误 */ }
  renderRecentPaths();
}

function renderRecentPaths() {
  const box = $('#recent-paths');
  if (!box) return;
  const list = recentPaths();
  box.innerHTML = '';
  if (!list.length) return;
  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = '最近：';
  box.append(label);
  for (const p of list) {
    const btn = document.createElement('button');
    btn.className = 'chip path-chip';
    btn.type = 'button';
    btn.title = p;
    btn.textContent = p.length > 34 ? `…${p.slice(-32)}` : p;
    btn.addEventListener('click', () => {
      $('#local-path').value = p;
      importLocal();
    });
    box.append(btn);
  }
}

/** Chromium 的 File System Access API：让用户用系统对话框挑文件夹，只取顶层文件名。 */
async function pickFolderNative() {
  if (typeof window.showDirectoryPicker !== 'function') {
    throw new Error('当前浏览器不支持系统文件夹选择器，请用「浏览…」');
  }
  const handle = await window.showDirectoryPicker({ mode: 'read' });
  const files = [];
  for await (const [name, entry] of handle.entries()) {
    if (entry.kind !== 'file') continue;
    const lower = name.toLowerCase();
    if (!/\.(md|markdown|txt|json|ya?ml|csv|py|js|mjs|ts|sh|ps1)$/.test(lower)) continue;
    try {
      const file = await entry.getFile();
      if (file.size > 2 * 1024 * 1024) continue;
      files.push({ name, text: await file.text() });
    } catch { /* 单个文件读失败就跳过 */ }
  }
  if (!files.length) throw new Error('该文件夹里没有可读取的文本文件');
  const skillFile = files.find((f) => /^skill\.(md|markdown)$/i.test(f.name));
  if (!skillFile) throw new Error('该文件夹里没有 SKILL.md；请选到 Skill 所在目录，或改用「浏览…」');
  const folderName = handle.name;
  const res = await api.post('/api/skills/import/text', { text: skillFile.text, name: folderName });
  state.skills = res.skills;
  state.selectedSkillId = res.skill.id;
  renderSkills();
  toast(`已从「${folderName}」导入：${res.skill.name}`, 'ok');
}

/* ---- 服务端目录浏览器（浏览器拿不到绝对路径时使用） ---- */

const browserState = { path: '', parent: '', items: [], quick: [], busy: false, importable: false, batch: { count: 0, paths: [] } };

async function openSkillBrowser(startPath) {
  $('#browser').hidden = false;
  const initial = startPath || $('#local-path').value.trim() || browserState.path || recentPaths()[0] || '';
  await loadBrowserDir(initial);
}

function closeSkillBrowser() {
  $('#browser').hidden = true;
}

async function loadBrowserDir(target) {
  const list = $('#browser-list');
  list.innerHTML = '<li class="hint" style="padding:8px 2px">读取中…</li>';
  try {
    const res = await api.post('/api/fs/list', { path: target || '' });
    browserState.path = res.path;
    browserState.parent = res.parent;
    browserState.items = res.items || [];
    browserState.quick = res.quick || [];
    browserState.importable = Boolean(res.importable);
    browserState.batch = res.batch || { count: 0, paths: [] };
    $('#browser-path').value = res.path;
    renderBrowser(res);
  } catch (err) {
    list.innerHTML = `<li class="hint" style="padding:8px 2px">读取失败：${escapeHtml(err.message)}</li>`;
  }
}

function renderBrowser(res) {
  const list = $('#browser-list');
  list.innerHTML = '';

  const quickBox = $('#browser-quick');
  quickBox.innerHTML = '';
  for (const q of browserState.quick) {
    const btn = document.createElement('button');
    btn.className = 'btn ghost sm';
    btn.textContent = q.label;
    btn.title = q.path;
    btn.addEventListener('click', () => loadBrowserDir(q.path));
    quickBox.append(btn);
  }

  if (!browserState.items.length) {
    list.innerHTML = '<li class="hint" style="padding:8px 2px">这个目录里没有子目录，也没有找到 markdown 文件</li>';
  }

  for (const item of browserState.items) {
    const li = document.createElement('li');
    li.className = 'list-item';
    const isSkillDir = item.type === 'dir' && (item.hasSkill || item.hasSkillChild);
    const isSkillFile = item.type === 'file' && item.isSkill;
    li.innerHTML = `
      <div class="li-top">
        <span class="li-name">${item.type === 'dir' ? '📁' : '📄'} ${escapeHtml(item.name)}</span>
        ${isSkillFile ? '<span class="chip accent">SKILL.md</span>' : ''}
        ${item.type === 'dir' && item.hasSkill ? '<span class="chip ok">含 SKILL.md</span>' : ''}
        ${item.type === 'dir' && !item.hasSkill && item.hasSkillChild ? '<span class="chip">子目录含 Skill</span>' : ''}
        ${item.type === 'file' && !isSkillFile ? `<span class="chip">${fmtBytes(item.size)}</span>` : ''}
      </div>`;
    if (item.type === 'dir') {
      li.addEventListener('click', () => loadBrowserDir(item.path));
    } else {
      li.title = item.path;
      li.addEventListener('click', async () => {
        $('#local-path').value = item.path;
        closeSkillBrowser();
        await importLocal();
      });
    }
    if (isSkillDir) {
      const actions = document.createElement('span');
      actions.className = 'li-actions';
      const use = document.createElement('button');
      use.className = 'icon-btn';
      use.title = '导入这个目录';
      use.textContent = '导入';
      use.addEventListener('click', async (e) => {
        e.stopPropagation();
        $('#local-path').value = item.path;
        closeSkillBrowser();
        await importLocal();
      });
      actions.append(use);
      li.querySelector('.li-top').append(actions);
    }
    list.append(li);
  }

  const hint = $('#browser-hint');
  const batchBtn = $('#browser-import-batch');
  const { count } = browserState.batch;
  if (count > 0) {
    batchBtn.hidden = false;
    batchBtn.textContent = `导入其中 ${count} 个 Skill`;
  } else {
    batchBtn.hidden = true;
  }
  const hereBtn = $('#browser-import-here');
  if (browserState.importable) {
    hereBtn.hidden = false;
    hereBtn.disabled = false;
    hereBtn.textContent = '导入当前目录';
    hereBtn.title = '把当前目录作为 Skill 导入';
  } else {
    // 当前目录本身不是 Skill：不显示一个点了会失败的按钮
    hereBtn.hidden = count > 0;
    hereBtn.disabled = true;
    hereBtn.textContent = '当前目录没有 SKILL.md';
    hereBtn.title = '当前目录里没有 SKILL.md，也不是只含一个 markdown 的目录';
  }

  hint.textContent = count > 0
    ? `这个目录下有 ${count} 个 Skill 子目录，可以一次全部导入`
    : browserState.importable
      ? '这个目录里发现 Skill，可点「导入当前目录」'
      : res.suggestion === 'file'
        ? '这个目录里只有一个 markdown，可点「导入当前目录」'
        : '进入 Skill 所在目录后点「导入当前目录」';
}

/** 批量导入当前目录下的 Skill 子目录。 */
async function importSkillBatch() {
  const paths = browserState.batch.paths || [];
  if (!paths.length) return;
  const btn = $('#browser-import-batch');
  btn.disabled = true;
  let ok = 0;
  const failed = [];
  for (const [i, p] of paths.entries()) {
    btn.textContent = `导入中 ${i + 1}/${paths.length}`;
    try {
      const res = await api.post('/api/skills/import/local', { path: p });
      state.skills = res.skills;
      ok++;
    } catch (err) {
      failed.push(`${p.split(/[\\/]/).pop()}: ${err.message}`);
    }
  }
  btn.disabled = false;
  renderSkills();
  closeSkillBrowser();
  if (ok) toast(`已导入 ${ok} 个 Skill${failed.length ? `，${failed.length} 个失败` : ''}`, 'ok');
  if (failed.length) toast(`失败：${failed.slice(0, 3).join('；')}`, 'err');
}

async function importPaste() {
  const text = $('#paste-text').value;
  if (!text.trim()) return toast('请粘贴 SKILL.md 内容', 'err');
  try {
    const res = await api.post('/api/skills/import/text', { text, name: $('#paste-name').value.trim() || undefined });
    state.skills = res.skills;
    state.selectedSkillId = res.skill.id;
    $('#paste-text').value = '';
    $('#paste-name').value = '';
    renderSkills();
    toast(`已保存：${res.skill.name}`, 'ok');
  } catch (err) {
    toast(`保存失败：${err.message}`, 'err');
  }
}

async function deleteSkill(skill) {
  if (!confirm(`删除 skill「${skill.name}」？`)) return;
  try {
    const res = await api.post(`/api/skills/${encodeURIComponent(skill.id)}/delete`, {});
    state.skills = res.skills;
    if (state.selectedSkillId === skill.id) state.selectedSkillId = '';
    renderSkills();
    toast('已删除', 'ok');
  } catch (err) { toast(`删除失败：${err.message}`, 'err'); }
}

async function refreshSkill(skill) {
  try {
    const res = await api.post(`/api/skills/${encodeURIComponent(skill.id)}/refresh`, {});
    state.skills = res.skills;
    renderSkills();
    toast(`已重新拉取：${res.skill.name}`, 'ok');
  } catch (err) { toast(`重新拉取失败：${err.message}`, 'err'); }
}

/* ============================== 模型面板 ============================== */

function renderPresets() {
  $('#p-preset').innerHTML = state.meta.presets
    .map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
}

function renderProviders() {
  const list = $('#provider-list');
  list.innerHTML = '';
  if (!state.config.providers.length) {
    list.innerHTML = '<li class="hint" style="padding:6px 2px">还没有配置模型服务，点右上角「+ 新增」</li>';
    renderProviderSelect();
    return;
  }
  for (const p of state.config.providers) {
    const li = document.createElement('li');
    const active = p.id === state.config.activeProviderId;
    li.className = `list-item${active || p.id === state.editingProviderId ? ' selected' : ''}`;
    li.innerHTML = `
      <div class="li-top">
        <span class="li-name">${escapeHtml(p.name)}</span>
        ${active ? '<span class="chip accent">使用中</span>' : `<span class="chip">${escapeHtml(p.protocol)}</span>`}
      </div>
      <div class="li-desc mono" style="font-size:11px">${escapeHtml(p.defaultModel || p.models?.[0] || '（未设置模型）')}</div>
      <div class="li-meta">
        <span>${p.hasApiKey ? '已配置 Key' : '无 Key'}</span>
        <span>${(p.models || []).length} 个模型</span>
      </div>`;
    li.addEventListener('click', () => {
      if (!active) api.post(`/api/providers/${encodeURIComponent(p.id)}/activate`, {}).then(loadConfig).catch((e) => toast(e.message, 'err'));
      openProviderEditor(p);
    });
    list.append(li);
  }
  renderProviderSelect();
}

function openProviderEditor(provider) {
  state.editingProviderId = provider ? provider.id : '';
  $('#provider-editor').hidden = false;
  $('#editor-title').textContent = provider ? `编辑：${provider.name}` : '新增服务商';
  $('#p-preset').value = provider?.preset || 'openai';
  $('#p-name').value = provider?.name || '';
  $('#p-protocol').value = provider?.protocol || 'openai';
  $('#p-baseurl').value = provider?.baseUrl || '';
  $('#p-apikey').value = provider?.apiKey || '';
  $('#p-apikey').placeholder = provider?.hasApiKey ? '已保存（留空则保持不变）' : 'sk-…';
  state.draftModels = [...(provider?.models || [])];
  renderDraftModels();
  $('#provider-note').hidden = true;
  if (!provider) applyPresetDefaults($('#p-preset').value, true);
}

function applyPresetDefaults(presetId, overwrite = false) {
  const preset = state.meta.presets.find((p) => p.id === presetId);
  if (!preset) return;
  if (overwrite || !$('#p-baseurl').value) $('#p-baseurl').value = preset.baseUrl || '';
  if (overwrite || !$('#p-name').value) $('#p-name').value = preset.label;
  $('#p-protocol').value = preset.protocol;
  if (!state.draftModels.length) state.draftModels = [...(preset.models || [])];
  renderDraftModels();
}

function renderDraftModels() {
  const box = $('#p-models');
  box.innerHTML = '';
  for (const m of state.draftModels) {
    const chip = document.createElement('span');
    chip.className = 'model-chip';
    chip.innerHTML = `<span>${escapeHtml(m)}</span><button title="移除">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.draftModels = state.draftModels.filter((x) => x !== m);
      renderDraftModels();
    });
    box.append(chip);
  }
}

async function saveProvider() {
  const body = {
    id: state.editingProviderId || undefined,
    preset: $('#p-preset').value,
    name: $('#p-name').value.trim() || undefined,
    protocol: $('#p-protocol').value,
    baseUrl: $('#p-baseurl').value.trim(),
    models: state.draftModels,
    defaultModel: state.draftModels[0] || '',
  };
  const key = $('#p-apikey').value;
  if (key && !key.includes('••')) body.apiKey = key;
  try {
    const res = await api.post('/api/providers', body);
    await loadConfig();
    openProviderEditor(state.config.providers.find((p) => p.id === res.provider.id));
    toast('已保存', 'ok');
  } catch (err) { toast(`保存失败：${err.message}`, 'err'); }
}

async function testProvider() {
  const note = $('#provider-note');
  note.hidden = false;
  note.className = 'notice';
  note.textContent = '正在测试…';
  const btn = $('#btn-test-provider');
  btn.disabled = true;
  try {
    const body = state.editingProviderId
      ? { providerId: state.editingProviderId }
      : {
        provider: {
          preset: $('#p-preset').value, protocol: $('#p-protocol').value,
          baseUrl: $('#p-baseurl').value.trim(), apiKey: $('#p-apikey').value,
          models: state.draftModels, allowEmptyKey: true,
        },
      };
    const res = await api.post('/api/providers/test', body);
    note.className = 'notice ok';
    note.textContent = `连通正常 · ${res.model} · ${fmtMs(res.elapsedMs)}\n${res.reply || '（无文本回复）'}`;
  } catch (err) {
    note.className = 'notice err';
    note.textContent = `失败：${err.message}`;
  } finally { btn.disabled = false; }
}

async function fetchModelList() {
  const note = $('#provider-note');
  note.hidden = false;
  note.className = 'notice';
  note.textContent = '正在拉取模型列表…';
  try {
    const res = await api.post('/api/providers/models', state.editingProviderId
      ? { providerId: state.editingProviderId }
      : { provider: { preset: $('#p-preset').value, protocol: $('#p-protocol').value, baseUrl: $('#p-baseurl').value.trim(), apiKey: $('#p-apikey').value, models: state.draftModels, allowEmptyKey: true } });
    if (!res.models?.length) {
      note.textContent = res.note || '该服务未返回模型列表，请手动填写。';
      return;
    }
    state.draftModels = [...new Set([...state.draftModels, ...res.models])].slice(0, 200);
    renderDraftModels();
    note.className = 'notice ok';
    note.textContent = `已补充 ${res.models.length} 个模型`;
  } catch (err) {
    note.className = 'notice err';
    note.textContent = `拉取失败：${err.message}`;
  }
}

async function deleteProvider() {
  if (!state.editingProviderId) return;
  if (!confirm('删除该服务商及其 API Key？')) return;
  try {
    await api.send('DELETE', `/api/providers/${encodeURIComponent(state.editingProviderId)}`);
    state.editingProviderId = '';
    $('#provider-editor').hidden = true;
    await loadConfig();
    toast('已删除', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

function renderProviderSelect() {
  const sel = $('#m-provider');
  sel.innerHTML = state.config.providers
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')
    || '<option value="">（无可用服务）</option>';
  sel.value = state.config.activeProviderId || state.config.providers[0]?.id || '';
  renderModelSelect();
}

function renderModelSelect() {
  const provider = currentProvider();
  const sel = $('#m-model');
  const models = provider?.models || [];
  sel.innerHTML = models.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
    || '<option value="">（请先添加模型）</option>';
  sel.value = provider?.defaultModel && models.includes(provider.defaultModel) ? provider.defaultModel : (models[0] || '');
}

function currentProvider() {
  const id = $('#m-provider').value;
  return state.config.providers.find((p) => p.id === id) || state.config.providers[0];
}

async function loadConfig() {
  state.config = await api.get('/api/config');
  renderProviders();
  renderProviderSelect();
}

/* ============================== 设置面板 ============================== */

function renderSettings() {
  const s = state.config.settings || {};
  $('#s-gittoken').value = s.gitToken || '';
  $('#s-temp').value = s.temperature ?? 0.7;
  $('#s-maxtokens').value = s.maxTokens ?? 4096;
  $('#s-systemextra').value = s.systemExtra || '';
  $('#i-temp').value = s.temperature ?? 0.7;
  $('#i-maxtokens').value = s.maxTokens ?? 4096;
}

async function saveSettings() {
  try {
    const body = {
      temperature: Number($('#s-temp').value),
      maxTokens: Number($('#s-maxtokens').value),
      systemExtra: $('#s-systemextra').value,
    };
    const token = $('#s-gittoken').value;
    if (token && !token.includes('••')) body.gitToken = token;
    await api.patch('/api/config/settings', body);
    await loadConfig();
    renderSettings();
    toast('设置已保存', 'ok');
  } catch (err) { toast(`保存失败：${err.message}`, 'err'); }
}

/* ============================== 附件 ============================== */

function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = '';
  if (!state.attachments.length) return;
  for (const [i, a] of state.attachments.entries()) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.title = `${a.name}\n${a.mime || ''}${a.source ? `\n来源：${a.source}` : ''}`;
    chip.innerHTML = `
      <span class="kind">${escapeHtml(a.kind)}</span>
      <span class="name">${escapeHtml(a.name)}</span>
      <span class="size">${fmtBytes(a.size)}</span>
      <button title="移除">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.attachments.splice(i, 1);
      renderAttachments();
    });
    box.append(chip);
  }
  const hint = document.createElement('span');
  hint.className = 'attach-hint';
  hint.textContent = `${state.attachments.length} 个附件随本次请求发送`;
  box.append(hint);
}

function addAttachments(list) {
  const room = 12 - state.attachments.length;
  if (room <= 0) return toast('附件数量已达上限（12 个）', 'err');
  const seen = new Set(state.attachments.map((a) => `${a.name}:${a.size}`));
  let added = 0;
  for (const a of list) {
    if (added >= room) break;
    const key = `${a.name}:${a.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    state.attachments.push(a);
    added++;
  }
  renderAttachments();
  if (added) toast(`已添加 ${added} 个附件`, 'ok');
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const form = new FormData();
  for (const f of files) form.append('files', f, f.name);
  try {
    const res = await fetch('/api/attach/upload', { method: 'POST', body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    addAttachments(json.attachments || []);
  } catch (err) {
    toast(`上传失败：${err.message}`, 'err');
  }
}

async function attachLocalPath() {
  const p = prompt('输入本机文件路径（例如 E:\\data\\report.csv）');
  if (!p) return;
  try {
    const res = await api.post('/api/attach/pick', { path: p });
    addAttachments([res.attachment]);
  } catch (err) { toast(`读取失败：${err.message}`, 'err'); }
}

async function attachFromSkill() {
  const skill = state.skills.find((s) => s.id === state.selectedSkillId);
  if (!skill) return toast('请先在顶部选择一个 Skill', 'err');
  let res;
  try {
    res = await api.get(`/api/skills/${encodeURIComponent(skill.id)}/files`);
  } catch (err) { return toast(`读取失败：${err.message}`, 'err'); }
  const usable = (res.files || []).filter((f) => f.exists && f.kind !== 'binary');
  if (!usable.length) {
    return toast(skill.dir ? '该 Skill 目录里没有可直接读取的文本/图片文件' : '该 Skill 是远程导入的，本机没有它的文件；请改用「＋ 文件」上传', 'err');
  }
  const answer = prompt(
    `「${skill.name}」目录下的可读文件：\n\n${usable.map((f, i) => `${i + 1}. ${f.path}（${f.kind}，${fmtBytes(f.size)}）`).join('\n')}\n\n输入要附件的序号（可多个，用逗号分隔）`,
    '1',
  );
  if (!answer) return;
  const picked = answer.split(/[,，\s]+/).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1 && n <= usable.length);
  if (!picked.length) return toast('没有选择有效序号', 'err');
  const added = [];
  for (const idx of picked) {
    try {
      const r = await api.post(`/api/skills/${encodeURIComponent(skill.id)}/attach`, { path: usable[idx - 1].abs || usable[idx - 1].path });
      added.push(r.attachment);
    } catch (err) { toast(`「${usable[idx - 1].path}」读取失败：${err.message}`, 'err'); }
  }
  addAttachments(added);
}

/* ============================== 运行测试 ============================== */

function modeLabel(mode) {
  return mode === 'none' ? '对照（不注入）' : mode === 'raw' ? '原始 SKILL.md' : '注入 Skill';
}

function buildTurn(promptText, meta) {
  const el = document.createElement('article');
  el.className = 'turn';
  el.innerHTML = `
    <header class="turn-head">
      <span class="chip accent">${escapeHtml(meta.skillName || '无 Skill')}</span>
      <span class="chip">${escapeHtml(meta.providerName || '')}</span>
      <span class="chip">${escapeHtml(meta.model || '')}</span>
      <span class="chip">${escapeHtml(modeLabel(meta.mode))}</span>
      <span class="spacer"></span>
      <span class="time">${fmtTime(meta.startedAt || new Date().toISOString())}</span>
    </header>
    <div class="turn-body">
      <p class="prompt"></p>
      <div class="attach-list"></div>
      <details class="reasoning" hidden>
        <summary class="reasoning-head"><span>推理过程</span><span class="spacer"></span><span class="rlen"></span><span>▾</span></summary>
        <div class="reasoning-body"></div>
      </details>
      <div class="tool-calls" hidden></div>
      <div class="answer streaming-cursor"></div>
      <div class="gallery" hidden></div>
      <div class="metrics" hidden></div>
    </div>`;
  el.querySelector('.prompt').textContent = promptText;
  return el;
}

/** 滚动跟随：只有用户本来就在底部时才自动跟随。 */
function createScroller(stageEl, jumpBtn) {
  let follow = true;
  const nearBottom = () => stageEl.scrollHeight - stageEl.scrollTop - stageEl.clientHeight < 80;
  const pin = () => {
    stageEl.scrollTop = stageEl.scrollHeight;
    jumpBtn.hidden = true;
  };
  stageEl.addEventListener('scroll', () => {
    follow = nearBottom();
    jumpBtn.hidden = follow;
  }, { passive: true });
  // 内容在渲染之后还会变高（图片异步加载、表格换行等），跟随状态下要重新贴底
  const content = stageEl.querySelector('#turns');
  if (content && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => { if (follow) pin(); }).observe(content);
  }
  return {
    follow: () => { if (follow) pin(); },
    always: pin,
    /** 所有内容都渲染完之后再钉到底部（下一帧 + 等一帧缓冲） */
    pinBottom: () => {
      follow = true;
      requestAnimationFrame(() => {
        pin();
        requestAnimationFrame(pin);
      });
    },
    isFollowing: () => follow,
    reset: () => { follow = true; jumpBtn.hidden = true; },
  };
}

async function runTest() {
  if (state.busy) return;
  const provider = currentProvider();
  if (!provider) return toast('请先在左侧配置模型服务', 'err');
  const input = $('#input').value.trim();
  if (!input && !state.attachments.length) {
    $('#input').focus();
    return toast('请输入测试内容或添加附件', 'err');
  }

  const model = $('#m-model').value;
  const skill = state.skills.find((s) => s.id === state.selectedSkillId) || null;
  const mode = state.mode;
  const attachments = state.attachments.slice();
  const overrides = {
    model,
    temperature: Number($('#i-temp').value),
    maxTokens: Number($('#i-maxtokens').value),
    systemExtra: state.config.settings?.systemExtra || '',
  };

  state.busy = true;
  state.controller = new AbortController();
  $('#btn-send').disabled = true;
  $('#btn-stop').hidden = false;
  $('#empty-state').hidden = true;
  // 每次运行都把输入区清空复位，历史留在输出区与记录里
  resetComposer();

  const turn = buildTurn(input, { skillName: skill?.name, providerName: provider.name, model, mode });
  $('#turns').append(turn);
  if (attachments.length) {
    const box = turn.querySelector('.attach-list');
    box.innerHTML = attachments
      .map((a) => `<span class="attach-chip"><span class="kind">${escapeHtml(a.kind)}</span><span class="name">${escapeHtml(a.name)}</span><span class="size">${fmtBytes(a.size)}</span></span>`)
      .join('');
  }
  const answer = turn.querySelector('.answer');
  const reasoningPane = turn.querySelector('.reasoning');
  const reasoningBody = turn.querySelector('.reasoning-body');
  const toolPane = turn.querySelector('.tool-calls');
  const galleryEl = turn.querySelector('.gallery');
  const metricsEl = turn.querySelector('.metrics');

  const stage = $('#stage');
  const scroller = createScroller(stage, $('#btn-jump-bottom'));
  scroller.reset();
  scroller.always();

  const renderer = new StreamRenderer(answer);

  let text = '';
  let reasoning = '';
  let usage = {};
  let updateQueued = false;
  const scheduleFollow = () => {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(() => {
      updateQueued = false;
      scroller.follow();
    });
  };

  const record = {
    id: `run_${Date.now()}`,
    at: new Date().toISOString(),
    skillName: skill?.name || '',
    skillId: skill?.id || '',
    providerName: provider.name,
    providerId: provider.id,
    model,
    mode,
    input,
    attachments: attachments.map((a) => ({ name: a.name, kind: a.kind, size: a.size })),
    temperature: overrides.temperature,
    maxTokens: overrides.maxTokens,
    status: 'running',
  };

  try {
    const res = await fetch('/api/test/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: state.controller.signal,
      body: JSON.stringify({ providerId: provider.id, skillId: skill?.id || undefined, input, mode, overrides, attachments }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }

        if (evt.type === 'meta') {
          record.model = evt.meta.model || model;
          turn.querySelectorAll('.turn-head .chip')[2].textContent = record.model;
          if (evt.meta.context) record.context = evt.meta.context;
        } else if (evt.type === 'reasoning') {
          reasoning += evt.text;
          reasoningPane.hidden = false;
          reasoningBody.textContent = reasoning;
          reasoningPane.querySelector('.rlen').textContent = `${reasoning.length} 字`;
          scheduleFollow();
        } else if (evt.type === 'text') {
          text += evt.text;
          renderer.append(evt.text);
          scheduleFollow();
        } else if (evt.type === 'tool_call') {
          toolPane.hidden = false;
          const d = document.createElement('details');
          d.className = 'tool-call';
          d.innerHTML = `<summary>⚙ ${escapeHtml(evt.call.name || 'tool')}</summary><pre></pre>`;
          d.querySelector('pre').textContent = typeof evt.call.arguments === 'string'
            ? evt.call.arguments
            : JSON.stringify(evt.call.arguments ?? {}, null, 2);
          toolPane.append(d);
          scheduleFollow();
        } else if (evt.type === 'usage') {
          usage = { ...usage, ...evt.usage };
        } else if (evt.type === 'result') {
          Object.assign(record, evt.result);
        } else if (evt.type === 'error') {
          throw new Error(evt.error);
        }
      }
    }
    await reader.cancel().catch(() => {});

    renderer.finish();
    answer.classList.remove('streaming-cursor');
    // 最终用一次性渲染对齐（保证与 markdown.js 输出完全一致）
    answer.innerHTML = renderMarkdown(text);
    record.status = 'done';
    renderMetrics(metricsEl, record, usage);
    renderGallery(galleryEl, record.images || []);
    // 指标与画廊渲染完之后再钉到底部
    scroller.pinBottom();
  } catch (err) {
    renderer.finish();
    answer.classList.remove('streaming-cursor');
    if (err.name === 'AbortError') {
      turn.classList.add('error');
      answer.innerHTML = `${text ? renderMarkdown(text) : ''}<p><b>已手动停止</b></p>`;
      record.status = 'stopped';
    } else {
      turn.classList.add('error');
      answer.innerHTML = `${text ? renderMarkdown(text) : ''}<p><b>请求失败：</b>${escapeHtml(err.message)}</p>`;
      record.status = 'error';
      record.error = err.message;
    }
    record.text = text;
    record.reasoning = reasoning;
    renderMetrics(metricsEl, record, usage);
    scroller.pinBottom();
  } finally {
    state.busy = false;
    state.controller = null;
    $('#btn-send').disabled = false;
    $('#btn-stop').hidden = true;
    state.runs.unshift(record);
    state.runs = state.runs.slice(0, MAX_RUNS);
    saveRuns();
    renderRuns();
  }
}

function renderMetrics(el, record, usage) {
  const ctx = record.context || {};
  const items = [
    `<span><b>耗时</b> ${fmtMs(record.elapsedMs)}</span>`,
    usage.inputTokens != null ? `<span><b>输入</b> ${usage.inputTokens} tok</span>` : (ctx.estimatedPromptTokens ? `<span><b>输入约</b> ${ctx.estimatedPromptTokens} tok</span>` : ''),
    usage.outputTokens != null ? `<span><b>输出</b> ${usage.outputTokens} tok</span>` : '',
    record.outputTokensPerSecond ? `<span><b>速度</b> ${record.outputTokensPerSecond} tok/s</span>` : '',
    record.stopReason ? `<span><b>结束</b> ${escapeHtml(String(record.stopReason))}</span>` : '',
    `<span><b>文本</b> ${(record.text || '').length} 字</span>`,
    record.reasoning ? `<span><b>推理</b> ${record.reasoning.length} 字</span>` : '',
    record.toolCalls?.length ? `<span><b>工具</b> ${record.toolCalls.length} 次</span>` : '',
    ctx.promptChars ? `<span><b>提示词</b> ${ctx.promptChars} 字符</span>` : '',
    ctx.imageCount ? `<span><b>图片</b> ${ctx.imageCount} 张</span>` : '',
  ].filter(Boolean);
  el.hidden = false;
  el.innerHTML = items.join('');
}

function renderGallery(el, images) {
  if (!images?.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = '';
  for (const img of images) {
    const fig = document.createElement('figure');
    fig.className = 'figure';
    fig.innerHTML = `
      <img src="${escapeHtml(img.url)}" alt="${escapeHtml(img.alt || '')}" loading="lazy" />
      <div class="figure-bar">
        <span>${escapeHtml(img.source || 'image')}</span>
        <span class="spacer"></span>
        <button data-act="zoom">放大</button>
        <button data-act="download">下载</button>
      </div>`;
    const imageEl = fig.querySelector('img');
    imageEl.addEventListener('error', () => {
      fig.querySelector('.figure-bar span').textContent = '加载失败（可能被防盗链拦截）';
      imageEl.style.opacity = '.35';
    });
    imageEl.addEventListener('click', () => openLightbox(img.url));
    fig.querySelector('[data-act="zoom"]').addEventListener('click', () => openLightbox(img.url));
    fig.querySelector('[data-act="download"]').addEventListener('click', () => downloadImage(img.url));
    el.append(fig);
  }
}

function openLightbox(url) {
  $('#lightbox-img').src = url;
  $('#lightbox').hidden = false;
}

/* ============================== 记录面板 ============================== */

function renderRuns() {
  const list = $('#run-list');
  list.innerHTML = '';
  if (!state.runs.length) {
    list.innerHTML = '<li class="hint" style="padding:6px 2px">还没有测试记录</li>';
    return;
  }
  for (const run of state.runs) {
    const li = document.createElement('li');
    li.className = 'list-item';
    const statusChip = run.status === 'done' ? '<span class="chip ok">完成</span>'
      : run.status === 'error' ? '<span class="chip err">失败</span>'
        : run.status === 'stopped' ? '<span class="chip warn">已停止</span>' : '<span class="chip">进行中</span>';
    li.innerHTML = `
      <div class="li-top">
        <span class="li-name">${escapeHtml(run.skillName || '（无 Skill）')}</span>
        ${statusChip}
        <span class="li-actions">
          <button class="icon-btn" data-act="rerun" title="用同样的参数再跑一次">↻</button>
          <button class="icon-btn" data-act="view" title="查看输出">👁</button>
          <button class="icon-btn danger" data-act="del" title="删除">✕</button>
        </span>
      </div>
      <div class="li-desc">${escapeHtml((run.input || '（仅附件）').slice(0, 120))}</div>
      <div class="li-meta">
        <span>${fmtTime(run.at)}</span>
        <span>${escapeHtml(run.model || '')}</span>
        <span>${fmtMs(run.elapsedMs)}</span>
        ${run.attachments?.length ? `<span>附件 ${run.attachments.length}</span>` : ''}
      </div>`;
    li.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'del') { e.stopPropagation(); state.runs = state.runs.filter((r) => r.id !== run.id); saveRuns(); renderRuns(); return; }
      if (act === 'view') { e.stopPropagation(); showRun(run); return; }
      fillFromRun(run);
      if (act === 'rerun') runTest();
    });
    list.append(li);
  }
}

function fillFromRun(run) {
  $('#input').value = run.input || '';
  autoGrowInput();
  if (run.skillId && state.skills.some((s) => s.id === run.skillId)) {
    state.selectedSkillId = run.skillId;
    renderSkills();
  }
  if (run.providerId && state.config.providers.some((p) => p.id === run.providerId)) {
    $('#m-provider').value = run.providerId;
    renderModelSelect();
    if (run.model) $('#m-model').value = run.model;
  }
  if (run.mode) {
    state.mode = run.mode;
    $$('#mode-seg .seg-item').forEach((b) => b.classList.toggle('active', b.dataset.mode === run.mode));
  }
  if (run.temperature != null) $('#i-temp').value = run.temperature;
  if (run.maxTokens != null) $('#i-maxtokens').value = run.maxTokens;
}

/** 把历史记录还原成一张输出卡片，便于回看。 */
function showRun(run) {
  $('#empty-state').hidden = true;
  const turn = buildTurn(run.input || '（仅附件）', {
    skillName: run.skillName, providerName: run.providerName, model: run.model, mode: run.mode, startedAt: run.at,
  });
  const answer = turn.querySelector('.answer');
  answer.classList.remove('streaming-cursor');
  answer.innerHTML = run.error
    ? `${run.text ? renderMarkdown(run.text) : ''}<p><b>请求失败：</b>${escapeHtml(run.error)}</p>`
    : renderMarkdown(run.text || '');
  if (run.error) turn.classList.add('error');
  if (run.reasoning) {
    const pane = turn.querySelector('.reasoning');
    pane.hidden = false;
    pane.querySelector('.reasoning-body').textContent = run.reasoning;
    pane.querySelector('.rlen').textContent = `${run.reasoning.length} 字`;
  }
  if (run.attachments?.length) {
    turn.querySelector('.attach-list').innerHTML = run.attachments
      .map((a) => `<span class="attach-chip"><span class="kind">${escapeHtml(a.kind)}</span><span class="name">${escapeHtml(a.name)}</span></span>`)
      .join('');
  }
  if (run.toolCalls?.length) {
    const pane = turn.querySelector('.tool-calls');
    pane.hidden = false;
    for (const call of run.toolCalls) {
      const d = document.createElement('details');
      d.className = 'tool-call';
      d.innerHTML = `<summary>⚙ ${escapeHtml(call.name || 'tool')}</summary><pre></pre>`;
      d.querySelector('pre').textContent = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}, null, 2);
      pane.append(d);
    }
  }
  renderMetrics(turn.querySelector('.metrics'), run, run.usage || {});
  renderGallery(turn.querySelector('.gallery'), run.images || []);
  $('#turns').append(turn);
  $('#stage').scrollTop = $('#stage').scrollHeight;
  toast('已从记录中还原输出');
}

/* ============================== 输入框 ============================== */

/** 空内容时交回 CSS 的 min-height（保证初始高度恒定），有内容时按内容长高。 */
function autoGrowInput() {
  const el = $('#input');
  if (!el.value) {
    el.style.height = '';
    return;
  }
  el.style.height = 'auto';
  el.style.height = `${Math.min(Math.max(el.scrollHeight, 76), 240)}px`;
}

/** 发送之后清空输入与附件，并把输入框恢复成初始样式。 */
function resetComposer() {
  const el = $('#input');
  el.value = '';
  el.style.height = '';
  autoGrowInput();
  state.attachments = [];
  renderAttachments();
}

/* ============================== 事件绑定 ============================== */

function bindEvents() {
  $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => {
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
    $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === btn.dataset.pane));
  }));

  $$('.import-tabs .tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.import-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    const pane = $(`.tabpane[data-tab="${tab.dataset.tab}"]`);
    $$('.tabpane').forEach((p) => p.classList.toggle('active', p === pane));
  }));

  $('#btn-import-git').addEventListener('click', importGit);
  $('#btn-import-local').addEventListener('click', importLocal);
  $('#btn-import-paste').addEventListener('click', importPaste);

  // 本地路径：浏览按钮
  $('#btn-browse-local').addEventListener('click', () => openSkillBrowser());
  $('#btn-browse-folder').addEventListener('click', async () => {
    try {
      await pickFolderNative();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      toast(`${err.message}（已切换到目录浏览）`, 'err');
      openSkillBrowser();
    }
  });
  $('#browser-close').addEventListener('click', closeSkillBrowser);
  $('#browser-up').addEventListener('click', () => {
    if (browserState.parent) loadBrowserDir(browserState.parent);
    else toast('已经是最上层目录', 'err');
  });
  $('#browser-go').addEventListener('click', () => loadBrowserDir($('#browser-path').value.trim()));
  $('#browser-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadBrowserDir($('#browser-path').value.trim());
  });
  $('#browser-import-here').addEventListener('click', async () => {
    if (!browserState.path) return;
    $('#local-path').value = browserState.path;
    closeSkillBrowser();
    await importLocal();
  });
  $('#browser').addEventListener('click', (e) => { if (e.target.id === 'browser') closeSkillBrowser(); });
  $('#browser-import-batch').addEventListener('click', importSkillBatch);
  $('#git-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') importGit(); });
  $('#local-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') importLocal(); });
  $('#skill-filter').addEventListener('input', renderSkills);

  $('#btn-new-provider').addEventListener('click', () => openProviderEditor(null));
  $('#btn-close-editor').addEventListener('click', () => { $('#provider-editor').hidden = true; state.editingProviderId = ''; renderProviders(); });
  $('#p-preset').addEventListener('change', () => { state.draftModels = []; applyPresetDefaults($('#p-preset').value, true); });
  $('#btn-add-model').addEventListener('click', () => {
    const v = $('#p-newmodel').value.trim();
    if (!v) return;
    if (!state.draftModels.includes(v)) state.draftModels.push(v);
    $('#p-newmodel').value = '';
    renderDraftModels();
  });
  $('#p-newmodel').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-add-model').click(); });
  $('#btn-fetch-models').addEventListener('click', fetchModelList);
  $('#btn-save-provider').addEventListener('click', saveProvider);
  $('#btn-test-provider').addEventListener('click', testProvider);
  $('#btn-delete-provider').addEventListener('click', deleteProvider);

  $('#m-provider').addEventListener('change', (e) => {
    api.post(`/api/providers/${encodeURIComponent(e.target.value)}/activate`, {})
      .then(() => { state.config.activeProviderId = e.target.value; renderModelSelect(); })
      .catch((err) => toast(err.message, 'err'));
  });
  $('#m-skill').addEventListener('change', (e) => {
    state.selectedSkillId = e.target.value;
    renderSkills();
  });

  $$('#mode-seg .seg-item').forEach((btn) => btn.addEventListener('click', () => {
    state.mode = btn.dataset.mode;
    $$('#mode-seg .seg-item').forEach((b) => b.classList.toggle('active', b === btn));
  }));

  // 附件
  $('#btn-attach').addEventListener('click', () => $('#pick-files').click());
  $('#pick-files').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
  $('#btn-attach-skill-file').addEventListener('click', attachFromSkill);
  document.addEventListener('click', (e) => {
    if (e.target.closest('#btn-attach-path')) attachLocalPath();
  });
  // 拖拽上传：整个窗口可接收
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth++;
    document.body.classList.add('drop-active');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('drop-active');
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drop-active');
    uploadFiles(e.dataTransfer.files);
  });

  $('#btn-send').addEventListener('click', runTest);
  $('#btn-stop').addEventListener('click', () => state.controller?.abort());
  $('#btn-clear-stage').addEventListener('click', () => {
    $('#turns').innerHTML = '';
    $('#empty-state').hidden = false;
    $('#btn-jump-bottom').hidden = true;
  });
  $('#btn-clear-runs').addEventListener('click', () => {
    if (!state.runs.length) return;
    if (!confirm('清空全部测试记录？')) return;
    state.runs = [];
    saveRuns();
    renderRuns();
  });
  $('#btn-save-settings').addEventListener('click', saveSettings);
  $('#btn-copy-answer').addEventListener('click', () => {
    const answers = $$('#turns .answer');
    const last = answers[answers.length - 1];
    copyText(last?.innerText || '', '回答已复制');
  });
  $('#btn-jump-bottom').addEventListener('click', () => {
    const stage = $('#stage');
    stage.scrollTop = stage.scrollHeight;
    $('#btn-jump-bottom').hidden = true;
  });

  $('#btn-view-skill').addEventListener('click', showPromptPreview);
  $('#modal-close').addEventListener('click', () => { $('#modal').hidden = true; });
  $('#modal-copy').addEventListener('click', () => copyText($('#modal-body').textContent, '提示词已复制'));
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });
  $('#lightbox').addEventListener('click', () => { $('#lightbox').hidden = true; $('#lightbox-img').src = ''; });

  document.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.code-copy');
    if (copyBtn) copyText(decodeURIComponent(copyBtn.dataset.copy), '代码已复制');
  });

  const input = $('#input');
  input.addEventListener('input', autoGrowInput);
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runTest(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#modal').hidden = true;
      $('#browser').hidden = true;
      $('#lightbox').hidden = true;
    }
  });

  // 粘贴图片/文件
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  });
}

async function showPromptPreview() {
  const skill = state.skills.find((s) => s.id === state.selectedSkillId);
  if (!skill) return toast('请先选择一个 Skill', 'err');
  try {
    const res = await api.post('/api/skills/preview', {
      id: skill.id,
      mode: state.mode === 'none' ? 'instructions' : state.mode,
      systemExtra: state.config.settings?.systemExtra || '',
    });
    const extra = state.attachments.length
      ? `\n\n=== 本次附件（会附加在提示词末尾）===\n${state.attachments.map((a, i) => `${i + 1}. ${a.name}（${a.kind}，${fmtBytes(a.size)}）`).join('\n')}`
      : '';
    $('#modal-title').textContent = `将注入的提示词 · ${skill.name}`;
    $('#modal-body').textContent = res.prompt + extra;
    $('#modal').hidden = false;
  } catch (err) { toast(err.message, 'err'); }
}

/* URL 参数预设一次运行，便于脚本化截屏/自检：
   /?skill=<id>&input=<文本>&autorun=1&mode=instructions */
{
  const q = new URLSearchParams(location.search);
  if (q.has('skill')) {
    state.selectedSkillId = q.get('skill');
    state.autorun = { input: q.get('input') || '', mode: q.get('mode') || 'instructions', autorun: q.get('autorun') === '1' };
  }
}

boot();
