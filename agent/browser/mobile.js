// Runs inside the page after the viewport is resized to a phone width. It re-measures the sections marked by
// extract.js (data-clone-sec) so the generator knows how the layout changes responsively.
(function () {
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && r.right > 0 && r.left < window.innerWidth + 2;
  };
  const kids = (el) => [...el.children].filter((c) => visible(c) && c.getBoundingClientRect().height >= 16 && c.getBoundingClientRect().width >= 24);

  function colsOf(el) {
    let best = 1;
    const queue = [[el, 0]];
    let seen = 0;
    while (queue.length && seen < 400) {
      const [cur, d] = queue.shift();
      seen++;
      const k = kids(cur);
      if (k.length >= 2) {
        const top = rectOf(k[0]).y;
        const row = k.filter((c) => Math.abs(rectOf(c).y - top) < 8).length;
        if (row > best && cur.tagName !== "NAV" && cur.tagName !== "UL") best = row;
      }
      if (d < 6) for (const c of k) queue.push([c, d + 1]);
    }
    return best;
  }

  const out = {};
  const groups = {};
  document.querySelectorAll("[data-clone-sec]").forEach((el) => {
    const id = el.getAttribute("data-clone-sec");
    (groups[id] = groups[id] || []).push(el);
  });
  for (const [id, els] of Object.entries(groups)) {
    const first = rectOf(els[0]);
    const last = rectOf(els[els.length - 1]);
    const links = els.reduce((n, e) => n + [...e.querySelectorAll("a")].filter((a) => visible(a) && a.innerText.trim()).length, 0);
    const menuButton = els.some((e) =>
      [...e.querySelectorAll("button,[role=button],a")].some((b) => {
        if (!visible(b)) return false;
        const label = ((b.getAttribute("aria-label") || "") + " " + (b.className && typeof b.className === "string" ? b.className : "")).toLowerCase();
        const r = b.getBoundingClientRect();
        return /menu|hamburger|toggle|burger|navigation/.test(label) || (!b.innerText.trim() && r.width < 64 && r.height < 64 && b.querySelector("svg,span,i"));
      })
    );
    out[id] = {
      rect: { x: first.x, y: first.y, w: Math.max(first.w, last.w), h: last.y + last.h - first.y },
      cols: colsOf(els[0]),
      navLinks: links,
      menuButton,
    };
  }
  return out;
})();
