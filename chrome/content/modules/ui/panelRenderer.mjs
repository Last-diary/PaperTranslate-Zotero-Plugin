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

export const MATH_SANITIZE_OPTIONS = Object.freeze({
  // KaTeX 的 HTML 视觉层需要行内布局样式，根号和可伸缩定界符还会使用
  // 经过 DOMPurify SVG profile 净化的 SVG。trust:false 会阻止 LaTeX
  // 输入注入任意 HTML、样式或 URL。
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ALLOW_ARIA_ATTR: true,
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: [
    "foreignObject",
    "form",
    "iframe",
    "input",
    "object",
    "script",
    "style"
  ]
});

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

function serializeFragment(doc, fragment) {
  const container = doc.createElement("div");
  container.appendChild(fragment);
  return container.innerHTML;
}

export function stripKatexSourceAnnotations(markupValue) {
  return String(markupValue || "").replace(
    /<annotation\b[^>]*\bencoding=(?:"application\/x-tex"|'application\/x-tex')[^>]*>[\s\S]*?<\/annotation\s*>/gi,
    ""
  );
}

function removeKatexSourceAnnotations(fragment) {
  const pending = [...(fragment?.childNodes || [])];
  while (pending.length) {
    const node = pending.pop();
    const localName = String(node?.localName || node?.nodeName || "").toLowerCase();
    const encoding = String(node?.getAttribute?.("encoding") || "").toLowerCase();
    if (localName === "annotation" && encoding === "application/x-tex") {
      node.remove();
      continue;
    }
    pending.push(...(node?.childNodes || []));
  }
  return fragment;
}

function isMathExcludedNode(node) {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.matches?.("pre, code, .pt-math-inline, .pt-math-display")) return true;
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
  win,
  katex
} = {}) {
  if (!markedNamespace?.Marked) throw new Error("Marked 18 加载失败");
  if (typeof createDOMPurify !== "function") throw new Error("DOMPurify 3.4.12 加载失败");
  if (!win?.document) throw new Error("Reader document 不可用");
  if (!katex?.renderToString) throw new Error("KaTeX 加载失败");

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
  markdown.use({ extensions: [markdownMathExtension] });

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

  const mathFragment = (tex, displayMode) => {
    const cleaned = stripMathWrappers(tex);
    if (!cleaned) return doc.createDocumentFragment();
    try {
      const html = stripKatexSourceAnnotations(
        katex.renderToString(cleaned, {
          displayMode: Boolean(displayMode),
          throwOnError: false,
          strict: "ignore",
          trust: false,
          // 使用 KaTeX HTML 负责稳定的视觉排版，MathML 仅用于无障碍。
          // 纯 MathML 会把部分 \underset 结构放进 token 元素，Gecko
          // 无法正确显示其下置内容。
          output: "htmlAndMathml",
          errorColor: "#b42318"
        })
      );
      return removeKatexSourceAnnotations(
        sanitizeFragment(html, MATH_SANITIZE_OPTIONS)
      );
    } catch {
      const fallback = doc.createElement("code");
      fallback.className = "pt-math-fallback";
      fallback.textContent = cleaned;
      const fragment = doc.createDocumentFragment();
      fragment.appendChild(fallback);
      return fragment;
    }
  };

  const renderMathInFragment = (fragment) => {
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
        if (segment.type === "text") {
          replacement.appendChild(doc.createTextNode(segment.text));
          continue;
        }
        const span = doc.createElement("span");
        span.className = segment.type === "display" ? "pt-math-display" : "pt-math-inline";
        span.appendChild(mathFragment(segment.tex, segment.type === "display"));
        replacement.appendChild(span);
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
    prepareLinks(renderMathInFragment(fragment))
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
      return serializeFragment(doc, mathFragment(tex, displayMode));
    }
  });
}
