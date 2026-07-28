# PaperTranslate for Zotero

把 [PaperTranslate](https://github.com/)（Node 版双栏论文翻译阅读器）的核心能力移植为**原生 Zotero 插件**：

- 用 **MinerU** 在线解析 Zotero 中的 PDF 附件（标题层级、正文块、图片、表格）。
- 用 **DeepSeek** 把论文段落翻译成中文，译文增量缓存在本地。
- 在 **Zotero Reader** 工具栏注入「译」按钮，与 PDF **并排**打开重排内容/译文面板（Reader 自带的 `#split-view` flex 布局，非覆盖浮层），支持原文/译文切换、目录跳转、点击块定位 PDF 页、拖拽调整面板宽度。
- LaTeX 公式用内置 MathJax **离线渲染为 SVG**（行内公式与独立公式块都支持）。
- 论文管理完全交给 Zotero（收藏、搜索、排序、同步），不再需要独立服务与浏览器扩展。

兼容 **Zotero 7 / 8 / 9**。

## 功能对照

| 原 Node 项目 | 本插件 |
| --- | --- |
| `server/mineru.js`、`server/translation.js`、`server/toc.js` | 直接移植为插件内 ESM 模块（`chrome/content/modules/`） |
| `papers/` 解析产物与译文缓存 | `Zotero 数据目录/papertranslate/<附件Key>/`（不随 Zotero 同步上传） |
| HTTP 服务 + 鉴权 + 论文列表 + 浏览器扩展 | 删除，由 Zotero 原生能力替代 |
| 左侧 pdf.js 阅读器 | Zotero Reader（原生，含批注） |
| 右侧重排/译文栏 | Reader 内注入的译文面板 |
| PDF 首页缩略图、PDF 大纲联动、滚动同步 | 暂未移植（见路线图） |

## 安装

### 方式一：安装打包好的 XPI（推荐）

```powershell
.\build.ps1
```

生成 `papertranslate.xpi` 后：Zotero → 工具 → 插件（Plugins）→ 齿轮 → Install Add-on From File…

> **注意**：Zotero 强制要求插件 manifest 中声明 `applications.zotero.update_url`（缺一不可安装）。
> 当前 `manifest.json` 中使用的是占位地址 `https://example.com/papertranslate-zotero/updates.json`，
> 仅供本地使用；如果要对外分发，请把它换成真实的 updates.json 地址
> （格式见 [Zotero 插件更新清单文档](https://www.zotero.org/support/dev/zotero_7_for_developers#updaterdf--updatesjson)）。

### 方式二：开发模式（免打包）

1. 找到 Zotero 配置文件目录（设置 → 高级 → 文件和文件夹 → 打开数据目录，profile 在其同级/附近；也可用 `-P` 启动参数确认）。
2. 在 `profile/extensions/` 下新建一个文本文件，文件名为插件 ID：`papertranslate@papertranslate.dev`（无扩展名），内容为本项目目录的完整路径，例如 `D:\_Projects\Personal\PaperTranslate-Zotero-Plugin`。
3. 重启 Zotero。

> 修改代码后需要重启 Zotero（ESM 模块有缓存，禁用/启用插件不一定足够）。

## 配置

Zotero → 设置 → PaperTranslate：

- **MinerU**：必填 API Token（[申请地址](https://mineru.net/apiManage/token)），解析 PDF 前必须配置；可按需调整模型版本、语言、OCR、公式/表格识别。
- **DeepSeek**：翻译与目录增强需要 API Key（[申请地址](https://platform.deepseek.com/)）。
- **翻译**：默认跳过作者名单、引用章节、补充材料，可在此开启翻译。
- **目录增强**：对标题层级用 DeepSeek 修复，结果带缓存。

两个「测试」按钮可验证 API 连通性。

## 使用

1. 在库中选中一篇有 PDF 附件的条目，右键 → **用 MinerU 解析 PDF**（条目信息面板也有 PaperTranslate 区块，显示解析/翻译状态）。
2. 解析完成后可右键 → **翻译全文**，或稍后在 Reader 面板里翻译。
3. 双击打开 PDF → Reader 工具栏点「**译**」→ 右侧展开面板：
   - 「原文 / 译文」切换；「翻译」对全文做增量翻译；
   - 「目录」下拉跳转章节；
   - 点击任意段落，PDF 跳转到对应页。

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
    deepseek.mjs            DeepSeek 翻译与过滤规则（移植）
    toc.mjs                 目录增强（移植）
    blocks.mjs              MinerU 内容块归一化（移植）
    importer.mjs            解析导入管线（移植）
    zip.mjs                 nsIZipReader 解压（替代 yauzl）
    utils.mjs               工具函数
    ui/                     菜单、条目面板、进度、Reader 面板
locale/                     Fluent 文案（菜单/区块标题）
vendor/marked.min.js        Markdown 渲染（marked@12，UMD）
build.ps1                   打包 XPI
```

## 注意

- `Zotero 数据目录/papertranslate/` 中的解析产物、图片与译文缓存体积可能较大，删除附件时不会自动清理（后续版本补充）。
- MinerU 与 DeepSeek 都是外部服务，请确认 API Key、额度与网络可用。
- Reader 译文面板使用了 Zotero Reader 工具栏事件（官方 API）+ 面板 DOM 注入（社区通行做法），Zotero 大版本升级后如面板异常请关注更新。
