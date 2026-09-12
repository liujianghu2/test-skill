/**
 * Skill 仓库：从本地目录或 Git 仓库导入，自动识别 SKILL.md 约定。
 *
 * 本地导入：读取目录下 SKILL.md（也接受 skill.md / 任意单个 .md）；
 * Git 导入：优先用 GitHub / Gitee 官方 raw + API（无需 git 客户端与 token），
 *          其他 git 主机回退到 `git clone --depth 1`（需要本机安装 git）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseSkillText, slug, serializeSkill } from './skill-format.mjs';

const execFileAsync = promisify(execFile);

const SKILL_FILE_CANDIDATES = ['SKILL.md', 'skill.md', 'Skill.md', 'SKILL.MD'];
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|toml|csv|tsv|py|js|mjs|cjs|ts|sh|ps1|sql|html|css|xml|ini|cfg|env|gitignore)$/i;

export class SkillsStore {
  constructor({ dir }) {
    this.dir = dir; // <data>/skills
    this.indexFile = path.join(this.dir, 'index.json');
    this.items = new Map();
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(this.indexFile, 'utf8');
      const parsed = JSON.parse(raw);
      for (const entry of parsed.skills || []) {
        const full = await this.#readSkill(entry);
        if (full) this.items.set(full.id, full);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[skills] 索引读取失败：', err.message);
    }
    // 索引丢失/不完整时，用目录里的 .md 兜底恢复
    await this.#repairFromDisk();
  }

  async #readSkill(entry) {
    try {
      const raw = await fs.readFile(path.join(this.dir, `${entry.id}.md`), 'utf8');
      return { ...entry, raw };
    } catch {
      return null;
    }
  }

  async #persist() {
    const skills = [...this.items.values()].map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      version: s.version,
      license: s.license,
      allowedTools: s.allowedTools,
      metadata: s.metadata,
      extraFrontmatter: s.extraFrontmatter,
      sourceType: s.sourceType,
      source: s.source,
      dir: s.dir,
      files: s.files,
      importedAt: s.importedAt,
      origin: s.origin,
    }));
    await fs.writeFile(this.indexFile, JSON.stringify({ version: 1, skills }, null, 2), 'utf8');
  }

  /**
   * 兜底自愈：索引里没有、但目录里存在的 .md，重新纳入索引。
   * 覆盖「索引文件写坏 / 被单独删掉」的情况，避免 Skill 静默消失。
   */
  async #repairFromDisk() {
    const files = (await fs.readdir(this.dir).catch(() => []))
      .filter((n) => /\.(md|markdown)$/i.test(n));
    let added = 0;
    for (const file of files) {
      const id = file.replace(/\.(md|markdown)$/i, '');
      if (this.items.has(id)) continue;
      try {
        const raw = await fs.readFile(path.join(this.dir, file), 'utf8');
        const skill = parseSkillText(raw, {
          id,
          sourceType: 'recovered',
          source: `（从磁盘恢复：${file}）`,
          dir: '',
          files: [],
        });
        skill.origin = { kind: 'local-file', path: path.join(this.dir, file), recovered: true };
        this.items.set(id, skill);
        added++;
      } catch { /* 跳过读不了的文件 */ }
    }
    if (added) {
      console.log(`[skills] 索引缺失，已从磁盘恢复 ${added} 个 Skill`);
      await this.#persist();
    }
    return added;
  }

  list() {
    return [...this.items.values()]
      .map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        version: s.version,
        license: s.license,
        allowedTools: s.allowedTools,
        metadata: s.metadata,
        extraFrontmatter: s.extraFrontmatter,
        sourceType: s.sourceType,
        source: s.source,
        dir: s.dir,
        files: s.files,
        importedAt: s.importedAt,
        instructionsLength: (s.instructions || '').length,
      }))
      .sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)));
  }

  get(id) {
    return this.items.get(id);
  }

  #uniqueId(base) {
    let id = slug(base);
    let n = 2;
    while (this.items.has(id)) id = `${slug(base)}-${n++}`;
    return id;
  }

  async #save(skill) {
    await fs.writeFile(path.join(this.dir, `${skill.id}.md`), skill.raw, 'utf8');
    await this.#snapshot(skill.id, skill.raw);
    this.items.set(skill.id, skill);
    await this.#persist();
    return skill;
  }

  /**
   * 给每个 Skill 留一份时间戳快照（最多 3 份/个）。
   * data/ 被误删时，除了回收站，这里还有一份可读的纯文本备份。
   */
  async #snapshot(id, raw) {
    try {
      const dir = path.join(this.dir, 'snapshots', id);
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await fs.writeFile(path.join(dir, `${stamp}.md`), raw, 'utf8');
      const files = (await fs.readdir(dir)).filter((n) => n.endsWith('.md')).sort();
      for (const old of files.slice(0, Math.max(0, files.length - 3))) {
        await fs.rm(path.join(dir, old), { force: true });
      }
    } catch { /* 快照失败不影响主流程 */ }
  }

  async remove(id) {
    const skill = this.items.get(id);
    if (!skill) return false;
    this.items.delete(id);
    await fs.rm(path.join(this.dir, `${id}.md`), { force: true });
    await this.#persist();
    return true;
  }

  async rename(id, { name, description }) {
    const skill = this.items.get(id);
    if (!skill) throw new Error(`skill 不存在：${id}`);
    if (name !== undefined) skill.name = String(name).trim() || skill.name;
    if (description !== undefined) skill.description = String(description).trim();
    await this.#persist();
    return skill;
  }

  /* --------------------------- 本地目录 / 文件 --------------------------- */

  async importLocal(inputPath) {
    let target = String(inputPath || '').trim().replace(/^"|"$/g, '');
    if (!target) throw new Error('请填写本地目录或 SKILL.md 路径');
    if (target.startsWith('~')) target = path.join(os.homedir(), target.slice(1));
    target = path.resolve(target);

    let stat;
    try { stat = await fs.stat(target); } catch { throw new Error(`路径不存在：${target}`); }

    if (stat.isFile()) {
      const text = await fs.readFile(target, 'utf8');
      const dir = path.dirname(target);
      const files = await this.#scanDir(dir);
      const base = path.basename(target).replace(/\.(md|markdown|txt)$/i, '');
      const skill = parseSkillText(text, {
        id: this.#uniqueId(base),
        sourceType: 'local-file',
        source: target,
        dir,
        files,
      });
      skill.origin = { kind: 'local', path: target };
      return this.#save(skill);
    }

    const found = await this.#findSkillFile(target);
    if (!found) {
      throw new Error(`目录里没有找到 SKILL.md：${target}（可改成直接指定某个 .md 文件）`);
    }
    const text = await fs.readFile(found.file, 'utf8');
    const files = await this.#scanDir(found.root);
    const candidate = path.basename(found.root) === '.claude' ? path.basename(target) : path.basename(found.root);
    const skill = parseSkillText(text, {
      id: this.#uniqueId(candidate),
      sourceType: 'local',
      source: found.root,
      dir: found.root,
      files,
    });
    skill.origin = { kind: 'local', path: found.root };
    return this.#save(skill);
  }

  /** 在目录中递归（限深度）寻找 SKILL.md。 */
  async #findSkillFile(root) {
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      const { dir, depth } = queue.shift();
      for (const name of SKILL_FILE_CANDIDATES) {
        const p = path.join(dir, name);
        try {
          const st = await fs.stat(p);
          if (st.isFile()) return { file: p, root: dir };
        } catch { /* 继续 */ }
      }
      // 目录里没有 SKILL.md，但只有一个 markdown 时，把它当作 skill 定义
      const mdFiles = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isFile() && /\.(md|markdown)$/i.test(e.name));
      if (mdFiles.length === 1) return { file: path.join(dir, mdFiles[0].name), root: dir };

      if (depth >= 2) continue;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'venv', '.venv', '.cache'].includes(entry.name)) continue;
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
    return null;
  }

  /** 扫描 skill 目录中的附带文件（相对路径 + 大小），最多 300 个。 */
  async #scanDir(root) {
    const out = [];
    const walk = async (dir, prefix, depth) => {
      if (out.length >= 300 || depth > 3) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (out.length >= 300) return;
        if (['node_modules', '.git', '__pycache__', 'venv', '.venv', '.cache'].includes(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel, depth + 1);
        else {
          const st = await fs.stat(path.join(dir, entry.name)).catch(() => null);
          out.push({ path: rel, size: st?.size ?? 0 });
        }
      }
    };
    await walk(root, '', 0);
    return out;
  }

  /* ------------------------------ Git 仓库 ------------------------------ */

  async importFromGit(input, { apiKey = '' } = {}) {
    const url = String(input || '').trim().replace(/^"|"$/g, '');
    if (!url) throw new Error('请填写仓库地址');

    const parsed = parseGitUrl(url);
    if (!parsed) throw new Error(`无法识别的仓库地址：${url}`);

    try {
      const remote = await fetchSkillFromGit(parsed, { apiKey });
      const skill = parseSkillText(remote.text, {
        id: this.#uniqueId(remote.suggestedName || parsed.repo || parsed.file || 'remote-skill'),
        sourceType: 'git',
        source: url,
        dir: remote.filePath ? path.posix.dirname(remote.filePath) : '',
        files: remote.files || [],
      });
      skill.origin = { kind: 'git', url, ref: parsed.ref, file: remote.filePath };
      return this.#save(skill);
    } catch (err) {
      // 回退到 git clone
      const cloned = await cloneViaGit(parsed).catch(() => null);
      if (!cloned) throw err;
      try {
        const found = await this.#findSkillFile(cloned.dir);
        if (!found) throw new Error(`仓库中没有找到 SKILL.md（${url}）`);
        const text = await fs.readFile(found.file, 'utf8');
        const files = await this.#scanDir(found.root);
        const skill = parseSkillText(text, {
          id: this.#uniqueId(path.basename(found.root)),
          sourceType: 'git',
          source: url,
          dir: found.root,
          files,
        });
        skill.origin = { kind: 'git', url, ref: parsed.ref, subdir: path.relative(cloned.dir, found.root) };
        return await this.#save(skill);
      } finally {
        await fs.rm(cloned.tmp, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  /** 重新从原始来源拉取最新指令。 */
  async refresh(id, { apiKey = '' } = {}) {
    const skill = this.items.get(id);
    if (!skill) throw new Error(`skill 不存在：${id}`);
    const origin = skill.origin || {};
    let fresh;
    if (origin.kind === 'git') fresh = await this.importFromGit(origin.url, { apiKey });
    else if (origin.kind === 'local') fresh = await this.importLocal(origin.path);
    else throw new Error('该 skill 没有记录原始来源，无法重新拉取（可手动编辑指令）');
    // 保留原 id，替换内容
    if (fresh.id !== id) {
      await this.remove(fresh.id);
      this.items.delete(id);
      fresh.id = id;
      await fs.rm(path.join(this.dir, `${fresh.id}.md`), { force: true });
      await this.#save(fresh);
    }
    return fresh;
  }

  /** 手动粘贴文本导入。 */
  async importText(text, { name } = {}) {
    if (!text || !String(text).trim()) throw new Error('内容不能为空');
    const parsed = parseSkillText(String(text), {
      sourceType: 'paste',
      source: name || '（粘贴内容）',
      dir: '',
      files: [],
    });
    parsed.id = this.#uniqueId(name || parsed.name);
    parsed.origin = { kind: 'paste', at: new Date().toISOString() };
    return this.#save(parsed);
  }

  /** 手动覆盖 skill 指令正文（界面内微调）。 */
  async updateInstructions(id, { name, description, instructions }) {
    const skill = this.items.get(id);
    if (!skill) throw new Error(`skill 不存在：${id}`);
    const next = {
      ...skill,
      name: name !== undefined && String(name).trim() ? String(name).trim() : skill.name,
      description: description !== undefined ? String(description) : skill.description,
      instructions: instructions !== undefined ? String(instructions) : skill.instructions,
    };
    next.raw = serializeSkill(next);
    await fs.writeFile(path.join(this.dir, `${id}.md`), next.raw, 'utf8');
    await this.#snapshot(id, next.raw);
    this.items.set(id, next);
    await this.#persist();
    return next;
  }
}

/* ----------------------------- 地址解析工具 ----------------------------- */

export function parseGitUrl(input) {
  const url = String(input).trim();
  // GitHub / Gitee / GitLab 网页地址，可带 /tree/<ref>/<subpath>
  const web = /^https?:\/\/(github\.com|gitee\.com|gitlab\.com)\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/]+)((?:\/.*)?))?\/?$/i.exec(url);
  if (web) {
    const [, host, owner, repo, ref, sub] = web;
    return { host: host.toLowerCase(), owner, repo, ref: ref || '', subpath: (sub || '').replace(/^\//, '').replace(/\/$/, ''), raw: url };
  }
  if (/^https?:\/\/raw\.githubusercontent\.com\//i.test(url) || /^https?:\/\/raw\.gitee\.com\//i.test(url)) {
    return { direct: url, raw: url };
  }
  if (/\.(md|markdown)(\?.*)?$/i.test(url) && /^https?:\/\//i.test(url)) {
    return { direct: url, raw: url };
  }
  if (/^(git@|https?:\/\/|ssh:\/\/)/i.test(url) && /\.git$/i.test(url)) {
    return { clone: url, raw: url };
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) {
    return { host: 'github.com', owner: url.split('/')[0], repo: url.split('/')[1], ref: '', subpath: '', raw: url };
  }
  return null;
}

/** 通过 raw / API 直接抓取，不依赖 git。 */
export async function fetchSkillFromGit(parsed, { apiKey = '' } = {}) {
  if (parsed.direct) {
    const text = await fetchText(parsed.direct, { apiKey });
    const name = path.basename(new URL(parsed.direct).pathname, '.md') || 'remote-skill';
    return { text, filePath: path.basename(new URL(parsed.direct).pathname), suggestedName: name, files: [] };
  }
  if (parsed.clone) throw new Error('该地址需要 git 客户端，正在回退到 git clone');

  const { host, owner, repo, ref, subpath } = parsed;
  const apiBase = host === 'gitee.com' ? 'https://gitee.com/api/v5' : host === 'gitlab.com' ? 'https://gitlab.com/api/v4' : 'https://api.github.com';

  // 1) 定位 SKILL.md：优先 subpath，其次仓库根，其次常见目录
  const candidates = [];
  if (subpath) {
    candidates.push(subpath.endsWith('.md') ? subpath : `${subpath}/SKILL.md`);
    candidates.push(`${subpath}/skill.md`);
  } else {
    candidates.push('SKILL.md', 'skill.md', 'skills/SKILL.md', '.claude/skills/SKILL.md');
  }

  let filePath = null;
  let text = null;
  let lastErr = null;

  for (const candidate of candidates) {
    try {
      text = await fetchRawFile({ host, owner, repo, ref, filePath: candidate, apiKey });
      filePath = candidate;
      break;
    } catch (err) { lastErr = err; }
  }

  // 2) 兜底：列出仓库顶层，找任意 SKILL.md
  if (!text) {
    const tree = await listRepoTree({ host, owner, repo, ref, apiKey }).catch(() => null);
    if (tree) {
      const hit = tree.find((f) => /(^|\/)SKILL\.md$/i.test(f));
      if (hit) {
        text = await fetchRawFile({ host, owner, repo, ref, filePath: hit, apiKey });
        filePath = hit;
      }
    }
  }

  if (!text) {
    throw new Error(`仓库中未找到 SKILL.md（${host}/${owner}/${repo}${ref ? `@${ref}` : ''}）${lastErr ? `：${lastErr.message}` : ''}`);
  }

  // 3) 附带文件清单（只取 SKILL.md 同目录及子目录，最多 200 条）
  const dirPrefix = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/') + 1) : '';
  const tree = await listRepoTree({ host, owner, repo, ref, apiKey }).catch(() => []);
  const files = tree
    .filter((f) => f.startsWith(dirPrefix) && f !== filePath)
    .slice(0, 200)
    .map((f) => ({ path: f.slice(dirPrefix.length), size: 0 }));

  return {
    text,
    filePath,
    files,
    suggestedName: dirPrefix ? dirPrefix.split('/').filter(Boolean).pop() : repo,
  };
}

async function fetchRawFile({ host, owner, repo, ref, filePath, apiKey }) {
  if (host === 'github.com') {
    const refs = ref ? [ref] : ['HEAD', 'main', 'master'];
    let lastErr;
    for (const r of refs) {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${r}/${filePath}`;
      try { return await fetchText(url, { apiKey }); } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error(`无法读取 ${filePath}`);
  }
  if (host === 'gitee.com') {
    const refs = ref ? [ref] : ['master', 'main'];
    let lastErr;
    for (const r of refs) {
      try { return await fetchText(`https://gitee.com/${owner}/${repo}/raw/${r}/${filePath}`, { apiKey }); } catch (err) { lastErr = err; }
    }
    throw lastErr || new Error(`无法读取 ${filePath}`);
  }
  if (host === 'gitlab.com') {
    const r = ref || 'HEAD';
    const url = `https://gitlab.com/${owner}/${repo}/-/raw/${r}/${filePath}`;
    return fetchText(url, { apiKey });
  }
  throw new Error(`不支持的 git 主机：${host}`);
}

async function listRepoTree({ host, owner, repo, ref, apiKey }) {
  if (host === 'github.com') {
    for (const r of ref ? [ref] : ['HEAD', 'main', 'master']) {
      try {
        const json = await fetchJsonAuth(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(r)}?recursive=1`, { apiKey });
        return (json.tree || []).filter((n) => n.type === 'blob').map((n) => n.path);
      } catch { /* 尝试下一个 ref */ }
    }
    return [];
  }
  if (host === 'gitee.com') {
    try {
      const json = await fetchJsonAuth(`https://gitee.com/api/v5/repos/${owner}/${repo}/git/trees/${ref || 'master'}?recursive=1`, { apiKey });
      return (json.tree || []).filter((n) => n.type === 'blob').map((n) => n.path);
    } catch { return []; }
  }
  return [];
}

async function fetchText(url, { apiKey = '' } = {}) {
  const headers = { 'user-agent': 'skill-lab/0.1' };
  if (apiKey && /github\.com/.test(url)) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

async function fetchJsonAuth(url, { apiKey = '' } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'skill-lab/0.1' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function cloneViaGit(parsed) {
  const gitUrl = parsed.clone || parsed.raw;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-lab-'));
  const args = ['clone', '--depth', '1'];
  if (parsed.ref) args.push('--branch', parsed.ref);
  args.push(gitUrl, tmp);
  try {
    await execFileAsync('git', args, { timeout: 120_000, windowsHide: true });
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new Error(`git clone 失败：${err.stderr || err.message}`);
  }
  return { dir: tmp, tmp };
}
