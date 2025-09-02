/* ===== DOM utils ===== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = { threads: {}, activeId: null, mode: null, autoscroll: true };
const LS_KEY = "ds_threads_v1";
const SS_EXPANDED = "ds_session_expanded";

/* ===== storage ===== */
function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state.threads));
  } catch {}
}
function load() {
  try {
    state.threads = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    state.threads = {};
  }
}
function uid() {
  return Math.random().toString(36).slice(2, 10);
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

/* ===== markdown mini-renderer ===== */
function mdToHtml(md) {
  const esc = String(md || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(/^### (.*$)/gim, "<h3>$1</h3>")
    .replace(/^## (.*$)/gim, "<h2>$1</h2>")
    .replace(/^# (.*$)/gim, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/gim, "<b>$1</b>")
    .replace(/^- (.*)$/gim, "<ul><li>$1</li></ul>")
    .replace(/\n{2,}/g, "\n\n")
    .replace(/\n/g, "<br/>");
}

/* ===== dynamic script loaders ===== */
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
async function ensurePlotly() {
  if (window.Plotly) return;
  await loadScript("https://cdn.plot.ly/plotly-latest.min.js");
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

/* ===== Hero background visibility + selection ===== */
function showHeroBg(show) {
  const el = $("#heroBg");
  if (!el) return;
  el.style.display = show ? "block" : "none";
  if (show) pickHeroVideo();
}
function pickHeroVideo() {
  const land = $("#bgLandscape"),
    p1 = $("#bgPortrait1"),
    p2 = $("#bgPortrait2");
  if (!land || !p1 || !p2) return;
  const isSmall = window.matchMedia("(max-width: 980px)").matches;
  const isPortrait = window.matchMedia("(orientation: portrait)").matches;
  if (!isSmall) {
    [land, p1, p2].forEach((el) => (el.style.display = "block"));
    return;
  }
  [land, p1, p2].forEach((el) => (el.style.display = "none"));
  (isPortrait ? (Math.random() < 0.5 ? p1 : p2) : land).style.display = "block";
}

/* ===== layout + scrolling ===== */
function updateComposerHeightVar() {
  const el = $("#composer");
  const h = el ? el.offsetHeight : 120;
  document.documentElement.style.setProperty("--composerH", `${h}px`);
  layoutMessages();
}
function layoutMessages() {
  const msgs = $("#messages");
  if (!msgs) return;
  const composerH = $("#composer")?.offsetHeight || 120;
  const rect = msgs.getBoundingClientRect();
  const available = Math.max(
    220,
    Math.floor(window.innerHeight - composerH - 24 - rect.top)
  );
  msgs.style.height = available + "px";
}
function isNearBottom(el, px = 80) {
  return el.scrollHeight - (el.scrollTop + el.clientHeight) <= px;
}
function scrollBottom() {
  const c = $("#messages");
  if (c) c.scrollTop = c.scrollHeight;
}

/* anchor composer to MAIN center */
function positionComposer() {
  const main = $("#main");
  if (!main) return;
  const r = main.getBoundingClientRect();
  document.documentElement.style.setProperty(
    "--composerCenter",
    `${r.left + r.width / 2}px`
  );
}

/* ===== high-level UI helpers ===== */
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
  if (i && b) b.disabled = !i.value.trim();
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

/* ===== sidebar + history ===== */
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
    li.innerHTML = `
      <div class="thread-item" data-id="${t.id}">
        <span class="title">${t.title || "Untitled"}</span>
        <button class="del" title="Delete">🗑</button>
      </div>`;
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
  if ($("#sidebarScroll")) $("#sidebarScroll").scrollTop = 0;
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

/* ===== block renderers ===== */
function createAssistantNode() {
  const tpl = $("#tpl-assistant");
  const node = tpl?.content?.firstElementChild
    ? tpl.content.firstElementChild.cloneNode(true)
    : Object.assign(document.createElement("div"), {
        className: "msg assistant",
      });
  const body = $(".msg-body", node) || node;
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

async function renderPlotly(container, spec) {
  await ensurePlotly();
  const div = document.createElement("div");
  div.className = "block chart plotly";
  container.appendChild(div);
  const { data, layout, config, frames } = spec || {};
  await window.Plotly.newPlot(div, data || [], layout || {}, config || {});
  if (frames) window.Plotly.addFrames(div, frames);
}
async function renderVegaLite(container, spec) {
  await ensureVegaLite();
  const div = document.createElement("div");
  div.className = "block chart vega";
  container.appendChild(div);
  await window.vegaEmbed(div, spec || {}, { actions: false });
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
  } catch {
    div.textContent = "Diagram render error";
  }
}
async function renderLottie(container, json) {
  await ensureLottie();
  const div = document.createElement("div");
  div.className = "block animation lottie";
  div.style.width = "100%";
  div.style.maxWidth = "640px";
  div.style.minHeight = "160px";
  container.appendChild(div);
  window.lottie.loadAnimation({
    container: div,
    renderer: "svg",
    loop: true,
    autoplay: true,
    animationData: json || {},
  });
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
}
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
    } else if (t === "chart" && blk.lib === "plotly") {
      await renderPlotly(container, blk.spec);
    } else if (t === "chart" && blk.lib === "vega-lite") {
      await renderVegaLite(container, blk.spec);
    } else if (t === "diagram" && blk.lib === "mermaid") {
      await renderMermaid(container, blk.code);
    } else if (t === "animation" && blk.lib === "lottie") {
      await renderLottie(container, blk.json);
    } else if (t === "image") {
      renderImage(container, blk.url, blk.alt);
    } else if (t === "table") {
      renderTable(container, blk.columns || [], blk.rows || []);
    } else {
      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(blk, null, 2);
      container.appendChild(pre);
    }
  }
}

/* ===== messages ===== */
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
  const retry = $(".tool-retry", node);
  if (retry)
    retry.onclick = () => {
      const th = state.threads[state.activeId];
      const lastUser = [...th.messages]
        .reverse()
        .find((m) => m.role === "user");
      if (lastUser) sendPrompt(lastUser.content, true);
    };
  const up = $(".tool-up", node),
    down = $(".tool-down", node);
  if (up)
    up.onclick = () => {
      up.classList.toggle("active");
      down?.classList.remove("active");
    };
  if (down)
    down.onclick = () => {
      down.classList.toggle("active");
      up?.classList.remove("active");
    };
  const edit = $(".tool-edit", node);
  if (edit)
    edit.onclick = () => {
      const curr = role === "assistant" ? body.innerText : body.textContent;
      const ci = $("#composerInput");
      if (ci) {
        ci.value = curr || "";
        ci.focus();
      }
      node.remove();
      const th = state.threads[state.activeId];
      const idx = th.messages.findIndex(
        (m) =>
          m.role === "user" &&
          (m.content === curr || m.content?.content === curr)
      );
      if (idx > -1) {
        th.messages.splice(idx, 1);
        save();
      }
      setSendEnabled();
    };
}

/* ===== first-send expansion ===== */
function exitCompactOnce() {
  if (sessionStorage.getItem(SS_EXPANDED) === "1") return;
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

/* ===== backend SSE (named events) ===== */
async function* sseStream(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body || {}),
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

  if (name === "render_table") {
    renderTable(container, args?.columns || [], args?.rows || []);
    if (args?.caption) {
      const cap = document.createElement("div");
      cap.className = "block caption";
      cap.innerHTML = mdToHtml(`**${args.caption}**`);
      container.appendChild(cap);
    }
    return;
  }
  if (name === "render_chart") {
    await renderVegaLite(
      container,
      Object.assign({ width: "container" }, args?.vegalite_spec || {})
    );
    if (args?.title) {
      const cap = document.createElement("div");
      cap.className = "block caption";
      cap.innerHTML = mdToHtml(`**${args.title}**`);
      container.appendChild(cap);
    }
    return;
  }
  if (name === "render_mermaid") {
    await renderMermaid(container, args?.code || "flowchart LR; A-->B;");
    return;
  }
  if (name === "render_image") {
    renderImage(container, args?.url || "", args?.alt || "");
    return;
  }
  if (name === "render_html") {
    const card = document.createElement("div");
    card.className = "block html";
    card.innerHTML = args?.html || "";
    container.appendChild(card);
    return;
  }

  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(tool, null, 2);
  container.appendChild(pre);
}

/* ===== send ===== */
async function sendPrompt(text) {
  if (!state.threads[state.activeId]) newThread();
  exitCompactOnce();

  if (state.threads[state.activeId].messages.length === 0) {
    const chip = $("#threadTitleChip");
    if (chip) chip.textContent = "Greeting and Offer of Assistance";
    state.threads[state.activeId].title = "Greeting and Offer of Assistance";
  }

  appendMessage("user", text, true, "text");
  const ci = $("#composerInput");
  if (ci) {
    ci.value = "";
    ci.style.height = "28px";
  }
  setSendEnabled();
  updateComposerHeightVar();

  const { body } = appendMessage("assistant", "", false, "text");
  if (body)
    body.innerHTML = `<div class="thinking"><span>Thinking</span><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;

  let acc = "";
  let usedBlocks = false;

  try {
    const container = $("#messages");
    for await (const evt of sseStream("/api/ask", { prompt: text })) {
      if (evt.event === "token" && typeof evt.data?.text === "string") {
        if (!acc) body.innerHTML = "";
        acc += evt.data.text;
        body.innerHTML = mdToHtml(acc);
        if (state.autoscroll && container)
          container.scrollTop = container.scrollHeight;
        continue;
      }
      if (evt.event === "tool" && evt.data?.name) {
        usedBlocks = true;
        await handleTool(evt.data, body);
        if (state.autoscroll && container)
          container.scrollTop = container.scrollHeight;
        continue;
      }
      if (evt.event === "final" && typeof evt.data?.text === "string") {
        acc = evt.data.text;
        body.innerHTML = mdToHtml(acc);
        continue;
      }
      if (evt.event === "done") break;

      // Legacy fallback: treat as token
      if (evt.data?.text) {
        if (!acc) body.innerHTML = "";
        acc += evt.data.text;
        body.innerHTML = mdToHtml(acc);
        if (state.autoscroll && container)
          container.scrollTop = container.scrollHeight;
      }
    }
  } catch {
    acc = acc || "_Error: failed to get response._";
    if (body) body.innerHTML = mdToHtml(acc);
  } finally {
    const th = state.threads[state.activeId];
    if (usedBlocks && body?.querySelector(".ai-blocks")) {
      const blocks = [];
      if (acc) blocks.push({ type: "text", content: acc });
      th.messages.push({
        role: "assistant",
        content: { blocks },
        kind: "blocks",
      });
    } else {
      th.messages.push({ role: "assistant", content: acc, kind: "text" });
    }
    th.updatedAt = nowISO();
    save();
    renderSidebar();
    scrollBottom();
  }
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
$("#fileInput")?.addEventListener("change", (e) => {
  const f = e.target?.files && e.target.files[0];
  if (f) toast(`Attached: ${f.name}`);
});
$("#deepthinkBtn")?.addEventListener("click", (e) =>
  setActivePill(
    e.currentTarget.classList.contains("active") ? null : e.currentTarget
  )
);
$("#searchBtn")?.addEventListener("click", (e) =>
  setActivePill(
    e.currentTarget.classList.contains("active") ? null : e.currentTarget
  )
);

/* sidebar controls */
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
  migrateThreads(); // ensure required fields exist
  if (Object.keys(state.threads).length === 0) newThread();
  else state.activeId = Object.keys(state.threads)[0];

  sessionStorage.removeItem(SS_EXPANDED);
  document.body.classList.add("compact");
  setHeroVisible(true);
  setSidebarOpen(false);
  renderSidebar();
  updateComposerHeightVar();
  positionComposer();

  pickHeroVideo();
  window.addEventListener("resize", () => {
    if (!$("#hero")?.classList.contains("hidden")) pickHeroVideo();
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
    state.autoscroll = isNearBottom(msgs);
  });

  setSendEnabled();
})();
