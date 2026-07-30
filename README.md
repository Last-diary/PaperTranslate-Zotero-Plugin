# PaperTranslate for Zotero

把 PaperTranslate（Node 版双栏论文翻译阅读器）的核心能力移植为**原生 Zotero 插件**：

- 用 **MinerU** 在线解析 Zotero 中的 PDF 附件（标题层级、正文块、图片、表格）。
- 通过 **OpenAI Chat Completions 兼容层**调用大模型；可直接配置兼容端点，并提供 DeepSeek 专属适配器，译文增量缓存在本地。
- 通过 Zotero Reader 官方事件在工具栏注入「译」按钮，并在 Reader 文档中增加右侧同级面板；面板通过 CSS 缩窄原生 PDF 区域，不移动或重建 PDF iframe。
- 支持原文/译文切换、当前屏幕自动翻译、全文翻译、块级双向定位、原文/译文编辑、会话内宽度记忆和 PDF 自动调整大小。
- LaTeX 公式使用内置 **MathJax 3.2.2** 离线动态排版，支持行内公式和独立公式块。
- 论文管理完全交给 Zotero（收藏、搜索、排序、同步），不再需要独立服务与浏览器扩展。

兼容 **Zotero 7 / 8 / 9**。

## 当前测试版本：0.4.9 RC1（Manifest 0.4.8.1）

- Reader 内容渲染迁移到 **Marked 18 + DOMPurify 3.4.12**，支持 GFM、围栏代码、
  Markdown 表格和经过白名单净化的链接、表格与公式输出。
- MathJax 以每个 Reader 独立实例异步排版变更内容；公式更新串行执行，并通过
  `tex2svgPromise()` 直接替换受控占位节点，避免全页扫描与重复排版。
- 代码块会识别并移除完整的反引号或波浪线围栏，保留语言标记；不完整围栏和代码正文
  中的反引号不会被误删。
- Reader 中所有已显示内容块都可编辑：译文模式下未翻译的公式、代码等块会编辑原文；
  编辑框随内容增长，并限制最大高度。
- Zotero 条目移入回收站时保留 PaperTranslate 缓存；彻底删除后自动清理对应解析、
  翻译和原文编辑数据，启动时也会保守清理孤立缓存。
- 条目右键菜单的解析、翻译和两项缓存删除命令均使用统一的 16×16 主题图标。

## 功能对照

| 原 Node 项目 | 本插件 |
| --- | --- |
| `server/mineru.js`、`server/translation.js`、`server/toc.js` | 直接移植为插件内 ESM 模块（`chrome/content/modules/`） |
| `papers/` 解析产物与译文缓存 | `Zotero 数据目录/papertranslate/<附件Key>/`（不随 Zotero 同步上传） |
| HTTP 服务 + 鉴权 + 论文列表 + 浏览器扩展 | 删除，由 Zotero 原生能力替代 |
| 左侧 pdf.js 阅读器 | Zotero Reader（原生，含批注） |
| 右侧重排/译文栏 | Reader 文档中的同级面板，通过 CSS 为原生 PDF 区域预留宽度 |
| PDF 联动 | 点击内容块定位并高亮 PDF；PDF 右键可反向定位右侧内容 |
| PDF 缩略图 | 继续使用 Zotero Reader 原生缩略图，不重建 PDF iframe |
| PDF 大纲联动、连续滚动同步 | 暂未移植（见路线图） |

## 安装

### 方式一：安装打包好的 XPI（推荐）

从 [Releases](https://github.com/Last-diary/PaperTranslate-Zotero-Plugin/releases/latest)
下载 `papertranslate.xpi`，然后进入 Zotero → 工具 → 插件（Plugins）→ 齿轮 →
Install Add-on From File… 并选择下载的文件。

> **注意**：Zotero 强制要求插件 manifest 中声明 `applications.zotero.update_url`（缺一不可安装）。
> 当前 `manifest.json` 中使用的是占位地址 `https://example.com/papertranslate-zotero/updates.json`，
> 因此当前版本需要从 Release 手动下载更新；如果要启用自动更新，请把它换成真实的 updates.json 地址
> （格式见 [Zotero 插件更新清单文档](https://www.zotero.org/support/dev/zotero_7_for_developers#updaterdf--updatesjson)）。

### 方式二：开发模式（免打包）

1. 如需生成 XPI，在仓库根目录运行 `.\build.ps1`。
2. 找到 Zotero 配置文件目录（设置 → 高级 → 文件和文件夹 → 打开数据目录，profile 在其同级/附近；也可用 `-P` 启动参数确认）。
3. 在 `profile/extensions/` 下新建一个文本文件，文件名为插件 ID：`papertranslate@papertranslate.dev`（无扩展名），内容为本项目目录的完整路径，例如 `D:\_Projects\Personal\PaperTranslate-Zotero-Plugin`。
4. 重启 Zotero。

> 修改代码后需要重启 Zotero（ESM 模块有缓存，禁用/启用插件不一定足够）。

## 配置

Zotero → 设置 → PaperTranslate：

- **阅读**：配置正文对齐方式、字号，以及是否隐藏页眉、页脚、页码、脚注等非正文信息。
- **翻译**：默认跳过作者名单、引用章节、补充材料，可在此开启翻译。
- **大模型 API**：可选择 DeepSeek 或 OpenAI-compatible，切换后显示并分别保存对应的 API Key、Base URL 和模型。兼容模式可连接 OpenAI、OpenRouter、硅基流动、本地模型网关等 `/chat/completions` 端点。“允许思考”属于 DeepSeek 专属能力，选择通用兼容接口时不会显示或发送。
- **MinerU**：必填 API Token（[申请地址](https://mineru.net/apiManage/token)），解析 PDF 前必须配置；可按需调整模型版本、语言、OCR、公式/表格识别。
- **目录增强**：使用当前配置的大模型修复标题层级，结果带缓存。
- **数据**：显示 PaperTranslate 本地缓存目录、当前占用空间和论文数，可直接打开缓存目录；也可单独清除全部翻译缓存，或清除全部解析产物与翻译缓存。清除前会再次确认，不会删除 Zotero 条目或原始 PDF。

两个「测试」按钮可验证 API 连通性。

## 使用

1. 在库中选中一篇有 PDF 附件的条目，右键 → **解析 PDF**，或选择 **解析 PDF 并全文翻译**。条目信息面板中的 PaperTranslate 区块会分层显示论文标题、页数、内容块、译文段数和解析日期，并提供重新解析、全文翻译和打开阅读操作。
2. 已有有效 `parser-manifest.json` 和内容块时，解析命令会复用缓存，不会重复调用 MinerU；“解析 PDF 并全文翻译”会继续翻译尚未缓存的内容块。
3. 在单选或多选论文时，可通过条目右键菜单删除对应的**翻译缓存**，或删除对应的**解析和翻译缓存**；删除前会二次确认，Zotero 条目与原始 PDF 不受影响。
4. 双击打开 PDF → Reader 工具栏点「**译**」→ 右侧展开面板：
   - 「原文 / 译文」切换；译文模式会自动翻译当前屏幕附近尚未缓存的内容块；
   - 「翻译全文」对全文做增量翻译；
   - 点击内容块可定位并高亮 PDF；在 PDF 中右键可反向定位右侧内容；
   - 内容块右键可复制、重新翻译、编辑内容或定位 PDF；原文页的文本类块还可选择
     **重新解析**，插件会截取该块对应的 PDF 区域交给 MinerU，并按编辑原文的方式替换；
     表格、图片和图表等结构化块暂不提供此操作；
   - 没有译文的公式、代码等块会直接编辑原文，编辑框随内容动态增长并限制最大高度；
   - 打开面板和完成宽度拖拽后，插件会请求 Zotero Reader 重新执行 PDF 自动调整大小。

## 内容渲染

Reader 面板保留 MinerU 的结构化内容块、页码和定位信息，并在块内使用
**Marked 18 + DOMPurify 3.4.12** 渲染和净化 Markdown：

- 标题、正文、列表、代码、公式、图片、图表和表格仍按块类型分别处理；
- 普通文本支持 GFM、链接、引用、围栏代码、列表和 Markdown 表格；
- 渲染结果使用绑定到当前 Reader window 的 DOMPurify 白名单净化，Markdown
  不允许加载任意远程图片，链接由 Zotero 在外部打开；
- `$...$`、`$$...$$`、`\(...\)` 和 `\[...\]` 会先由公式分段器识别为受控占位节点，
  再由当前 Reader document 中的 MathJax 3.2.2 直接转换为 SVG；
- MathJax 关闭页面级自动扫描和菜单，只处理插件变更的内容根节点，并启用 `ui/safe`
  禁止公式输入生成 URL、CSS 类、ID 或内联样式；
- 本地图片读取后转换为 Base64 `data:` URL，避免 Reader 文档跨权限加载本地文件；
- MinerU `table_body` 不经过 Markdown 解析，使用仅允许表格标签和
  `rowspan`/`colspan` 等属性的独立白名单；
- 样式由 `readerPanelStyles.mjs` 作为 `<style>` 直接注入 Reader document。

这里的“重排内容”仍以 MinerU 块结构为准，不会直接渲染 `full.md`，因此块级
翻译缓存、PDF 页码/bbox 定位、内容编辑和增量更新保持可用。

## 路线图

- [ ] 新附件自动触发 MinerU 解析（Zotero Notifier）
- [x] 译文块右键复制原文/译文、重新翻译、编辑译文、定位 PDF
- [ ] 左右栏滚动同步
- [ ] PDF 大纲（outline）联动的章节过滤

## 目录结构

```text
manifest.json               插件清单（Zotero 7-9）
bootstrap.js                生命周期：注册 chrome、加载 main.mjs
prefs.js                    默认配置
chrome/content/
  preferences.xhtml/.js     设置面板
  modules/
    main.mjs                入口：注册菜单/条目面板/Reader 事件/设置页
    context.mjs             模块共享上下文（Zotero 对象等）
    config.mjs              偏好读取（对应原 config.json 结构）
    storage.mjs             条目数据目录、缓存读写
    mineru.mjs              MinerU API（移植）
    deepseek.mjs            论文翻译、过滤规则与缓存调度（移植）
    llm/
      openaiCompatible.mjs  OpenAI Chat Completions 兼容客户端
      provider.mjs          大模型 Provider 工厂
      providers/deepseek.mjs DeepSeek 专属适配器
      providers/openaiCompatible.mjs 用户可配置的兼容 Provider
    toc.mjs                 目录增强（移植）
    blocks.mjs              MinerU 内容块归一化（移植）
    importer.mjs            解析导入管线（移植）
    zip.mjs                 nsIZipReader 解压（替代 yauzl）
    utils.mjs               工具函数
    cacheCleanup.mjs        永久删除条目后的缓存清理与启动扫描
    readerPanelStyles.mjs   Reader 面板注入样式
    ui/
      blockEditing.mjs      原文/译文块编辑字段适配
      codeBlock.mjs         围栏代码规范化与语言标记提取
      mathJax.mjs           每个 Reader 的 MathJax 加载、排版队列与清理
      markdownMath.mjs      Marked 数学 token 与公式分段
      panelRenderer.mjs     Marked、DOMPurify、公式保留与表格净化
      pdfBlockCrop.mjs      PDF 块坐标转换与 Reader 截图兼容层
      actions.mjs           解析、解析后翻译等共享动作
      menu.mjs              条目右键菜单
      itemPane.mjs          条目信息面板
      progress.mjs          进度与通知
      readerPanel.mjs       Reader 面板、块渲染、翻译调度与 PDF 联动
  vendor/mathjax/
    es5/tex-svg-full.js     MathJax 3.2.2 TeX + SVG 离线组件
    es5/ui/safe.js          不可信公式属性过滤
  vendor/marked/            Marked 18 UMD 与 MIT 许可证
  vendor/dompurify/         DOMPurify 3.4.12 与许可证
icons/                      插件、侧栏和条目右键菜单图标
locale/                     Fluent 文案（菜单/区块标题）
test/                       渲染、公式、代码、编辑和缓存清理回归测试
build.ps1                   打包 XPI
```

## 开发检查

```powershell
$tests = Get-ChildItem .\test\*.test.mjs | ForEach-Object FullName
node --test $tests
.\build.ps1
```

测试覆盖 Markdown/公式分段、MathJax 配置和资源、代码围栏、内容块编辑与缓存清理决策。
成功打包后，仓库根目录会生成 `papertranslate.xpi`。

## 注意

- `Zotero 数据目录/papertranslate/` 中的解析产物、图片与译文缓存体积可能较大；附件或父论文移入回收站时缓存会保留，恢复后仍可使用；从回收站彻底删除后，插件会自动清理相关缓存。也可在设置页“数据”区域手动清除。
- MinerU 与配置的大模型都是外部服务，请确认 API Key、额度、数据处理政策与网络可用。
- Marked 本身不负责安全；所有 Markdown 输出和 MinerU `table_body` 都必须先经过
  当前 Reader window 中的 DOMPurify 白名单，不能绕过 `panelRenderer.mjs` 直接写入。
- Reader 译文面板使用 Zotero Reader 官方工具栏/右键菜单事件，并在 Reader document 中注入面板 DOM。PDF 就绪检测、自动缩放和块定位还包含经过能力检测的 Zotero Reader/PDF.js 内部兼容访问，因此 Zotero 大版本升级后仍需运行验证。
