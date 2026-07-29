import { ctx } from "../context.mjs";

export const MATHJAX_VERSION = "3.2.2";
export const MATHJAX_BASE_URL = "chrome://papertranslate/content/vendor/mathjax/es5";
export const MATHJAX_SCRIPT_URL = `${MATHJAX_BASE_URL}/tex-svg-full.js`;

const SCRIPT_ID = "papertranslate-mathjax-script";
const STYLE_ID = "MJX-SVG-styles";
const LOAD_TIMEOUT_MS = 15000;

export function mathJaxConfig() {
  return {
    loader: {
      paths: {
        mathjax: MATHJAX_BASE_URL
      },
      load: ["ui/safe"]
    },
    startup: {
      typeset: false
    },
    tex: {
      // panelRenderer 会把经过识别的公式统一写成 \(...\) 或 \[...\]。
      // 不启用 $ 分隔符，避免把 “$5 and $10” 等普通货币文本误判为公式。
      inlineMath: [["\\(", "\\)"]],
      displayMath: [["\\[", "\\]"]],
      processEscapes: true
    },
    svg: {
      fontCache: "local"
    },
    options: {
      enableMenu: false,
      skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      safeOptions: {
        allow: {
          URLs: "none",
          classes: "none",
          cssIDs: "none",
          styles: "none"
        }
      }
    }
  };
}

function readerGlobal(win) {
  return win?.wrappedJSObject || win;
}

function asArray(value) {
  if (
    value
    && !Array.isArray(value)
    && !value.nodeType
    && typeof value !== "string"
    && typeof value.length === "number"
  ) {
    return Array.from(value).filter(Boolean);
  }
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function mathSourceNodes(roots) {
  const result = [];
  for (const root of asArray(roots)) {
    if (root.matches?.(".pt-math-source")) result.push(root);
    result.push(...(root.querySelectorAll?.(".pt-math-source") || []));
  }
  return [...new Set(result)];
}

function debug(stage, details = {}) {
  try {
    ctx.Zotero?.debug?.(
      `[PaperTranslate][mathjax-v1] ${JSON.stringify({
        stage,
        version: MATHJAX_VERSION,
        ...details
      })}`
    );
  } catch {}
}

export function createMathJaxController(win) {
  if (!win?.document) throw new Error("Reader window 不可用，无法初始化 MathJax。");

  const doc = win.document;
  const targetGlobal = readerGlobal(win);
  let api = null;
  let configuredGlobal = null;
  let marker = null;
  let loadPromise = null;
  let queue = Promise.resolve();
  let disposed = false;
  let generation = 0;
  let lastError = null;

  const reportError = (error, stage) => {
    lastError = error;
    debug(stage, { message: error?.message || String(error) });
    ctx.Zotero?.logError?.(error);
  };

  const ensureLoaded = () => {
    if (disposed) return Promise.reject(new Error("MathJax controller 已释放。"));
    if (api?.typesetPromise) return Promise.resolve(api);
    if (loadPromise) return loadPromise;

    const existingMarker = doc.getElementById(SCRIPT_ID);
    const existingMathJax = Cu.waiveXrays(targetGlobal.MathJax);
    if (existingMarker || existingMathJax?.startup?.promise) {
      const error = new Error(
        "Reader document 中已存在未知 MathJax 实例，已停止加载以避免全局冲突。"
      );
      reportError(error, "global-conflict");
      loadPromise = Promise.resolve(null);
      return loadPromise;
    }

    configuredGlobal = Cu.cloneInto(mathJaxConfig(), targetGlobal);
    const targetConfig = Cu.waiveXrays(configuredGlobal);
    targetConfig.loader.require = Cu.exportFunction((uri) => {
      // MathJax 的组件 loader 默认创建 <script>，但 Zotero Reader 的
      // resource:// document 不允许加载插件 chrome:// 脚本。让主脚本和
      // ui/safe 组件都经 privileged scriptloader 进入同一个 Reader global。
      Services.scriptloader.loadSubScript(String(uri), targetGlobal, "UTF-8");
    }, targetGlobal);
    targetGlobal.MathJax = configuredGlobal;
    marker = doc.createElement("meta");
    marker.id = SCRIPT_ID;
    marker.dataset.papertranslateVersion = MATHJAX_VERSION;

    loadPromise = new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        win.clearTimeout(timeoutID);
        reject(error);
      };
      const timeoutID = win.setTimeout(() => {
        fail(new Error(`MathJax ${MATHJAX_VERSION} 加载超时。`));
      }, LOAD_TIMEOUT_MS);

      try {
        Services.scriptloader.loadSubScript(MATHJAX_SCRIPT_URL, targetGlobal, "UTF-8");
        const loaded = Cu.waiveXrays(targetGlobal.MathJax);
        const startupPromise = loaded?.startup?.promise;
        if (typeof startupPromise?.then !== "function") {
          fail(new Error(`MathJax ${MATHJAX_VERSION} 启动接口不可用。`));
          return;
        }
        Promise.resolve(startupPromise).then(() => {
          if (disposed) {
            fail(new Error("MathJax 加载完成前面板已关闭。"));
            return;
          }
          if (!loaded?.tex2svgPromise || !loaded?.svgStylesheet) {
            fail(new Error(`MathJax ${MATHJAX_VERSION} SVG 转换接口不可用。`));
            return;
          }
          if (settled) return;
          settled = true;
          win.clearTimeout(timeoutID);
          api = loaded;
          if (!doc.getElementById(STYLE_ID)) {
            const stylesheet = Cu.waiveXrays(api.svgStylesheet());
            (doc.head || doc.documentElement).appendChild(stylesheet);
          }
          lastError = null;
          debug("ready", {
            script: MATHJAX_SCRIPT_URL,
            output: "svg"
          });
          resolve(api);
        }, fail);
      } catch (error) {
        fail(new Error(
          `无法从 ${MATHJAX_SCRIPT_URL} 加载 MathJax：${error?.message || error}`
        ));
      }
    }).catch((error) => {
      reportError(error, "load-failed");
      return null;
    });

    (doc.head || doc.documentElement).appendChild(marker);
    debug("loading", { script: MATHJAX_SCRIPT_URL });
    return loadPromise;
  };

  const replace = (mutate) => {
    const requestGeneration = generation;
    queue = queue.catch(() => {}).then(async () => {
      if (disposed || requestGeneration !== generation) return [];
      let loaded = null;
      try {
        loaded = await ensureLoaded();
      } catch (error) {
        reportError(error, "load-conflict");
      }
      if (disposed || requestGeneration !== generation) return [];

      const changed = asArray(mutate());
      if (!loaded || disposed || requestGeneration !== generation || !changed.length) {
        return changed;
      }
      const sources = mathSourceNodes(changed);
      let converted = 0;
      for (const source of sources) {
        if (disposed || requestGeneration !== generation) break;
        const tex = String(source.textContent || "").trim();
        if (!tex) continue;
        try {
          const options = Cu.cloneInto({
            display: source.dataset.display === "true"
          }, targetGlobal);
          const output = Cu.waiveXrays(await loaded.tex2svgPromise(tex, options));
          source.replaceChildren(output);
          source.classList.remove("pt-math-fallback");
          source.dataset.mathJaxRendered = MATHJAX_VERSION;
          converted += 1;
        } catch (error) {
          source.classList.add("pt-math-fallback");
          reportError(error, "convert-failed");
        }
      }
      debug("typeset-complete", {
        roots: changed.length,
        sources: sources.length,
        converted
      });
      return changed;
    });
    return queue;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    try {
      api?.typesetClear?.();
    } catch (error) {
      reportError(error, "dispose-clear-failed");
    }
    if (marker || configuredGlobal || api) doc.getElementById(STYLE_ID)?.remove();
    marker?.remove();
    if (
      targetGlobal.MathJax === configuredGlobal
      || Cu.waiveXrays(targetGlobal.MathJax) === api
    ) {
      try {
        delete targetGlobal.MathJax;
      } catch {}
    }
    api = null;
    configuredGlobal = null;
    marker = null;
    debug("disposed");
  };

  return Object.freeze({
    ensureLoaded,
    replace,
    dispose,
    get ready() {
      return loadPromise;
    },
    get error() {
      return lastError;
    }
  });
}
