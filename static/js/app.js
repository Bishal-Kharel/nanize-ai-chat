// app.js
/* ===== DOM utils ===== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ===== global state ===== */
const state = {
  threads: {},
  activeId: null,
  mode: null,
  autoscroll: true,
  streaming: false,
  _streamBlocks: null, // collect blocks during a stream
};
const LS_KEY = "ds_threads_v1";
const SS_EXPANDED = "ds_session_expanded";
const MAX_DOM_MESSAGES = 200;

/* ===== runtime config ===== */
const API_URL = window.APP_API_URL || "/api/ask";
const APP_DEFAULTS = Object.assign(
  { temperature: 0.7, top_p: 1.0 },
  window.APP_DEFAULTS || {}
);

/* ===== storage ===== */
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state.threads));
    } catch {}
  }, 200);
}
function load() {
  try {
    state.threads = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    state.threads = {};
  }
}
function uid() {
  if (crypto?.randomUUID) return crypto.randomUUID().slice(0, 12);
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return Array.from(a, (x) => x.toString(36))
      .join("")
      .slice(0, 12);
  } catch {
    return Math.random().toString(36).slice(2, 14);
  }
}
function nowISO() {
  return new Date().toISOString();
}

/* ===== migration ===== */
function migrateThreads() {
  const ids = Object.keys(state.threads || {});
  for (const id of ids) {
    const t = state.threads[id] || {};
    if (!t.id) t.id = id || uid();
    if (typeof t.title !== "string") t.title = "Untitled";
    if (!Array.isArray(t.messages)) t.messages = [];
    if (!t.createdAt && !t.updatedAt) t.createdAt = nowISO();
    state.threads[id] = t;
  }
  save();
}
function threadSortKey(t) {
  return (t && (t.updatedAt || t.createdAt)) || "";
}

/* ===== markdown (safe) ===== */
function mdToHtml(md) {
  const src = String(md || "");
  let esc = src
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const codeBlocks = [];
  esc = esc.replace(/```([\s\S]*?)```/g, (_, code) => {
    const i = codeBlocks.push(code) - 1;
    return `\uE000CODEBLOCK${i}\uE000`;
  });
  esc = esc
    .replace(/^### (.*)$/gim, "<h3>$1</h3>")
    .replace(/^## (.*)$/gim, "<h2>$1</h2>")
    .replace(/^# (.*)$/gim, "<h1>$1</h1>");
  // bullet lists
  esc = esc.replace(/(?:^|\n)(- .*(?:\n- .*)+)(?=\n|$)/g, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((l) => l.replace(/^- /, "").trim());
    return `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
  });
  // emphasis, inline code, links
  esc = esc
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    .replace(/\*(.*?)\*/g, "<i>$1</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      `<a href="$2" target="_blank" rel="nofollow noopener">$1</a>`
    );
  // pipe tables
  esc = esc.replace(/(?:^|\n)((?:\|.*\|\r?\n)+)(?:\r?\n|$)/g, (block) => {
    const lines = block
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length < 2) return block;
    const header = lines[0],
      sep = lines[1];
    if (!/^\|?(\s*:?-{3,}:?\s*\|)+\s*$/.test(sep)) return block;
    const cells = (line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
    const thead = cells(header);
    const rows = lines.slice(2).map(cells);
    const ths = thead.map((h) => `<th>${h}</th>`).join("");
    const trs = rows
      .map((r) => `<tr>${r.map((v) => `<td>${v || ""}</td>`).join("")}</tr>`)
      .join("");
    return `<table class="ai-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  });
  // paragraphs
  esc = esc
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/^/, "<p>")
    .replace(/$/, "</p>")
    .replace(/\n/g, "<br/>");
  // restore fenced code
  esc = esc.replace(/\uE000CODEBLOCK(\d+)\uE000/g, (_, n) => {
    const code = (codeBlocks[Number(n)] || "")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre><code>${code}</code></pre>`;
  });
  return esc;
}

/* ===== AI narrative guard: strip leaked HTML (table-ish) ===== */
function stripAiHtml(s) {
  if (!s) return s;
  s = s.replace(/<style[\s\S]*?<\/style>/gi, "");
  s = s.replace(/<div[^>]*class=["']?nx-compare[^>]*>[\s\S]*?<\/div>/gi, "");
  s = s.replace(/<table[\s\S]*?<\/table>/gi, "");
  s = s.replace(/<div[^>]*role=["']table["'][\s\S]*?<\/div>/gi, "");
  s = s.replace(
    /<div[^>]*role=["'](?:rowgroup|row|cell|columnheader|rowheader)["'][^>]*>[\s\S]*?<\/div>/gi,
    ""
  );
  s = s.replace(/<(iframe|script)[\s\S]*?<\/\1>/gi, "");
  return s;
}

/* ===== simple HTML sanitizer for tool-rendered HTML ===== */
function sanitizeHtml(html) {
  const allowedTags = new Set([
    "STYLE",
    "DIV",
    "SPAN",
    "P",
    "B",
    "I",
    "UL",
    "LI",
    "CODE",
    "PRE",
    "H1",
    "H2",
    "H3",
    "TABLE",
    "THEAD",
    "TBODY",
    "TR",
    "TH",
    "TD",
    "FIGURE",
    "IMG",
    "FIGCAPTION",
    "A",
  ]);
  const allowedAttrs = new Set([
    "class",
    "role",
    "style",
    "href",
    "target",
    "rel",
    "src",
    "alt",
    "aria-label",
    "aria-live",
    "aria-role",
  ]);
  const tmp = document.createElement("div");
  tmp.innerHTML = html || "";
  const walker = document.createTreeWalker(tmp, NodeFilter.SHOW_ELEMENT, null);
  const toRemove = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!allowedTags.has(el.tagName)) {
      toRemove.push(el);
      continue;
    }
    [...el.attributes].forEach((a) => {
      const n = a.name.toLowerCase();
      if (!allowedAttrs.has(a.name)) el.removeAttribute(a.name);
      if (
        (n === "href" || n === "src") &&
        /^(javascript:|data:)/i.test(a.value || "")
      )
        el.removeAttribute(a.name);
    });
  }
  toRemove.forEach((n) =>
    n.replaceWith(document.createTextNode(n.textContent || ""))
  );
  return tmp.innerHTML;
}

/* ===== dynamic libs ===== */
const libCache = {};
function loadScript(src) {
  if (libCache[src]) return libCache[src];
  libCache[src] = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error("Failed " + src));
    document.head.appendChild(s);
  });
  return libCache[src];
}
async function ensureVegaLite() {
  if (window.vegaEmbed) return;
  await loadScript("https://cdn.jsdelivr.net/npm/vega@5/build/vega.min.js");
  await loadScript(
    "https://cdn.jsdelivr.net/npm/vega-lite@5/build/vega-lite.min.js"
  );
  await loadScript(
    "https://cdn.jsdelivr.net/npm/vega-embed@6/build/vega-embed.min.js"
  );
}
async function ensureMermaid() {
  if (window.mermaid) return;
  await loadScript(
    "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"
  );
  window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
}
async function ensureLottie() {
  if (window.lottie) return;
  await loadScript(
    "https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"
  );
}

/* ===== layout ===== */
function showHeroBg(show) {
  $("#heroBg") && ($("#heroBg").style.display = show ? "block" : "none");
}
function updateComposerHeightVar() {
  const el = $("#composer");
  const h = el ? el.offsetHeight : 120;
  document.documentElement.style.setProperty("--composerH", `${h}px`);
  layoutMessages();
}
function layoutMessages() {
  const msgs = $("#messages");
  if (!msgs) return;
  const composer = $("#composer");
  const ch = composer ? composer.offsetHeight : 120;
  const rect = msgs.getBoundingClientRect();
  const avail = Math.max(
    220,
    Math.floor(window.innerHeight - ch - 24 - rect.top)
  );
  msgs.style.height = avail + "px";
}
function isNearBottom(el, px = 80) {
  return el.scrollHeight - (el.scrollTop + el.clientHeight) <= px;
}
function scrollBottom() {
  const c = $("#messages");
  if (c) c.scrollTop = c.scrollHeight;
}
function positionComposer() {
  const main = $("#main");
  if (!main) return;
  const r = main.getBoundingClientRect();
  document.documentElement.style.setProperty(
    "--composerCenter",
    `${r.left + r.width / 2}px`
  );
}

/* ===== UI helpers ===== */
function setHeroVisible(v) {
  $("#hero")?.classList.toggle("hidden", !v);
  $("#chat")?.classList.toggle("hidden", v);
  $("#threadTitleChip")?.classList.toggle("hidden", v);
  showHeroBg(v);
  layoutMessages();
  positionComposer();
}
function setSendEnabled() {
  const i = $("#composerInput"),
    b = $("#sendBtn");
  if (i && b) b.disabled = state.streaming || !i.value.trim();
}
function setActivePill(btn) {
  $$(".pill").forEach((b) => b.classList.remove("active"));
  if (btn) {
    btn.classList.add("active");
    state.mode = btn.id === "deepthinkBtn" ? "deepthink" : "search";
  } else state.mode = null;
}
function setSidebarOpen(open) {
  $("#sidebar")?.classList.toggle("open", open);
  const fab = $("#sidebarOpenFloat");
  if (fab) fab.style.display = open ? "none" : "inline-flex";
  const comp = $("#composer");
  if (comp) {
    comp.classList.remove("animate");
    void comp.offsetWidth;
    comp.classList.add("animate");
  }
  positionComposer();
}

/* ===== history ===== */
function renderSidebar() {
  const all = Object.values(state.threads).sort((a, b) =>
    threadSortKey(b).localeCompare(threadSortKey(a))
  );
  const todayList = $("#todayList"),
    yList = $("#yesterdayList");
  if (!todayList || !yList) return;
  todayList.innerHTML = "";
  yList.innerHTML = "";
  const today = new Date().toDateString();
  for (const t of all) {
    const created = t.createdAt || t.updatedAt || "";
    const d = created ? new Date(created).toDateString() : "Unknown";
    const li = document.createElement("li");
    li.innerHTML = `<div class="thread-item" data-id="${
      t.id
    }"><span class="title">${
      t.title || "Untitled"
    }</span><button class="del" title="Delete">🗑</button></div>`;
    (d === today ? todayList : yList).appendChild(li);
    const row = $(".thread-item", li);
    if (t.id === state.activeId) row.classList.add("active");
    row.addEventListener("click", (e) => {
      if (e.target.closest(".del")) return;
      activateThread(t.id, true);
    });
    $(".del", row).addEventListener("click", (e) => {
      e.stopPropagation();
      deleteThread(t.id);
    });
  }
  $("#sidebarScroll") && ($("#sidebarScroll").scrollTop = 0);
}
function deleteThread(id) {
  const ids = Object.keys(state.threads);
  const idx = ids.indexOf(id);
  delete state.threads[id];
  save();
  if (state.activeId === id) {
    const nextId = ids[idx + 1] || ids[idx - 1];
    if (nextId && state.threads[nextId]) {
      state.activeId = nextId;
      const m = $("#messages");
      if (m) m.innerHTML = "";
      for (const msg of state.threads[nextId].messages)
        appendMessage(msg.role, msg.content, false, msg.kind);
      const chip = $("#threadTitleChip");
      if (chip) chip.textContent = state.threads[nextId].title || "";
    } else {
      newThread();
      activateThread(state.activeId, true);
    }
  }
  renderSidebar();
}
function newThread() {
  const id = uid();
  state.threads[id] = {
    id,
    title: "New chat",
    createdAt: nowISO(),
    messages: [],
    mode: null,
  };
  state.activeId = id;
  save();
  renderSidebar();
}
function activateThread(id, renderMessages = false) {
  state.activeId = id;
  const container = $("#messages");
  if (container) container.innerHTML = "";
  if (renderMessages) {
    const t = state.threads[id];
    for (const m of t.messages) appendMessage(m.role, m.content, false, m.kind);
    const chip = $("#threadTitleChip");
    if (chip) chip.textContent = t.title || "";
  }
  renderSidebar();
  setTimeout(() => {
    updateComposerHeightVar();
    scrollBottom();
    positionComposer();
  }, 20);
}

/* ===== renderers ===== */
function createAssistantNode() {
  const tpl = $("#tpl-assistant");
  const node = tpl?.content?.firstElementChild
    ? tpl.content.firstElementChild.cloneNode(true)
    : Object.assign(document.createElement("div"), {
        className: "msg assistant",
      });
  const body = $(".msg-body", node) || node;
  body.setAttribute("role", "status");
  body.setAttribute("aria-live", "polite");
  return { node, body };
}
function createUserNode(text) {
  const tpl = $("#tpl-user");
  const node = tpl?.content?.firstElementChild
    ? tpl.content.firstElementChild.cloneNode(true)
    : Object.assign(document.createElement("div"), { className: "msg user" });
  const body = $(".msg-body", node) || node;
  body.textContent = text || "";
  return { node, body };
}
function renderMarkdown(body, md) {
  body.innerHTML = mdToHtml(md || "");
}

/* ===== dynamic compaction ===== */
function compactBlocks(container) {
  if (!container) return;
  const blocks = Array.from(container.querySelectorAll(".block"));
  for (let i = 0; i < blocks.length; i++) {
    const cur = blocks[i],
      nxt = blocks[i + 1];
    if (!cur) continue;
    cur.style.margin = "0"; // margins disabled; flex gap handles rhythm
    if (cur.classList.contains("html") && nxt?.classList.contains("animation"))
      nxt.style.margin = "0";
  }
}

/* charts / diagrams / media helpers */
async function renderVegaLite(container, spec) {
  await ensureVegaLite();
  const div = document.createElement("div");
  div.className = "block chart vega";
  container.appendChild(div);
  await window.vegaEmbed(
    div,
    Object.assign({ width: "container" }, spec || {}),
    { actions: false }
  );
  // embed outputs an inline SVG → kill baseline gap
  const svg = div.querySelector("svg");
  if (svg) {
    svg.style.display = "block";
    svg.style.verticalAlign = "top";
  }
  compactBlocks(container);
}
async function renderMermaid(container, code) {
  await ensureMermaid();
  const div = document.createElement("div");
  div.className = "block diagram mermaid";
  container.appendChild(div);
  try {
    const { svg } = await window.mermaid.render(
      `m_${uid()}`,
      code || "flowchart LR; A-->B;"
    );
    div.innerHTML = svg;
    const s = div.querySelector("svg");
    if (s) {
      s.style.display = "block";
      s.style.verticalAlign = "top";
    }
  } catch {
    div.textContent = "Diagram render error";
  }
  compactBlocks(container);
}
async function renderLottie(container, json, data = {}, controls = {}) {
  await ensureLottie();
  const div = document.createElement("div");
  div.className = "block animation lottie";
  div.style.width = "100%";
  div.style.maxWidth = "480px";
  div.style.minHeight = "0";
  div.style.margin = "0";
  div.style.overflow = "hidden";
  container.appendChild(div);

  const anim = window.lottie.loadAnimation({
    container: div,
    renderer: "svg",
    loop: controls.loop !== false,
    autoplay: controls.autoplay !== false,
    animationData: json || {},
  });
  anim.setSpeed(Number(controls.speed || 1));

  anim.addEventListener("DOMLoaded", () => {
    const svg = div.querySelector("svg");
    if (svg) {
      svg.style.display = "block";
      svg.style.verticalAlign = "top";
    }
    const h = svg ? Math.ceil(svg.getBoundingClientRect().height || 36) : 36;
    div.style.height = Math.max(28, Math.min(56, h)) + "px";
    compactBlocks(container);
  });
  return anim;
}
function renderImage(container, url, alt) {
  const fig = document.createElement("figure");
  fig.className = "block image";
  const img = document.createElement("img");
  img.src = url;
  img.alt = alt || "";
  img.style.maxWidth = "100%";
  img.loading = "lazy";
  fig.appendChild(img);
  if (alt) {
    const cap = document.createElement("figcaption");
    cap.textContent = alt;
    fig.appendChild(cap);
  }
  container.appendChild(fig);
  compactBlocks(container);
}
function renderTable(container, columns, rows) {
  const wrap = document.createElement("div");
  wrap.className = "block table";
  const table = document.createElement("table");
  table.className = "ai-table";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  (columns || []).forEach((c) => {
    const th = document.createElement("th");
    th.textContent = c;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  (rows || []).forEach((r) => {
    const tr = document.createElement("tr");
    (r || []).forEach((v) => {
      const td = document.createElement("td");
      td.textContent = typeof v === "object" ? JSON.stringify(v) : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);
  compactBlocks(container);
}

/* ===== blocks persistence helpers ===== */
function toolToBlock(tool) {
  const { name, args = {} } = tool || {};
  if (!name) return null;
  if (name === "render_table")
    return {
      type: "table",
      columns: args.columns || [],
      rows: args.rows || [],
      caption: args.caption,
    };
  if (name === "render_chart")
    return {
      type: "chart",
      lib: "vega-lite",
      spec: args.vegalite_spec,
      title: args.title,
    };
  if (name === "render_mermaid")
    return { type: "diagram", lib: "mermaid", code: args.code };
  if (name === "render_image")
    return { type: "image", url: args.url, alt: args.alt };
  if (name === "render_html")
    return {
      type: "html",
      html: sanitizeHtml(args.html || ""),
      data: args.data,
    };
  if (name === "render_lottie")
    return {
      type: "animation",
      lib: "lottie",
      json: args.json,
      data: args.data,
      controls: args.controls,
      title: args.title,
    };
  return { type: "unknown", raw: tool };
}

/* ===== render blocks ===== */
async function renderBlocksInto(body, blocks) {
  body.innerHTML = "";
  const container = document.createElement("div");
  container.className = "ai-blocks";
  body.appendChild(container);
  for (const blk of blocks || []) {
    const t = blk?.type;
    if (t === "text") {
      const div = document.createElement("div");
      div.className = "block text";
      div.innerHTML = mdToHtml(blk.content || "");
      container.appendChild(div);
    } else if (t === "chart" && blk.lib === "vega-lite") {
      await renderVegaLite(container, blk.spec);
      if (blk.title) {
        const cap = document.createElement("div");
        cap.className = "block caption";
        cap.innerHTML = mdToHtml(`**${blk.title}**`);
        container.appendChild(cap);
      }
    } else if (t === "diagram" && blk.lib === "mermaid") {
      await renderMermaid(container, blk.code);
    } else if (t === "animation" && blk.lib === "lottie") {
      await renderLottie(container, blk.json, blk.data, blk.controls);
      // no caption to avoid extra space
    } else if (t === "image") {
      renderImage(container, blk.url, blk.alt);
    } else if (t === "table") {
      renderTable(container, blk.columns || [], blk.rows || []);
      if (blk.caption) {
        const cap = document.createElement("div");
        cap.className = "block caption";
        cap.innerHTML = mdToHtml(`**${blk.caption}**`);
        container.appendChild(cap);
      }
    } else if (t === "html") {
      const card = document.createElement("div");
      card.className = "block html";
      card.innerHTML = sanitizeHtml(blk.html || "");
      container.appendChild(card);
    } else {
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(blk, null, 2);
      container.appendChild(pre);
    }
  }
  compactBlocks(container);
}

/* ===== messages ===== */
function titleFrom(text) {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (!t) return "New chat";
  const words = t.split(" ");
  const short = words.slice(0, 12).join(" ");
  return short.length < t.length ? short + "…" : short;
}
function appendMessage(role, content, push = true, kind) {
  kind = kind || (content && content.blocks ? "blocks" : "text");
  const list = $("#messages");
  if (!list) return { node: null, body: null };
  let node, body;
  if (role === "assistant") {
    ({ node, body } = createAssistantNode());
    if (kind === "blocks" && content && content.blocks)
      renderBlocksInto(body, content.blocks);
    else renderMarkdown(body, typeof content === "string" ? content : "");
  } else {
    ({ node, body } = createUserNode(
      typeof content === "string" ? content : ""
    ));
  }
  list.appendChild(node);
  while (list.children.length > MAX_DOM_MESSAGES)
    list.removeChild(list.firstChild);
  hookMessageTools(node, role, body, kind);
  if (push) {
    const th = state.threads[state.activeId];
    th.messages.push({ role, content, kind });
    th.updatedAt = nowISO();
    save();
  }
  if (state.autoscroll) list.scrollTop = list.scrollHeight;
  return { node, body };
}
function hookMessageTools(node, role, body) {
  const copyBtn = $(".tool-copy", node);
  if (copyBtn)
    copyBtn.onclick = async () => {
      const t =
        role === "assistant" ? body.innerText || "" : body.textContent || "";
      try {
        await navigator.clipboard.writeText(t);
        toast("Copied");
      } catch {
        toast("Copy failed");
      }
    };
}

/* ===== toast ===== */
let toastTimer = null;
function toast(msg) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = "toast show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1500);
}

/* ===== SSE ===== */
async function* sseStream(url, body, signal) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body || {}),
    signal,
  });
  if (!res.ok || !res.body) throw new Error("Request failed");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = { text: data };
      }
      yield { event, data: parsed };
    }
  }
}

/* ===== tool dispatcher ===== */
async function handleTool(tool, bodyEl) {
  const { name, args } = tool || {};
  if (!name || !bodyEl) return;
  let container = bodyEl.querySelector(".ai-blocks");
  if (!container) {
    container = document.createElement("div");
    container.className = "ai-blocks";
    bodyEl.appendChild(container);
  }

  const hasLinksCard = !!bodyEl.querySelector(".block.html"); // optional pairing for Lottie

  if (name === "render_table") {
    renderTable(container, args?.columns || [], args?.rows || []);
    if (args?.caption) {
      const cap = document.createElement("div");
      cap.className = "block caption";
      cap.innerHTML = mdToHtml(`**${args.caption}**`);
      container.appendChild(cap);
    }
  } else if (name === "render_chart") {
    await ensureVegaLite();
    const div = document.createElement("div");
    div.className = "block chart vega";
    container.appendChild(div);
    await window.vegaEmbed(
      div,
      Object.assign({ width: "container" }, args?.vegalite_spec || {}),
      { actions: false }
    );
    const svg = div.querySelector("svg");
    if (svg) {
      svg.style.display = "block";
      svg.style.verticalAlign = "top";
    }
  } else if (name === "render_mermaid") {
    await renderMermaid(container, args?.code || "flowchart LR; A-->B;");
  } else if (name === "render_image") {
    renderImage(container, args?.url || "", args?.alt || "");
  } else if (name === "render_html") {
    const card = document.createElement("div");
    card.className = "block html";
    card.innerHTML = sanitizeHtml(args?.html || "");
    container.appendChild(card);
  } else if (name === "render_lottie") {
    if (!hasLinksCard) return; // optional guard
    await renderLottie(
      container,
      args?.json || {},
      args?.data || {},
      args?.controls || {}
    );
  } else {
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(tool, null, 2);
    container.appendChild(pre);
  }

  compactBlocks(container);

  const blk = toolToBlock(tool);
  if (blk && state._streamBlocks) state._streamBlocks.push(blk);
}

/* ===== send ===== */
async function sendPrompt(text) {
  if (state.streaming) {
    toast("Busy");
    return;
  }
  exitCompactOnce();
  if (!state.threads[state.activeId]) newThread();

  if (state.threads[state.activeId].messages.length === 0) {
    const pretty = titleFrom(text);
    const chip = $("#threadTitleChip");
    if (chip) chip.textContent = pretty;
    state.threads[state.activeId].title = pretty;
    save();
    renderSidebar();
  }

  appendMessage("user", text, true, "text");
  const ci = $("#composerInput");
  if (ci) {
    ci.value = "";
    ci.style.height = "28px";
  }
  state.streaming = true;
  state._streamBlocks = [];
  setSendEnabled();
  updateComposerHeightVar();

  const { body } = appendMessage("assistant", "", false, "text");
  if (body)
    body.innerHTML = `<div class="thinking"><span>Thinking</span><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;

  let acc = "";
  let usedBlocks = false;
  let gotFinalBlocks = null;
  const renderBuf = [];
  let frameScheduled = false;

  function scheduleRender() {
    const container = $("#messages");
    if (!frameScheduled) {
      frameScheduled = true;
      requestAnimationFrame(() => {
        frameScheduled = false;
        if (!renderBuf.length) return;
        acc += renderBuf.join("");
        renderBuf.length = 0;
        body.innerHTML = mdToHtml(stripAiHtml(acc));
        if (container) state.autoscroll = isNearBottom(container);
        if (state.autoscroll && container)
          container.scrollTop = container.scrollHeight;
      });
    }
  }

  const container = $("#messages");
  const ctrl = new AbortController();

  try {
    for await (const evt of sseStream(
      API_URL,
      {
        prompt: text,
        temperature: APP_DEFAULTS.temperature,
        top_p: APP_DEFAULTS.top_p,
      },
      ctrl.signal
    )) {
      if (evt.event === "token" && typeof evt.data?.text === "string") {
        const t = evt.data.text || "";
        if (/<style|<table|role=["']table["']|class=["']?nx-compare/i.test(t))
          continue;
        if (!acc) body.innerHTML = "";
        renderBuf.push(t);
        scheduleRender();
        continue;
      }
      if (evt.event === "tool" && evt.data?.name) {
        usedBlocks = true;
        await handleTool(evt.data, body);
        if (state.autoscroll && container)
          container.scrollTop = container.scrollHeight;
        continue;
      }
      if (evt.event === "final") {
        const hasBlocks = Array.isArray(evt.data?.blocks);
        if (hasBlocks) {
          usedBlocks = true;
          gotFinalBlocks = evt.data.blocks;
          await renderBlocksInto(body, gotFinalBlocks);
          if (state.autoscroll && container)
            container.scrollTop = container.scrollHeight;
        } else if (typeof evt.data?.text === "string") {
          if (renderBuf.length) {
            acc += renderBuf.join("");
            renderBuf.length = 0;
          }
          acc = stripAiHtml(evt.data.text);
          body.innerHTML = mdToHtml(acc);
          if (state.autoscroll && container)
            container.scrollTop = container.scrollHeight;
        }
        continue;
      }
      if (evt.event === "message" && Array.isArray(evt.data?.blocks)) {
        usedBlocks = true;
        gotFinalBlocks = evt.data.blocks;
        await renderBlocksInto(body, gotFinalBlocks);
        if (state.autoscroll && container)
          container.scrollTop = container.scrollHeight;
        continue;
      }
      if (evt.event === "done") break;
      if (evt.data?.text) {
        if (!acc) body.innerHTML = "";
        renderBuf.push(evt.data.text);
        scheduleRender();
      }
    }
  } catch {
    acc = acc || "_Error: failed to get response._";
    if (body) body.innerHTML = mdToHtml(acc);
  } finally {
    ctrl.abort();
    const th = state.threads[state.activeId];
    if (usedBlocks || (gotFinalBlocks && gotFinalBlocks.length)) {
      const blocks = [];
      if (acc) blocks.push({ type: "text", content: acc });
      if (state._streamBlocks && state._streamBlocks.length)
        blocks.push(...state._streamBlocks);
      if (gotFinalBlocks && gotFinalBlocks.length)
        blocks.push(...gotFinalBlocks);
      th.messages.push({
        role: "assistant",
        content: { blocks },
        kind: "blocks",
      });
    } else {
      if (renderBuf.length) {
        acc += renderBuf.join("");
        renderBuf.length = 0;
      }
      th.messages.push({ role: "assistant", content: acc, kind: "text" });
    }
    state._streamBlocks = null;
    th.updatedAt = nowISO();
    save();
    renderSidebar();
    scrollBottom();
    state.streaming = false;
    setSendEnabled();
  }
}

/* ===== first-send expansion ===== */
function exitCompactOnce() {
  if (sessionStorage.getItem(SS_EXPANDED) === "1") return;
  newThread();
  setHeroVisible(false);
  setSidebarOpen(true);
  activateThread(state.activeId, true);
  requestAnimationFrame(() => {
    document.body.classList.remove("compact");
  });
  sessionStorage.setItem(SS_EXPANDED, "1");
  updateComposerHeightVar();
  positionComposer();
}

/* ===== events ===== */
const ci = $("#composerInput");
ci?.addEventListener("input", () => {
  ci.style.height = "auto";
  ci.style.height = Math.min(ci.scrollHeight, 160) + "px";
  setSendEnabled();
  updateComposerHeightVar();
});
ci?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#sendBtn")?.click();
  }
});
$("#sendBtn")?.addEventListener("click", () => {
  const text = $("#composerInput")?.value.trim();
  if (!text) return;
  sendPrompt(text);
});
$("#sidebarCloseBtn")?.addEventListener("click", () => setSidebarOpen(false));
$("#sidebarOpenBtn")?.addEventListener("click", () => setSidebarOpen(true));
$("#sidebarOpenFloat")?.addEventListener("click", () => setSidebarOpen(true));
$("#newChatBtn")?.addEventListener("click", () => {
  newThread();
  if (sessionStorage.getItem(SS_EXPANDED) === "1")
    activateThread(state.activeId, true);
});

/* ===== init ===== */
(function init() {
  load();
  migrateThreads();

  // spacing + baseline-gap fixes + table theme
  const style = document.createElement("style");
  style.textContent = `
    .ai-blocks{display:flex;flex-direction:column;row-gap:6px}
    .ai-blocks .block{margin:0}
    .ai-blocks .block.animation.lottie{line-height:0;overflow:hidden}
    .ai-blocks .block.animation.lottie svg{display:block;height:auto;vertical-align:top}
    .chart.vega svg, .diagram.mermaid svg{display:block;vertical-align:top}
    .ai-blocks .block p{margin:6px 0}
    .ai-table{border-collapse:separate;border:1px solid #e6edf7;border-radius:10px;overflow:hidden}
    .ai-table thead th{background:#f6f9ff;text-align:left}
  `;
  document.head.appendChild(style);

  const ids = Object.keys(state.threads);
  state.activeId = ids.length ? ids[0] : null;

  sessionStorage.removeItem(SS_EXPANDED);
  document.body.classList.add("compact");
  setHeroVisible(true);
  setSidebarOpen(false);
  renderSidebar();
  updateComposerHeightVar();
  positionComposer();

  window.addEventListener("resize", () => {
    updateComposerHeightVar();
    positionComposer();
  });
  const composerEl = $("#composer");
  if (composerEl)
    new ResizeObserver(() => {
      updateComposerHeightVar();
      positionComposer();
    }).observe(composerEl);
  const msgs = $("#messages");
  msgs?.addEventListener("scroll", () => {
    if (!msgs) return;
    state.autoscroll = isNearBottom(msgs);
  });
  setSendEnabled();
})();
