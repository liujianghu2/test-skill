/** 本地配置持久化：模型服务商 + 全局设置。文件位于 <data>/config.json */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeProvider } from './providers.mjs';

const DEFAULT_SETTINGS = {
  temperature: 0.7,
  maxTokens: 4096,
  systemExtra: '',
  gitToken: '',
  requestTimeoutMs: 300_000,
};

export class ConfigStore {
  constructor({ dir }) {
    this.dir = dir;
    this.file = path.join(dir, 'config.json');
    this.data = { version: 1, activeProviderId: '', providers: [], settings: { ...DEFAULT_SETTINGS } };
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = {
        version: 1,
        activeProviderId: raw.activeProviderId || '',
        providers: Array.isArray(raw.providers) ? raw.providers.map((p) => normalizeProvider(p)) : [],
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
      };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[config] 读取失败，使用默认配置：', err.message);
    }
  }

  async save() {
    const json = JSON.stringify(this.data, null, 2);
    // 每次覆盖前留一份上一版：配置（含 API Key）是用户手工填的唯一副本，误删/写坏要能救回来
    await this.#backup(json);
    await fs.writeFile(this.file, json, 'utf8');
    try { await fs.chmod(this.file, 0o600); } catch { /* Windows 上忽略 */ }
  }

  /** 把当前磁盘上的配置复制到 backup/ 目录，最多保留 5 份。 */
  async #backup(incoming) {
    try {
      const current = await fs.readFile(this.file, 'utf8').catch(() => '');
      if (!current || current === incoming) return;
      const backupDir = path.join(this.dir, 'backup');
      await fs.mkdir(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await fs.writeFile(path.join(backupDir, `config-${stamp}.json`), current, 'utf8');
      const files = (await fs.readdir(backupDir))
        .filter((n) => /^config-.*\.json$/.test(n))
        .sort();
      for (const old of files.slice(0, Math.max(0, files.length - 5))) {
        await fs.rm(path.join(backupDir, old), { force: true });
      }
    } catch { /* 备份失败不能影响主流程 */ }
  }

  /** 返回给前端时默认打码 API Key。 */
  publicConfig({ revealKeys = false } = {}) {
    const mask = (key) => {
      if (!key) return '';
      if (revealKeys) return key;
      if (key.length <= 8) return '••••••';
      return `${key.slice(0, 4)}••••••${key.slice(-4)}`;
    };
    return {
      activeProviderId: this.data.activeProviderId,
      settings: { ...this.data.settings, gitToken: this.data.settings.gitToken ? mask(this.data.settings.gitToken) : '' },
      providers: this.data.providers.map((p) => ({ ...p, apiKey: mask(p.apiKey), hasApiKey: Boolean(p.apiKey) })),
      configPath: this.file,
    };
  }

  getProvider(id) {
    return this.data.providers.find((p) => p.id === id);
  }

  activeProvider() {
    return this.getProvider(this.data.activeProviderId) || this.data.providers[0];
  }

  /**
   * 新增 / 更新服务商。apiKey 传 undefined 表示保持原值，传 '' 表示清空。
   * 前端拿到的是打码后的 key，因此打码值会被自动忽略。
   */
  async upsertProvider(input) {
    const id = input.id || `p_${crypto.randomBytes(4).toString('hex')}`;
    const existing = this.getProvider(id);
    const merged = { ...(existing || {}), ...input, id };

    if (input.apiKey === undefined) merged.apiKey = existing?.apiKey || '';
    else if (isMasked(input.apiKey)) merged.apiKey = existing?.apiKey || '';
    else merged.apiKey = String(input.apiKey);

    if (existing && input.models === undefined) merged.models = existing.models;
    const provider = normalizeProvider({ ...merged, allowEmptyKey: input.allowEmptyKey ?? existing?.allowEmptyKey });
    provider.allowEmptyKey = Boolean(input.allowEmptyKey ?? existing?.allowEmptyKey);

    const idx = this.data.providers.findIndex((p) => p.id === id);
    if (idx >= 0) this.data.providers[idx] = provider;
    else this.data.providers.push(provider);
    if (!this.data.activeProviderId) this.data.activeProviderId = id;
    await this.save();
    return provider;
  }

  async removeProvider(id) {
    this.data.providers = this.data.providers.filter((p) => p.id !== id);
    if (this.data.activeProviderId === id) this.data.activeProviderId = this.data.providers[0]?.id || '';
    await this.save();
  }

  async setActiveProvider(id) {
    if (id && !this.getProvider(id)) throw new Error(`服务商不存在：${id}`);
    this.data.activeProviderId = id || '';
    await this.save();
  }

  async updateSettings(patch = {}) {
    if (patch.gitToken !== undefined && isMasked(patch.gitToken)) delete patch.gitToken;
    this.data.settings = { ...this.data.settings, ...patch };
    await this.save();
    return this.data.settings;
  }

  /** 取真实 key（内部调用）。 */
  realKey(provider) {
    return provider?.apiKey || '';
  }
}

function isMasked(v) {
  return typeof v === 'string' && (v.includes('••') || /^[*x]{4,}$/i.test(v));
}

export { DEFAULT_SETTINGS };
