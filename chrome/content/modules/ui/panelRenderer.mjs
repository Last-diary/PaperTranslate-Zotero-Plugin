import { markdownMathExtension, splitMathSegments } from "./markdownMath.mjs";

export const MARKDOWN_SANITIZE_OPTIONS = Object.freeze({
  ALLOWED_TAGS: [
    "a",
    "blockquote",
    "br",
    "code",
    "del",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "li",
    "ol",
    "p",
    "pre",
    "strong",
    "sub",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr",
    "ul"
  ],
  ALLOWED_ATTR: [
    "align",
    "class",
    "colspan",
    "href",
    "reversed",
    "rowspan",
    "scope",
    "start",
    "title"
  ],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ["style"],
  FORBID_TAGS: ["form", "iframe", "input", "object", "script", "style", "svg"],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):)/i
});

export const TABLE_SANITIZE_OPTIONS = Object.freeze({
  ALLOWED_TAGS: [
    "caption",
    "col",
    "colgroup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "tr"
  ],
  ALLOWED_ATTR: ["align", "colspan", "rowspan", "scope"],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR: ["style"],
  KEEP_CONTENT: true
});

const SAFE_SOURCE_HTML_TAGS = new Set(MARKDOWN_SANITIZE_OPTIONS.ALLOWED_TAGS);

function stripMathWrappers(content) {
  const trimmed = String(content || "").trim();
  const patterns = [
    /^\$\$([\s\S]*?)\$\$$/,
    /^\\\[([\s\S]*?)\\\]$/,
    /^\\\(([\s\S]*?)\\\)$/,
    /^\$([\s\S]*?)\$$/
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1].trim();
  }
  return trimmed;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Marked 会把 <search> 等 HTML/类 XML 标签解析成原始 HTML token，而
// DOMPurify 随后会移除白名单外的标签。未知标签在这里转义为可见文字；
// 已明确允许的 Markdown HTML 仍交给 DOMPurify 做属性和协议净化。
export function renderSourceHtmlToken(token) {
  const raw = String(token?.raw ?? token?.text ?? "");
  const tagNames = Array.from(
    raw.matchAll(/<\s*\/?\s*([a-z][a-z0-9:-]*)\b/gi),
    (match) => match[1].toLowerCase()
  );
  if (
    tagNames.length
    && tagNames.every((tagName) => SAFE_SOURCE_HTML_TAGS.has(tagName))
  ) {
    return raw;
  }
  return escapeHtml(raw);
}

export function normalizeMathSource(tex, displayMode = false) {
  const cleaned = stripMathWrappers(tex);
  if (!cleaned) return "";
  return displayMode ? `\\[${cleaned}\\]` : `\\(${cleaned}\\)`;
}

function serializeFragment(doc, fragment) {
  const container = doc.createElement("div");
  container.appendChild(fragment);
  return container.innerHTML;
}

function isMathExcludedNode(node) {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.matches?.("pre, code, mjx-container")) return true;
  }
  return false;
}

export function safeBlockTypeClass(value) {
  const token = String(value || "text")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token || "text";
}

export function createPanelRenderer({
  markedNamespace,
  createDOMPurify,
  win
} = {}) {
  if (!markedNamespace?.Marked) throw new Error("Marked 18 加载失败");
  if (typeof createDOMPurify !== "function") throw new Error("DOMPurify 3.4.12 加载失败");
  if (!win?.document) throw new Error("Reader document 不可用");

  const { document: doc } = win;
  const purifier = createDOMPurify(win);
  if (!purifier?.sanitize || purifier.isSupported === false) {
    throw new Error("DOMPurify 不支持当前 Reader 运行环境");
  }

  const markdown = new markedNamespace.Marked({
    async: false,
    breaks: true,
    gfm: true
  });
  markdown.use({
    extensions: [markdownMathExtension],
    renderer: {
      html(token) {
        return renderSourceHtmlToken(token);
      }
    }
  });

  const sanitizeFragment = (html, options) => {
    const clean = purifier.sanitize(String(html || ""), {
      ...options,
      RETURN_DOM_FRAGMENT: true
    });
    if (clean?.nodeType === 11) return clean;
    const template = doc.createElement("template");
    template.innerHTML = String(clean || "");
    return template.content;
  };

  const mathSourceElement = (tex, displayMode = false) => {
    const node = doc.createElement("span");
    node.className = "pt-math-source";
    node.dataset.display = displayMode ? "true" : "false";
    node.textContent = stripMathWrappers(tex);
    return node;
  };

  // DOMPurify 先完成 HTML 净化，再把当前解析器认可的公式改写为受控
  // 占位节点。后续队列直接调用 MathJax.tex2svgPromise()，不依赖
  // Zotero Reader 中不稳定的 delimiter DOM 扫描。
  const preserveMathInFragment = (fragment) => {
    const walker = doc.createTreeWalker(fragment, win.NodeFilter.SHOW_TEXT);
    const textNodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!isMathExcludedNode(node)) textNodes.push(node);
    }
    for (const node of textNodes) {
      const segments = splitMathSegments(node.nodeValue || "");
      if (!segments.some((segment) => segment.type !== "text")) continue;
      const replacement = doc.createDocumentFragment();
      for (const segment of segments) {
        replacement.appendChild(
          segment.type === "text"
            ? doc.createTextNode(segment.text)
            : mathSourceElement(segment.tex, segment.type === "display")
        );
      }
      node.replaceWith(replacement);
    }
    return fragment;
  };

  const prepareLinks = (fragment) => {
    for (const link of fragment.querySelectorAll?.("a[href]") || []) {
      const href = String(link.getAttribute("href") || "").trim();
      if (!/^(?:https?|mailto):/i.test(href)) {
        link.removeAttribute("href");
        continue;
      }
      link.classList.add("pt-external-link");
      link.setAttribute("rel", "noopener noreferrer");
    }
    return fragment;
  };

  const finish = (fragment) => serializeFragment(
    doc,
    prepareLinks(preserveMathInFragment(fragment))
  );

  return Object.freeze({
    block(content) {
      const html = markdown.parse(String(content || ""), {
        async: false,
        breaks: true,
        gfm: true
      });
      return finish(sanitizeFragment(html, MARKDOWN_SANITIZE_OPTIONS));
    },

    inline(content) {
      const html = markdown.parseInline(String(content || ""), {
        async: false,
        breaks: true,
        gfm: true
      });
      return finish(sanitizeFragment(html, MARKDOWN_SANITIZE_OPTIONS));
    },

    table(html) {
      return finish(sanitizeFragment(html, TABLE_SANITIZE_OPTIONS));
    },

    math(tex, displayMode = false) {
      return mathSourceElement(tex, displayMode).outerHTML;
    }
  });
}
