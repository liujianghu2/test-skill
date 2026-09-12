/**
 * SKILL.md 约定解析与序列化。
 *
 * 兼容两类写法：
 *  1) Claude / DSH 风格 frontmatter：
 *       ---
 *       name: pdf-processing
 *       description: ...
 *       allowed-tools: Read, Write
 *       ---
 *       # 正文 -> 作为 instructions 注入 system prompt
 *  2) 无 frontmatter：标题行猜 name，首段猜 description，全文作为 instructions。
 *  3) 也接受裸 markdown（.md）与 metadata: 嵌套块。
 */

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 极简 YAML 解析：支持 key: value、引号、行内数组 [a, b]、多行折行（| / >）与 metadata 嵌套一层。 */
export function parseYaml(src) {
  const root = {};
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const stack = [{ indent: -1, obj: root }];

  const unquote = (v) => {
    let s = v.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
      if (v.trim().startsWith('"')) s = s.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
    return s;
  };

  while (i < lines.length) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith('#')) { i++; continue; }
    const indent = raw.length - raw.replace(/^\s*/, '').length;
    const line = raw.trim();
    const m = /^([^:#]+?)\s*:\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = unquote(m[1]);
    let value = m[2];

    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = (stack[stack.length - 1] || stack[0]).obj;

    if (value === '' || value === '|' || value === '>' || value === '|-') {
      // 收集子块
      const folded = value.startsWith('>');
      const block = [];
      let j = i + 1;
      let childIndent = null;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (!l.trim()) { block.push(''); continue; }
        const ci = l.length - l.replace(/^\s*/, '').length;
        if (ci <= indent) break;
        if (childIndent === null) childIndent = ci;
        block.push(l.slice(childIndent));
      }
      const hasChildKey = block.some((l) => /^[^:\s][^:]*:\s*/.test(l));
      if (hasChildKey && value === '') {
        const child = {};
        parent[key] = child;
        stack.push({ indent, obj: child });
        i++;
        continue;
      }
      const text = folded
        ? block.join(' ').replace(/\s+/g, ' ').trim()
        : block.join('\n').replace(/\n+$/, '');
      parent[key] = text;
      i = j;
      continue;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      parent[key] = value.slice(1, -1).split(',').map((s) => unquote(s)).filter(Boolean);
    } else {
      parent[key] = unquote(value);
    }
    i++;
  }
  return root;
}

function stripListMarkers(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v === undefined || v === null) return undefined;
  return String(v).split(/[,\n]/).map((s) => s.trim().replace(/^[-*]\s*/, '')).filter(Boolean);
}

const TITLE = /^#{1,3}\s+(.+)$/m;
const BULLET = /^\s*[-*]\s+(.+)$/;

/** 把一个 SKILL.md 文本解析成 skill 记录。 */
export function parseSkillText(text, { id, source, sourceType, dir, files = [] } = {}) {
  const src = String(text ?? '');
  const fmMatch = FM.exec(src);
  const front = fmMatch ? parseYaml(fmMatch[1]) : {};
  const body = (fmMatch ? src.slice(fmMatch[0].length) : src).trim();
  const meta = front.metadata && typeof front.metadata === 'object' ? front.metadata : {};

  let name = front.name || meta.name || '';
  if (!name) {
    const t = TITLE.exec(body);
    name = t ? t[1].trim() : (dir ? dir.split(/[\\/]/).filter(Boolean).pop() : 'untitled-skill');
  }

  let description = front.description || meta.description || '';
  if (!description) {
    const firstPara = body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith('#') && !p.startsWith('---'));
    description = firstPara ? firstPara.replace(/\s+/g, ' ').slice(0, 200) : '';
  }

  const toolsRaw = front['allowed-tools'] ?? front.allowedTools ?? meta['allowed-tools'] ?? front.tools;

  return {
    id: id || slug(name),
    name: String(name).trim(),
    description: String(description).trim(),
    instructions: body,
    version: front.version || meta.version || '',
    license: front.license || meta.license || '',
    allowedTools: stripListMarkers(toolsRaw) || [],
    metadata: Object.keys(meta).length ? { ...meta } : undefined,
    extraFrontmatter: Object.fromEntries(
      Object.entries(front).filter(([k]) => !['name', 'description', 'version', 'license', 'allowed-tools', 'allowedTools', 'metadata', 'tools'].includes(k)),
    ),
    sourceType: sourceType || 'local',
    source: source || '',
    dir: dir || '',
    files,
    raw: src,
    importedAt: new Date().toISOString(),
  };
}

export function serializeSkill(skill) {
  const fm = [
    '---',
    `name: ${skill.name}`,
    `description: ${JSON.stringify(skill.description || '')}`,
    skill.version ? `version: ${skill.version}` : null,
    skill.license ? `license: ${skill.license}` : null,
    skill.allowedTools?.length ? `allowed-tools: ${skill.allowedTools.join(', ')}` : null,
    '---',
    '',
  ].filter((l) => l !== null);
  return fm.join('\n') + skill.instructions + (skill.instructions.endsWith('\n') ? '' : '\n');
}

/** 列出正文中的子文件（references/assets/scripts 等），用于界面提示与附带说明。 */
export function listBodyFiles(files) {
  return (files || []).filter((f) => !/^SKILL\.md$/i.test(f.path));
}

export function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
}

/** 依据 skill 记录构造注入模型的 system prompt。 */
export function buildSkillPrompt(skill, { mode = 'instructions', extra = '' } = {}) {
  const parts = [];
  if (mode === 'raw') {
    parts.push(skill.raw);
  } else {
    parts.push(`You are operating with the following skill enabled.\n\nSkill: ${skill.name}`);
    if (skill.description) parts.push(`Purpose: ${skill.description}`);
    parts.push('Follow the skill instructions below exactly when they are relevant to the user request.\n');
    parts.push('=== SKILL INSTRUCTIONS ===');
    parts.push(skill.instructions || skill.raw);
    parts.push('=== END SKILL INSTRUCTIONS ===');
    const bodyFiles = listBodyFiles(skill.files);
    if (bodyFiles.length) {
      parts.push(`\nBundled files available in this skill: ${bodyFiles.map((f) => f.path).join(', ')}`);
    }
  }
  if (extra && extra.trim()) parts.push(`\n=== ADDITIONAL SYSTEM CONTEXT ===\n${extra.trim()}`);
  return parts.join('\n');
}
