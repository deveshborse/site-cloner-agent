// Studio front end: talks to the agent server (REST + Server-Sent Events). Plain JS, no build step.
const $ = (id) => document.getElementById(id);
const state = { slug: null, previewUrl: null, device: "desktop", tab: "preview", busy: false, source: null };

const CLONE_STAGES = [
  ["analyze", "Analyze website"],
  ["generate", "Generate components"],
  ["validate", "Validate & repair"],
  ["preview", "Local preview"],
  ["compare", "Score visual similarity"],
  ["refine", "Visual refinement"],
];
const MODIFY_STAGES = [
  ["plan", "Plan the edit"],
  ["apply", "Apply changes"],
  ["validate", "Validate & repair"],
];
const SUGGESTIONS = [
  "Change the primary color to blue",
  "Add a testimonials section",
  "Replace the hero section with a bakery hero",
  "Make the navbar sticky",
  "Remove the pricing section",
];
const DEVICES = { desktop: 1440, tablet: 768, mobile: 390 };

// ---------- helpers ----------
async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.style.cssText = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}
function log(message, level = "info") {
  const line = el("div", { class: level }, message);
  $("log").append(line);
  $("log").scrollTop = $("log").scrollHeight;
}
function usageLabel(u = {}) {
  const tokens = (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
  const cost = u.costUsd ? `$${u.costUsd.toFixed(4)} · ` : "";
  return `${cost}${u.calls ?? 0} AI calls · ${(tokens / 1000).toFixed(1)}k tokens${u.cachedCalls ? ` · ${u.cachedCalls} cached` : ""}`;
}
function setBusy(busy) {
  state.busy = busy;
  $("cloneBtn").disabled = busy;
  $("modifyBtn").disabled = busy;
  $("undoBtn").disabled = busy;
}

// ---------- pipeline stages ----------
function renderStages(stages) {
  $("stages").replaceChildren(...stages.map(([id, label]) => el("li", { "data-stage": id }, label)));
}
function markStage(stage) {
  let reached = false;
  const items = [...$("stages").children];
  const target = items.findIndex((li) => li.dataset.stage === stage);
  items.forEach((li, i) => {
    if (i < target) li.className = "done";
    else if (i === target) {
      li.className = "active";
      reached = true;
    }
  });
  return reached;
}
function finishStages(ok) {
  for (const li of $("stages").children) {
    if (li.className === "active") li.className = ok ? "done" : "failed";
  }
}

// ---------- analysis / sections ----------
function renderAnalysis(data) {
  $("analysisCard").hidden = false;
  const t = data.tokens;
  const swatches = ["primary", "background", "foreground", "muted", "surface", "border"].map((k) =>
    el("span", { class: "swatch", title: k }, el("i", { style: `background:${t[k]}` }), `${k} ${t[k]}`)
  );
  $("tokens").replaceChildren(...swatches);
  $("fonts").textContent = `Fonts: ${t.headingFont} / ${t.bodyFont} · radius ${t.radius} · ${data.assetCount} assets · ${data.sections.length} sections`;
  renderSections(data.sections.map((s) => ({ ...s, file: `components/${s.name}.tsx` })));
}
function renderSections(sections) {
  $("sections").replaceChildren(
    ...sections.map((s) => {
      const score = typeof s.score === "number" ? Math.round(s.score * 100) : null;
      const badge = s.source ? el("span", { class: `badge ${s.source === "fallback" ? "fallback" : ""}` }, s.source === "fallback" ? "deterministic" : s.source === "added" ? "added" : "AI") : el("span", { class: "badge fallback" }, s.kind);
      return el(
        "li",
        { "data-id": s.id },
        el("span", { class: "name" }, `${s.name}${score !== null ? ` · ${score}%` : ""}`),
        badge,
        el("span", { class: "meta" }, s.summary || `${s.kind}: ${s.heading || ""}`),
        score !== null ? el("div", { class: "bar" }, el("span", { style: `width:${score}%` })) : ""
      );
    })
  );
}
function renderManifest(m) {
  $("analysisCard").hidden = false;
  $("modifyCard").hidden = false;
  const t = m.tokens;
  $("tokens").replaceChildren(
    ...["primary", "background", "foreground", "muted", "surface", "border"].map((k) =>
      el("span", { class: "swatch", title: k }, el("i", { style: `background:${t[k]}` }), `${k} ${t[k]}`)
    )
  );
  $("fonts").textContent = `Fonts: ${t.headingFont} / ${t.bodyFont} · radius ${t.radius} · ${m.sections.length} sections · source ${m.sourceUrl}`;
  renderSections(m.sections);
  $("history").replaceChildren(...[...m.history].reverse().map((h) => el("li", { title: h.prompt }, h.summary)));
  $("costPill").textContent = usageLabel(m.usage);
  if (typeof m.similarity === "number") {
    $("scorePill").hidden = false;
    $("scorePill").textContent = `Similarity ${(m.similarity * 100).toFixed(1)}%`;
  }
}

// ---------- preview ----------
function layoutFrame() {
  const wrap = $("frameWrap");
  const frame = $("preview");
  const width = DEVICES[state.device];
  const avail = wrap.clientWidth - 32;
  const scale = Math.min(1, avail / width);
  frame.style.width = `${width}px`;
  frame.style.height = `${(wrap.clientHeight - 24) / scale}px`;
  frame.style.transform = `scale(${scale})`;
  frame.style.marginTop = "12px";
}
function showPreview(url) {
  state.previewUrl = url;
  $("emptyState").hidden = true;
  $("frameWrap").hidden = false;
  $("openLink").hidden = false;
  $("openLink").href = url;
  $("preview").src = `${url}/?t=${Date.now()}`;
  layoutFrame();
}
function refreshShots() {
  if (!state.slug) return;
  const suffix = state.device === "mobile" ? "mobile" : "desktop";
  $("shotOriginal").src = `/shots/${state.slug}/original-${suffix}.png?t=${Date.now()}`;
  $("shotClone").src = `/shots/${state.slug}/clone-${suffix}.png?t=${Date.now()}`;
}
async function loadFiles() {
  if (!state.slug) return;
  const files = await api(`/api/sites/${state.slug}/files`);
  $("fileList").replaceChildren(
    ...files.map((f) =>
      el("li", {
        onclick: async (e) => {
          [...$("fileList").children].forEach((li) => li.classList.remove("active"));
          e.currentTarget.classList.add("active");
          const res = await fetch(`/api/sites/${state.slug}/file?path=${encodeURIComponent(f)}`);
          $("codeView").firstChild.textContent = await res.text();
        },
      }, f)
    )
  );
}

// ---------- jobs ----------
function follow(jobId, kind) {
  state.source?.close();
  const source = new EventSource(`/api/jobs/${jobId}/events`);
  state.source = source;
  source.onmessage = async (msg) => {
    const e = JSON.parse(msg.data);
    switch (e.type) {
      case "stage":
        markStage(e.stage);
        log(`▸ ${e.message}`, "stage");
        break;
      case "log":
        log(e.message, e.level);
        break;
      case "analysis":
        if (e.data.plan) log(`Plan: ${JSON.stringify(e.data.plan)}`);
        else renderAnalysis(e.data);
        break;
      case "section": {
        const li = document.querySelector(`#sections li[data-id="${e.data.id}"] .badge`);
        if (li) {
          li.textContent = e.data.source === "fallback" ? "deterministic" : "AI";
          li.className = `badge ${e.data.source === "fallback" ? "fallback" : ""}`;
        }
        break;
      }
      case "preview":
        showPreview(e.url);
        break;
      case "score":
        $("scorePill").hidden = false;
        $("scorePill").textContent = `Similarity ${(e.data.overall * 100).toFixed(1)}%`;
        refreshShots();
        break;
      case "usage": {
        $("costPill").textContent = usageLabel(e.data.total ?? e.data);
        break;
      }
      case "done":
        finishStages(true);
        log(kind === "clone" ? "✔ Clone complete" : `✔ ${e.data.summary}`, "stage");
        source.close();
        setBusy(false);
        await openSite(state.slug, { keepLog: true });
        if (state.previewUrl) $("preview").src = `${state.previewUrl}/?t=${Date.now()}`;
        await refreshSiteList();
        break;
      case "failed":
        finishStages(false);
        log(`✖ ${e.message}`, "error");
        source.close();
        setBusy(false);
        if (state.previewUrl) $("preview").src = `${state.previewUrl}/?t=${Date.now()}`;
        break;
    }
  };
  source.onerror = () => {
    if (state.busy) log("Lost connection to the agent server", "warn");
  };
}

async function startClone(url) {
  setBusy(true);
  $("log").replaceChildren();
  renderStages(CLONE_STAGES);
  $("analysisCard").hidden = true;
  $("modifyCard").hidden = true;
  $("scorePill").hidden = true;
  try {
    const { jobId, slug } = await api("/api/clone", { method: "POST", body: JSON.stringify({ url }) });
    state.slug = slug;
    follow(jobId, "clone");
  } catch (err) {
    log(err.message, "error");
    setBusy(false);
  }
}

async function startModify(prompt) {
  if (!state.slug) return;
  setBusy(true);
  renderStages(MODIFY_STAGES);
  log(`— Edit: "${prompt}"`, "stage");
  try {
    const { jobId } = await api(`/api/sites/${state.slug}/modify`, { method: "POST", body: JSON.stringify({ prompt }) });
    follow(jobId, "modify");
  } catch (err) {
    log(err.message, "error");
    setBusy(false);
  }
}

async function openSite(slug, { keepLog = false } = {}) {
  state.slug = slug;
  const { manifest, previewUrl } = await api(`/api/sites/${slug}`);
  renderManifest(manifest);
  $("siteSelect").value = slug;
  if (!keepLog) {
    $("log").replaceChildren();
    renderStages([]);
    log(`Opened ${manifest.sourceUrl}`);
  }
  refreshShots();
  if (state.tab === "code") loadFiles();
  if (previewUrl) showPreview(previewUrl);
  else {
    log("Starting preview server…");
    const { url } = await api(`/api/sites/${slug}/preview`, { method: "POST" });
    showPreview(url);
  }
}

async function refreshSiteList() {
  const sites = await api("/api/sites");
  $("siteSelect").replaceChildren(
    el("option", { value: "" }, "Previous clones…"),
    ...sites.map((s) => el("option", { value: s.slug }, `${s.title || s.slug}${typeof s.similarity === "number" ? ` · ${Math.round(s.similarity * 100)}%` : ""}`))
  );
  if (state.slug) $("siteSelect").value = state.slug;
}

// ---------- wiring ----------
$("cloneForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!state.busy) startClone($("urlInput").value);
});
$("modifyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const prompt = $("promptInput").value.trim();
  if (prompt && !state.busy) startModify(prompt);
});
$("undoBtn").addEventListener("click", async () => {
  if (!state.slug || state.busy) return;
  try {
    const { manifest } = await api(`/api/sites/${state.slug}/undo`, { method: "POST" });
    renderManifest(manifest);
    log("↶ Reverted the last change", "stage");
    setTimeout(() => state.previewUrl && ($("preview").src = `${state.previewUrl}/?t=${Date.now()}`), 1500);
  } catch (err) {
    log(err.message, "warn");
  }
});
$("siteSelect").addEventListener("change", (e) => e.target.value && !state.busy && openSite(e.target.value).catch((err) => log(err.message, "error")));
$("reloadBtn").addEventListener("click", () => state.previewUrl && ($("preview").src = `${state.previewUrl}/?t=${Date.now()}`));
$("chips").append(...SUGGESTIONS.map((s) => el("button", { type: "button", onclick: () => ($("promptInput").value = s) }, s)));

document.querySelectorAll("[data-tab]").forEach((b) =>
  b.addEventListener("click", () => {
    state.tab = b.dataset.tab;
    document.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
    for (const p of ["preview", "compare", "code"]) $(`panel-${p}`).hidden = p !== state.tab;
    if (state.tab === "code") loadFiles();
    if (state.tab === "compare") refreshShots();
    if (state.tab === "preview") layoutFrame();
  })
);
document.querySelectorAll("[data-device]").forEach((b) =>
  b.addEventListener("click", () => {
    state.device = b.dataset.device;
    document.querySelectorAll("[data-device]").forEach((x) => x.classList.toggle("active", x === b));
    layoutFrame();
    refreshShots();
  })
);
new ResizeObserver(() => !$("frameWrap").hidden && layoutFrame()).observe($("panel-preview"));

(async function init() {
  renderStages(CLONE_STAGES);
  const status = await api("/api/status");
  $("modelPill").textContent = status.llm ? `AI: ${status.mainModel}` : "Offline mode (no API key)";
  $("modelPill").className = `pill ${status.llm ? "ok" : "warn"}`;
  await refreshSiteList();
})();
