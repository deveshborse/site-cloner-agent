// Runs inside the page (via Playwright page.evaluate). Plain JS on purpose: it is sent to the browser as a string.
// Returns a compact, token-efficient description of the rendered page: sections, simplified DOM trees with the
// styles that matter visually, assets to download, and colour/font statistics used to derive design tokens.
(function (opts) {
  const MAX_SECTIONS = opts.maxSections || 18;
  const NODE_BUDGET = opts.nodeBudget || 170;
  const MAX_ASSETS = opts.maxAssets || 80;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "HEAD", "BR", "WBR", "SOURCE", "TRACK"]);
  const TEXT_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "span", "a", "button", "li", "label", "strong", "em", "b", "i", "small", "blockquote", "figcaption", "td", "th", "dt", "dd", "summary"]);

  const styleCache = new Map();
  const cs = (el) => {
    let s = styleCache.get(el);
    if (!s) {
      s = getComputedStyle(el);
      styleCache.set(el, s);
    }
    return s;
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const px = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
  };

  function toHex(c) {
    if (!c) return null;
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return c === "transparent" ? null : c;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    const [r, g, b] = parts;
    const a = parts.length > 3 ? parts[3] : 1;
    if (a === 0) return null;
    const h = "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
    return a < 1 ? `${h}${Math.round(a * 255).toString(16).padStart(2, "0")}` : h;
  }

  function isVisible(el) {
    if (SKIP.has(el.tagName)) return false;
    const s = cs(el);
    if (s.display === "none" || s.visibility === "hidden" || s.visibility === "collapse") return false;
    if (s.display === "contents") return true;
    if (parseFloat(s.opacity) < 0.02) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const docW = document.documentElement.scrollWidth;
    if (r.right + scrollX < -5 || r.left + scrollX > docW + 5) return false; // off-canvas menus
    return true;
  }

  // Cookie banners, chat widgets and modals are not part of the page design.
  function isOverlay(el) {
    const s = cs(el);
    if (el.getAttribute("role") === "dialog" || el.getAttribute("aria-modal") === "true") return true;
    if (s.position !== "fixed") return false;
    const r = el.getBoundingClientRect();
    const looksLikeTopBar = r.top <= 5 && r.height < 180 && r.width > vw * 0.6;
    return !looksLikeTopBar;
  }

  // Zero-size wrappers (e.g. a 0px-tall <section> holding a fixed header) are transparent: use their children.
  function passThrough(el) {
    const s = cs(el);
    if (s.display === "contents") return true;
    if (s.display === "none" || s.visibility === "hidden" || s.overflow === "hidden" || !el.children.length) return false;
    const r = el.getBoundingClientRect();
    return r.width < 2 || r.height < 2;
  }
  // Text duplicated for visual effects (gradient overlays, marquee clones) is marked aria-hidden; keep only the original.
  const isHiddenDuplicate = (el) => el.getAttribute("aria-hidden") === "true" && el.tagName !== "svg" && (el.innerText || "").trim().length > 0;
  function visibleKids(el) {
    const out = [];
    for (const c of el.children) {
      if (SKIP.has(c.tagName) || isHiddenDuplicate(c)) continue;
      if (passThrough(c)) {
        out.push(...visibleKids(c));
        continue;
      }
      if (!isVisible(c) || isOverlay(c)) continue;
      out.push(c);
    }
    return out;
  }

  function descend(el) {
    let cur = el;
    for (let i = 0; i < 14; i++) {
      const k = visibleKids(cur).filter((c) => rectOf(c).h >= 8);
      if (k.length === 1) cur = k[0];
      else break;
    }
    return cur;
  }

  function isRow(list) {
    if (list.length < 2) return false;
    const a = rectOf(list[0]);
    const b = rectOf(list[1]);
    return Math.abs(a.y - b.y) < 12 && b.x >= a.x + a.w - 6;
  }

  function collect(el, depth) {
    const root = descend(el);
    const list = visibleKids(root);
    if (list.length === 0) return [root];
    if (isRow(list.filter((c) => rectOf(c).h >= 24)) && depth > 0) return [root];
    const out = [];
    const inFlow = list.filter((c) => cs(c).position !== "absolute");
    for (const c of list) {
      const r = rectOf(c);
      if (r.h < 20) continue;
      // Absolutely positioned siblings are usually decorative layers (gradients, glows) that overlap real sections.
      if (cs(c).position === "absolute" && inFlow.length > 0) continue;
      const inner = descend(c);
      const sub = visibleKids(inner).filter((x) => rectOf(x).h >= 24);
      const atomic = ["HEADER", "FOOTER", "NAV"].includes(c.tagName) || isRow(sub) || sub.length < 2;
      if (depth < 4 && r.h > vh * 1.6 && !atomic) out.push(...collect(c, depth + 1));
      else out.push(c);
    }
    return out;
  }

  // ---------- assets ----------
  const assets = [];
  const assetKeys = new Map();
  function addAsset(key, data) {
    if (assetKeys.has(key)) return assetKeys.get(key);
    if (assets.length >= MAX_ASSETS) return null;
    const id = (data.kind === "svg" ? "svg-" : "img-") + (assets.length + 1);
    assets.push({ id, ...data });
    const ref = "@asset:" + id;
    assetKeys.set(key, ref);
    return ref;
  }
  function svgAsset(svg) {
    const r = svg.getBoundingClientRect();
    if (r.width * r.height > 600 * 600) return null;
    const clone = svg.cloneNode(true);
    const color = toHex(cs(svg).color) || "#000000";
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (!clone.getAttribute("width")) clone.setAttribute("width", String(Math.round(r.width)));
    if (!clone.getAttribute("height")) clone.setAttribute("height", String(Math.round(r.height)));
    let markup = clone.outerHTML.replace(/currentColor/g, color.slice(0, 7));
    if (!/fill=/.test(markup.slice(0, 300)) && cs(svg).fill && cs(svg).fill !== "none") {
      const fill = toHex(cs(svg).fill);
      if (fill) markup = markup.replace("<svg", `<svg fill="${fill.slice(0, 7)}"`);
    }
    if (markup.length > 60000) return null;
    return addAsset("svg:" + markup, { kind: "svg", svg: markup });
  }
  function bgImageUrl(s) {
    const m = /url\(["']?([^"')]+)["']?\)/.exec(s.backgroundImage || "");
    return m ? m[1] : null;
  }

  // ---------- styles ----------
  function styleOf(el, s, isRoot, hasText) {
    const st = {};
    const disp = s.display;
    if (disp.includes("flex")) {
      st.display = "flex";
      if (s.flexDirection !== "row") st.flexDirection = s.flexDirection;
      if (s.flexWrap === "wrap") st.flexWrap = "wrap";
      if (s.justifyContent && !["normal", "flex-start", "start"].includes(s.justifyContent)) st.justifyContent = s.justifyContent;
      if (s.alignItems && !["normal", "stretch"].includes(s.alignItems)) st.alignItems = s.alignItems;
    } else if (disp.includes("grid")) {
      st.display = "grid";
      const cols = s.gridTemplateColumns && s.gridTemplateColumns !== "none" ? s.gridTemplateColumns.split(" ").filter(Boolean).length : 1;
      st.gridCols = cols;
    } else if (disp === "inline-block" || disp === "inline") {
      if (!hasText) st.display = disp;
    }
    const gap = px(s.rowGap) || px(s.columnGap) || px(s.gap);
    if ((st.display === "flex" || st.display === "grid") && gap) st.gap = gap;
    const pad = [px(s.paddingTop), px(s.paddingRight), px(s.paddingBottom), px(s.paddingLeft)];
    if (pad.some(Boolean)) st.padding = pad.join(" ");
    if (!isRoot) {
      const mar = [px(s.marginTop), px(s.marginRight), px(s.marginBottom), px(s.marginLeft)];
      if (mar[0] || mar[2]) st.margin = mar.map((m) => (m < 0 ? 0 : m)).join(" ");
    }
    if (s.maxWidth && s.maxWidth !== "none" && s.maxWidth.endsWith("px")) st.maxWidth = px(s.maxWidth);
    const ml = px(s.marginLeft);
    const mr = px(s.marginRight);
    if (!isRoot && ml > 0 && Math.abs(ml - mr) <= 1) st.center = 1;
    if (s.position === "absolute") {
      const parent = el.offsetParent || el.parentElement;
      if (parent) {
        const pr = parent.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        st.position = "absolute";
        st.abs = [Math.round(r.top - pr.top), Math.round(r.left - pr.left), Math.round(r.width), Math.round(r.height)].join(" ");
      }
    }
    const bg = toHex(s.backgroundColor);
    if (bg) st.bg = bg;
    const bgImg = s.backgroundImage;
    if (bgImg && bgImg !== "none") {
      if (bgImg.includes("gradient")) st.bgGradient = bgImg.slice(0, 240);
      const u = bgImageUrl(s);
      if (u && !u.startsWith("data:image/svg")) {
        const ref = addAsset(u, { kind: "img", url: new URL(u, location.href).href });
        if (ref) st.bgImage = ref;
        if (s.backgroundSize && s.backgroundSize !== "auto") st.bgSize = s.backgroundSize;
      }
    }
    const bw = px(s.borderTopWidth) || px(s.borderBottomWidth) || px(s.borderLeftWidth);
    if (bw && s.borderTopStyle !== "none") {
      const side = px(s.borderTopWidth) && px(s.borderBottomWidth) && px(s.borderLeftWidth) ? "" : px(s.borderTopWidth) ? "top " : px(s.borderBottomWidth) ? "bottom " : "left ";
      st.border = `${side}${bw}px ${s.borderTopStyle || "solid"} ${toHex(s.borderTopColor) || toHex(s.borderBottomColor) || "#000"}`;
    }
    const rad = px(s.borderTopLeftRadius);
    if (rad) st.radius = rad >= 999 ? 9999 : rad;
    if (s.boxShadow && s.boxShadow !== "none") st.shadow = s.boxShadow.length > 80 ? "yes" : s.boxShadow;
    if (s.position === "sticky" || s.position === "fixed") st.position = s.position;
    else if (s.position === "relative" && [...el.children].some((c) => cs(c).position === "absolute")) st.position = "relative";
    if (px(s.opacity) < 1 && px(s.opacity) > 0) st.opacity = px(s.opacity);
    if (hasText) {
      st.fontSize = px(s.fontSize);
      st.fontWeight = Number(s.fontWeight) || s.fontWeight;
      st.color = toHex(s.color) || "#000000";
      const fam = (s.fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
      if (fam && fam !== bodyFont) st.font = fam;
      const lh = s.lineHeight === "normal" ? 0 : px(s.lineHeight);
      if (lh && st.fontSize) st.lineHeight = Math.round((lh / st.fontSize) * 100) / 100;
      if (s.letterSpacing && s.letterSpacing !== "normal" && px(s.letterSpacing) !== 0) st.letterSpacing = px(s.letterSpacing);
      if (s.textAlign && !["start", "left", "-webkit-auto"].includes(s.textAlign)) st.textAlign = s.textAlign;
      if (s.textTransform && s.textTransform !== "none") st.textTransform = s.textTransform;
      if (s.fontStyle === "italic") st.italic = 1;
      if ((s.textDecorationLine || "").includes("underline")) st.underline = 1;
    }
    return st;
  }

  const bodyFont = (cs(document.body).fontFamily || "").split(",")[0].replace(/["']/g, "").trim();
  const sameOrigin = (href) => {
    try {
      return new URL(href, location.href).origin === location.origin;
    } catch {
      return true;
    }
  };

  let budget = 0;
  let truncated = false;
  function directText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  }

  function ser(el, depth, isRoot) {
    if (budget <= 0 || depth > 14) {
      truncated = true;
      return null;
    }
    const tag = el.tagName.toLowerCase();
    const s = cs(el);
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    budget--;

    if (tag === "svg") {
      const ref = svgAsset(el);
      return ref ? { tag: "img", asset: ref, attrs: { alt: el.getAttribute("aria-label") || "" }, w, h } : null;
    }
    if (tag === "img" || tag === "picture") {
      const img = tag === "picture" ? el.querySelector("img") : el;
      if (!img) return null;
      const src = img.currentSrc || img.src;
      const ref = src ? addAsset(src, { kind: "img", url: src }) : null;
      const st = {};
      const ics = cs(img);
      if (ics.objectFit && ics.objectFit !== "fill") st.objectFit = ics.objectFit;
      if (px(ics.borderTopLeftRadius)) st.radius = px(ics.borderTopLeftRadius);
      return { tag: "img", asset: ref, attrs: { alt: (img.alt || "").slice(0, 120) }, w, h, style: st };
    }
    if (tag === "video") {
      const poster = el.getAttribute("poster");
      const ref = poster ? addAsset(poster, { kind: "img", url: new URL(poster, location.href).href }) : null;
      return ref ? { tag: "img", asset: ref, attrs: { alt: "video" }, w, h } : { tag: "div", attrs: { "data-media": "video" }, w, h, style: { bg: "#111111" } };
    }
    if (tag === "iframe" || tag === "canvas" || tag === "object" || tag === "embed") {
      return { tag: "div", attrs: { "data-media": tag }, w, h, style: { bg: "#e5e7eb" } };
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const attrs = { type: el.getAttribute("type") || (tag === "input" ? "text" : tag) };
      if (el.getAttribute("placeholder")) attrs.placeholder = el.getAttribute("placeholder").slice(0, 80);
      if (attrs.type === "submit" || attrs.type === "button") attrs.value = (el.value || "").slice(0, 60);
      return { tag, attrs, w, h, style: styleOf(el, s, false, attrs.type === "submit") };
    }

    const own = directText(el);
    const node = { tag };
    const attrs = {};
    if (tag === "a") {
      const href = el.getAttribute("href") || "#";
      attrs.href = sameOrigin(href) ? (href.startsWith("#") ? href : "#") : href;
    }
    const aria = el.getAttribute("aria-label");
    if (aria && (tag === "a" || tag === "button")) attrs.ariaLabel = aria.slice(0, 60);
    if (Object.keys(attrs).length) node.attrs = attrs;

    const kids = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        const t = n.textContent.replace(/\s+/g, " ");
        if (t.trim()) kids.push({ tag: "#text", text: t.slice(0, 400) });
        else if (t && kids.length) kids.push({ tag: "#text", text: " " });
      } else if (n.nodeType === 1) {
        if (n.tagName === "BR") {
          kids.push({ tag: "br" });
          continue;
        }
        if (SKIP.has(n.tagName) || isOverlay(n) || isHiddenDuplicate(n)) continue;
        if (passThrough(n)) {
          for (const c of visibleKids(n)) {
            const sc = ser(c, depth + 1, false);
            if (sc) kids.push(sc);
          }
          continue;
        }
        if (!isVisible(n)) continue;
        const sc = ser(n, depth + 1, false);
        if (sc) kids.push(sc);
      }
    }

    // Whitespace only matters between inline siblings; trim it at the edges and next to block children.
    const isBlockKid = (k) => k && k.tag !== "#text" && k.tag !== "br" && (k.style && (k.style.display === "flex" || k.style.display === "grid") || ["div", "section", "ul", "ol", "li", "p", "h1", "h2", "h3", "h4", "h5", "h6", "header", "footer", "nav", "form", "table"].includes(k.tag));
    for (let i = kids.length - 1; i >= 0; i--) {
      if (kids[i].tag === "#text" && !kids[i].text.trim() && (i === 0 || i === kids.length - 1 || isBlockKid(kids[i - 1]) || isBlockKid(kids[i + 1]))) kids.splice(i, 1);
    }
    if (kids.length && kids[0].tag === "#text") kids[0].text = kids[0].text.replace(/^\s+/, "");
    if (kids.length && kids[kids.length - 1].tag === "#text") kids[kids.length - 1].text = kids[kids.length - 1].text.replace(/\s+$/, "");
    const hasText = own.length > 0 || (TEXT_TAGS.has(tag) && kids.some((k) => k.tag === "#text"));
    node.style = styleOf(el, s, isRoot, hasText);
    if (kids.length === 1 && kids[0].tag === "#text") node.text = kids[0].text;
    else if (kids.length) node.children = kids;

    // Collapse meaningless wrappers: a plain element with a single element child.
    const plain = Object.keys(node.style).filter((k) => k !== "margin").length === 0 && !node.attrs;
    if (!isRoot && plain && !node.text && kids.length === 1 && kids[0].tag !== "#text" && !["ul", "ol", "li", "a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "p", "form", "table"].includes(tag)) {
      return kids[0];
    }
    if (!node.text && !node.children && Object.keys(node.style).length === 0) return null;
    if (!node.text || node.style.display || node.style.bg || node.style.border) {
      node.w = w;
      node.h = h;
    }
    return node;
  }

  function kindOf(els, idx, total, prevKinds) {
    const el = els[0];
    const r = rectOf(el);
    const text = els.map((e) => e.innerText || "").join(" ").slice(0, 4000).toLowerCase();
    const cls = els.map((e) => (e.id || "") + " " + (typeof e.className === "string" ? e.className : "")).join(" ").toLowerCase();
    const links = els.reduce((n, e) => n + e.querySelectorAll("a").length, 0);
    const media = els.reduce((n, e) => n + e.querySelectorAll("img,svg,picture").length, 0);
    const words = text.split(/\s+/).filter(Boolean).length;
    const hasH1 = els.some((e) => e.tagName === "H1" || e.querySelector("h1"));
    const tag = el.tagName;
    const nearTop = r.y < 200 || idx === 0;
    if (((tag === "NAV" || tag === "HEADER") && nearTop) || (r.y < 140 && r.h < 180 && links >= 3) || (/\b(nav|navbar|header|topbar)\b/.test(cls) && nearTop)) return "navbar";
    if (tag === "FOOTER" || /\bfooter\b/.test(cls) || (idx === total - 1 && links >= 6)) return "footer";
    if (/pricing|\bplans?\b/.test(cls) || /(per month|\/mo\b|\/month|billed (annually|monthly)|\bpricing\b)/.test(text)) return "pricing";
    if (/testimonial|review/.test(cls) || /(testimonial|what (our )?(customers|clients|users) (say|are saying)|loved by)/.test(text)) return "testimonials";
    if (/\bfaq\b/.test(cls) || /(frequently asked|\bfaqs?\b)/.test(text)) return "faq";
    if (!prevKinds.includes("hero") && (hasH1 || (prevKinds.every((k) => k === "navbar") && r.h > 280))) return "hero";
    if (media >= 4 && words < 40) return "logos";
    if (els.some((e) => e.querySelector("form,input,textarea"))) return /newsletter|subscribe/.test(text) ? "newsletter" : "contact";
    if (/feature|benefit|service/.test(cls) || /\bfeatures?\b/.test(text.slice(0, 300))) return "features";
    if (/\bstats?\b|numbers|metrics/.test(cls)) return "stats";
    if (words < 70 && els.some((e) => e.querySelector("a,button"))) return "cta";
    if (/blog|article|post/.test(cls)) return "blog";
    return "content";
  }

  function effectiveBg(el) {
    for (let cur = el; cur; cur = cur.parentElement) {
      const s = cs(cur);
      const bg = toHex(s.backgroundColor);
      if (bg && !(bg.length === 9 && bg.endsWith("00"))) return bg;
      if (s.backgroundImage && s.backgroundImage !== "none") return s.backgroundImage.includes("gradient") ? "gradient" : "image";
    }
    return "#ffffff";
  }

  function colsOf(el) {
    let best = 1;
    const queue = [[el, 0]];
    let seen = 0;
    while (queue.length && seen < 400) {
      const [cur, d] = queue.shift();
      seen++;
      const k = visibleKids(cur).filter((c) => rectOf(c).h >= 16 && rectOf(c).w >= 24);
      if (k.length >= 2) {
        const top = rectOf(k[0]).y;
        const row = k.filter((c) => Math.abs(rectOf(c).y - top) < 8).length;
        if (row > best && cur.tagName !== "NAV" && cur.tagName !== "UL") best = row;
      }
      if (d < 6) for (const c of k) queue.push([c, d + 1]);
    }
    return best;
  }

  // ---------- main ----------
  window.scrollTo(0, 0);
  let roots = collect(document.body, 0);
  if (!roots.length) roots = [document.body];
  let groups = roots.map((e) => [e]);
  if (groups.length > MAX_SECTIONS) {
    const head = groups.slice(0, MAX_SECTIONS - 1);
    const rest = groups.slice(MAX_SECTIONS - 1).flat();
    groups = [...head, rest];
  }

  const sections = [];
  const kinds = [];
  groups.forEach((els, i) => {
    budget = NODE_BUDGET;
    truncated = false;
    const id = "s" + i;
    els.forEach((e) => e.setAttribute("data-clone-sec", id));
    let node;
    if (els.length === 1) node = ser(els[0], 0, true);
    else node = { tag: "div", children: els.map((e) => ser(e, 1, false)).filter(Boolean) };
    if (!node || (!node.text && !(node.children && node.children.length) && !(node.style && node.style.bgImage))) return;
    const first = rectOf(els[0]);
    const last = rectOf(els[els.length - 1]);
    const rect = { x: first.x, y: first.y, w: Math.max(first.w, last.w), h: last.y + last.h - first.y };
    const kind = kindOf(els, i, groups.length, kinds);
    kinds.push(kind);
    const headingEl = els.map((e) => e.querySelector("h1,h2,h3")).find(Boolean);
    const sticky = els.some((e) => ["sticky", "fixed"].includes(cs(e).position) || [...e.querySelectorAll(":scope > *")].some((c) => ["sticky", "fixed"].includes(cs(c).position)));
    sections.push({
      id,
      kind,
      rect,
      fullBleed: rect.w >= vw - 24,
      sticky: kind === "navbar" && sticky,
      background: effectiveBg(els[0]),
      heading: headingEl ? headingEl.innerText.replace(/\s+/g, " ").trim().slice(0, 120) : (els[0].innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
      node,
      truncated,
      desktopCols: colsOf(els[0]),
      navLinksDesktop: els[0].querySelectorAll("a").length,
    });
  });

  // ---------- statistics for design tokens ----------
  const stats = { text: {}, bg: {}, button: {}, link: {}, border: {}, radius: {}, container: {} };
  const bump = (map, key, w) => {
    if (key) map[key] = (map[key] || 0) + w;
  };
  const all = document.body.querySelectorAll("*");
  const limit = Math.min(all.length, 6000);
  for (let i = 0; i < limit; i++) {
    const el = all[i];
    if (SKIP.has(el.tagName) || el.closest("svg")) continue;
    const s = cs(el);
    if (s.display === "none" || s.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const t = directText(el);
    if (t) bump(stats.text, toHex(s.color), t.length);
    const bg = toHex(s.backgroundColor);
    if (bg && bg.length === 7) bump(stats.bg, bg, (r.width * r.height) / 1000);
    const isButton = el.tagName === "BUTTON" || el.getAttribute("role") === "button" || (el.tagName === "A" && bg && px(s.paddingLeft) >= 8);
    if (isButton && bg && bg.length === 7) {
      bump(stats.button, bg, 1);
      bump(stats.radius, String(px(s.borderTopLeftRadius)), 1);
    }
    if (el.tagName === "A" && t) bump(stats.link, toHex(s.color), 1);
    if (px(s.borderTopWidth) || px(s.borderBottomWidth)) bump(stats.border, toHex(s.borderTopColor) || toHex(s.borderBottomColor), 1);
    if (s.maxWidth && s.maxWidth.endsWith("px")) {
      const mw = px(s.maxWidth);
      if (mw >= 640 && mw <= 1800) bump(stats.container, String(Math.round(mw)), 1);
    }
  }
  const headingEl = document.querySelector("h1") || document.querySelector("h2");
  const fonts = {
    body: bodyFont,
    heading: headingEl ? (cs(headingEl).fontFamily || "").split(",")[0].replace(/["']/g, "").trim() : bodyFont,
    bodyStack: cs(document.body).fontFamily,
  };
  const pageBg = toHex(cs(document.body).backgroundColor) || toHex(cs(document.documentElement).backgroundColor) || "#ffffff";

  return {
    title: document.title,
    description: (document.querySelector('meta[name="description"]') || {}).content || "",
    lang: document.documentElement.lang || "en",
    pageHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    viewport: { w: vw, h: vh },
    sections,
    assets,
    stats,
    fonts,
    pageBg,
  };
})(__OPTS__);
