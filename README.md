# Skill Lab · 本地 Skill 测试工具

一个跑在本机的小工具：**接入多家大模型 API，从 Git 仓库或本地目录导入 Skill，在同一个界面里观察 Skill 到底让模型输出了什么** —— 文本、Markdown 表格、代码、图片、推理链、工具调用。

- 零运行时依赖（只用 Node 内置模块），不需要 `npm install`
- 前端是原生 HTML/CSS/JS，无构建步骤
- **一键启动脚本自带 Node 运行时**：没装 Node 的机器也能直接跑
- API Key 只存在本机 `data/config.json`，不上传任何地方

---

## 快速开始

**方式一：双击 `start.bat`（推荐，无需任何环境）**

脚本会检查本机 Node；没有或版本过低（< 18.17）时自动下载一份便携版 Node 到项目内的 `.runtime/`，然后启动并打开浏览器。首次运行约需下载 30MB。

**方式二：命令行**

```bash
cd E:\tools\test-skill
npm start                 # 默认 http://127.0.0.1:5177
npm start -- --open       # 启动后自动打开浏览器
npm start -- --port 8080  # 换端口
```

macOS / Linux 用 `./start.sh`（需要已安装 Node 18.17+）。

想先看效果、又没有 API Key：

```bash
npm run demo              # 启动内置假模型 + 示例 Skill，http://127.0.0.1:5179
```

打开界面后：

1. 左侧「模型」→「+ 新增」→ 选预设（DeepSeek / OpenAI / Claude / 通义 / Kimi / GLM / Gemini / Ollama…）→ 填 API Key → 保存 → 点「测试连通」。
2. 左侧「Skill」→ 填 Git 仓库地址或本地路径 → 导入。
3. 顶部选 Skill 与模型，底部输入让这个 Skill 发挥作用的请求，`Ctrl + Enter` 运行。
4. 需要文件输入的 Skill：把文件拖进窗口，或点「＋ 文件」「本机路径」。

---

## 界面

三栏式，没有多余面板：

| 区域 | 作用 |
| --- | --- |
| 左侧导航 | Skill 库 / 模型服务 / 测试记录 / 设置 |
| 中间面板 | 当前导航的详情：导入、服务商编辑、历史记录 |
| 右侧主区 | 顶部选 Skill 与模型，中间输出结果，底部输入区（**固定贴底，不随内容滚动**） |

**输出区行为**（这一版重点修好的部分）：

- 只有输出区滚动，页面本身不出现滚动条；输入区永远固定在窗口底部
- **流式输出**：正文按行增量渲染成真实 DOM（表格按行追加、代码块就地增长、列表按项追加），不是每来一段就整篇重刷
- 自动跟随：你停在底部时自动跟随；手动往上滚就停止跟随，并出现「↓ 回到底部」按钮
- 内容在渲染后还会变高（图片异步加载等）时，跟随状态下会自动重新贴底

**输出内容**按模型真实返回渲染：

- 正文 Markdown（标题、**表格**、列表、引用、代码块带复制按钮）
- 图片：正文里的图片与抽取出的图片进入画廊，支持放大、下载；加载失败会标注原因
- 推理链：可折叠，实时累计字数
- 工具调用：Skill 声明了 `allowed-tools` 时会带上工具声明，模型发起的调用以可展开卡片展示
- 底部指标：耗时、输入/输出 Token（没有用量时显示估算）、tok/s、结束原因、文本/推理字数、提示词字符数、图片数

---

## 导入 Skill

三种方式，自动识别 `SKILL.md` 约定（frontmatter + 正文）：

| 方式 | 说明 |
| --- | --- |
| **Git 仓库** | 支持 `https://github.com/user/repo`、`…/tree/<分支>/<子目录>`、`…/blob/…/SKILL.md`、裸 raw 链接、`user/repo` 简写。GitHub / Gitee / GitLab 走 raw + API，**不需要本机装 git**；其他主机回退到 `git clone --depth 1`。 |
| **本地路径** | 目录或单个 `.md` 文件。目录里没有 `SKILL.md` 但只有一个 markdown 时，会把它当作 Skill 定义；也会向下找两层（`skills/<name>/SKILL.md` 这类布局）。带「浏览…」选择器，见下。 |
| **粘贴** | 直接把 SKILL.md 内容贴进来存为 Skill。 |

### 本地选择器（「浏览…」）

浏览器基于安全限制拿不到文件夹的绝对路径，所以本地导入由本机后端提供目录浏览：

- 点「浏览…」打开选择器：可逐层进入目录，`↑ 上一层`、直接输入路径回车跳转
- 目录里的 `SKILL.md` 会标 `SKILL.md` 徽标；**自带 Skill 的目录**标 `含 SKILL.md`；**下一层才是 Skill 的目录**（如 `<repo>/skills/`）标出数量
- 单条目录右侧的「导入」= 直接导入这一个 Skill；点 `SKILL.md` 文件 = 导入这个文件
- 目录下有一批 Skill 子目录时，底部出现 **「导入其中 N 个 Skill」一次性批量导入**
- 当前目录本身不是 Skill 时，底部按钮是禁用状态并说明原因，不会让你点一个必然失败的按钮
- 快捷入口：主目录 / 桌面 / 文档 / 下载 / 各磁盘根目录 / 项目目录
- 导入过的路径会记在「最近」里，点一下即可再导入

另外还有一个「系统文件夹选择器」按钮：Chromium 内核下会调用系统的文件夹对话框（只取顶层文件名，因此选到 Skill 所在目录即可）；不支持时自动回退到上面的目录浏览。

解析出的字段：

```yaml
---
name: 图表周报
description: 把原始指标整理成带表格与趋势图的周报
version: 1.1.0
allowed-tools: Read, Write          # 或 [Read, Write]
metadata:                            # 支持一层嵌套
  author: me
---
# 正文会完整注入 system prompt
```

---

## 附件：给需要文件的 Skill 喂输入

很多 Skill（PDF 提取、数据分析、图片理解、文档改写）必须要有文件。三种给法：

| 方式 | 说明 |
| --- | --- |
| **拖拽 / 粘贴** | 把文件拖进窗口任意位置，或直接在输入框里 `Ctrl+V` 粘贴截图 |
| **＋ 文件** | 系统文件选择框，可多选 |
| **本机路径** | 直接填本机绝对路径（后端读取，绕过浏览器限制） |
| **从 Skill 选取** | 列出当前 Skill 目录下的可读文件（`SKILL.md` 同目录及其子目录），按序号附带 —— 适合 `references/`、`assets/` 里有示例数据的 Skill |

处理规则：

- **文本类**（`.md/.txt/.csv/.json/.yaml/.py/.js/.sql/…` 共 40 余种）解码为文本，内容与文件名一起进入提示词
- **图片类**（`.png/.jpg/.gif/.webp/.bmp`）转成 data URL，按各家协议的原生多模态格式发送：OpenAI 用 `image_url` 内容块、Anthropic 用 `image/source` 块、Gemini 用 `inlineData`
- **二进制类**（PDF、zip、docx…）只传文件名与用户说明，并提示模型需要文本版本而不是假装看到了内容
- 上限：单文件 8MB、总计 32MB、最多 12 个；超限会在开流之前就以明确错误返回

---

## 注入模式

同一个 Skill 可以三种方式对照测试，用来判断效果到底来自 Skill 还是模型本身：

- **注入 Skill**（默认）：frontmatter + 正文组装成结构化 system prompt
- **原始 SKILL.md**：整份文件原样作为 system prompt（用于验证模型对原始格式的理解）
- **不使用（对照）**：完全不注入，作为基线对照

顶部「查看提示词」可以预览这一次实际会发给模型的 system prompt（含附件清单）。

---

## 测试记录

- 每次运行自动记入「记录」面板，**保存在浏览器本地**（localStorage），重启进程也在
- 每条记录含：Skill、模型、模式、输入、附件清单、耗时、Token、状态、输出正文、推理链、工具调用、图片 URL
- 卡片操作：`↻` 用同样的参数再跑一次 · `👁` 把当时的输出还原成卡片回看 · `✕` 删除
- 为避免撑爆浏览器存储：正文截断到 2 万字符、推理 8 千字符，内联的 data URL 图片不落盘（只保留远程图片 URL）

---

## 支持的模型服务

| 协议 | 覆盖 |
| --- | --- |
| `openai` | OpenAI、DeepSeek、通义千问（兼容模式）、Moonshot、智谱 GLM、MiniMax、SiliconFlow、OpenRouter、Ollama、vLLM / LM Studio 等任何 OpenAI 兼容端点 |
| `anthropic` | Claude Messages API（`/v1/messages`，支持 thinking 增量） |
| `gemini` | Google `generateContent` 流式接口 |
| `image` | OpenAI 兼容图片生成 `/images/generations`（可选，用于测图片型 Skill） |

兼容性上做了额外处理：有些网关会忽略 `stream` 参数 —— 要么非流式请求返回 SSE、要么流式请求返回整包 JSON，两种都会被正确解析（有回归测试覆盖）。

配置项：Base URL、API Key、模型列表（可「拉取列表」自动补全，也可手填）、自定义请求路径、附加请求头 / 请求体（`extraBody`、`headers` 写在配置文件里）。

---

## 一键启动与环境问题

**最省事的用法：双击项目根目录的 `启动.bat`（或 `start.bat`）。**

它会自动完成：检测/准备 Node 运行时 → 启动服务 → **用默认浏览器打开界面**。第一次运行如果本机没有 Node，会先自动下载便携版（约 30MB），之后的启动都是秒开。

| 文件 | 平台 | 说明 |
| --- | --- | --- |
| `启动.bat` / `start.bat` | Windows | **双击即可**，启动后自动打开浏览器（两个文件等价，取你顺手的那个） |
| `start.ps1` | Windows | 真正的启动逻辑：检测/下载便携 Node，再启动服务 |
| `start.sh` | macOS / Linux | 需要系统已装 Node 18.17+ |

命令行等价写法：

```bash
npm start -- --open        # 启动并打开浏览器
node bin/skill-lab.mjs --open
```

`start.ps1` 的行为：

1. 先看项目内 `.runtime/node/node.exe` 是否存在 → 直接用
2. 否则看系统 `node` 是否 ≥ 18.17 → 满足则用系统的
3. 都不满足 → 从 `https://nodejs.org/dist/index.json` 取最新 LTS，下载 `node-<ver>-win-<arch>.zip`（优先用系统自带 `curl.exe`），解压到 `.runtime/node`
4. 启动 `bin/skill-lab.mjs --port 5177 --open`（`--open` 会用系统默认浏览器打开界面；Windows 上依次尝试 `cmd start` / PowerShell / `rundll32`，避免被策略拦住）

参数：`-Port 5178` 换端口、`-NoOpen` 不打开浏览器、`-Open` 强制打开、`-Rebuild` 强制重新下载运行时。

**端口被占用时**：不会静默失败 —— 会提示「Skill Lab 可能已经在运行」，并（在自动打开模式下）直接为你打开现有实例的页面。

**关掉服务**：关掉那个命令行窗口，或在窗口里按 `Ctrl+C`。

> 代码用到内置 `fetch`，因此 **最低 Node 18.17**；脚本会拦住更低版本并自动处理。

---

## 命令行参数

```
node bin/skill-lab.mjs [选项]

  -p, --port <n>      监听端口（默认 5177）
      --host <addr>   监听地址（默认 127.0.0.1，仅本机可访问）
      --data <dir>    数据目录（默认 ./data）
  -o, --open          启动后自动打开浏览器
  -h, --help          帮助
```

---

## 数据与安全

```
data/
  config.json    模型服务配置（含 API Key，文件权限 0600）
  backup/        config.json 的历史版本（每次保存前留一份，最多 5 份）
  skills/        导入的 Skill 正文与索引（index.json）
    snapshots/   每个 Skill 的时间戳快照（最多 3 份/个）
.runtime/        一键脚本下载的便携 Node（可随时删除）
```

**误删或写坏了也能救回来（三重）：**

1. **Skill 快照** —— 每次导入/编辑 Skill 时，正文会在 `data/skills/snapshots/<id>/<时间>.md` 留一份纯文本快照（每个 Skill 最多 3 份）。
2. **配置备份** —— 每次保存 `config.json` 前，把上一版复制到 `data/backup/config-<时间>.json`（最多 5 份）。API Key 只有你手工输入的这一份，改坏了能从这儿翻回去。
3. **索引自愈** —— `data/skills/index.json` 丢失或损坏时，启动会自动扫描 `skills/*.md` 重建索引（日志打印「索引缺失，已从磁盘恢复 N 个 Skill」），Skill 不会静默消失。

即使整个 `data/` 被删掉，Windows 上一般还在回收站，右键还原即可（本工具的资料就是这些纯文本文件）。想彻底避开项目目录里的清理动作，可以把数据放到项目外：`npm start -- --data D:\skill-lab-data`

- API Key 通过接口回传时默认打码（`sk-t••••••7890`），界面拿到的是打码值，保存时不会用打码值覆盖真实 Key；需要明文时用 `GET /api/config?reveal=1`。
- 服务默认只监听 `127.0.0.1`。如果改成 `0.0.0.0`，同网段的人就能读到你的配置，不要这么做。
- `/api/file` 与 `/api/skills/:id/attach` 只允许读取已导入 Skill 目录内的文件。
- `/api/fs/list`（本地选择器用）为了让你能挑任意位置的 Skill，**可以列出本机任意目录**。它的定位和「本机路径」输入框一致，只在你本机使用；服务默认只监听 `127.0.0.1`，不要改成 `0.0.0.0` 后暴露给他人。
- **本工具只做提示词级测试，不执行 Skill 里的任何脚本**。附件只是被读取成文本或图片发给模型，不会被运行。这是刻意的设计：脚本执行不在可信边界内。

---

## 测试与自检

```bash
npm test          # 四套测试一起跑（179 项）
```

| 命令 | 覆盖范围 |
| --- | --- |
| `npm run test:md` | Markdown 渲染器 16 项：表格、代码块、列表、引用、URL 含 `&` 的图片/链接、data URL、HTML 转义、软换行、图片抽取 |
| `npm run test:stream` | **流式渲染器与一次性渲染对拍 42 项**：同一段文本按 2/3/5/7 字符与逐字符喂入，最终 DOM 结构必须与 `renderMarkdown` 完全一致；另有表格节点复用、代码块就地增长、半行预览与收尾转正 |
| `npm run test:api` | 后端 59 项：配置读写与打码、**配置备份、Skill 快照、索引丢失自愈**、Skill 解析与导入、附件读取与上传（multipart）、附件大小上限、**本地目录浏览（SKILL.md 识别、hasSkill/hasSkillChild、批量导入列表、文件路径回落、错误路径）**、路径越权防护、静态资源 |
| `npm run test:e2e` | 端到端 62 项：三种协议的真实请求/流式解析、Skill 是否真的进入请求、附件按协议转成多模态格式、工具调用分片拼接、模式对照、错误上报、SSE 兼容回归 |

**浏览器布局自检**（需要本机有 Chrome/Edge）：

```bash
npm run demo                    # 另开一个窗口起演示环境
npm run ui                      # 无头浏览器跑一次完整流式测试并断言布局
```

`scripts/ui-probe.mjs` 通过 CDP 打开页面、等待流式输出结束、截图，并断言 14 项：容器占满一屏、页面无滚动条、输入区贴底、表格/代码/图片已渲染、输出区可滚动、结束后自动跟随到底部、手动上滚出现「回到底部」且点击后回到底、页面无未捕获异常。

开发辅助：

```bash
npm run demo        # 假模型 + 示例 Skill 的完整体验环境
npm run preview     # 把真实接口返回渲染成静态页，用于视觉检查
```

---

## 目录结构

```
start.bat / start.ps1 / start.sh   一键启动脚本（含便携 Node 引导）
bin/skill-lab.mjs      启动入口（参数解析、浏览器打开、优雅退出）
src/server.mjs         HTTP 服务：静态资源 + JSON API + NDJSON 流式测试 + 附件接口
src/providers.mjs      模型适配层（openai / anthropic / gemini / image，含多模态内容块）
src/runner.mjs         测试执行：组装 system prompt 与附件、上下文估算、统一事件
src/skills.mjs         Skill 仓库：本地与 Git 导入、刷新、编辑、目录文件清单
src/skill-format.mjs   frontmatter 与 SKILL.md 约定解析、system prompt 组装
src/config.mjs         配置持久化与 API Key 打码
src/http.mjs           HTTP/SSE 工具、图片抽取
public/index.html      页面结构
public/styles.css      样式（三段式固定布局：头部 / 唯一滚动区 / 贴底输入区）
public/app.js          前端状态与交互（导入、服务商、附件、运行、记录）
public/markdown.js     一次性 Markdown 渲染器
public/stream-render.js 流式增量渲染器
scripts/               测试与开发辅助脚本
```

---

## 常见问题

**双击 start.bat 后卡在下载 ——** 首次需要访问 `nodejs.org`；公司网络或代理可能拦截。可以手动装 Node.js 18.17+ 后重试，或设好代理后运行 `start.ps1 -Rebuild`。

**导入 GitHub 私有仓库失败 ——** 在「设置」里填 Git 访问令牌（GitHub 用 `ghp_…`，只需 `repo` 只读权限）。

**连接测试报 404 ——** Base URL 通常要带版本段（`https://api.deepseek.com/v1`），确认是否重复或缺失。

**「从 Skill 选取」提示没有可读文件 ——** 远程导入的 Skill 只保存了 `SKILL.md` 正文与文件清单，本机没有那些文件；改用「＋ 文件」上传，或把仓库 clone 到本地后用「本地路径」导入。

**「浏览…」里看不到某个目录 ——** 选择器会跳过隐藏目录（`.git`、`.github` 等，`.claude` 除外）以及 `node_modules` / `dist` / `build` / `venv` / `__pycache__`；这些目录仍可直接输入路径回车进入。目录下没有 markdown 且子目录里也没有 Skill 时条目会显示为普通目录，可以正常进去。

**上传大文件报「超过单文件上限」——** 单文件上限 8MB。超大文件请先裁剪，或改用「本机路径」（同样受上限约束，但省一次浏览器上传）。

**图片显示「加载失败」——** 该图片地址需要鉴权或防盗链。画廊条目仍保留原始 URL，可复制到别处打开。

**模型没有工具调用 ——** 只有 Skill 的 frontmatter 声明了 `allowed-tools` 时才会带工具声明；声明了也只是「允许」，模型可以不调用。
