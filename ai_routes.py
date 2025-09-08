# ai_routes.py
from dotenv import load_dotenv
load_dotenv()

import os, json, hashlib, re
from typing import Any, Dict, List, Tuple, Optional

from flask import Blueprint, request, jsonify, Response, stream_with_context
import redis
from openai import OpenAI
from langchain_openai import OpenAIEmbeddings
from langchain_chroma import Chroma

# -------------------- setup --------------------
ai_bp = Blueprint("ai", __name__)

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL   = os.getenv("OPENAI_MODEL", "").strip()   # must support tools
REDIS_URL      = os.getenv("REDIS_URL", "").strip()
if not OPENAI_API_KEY or not OPENAI_MODEL or not REDIS_URL:
  raise ValueError("OPENAI_API_KEY, OPENAI_MODEL, and REDIS_URL must be set")

client = OpenAI(api_key=OPENAI_API_KEY)

# Vector store (persisted)
embedding = OpenAIEmbeddings(api_key=OPENAI_API_KEY, model="text-embedding-3-small")
vectorstore = Chroma(persist_directory="chroma_store", embedding_function=embedding)

# Redis
redis_client = redis.from_url(REDIS_URL, decode_responses=True)

# -------------------- helpers --------------------
def sse(event: str, data: Dict[str, Any]) -> str:
  return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

def hash_key(obj: Any) -> str:
  return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()

def try_json(s: str):
  try:
    return json.loads(s)
  except Exception:
    return None

# ---- HTML block promotion: turn any in-narrative table-like HTML into a render_html tool
NX_COMPARE_BLOCK = re.compile(
  r'(?is)(?:<style[\s\S]*?nx-compare[\s\S]*?</style>\s*)?(<div[^>]*class=["\']?nx-compare[^>]*>[\s\S]*?</div>)'
)
HTML_TABLE_BLOCK = re.compile(
  r'(?is)(?:<style[\s\S]*?</style>\s*)?(<table[\s\S]*?</table>)'
)
ARIA_TABLE_BLOCK = re.compile(
  r'(?is)(?:<style[\s\S]*?</style>\s*)?(<div[^>]*role=["\']table["\'][\s\S]*?</div>)'
)

def _promote_blocks(txt: str) -> Tuple[str, List[Dict[str, Any]]]:
  tools: List[Dict[str, Any]] = []
  s = txt or ""

  def capture(pattern, buf):
    def repl(m):
      html = m.group(0)
      tools.append({"name": "render_html", "args": {"html": html}})
      return ""
    return pattern.sub(repl, buf)

  s = capture(NX_COMPARE_BLOCK, s)
  s = capture(HTML_TABLE_BLOCK, s)
  s = capture(ARIA_TABLE_BLOCK, s)

  s = re.sub(r'(?is)<style[\s\S]*?</style>', "", s).strip()
  return s, tools

# ---- global markdown theme (large bold headings, clean spacing) ------------
def _md_theme_html() -> str:
  return """
<style id="nx-md-theme">
:root{--nx-text:#0b1220;--nx-muted:#637085;--nx-line:#e6edf7;--nx-accent:#2563eb;--nx-max:780px}
article, .markdown, .chat-md, body{color:var(--nx-text);line-height:1.7}
.chat-md, .markdown, article{max-width:var(--nx-max)}
h1{font:700 28px/1.25 system-ui,Segoe UI,Roboto,Inter,sans-serif;margin:18px 0 8px}
h2{font:700 22px/1.3 system-ui,Segoe UI,Roboto,Inter,sans-serif;margin:16px 0 8px}
h3{font:700 18px/1.35 system-ui,Segoe UI,Roboto,Inter,sans-serif;margin:14px 0 6px}
p{margin:10px 0}
ul,ol{margin:10px 0 12px 22px}
li{margin:4px 0}
strong{font-weight:700}
code{background:#f6f8fb;border:1px solid var(--nx-line);border-radius:6px;padding:0 6px}
hr{border:0;border-top:1px solid var(--nx-line);margin:16px 0}
blockquote{margin:12px 0;padding:8px 12px;border-left:3px solid var(--nx-line);color:var(--nx-muted);background:#fbfdff}
table{border-collapse:separate;border-spacing:0;border:1px solid var(--nx-line);border-radius:10px;overflow:hidden}
th,td{padding:10px 12px;border-bottom:1px solid var(--nx-line)}
thead th{background:#f6f9ff;text-align:left}
tbody tr:nth-child(odd){background:#fbfdff}
a{color:var(--nx-accent);text-decoration:none}
a:hover{text-decoration:underline}
</style>
"""

# ---- link extraction + compact links panel ---------------------------------
MD_LINK = re.compile(r'\[([^\]]+)\]\((https?://[^\s)]+)\)')
BARE_URL = re.compile(r'(?<!\()(?P<url>https?://[^\s<>"\')]+)')

def _extract_links(txt: str) -> List[Dict[str, str]]:
  seen = set()
  links = []
  for label, url in MD_LINK.findall(txt or ""):
    u = url.strip()
    if u not in seen:
      seen.add(u); links.append({"label": (label or u).strip()[:120] or u, "url": u})
  for m in BARE_URL.finditer(txt or ""):
    u = m.group("url").strip().rstrip('.,);]')
    if u not in seen:
      seen.add(u)
      try:
        host = re.sub(r'^www\.', '', u.split("/")[2])
      except Exception:
        host = u
      links.append({"label": host[:120], "url": u})
  return links

def _links_card_html(items: List[Dict[str, str]]) -> str:
  if not items: return ""
  rows = "\n".join(
    f'''<li class="nxl-item"><a href="{i["url"]}" target="_blank" rel="noopener">{i["label"]}</a>
          <span class="nxl-url">{i["url"]}</span></li>'''
    for i in items
  )
  return f"""
<style>
.nx-links{{--bg:#fff;--fg:#0b1220;--muted:#64748b;--line:#e6edf7;--accent:#2563eb;
  border:1px solid var(--line);border-radius:12px;background:var(--bg);box-shadow:0 6px 30px rgba(2,6,23,.06);
  font:14px/1.5 system-ui,Segoe UI,Roboto,Inter,sans-serif;color:var(--fg);overflow:hidden;margin:8px 0}}
.nx-links .hdr{{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--line);
  background:linear-gradient(180deg,#f8fbff,#f2f7ff)}}
.nx-links .dot{{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 8px #60a5fa;animation:nxPulse 1.8s ease-in-out infinite}}
.nx-links .title{{font-weight:600}}
.nx-links ul{{list-style:none;margin:0;padding:6px 8px}}
.nx-links .nxl-item{{padding:8px;border-radius:10px;border:1px solid transparent;display:flex;flex-direction:column;gap:2px;animation:nxSlide .30s ease both}}
.nx-links .nxl-item:hover{{background:#f6f9ff;border-color:var(--line)}}
.nx-links a{{text-decoration:none;color:var(--accent);font-weight:600}}
.nx-links .nxl-url{{color:var(--muted);font-size:12px;word-break:break-all}}
@keyframes nxSlide{{from{{opacity:0;transform:translateY(5px)}}to{{opacity:1;transform:translateY(0)}}}}
@keyframes nxPulse{{0%{{box-shadow:0 0 0 0 rgba(37,99,235,.35)}}70%{{box-shadow:0 0 0 8px rgba(37,99,235,0)}}100%{{box-shadow:0 0 0 0 rgba(37,99,235,0)}}}}
</style>
<div class="nx-links" role="region" aria-label="Links">
  <div class="hdr"><span class="dot"></span><span class="title">Links referenced</span></div>
  <ul>{rows}</ul>
</div>
"""

# ---- readable text post-processor -----------------------------------------
_H_WHITESPACE = re.compile(r'[ \t]+\n')
_H_ML_BLANKS  = re.compile(r'\n{3,}')
_H_BULLET_ANY = re.compile(r'^[ \t]*([*-])\s+', re.M)
_H_HEADINGS   = re.compile(r'^(#{1,6})[ \t]*', re.M)

def _polish_markdown(txt: str) -> str:
  if not txt:
    return txt
  s = txt.replace('\r\n', '\n').replace('\r', '\n')
  s = _H_BULLET_ANY.sub('- ', s)
  s = _H_HEADINGS.sub(lambda m: f'{m.group(1)} ', s)
  s = re.sub(r'([^\n])\n(#{1,6} )', r'\1\n\n\2', s)
  s = re.sub(r'([^\n])\n(- )', r'\1\n\n- ', s)
  s = re.sub(r'(- [^\n]+)\n([^-\n#>])', r'\1\n\n\2', s)
  s = _H_WHITESPACE.sub('\n', s)
  s = _H_ML_BLANKS.sub('\n\n', s)
  s = s.strip()
  s = re.sub(r'(?i)^key points:?$', '**Key points**:', s, flags=re.M)
  return s

# ---- compare intent → auto table from bullets ------------------------------
_MD_VS = re.compile(r'(?i)\b(.+?)\s+vs\.?\s+(.+?)\b')
_MD_FEATURE_ROW = re.compile(r'^[ \t]*[-*]\s*([^:]+):\s*(.*?)\s*\|\s*(.*)$', re.M)

def _auto_compare_table(narrative: str) -> Optional[Dict[str, Any]]:
  rows = []
  for m in _MD_FEATURE_ROW.finditer(narrative or ""):
    feature, left, right = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
    rows.append([feature, left, right])
  if not rows:
    return None
  m = _MD_VS.search(narrative)
  left_label = m.group(1).strip() if m else "Option A"
  right_label = m.group(2).strip() if m else "Option B"
  return {
    "name": "render_table",
    "args": {
      "columns": ["Feature", left_label, right_label],
      "rows": rows,
      "caption": f"{left_label} vs {right_label}"
    }
  }

# -------------------- model system prompt and tools --------------------
QUALITY_RUBRIC = """
House style:
- Start with an H1 title that summarizes the answer.
- Short paragraphs. 2–4 lines each.
- Bullets for steps, options, or comparisons. One idea per bullet.
- Bold only for key terms or labels.
- Clean Markdown spacing: blank line around headings and lists.
- Active voice. Plain language.
"""

SYSTEM_PROMPT = f"""
You are Nanize Assistant, a product-first guide for the Nanize brand.

Mission
- Explain Nanize products, technology, use cases, care, safety, availability, and roadmap.
- When comparing to alternatives like PTFE/Teflon, show clear factual advantages where applicable. Admit narrow cases where an alternative wins, then give Nanize counters.

Audience
- Engineers, buyers, compliance teams, and consumers. Default to plain language. Add technical depth only when the user signals it.

Sources and truth
- Prefer provided context, specs, certificates, SDS, and approved copy. If data is missing, say Not yet public or Unknown. Do not guess.
- Never invent pricing, lead times, certifications, or test results. Name the standard and status if known.

Response logic
- Pick layout by intent:
  • Simple Q → 1–3 short paragraphs, no sections.
  • Product explainer → summary → sections.
  • Quick compare → bullets or compact paragraph; table only if asked or clearly useful.
- Vary openings. Do not reuse the same first sentence within a session.

Style presets
- neutral: concise, plain language, short sentences.
- friendly: warmer, contractions, light transitions.
- technical: terse, spec-first, bullet-heavy.
- marketing-safe: benefit-first, compliant phrasing.

Style and structure
- Natural, concise, friendly. Keep paragraphs short.

PFAS wording
- Many jurisdictions classify PTFE as PFAS. If saying PFAS-free, clarify scope and region. Use one of:
  • PFAS-free by OECD 2021 definition excluding fluoropolymers.
  • Fluoropolymer-free for regions that classify PTFE as PFAS.
- If unsure which applies, state “Definitions vary by jurisdiction” and avoid absolute claims.

Comparisons policy
- Compare on performance, durability, cure time, cost in use, regulatory risk, and recyclability.
- If a competitor is better on a narrow metric, state it briefly, then offer Nanize mitigation or roadmap.

Safety
- Mention handling, cure temperature, ventilation, food-contact status, and any applicable standards only when documented.
- No medical or legal advice.

Tools and output rendering
- Write the full narrative first as Markdown. Do not include raw HTML in the narrative.
- Then, optionally use a single visual tool (table, chart, HTML card, or Lottie).
- Lottie JSON under 25 KB.

Structural rules
- Always use Markdown headings for sectioned answers. Start with an H1 title.
- Keep paragraphs 2–4 lines. Use bullets for lists.
- If the user asks to compare or the content implies comparison, include a compact comparison table after the narrative using a provided tool.
- Do not add AI disclaimers.

Formatting quality
{QUALITY_RUBRIC}
"""

TOOLS = [
  {
    "type": "function",
    "function": {
      "name": "render_table",
      "description": "Render a simple table.",
      "parameters": {
        "type": "object",
        "properties": {
          "columns": {"type": "array", "items": {"type": "string"}},
          "rows": {
            "type": "array",
            "items": {"type": "array", "items": {"type": ["string","number","boolean","object","null"]}}
          },
          "caption": {"type": "string"}
        },
        "required": ["columns", "rows"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "render_chart",
      "description": "Render a Vega-Lite chart.",
      "parameters": {
        "type": "object",
        "properties": {
          "vegalite_spec": {"type": "object", "description": "Valid Vega-Lite spec"},
          "title": {"type": "string"}
        },
        "required": ["vegalite_spec"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "render_mermaid",
      "description": "Render a Mermaid diagram.",
      "parameters": {
        "type": "object",
        "properties": {"code": {"type": "string"}},
        "required": ["code"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "render_image",
      "description": "Render an image by URL.",
      "parameters": {
        "type": "object",
        "properties": {"url": {"type": "string"}, "alt": {"type": "string"}},
        "required": ["url"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "render_html",
      "description": "Render an HTML card. Include scoped CSS in <style> if needed.",
      "parameters": {
        "type": "object",
        "properties": {"html": {"type": "string"}},
        "required": ["html"]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "render_lottie",
      "description": "Render a Lottie animation from JSON.",
      "parameters": {
        "type": "object",
        "properties": {"json": {"type": "object"}, "title": {"type": "string"}},
        "required": ["json"]
      }
    }
  }
]

# Animated table template (LIGHT THEME) kept for model reference if it outputs HTML tables
NX_COMPARE_TEMPLATE_LIGHT = """<style>
.nx-compare{--rx:12px;--bg:#ffffff;--fg:#0b1220;--muted:#64748b;--row:#fbfdff;--row2:#f6f9ff;--line:#e6edf7;--accent:#2563eb;--ok:#16a34a;--bad:#ef4444;}
.nx-compare{font:14px/1.5 system-ui,Segoe UI,Roboto,Inter,sans-serif;color:var(--fg);background:var(--bg);border-radius:var(--rx);overflow:hidden;border:1px solid var(--line);box-shadow:0 6px 30px rgba(2,6,23,.06)}
.nx-compare .hdr{padding:14px 16px;background:linear-gradient(180deg,#f8fbff,#f2f7ff);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
.nx-compare .dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 10px #60a5fa}
.nx-compare .title{font-weight:600}
.nx-compare table{width:100%;border-collapse:separate;border-spacing:0}
.nx-compare th,.nx-compare td{padding:12px 14px;vertical-align:top}
.nx-compare thead th{background:#f6f9ff;border-bottom:1px solid var(--line);font-weight:600;color:#0b1220}
.nx-compare tbody tr{background:var(--row);animation:nxRow .45s ease both}
.nx-compare tbody tr:nth-child(odd){background:var(--row2)}
.nx-compare tbody tr+tr td{border-top:1px solid var(--line)}
.nx-compare tbody tr:hover{background:#eef5ff}
.nx-compare .muted{color:var(--muted)}
.nx-compare .chip{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid var(--line);background:#fff}
.nx-compare .ok{border-color:#86efac;background:#f0fdf4;color:#166534;animation:nxPulse 2.2s ease-in-out infinite}
.nx-compare .bad{border-color:#fecaca;background:#fff1f2;color:#991b1b}
.nx-compare .spark{display:inline-block;width:6px;height:6px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px #86efac}
.nx-compare .warn{display:inline-block;width:6px;height:6px;border-radius:50%;background:#ef4444;box-shadow:0 0 10px #fecaca}
@keyframes nxRow{from{opacity:0;transform:translateY(8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}
@keyframes nxPulse{0%{box-shadow:0 0 0 0 rgba(22,163,74,.35)}70%{box-shadow:0 0 0 12px rgba(22,163,74,0)}100%{box-shadow:0 0 0 0 rgba(22,163,74,0)}}
</style>
<div class="nx-compare" role="table" aria-label="Key Comparison">
  <div class="hdr"><span class="dot"></span><span class="title">{title}</span></div>
  <table>
    <thead>
      <tr>
        <th scope="col">Feature</th>
        <th scope="col">{left_label}</th>
        <th scope="col">{right_label}</th>
      </tr>
    </thead>
    <tbody>
      {rows_html}
    </tbody>
  </table>
  <div class="muted" style="padding:10px 14px;border-top:1px solid var(--line)">{footnote}</div>
</div>"""

def build_prompt(user_prompt: str) -> str:
  try:
    docs = vectorstore.similarity_search(user_prompt, k=3)
    ctx = "\n\n---\n\n".join([d.page_content for d in docs if getattr(d, "page_content", "").strip()])
  except Exception:
    ctx = ""
  preface = (
    "Format in Markdown. Choose layout by intent. "
    "If the question is simple, answer in 1–3 short paragraphs with no sections. "
    "Only add visuals via tools if they materially help. "
    "Write the full narrative first; do not include raw HTML in the narrative."
  )
  hint = (
    "\n\nIf you do a comparison, render the narrative first. "
    "Then optionally call a table tool. "
    "Optionally add a small Vega-Lite chart or short Lottie status after the table."
  )
  if ctx:
    return f"{preface}\n\nContext:\n{ctx}\n\nUser: {user_prompt}\n\nAnswer:{hint}"
  return f"{preface}\n\nUser: {user_prompt}\n\nAnswer:{hint}"

# -------------------- route --------------------
@ai_bp.route("/api/ask", methods=["POST"])
def ask():
  data = request.get_json(silent=True) or {}
  prompt = (data.get("prompt") or "").strip()
  if not prompt:
    return jsonify({"error": "No prompt provided"}), 400

  style = (data.get("style") or "neutral").strip().lower()
  if style not in {"neutral","friendly","technical","marketing-safe"}:
    style = "neutral"

  temperature = float(data.get("temperature", 0.7))
  top_p = float(data.get("top_p", 1.0))
  presence_penalty = float(data.get("presence_penalty", 0.2))
  frequency_penalty = float(data.get("frequency_penalty", 0.2))

  cache_key = "nanize_v8:" + hash_key({
    "p": prompt, "t": temperature, "tp": top_p, "pp": presence_penalty, "fp": frequency_penalty, "style": style
  })
  cached = redis_client.get(cache_key)
  if cached:
    try:
      obj = json.loads(cached)
      cached_text = obj.get("text", "")
      cached_tools = obj.get("tools", [])
    except Exception:
      cached_text = cached
      cached_tools = []
    def cached_stream():
      yield sse("final", {"text": cached_text})
      for ev in cached_tools:
        yield sse("tool", ev)
      yield sse("done", {})
    return Response(stream_with_context(cached_stream()), mimetype="text/event-stream")

  full_prompt = build_prompt(prompt)

  def generate():
    full_text_chunks: List[str] = []
    tool_queue: List[Dict[str, Any]] = []
    tool_buf: Dict[int, Dict[str, Any]] = {}

    stream = client.chat.completions.create(
      model=OPENAI_MODEL,
      messages=[
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "system", "content": f"Style preset: {style}"},
        {"role": "system", "content": "Avoid repeating identical openings across answers in one session."},
        {"role": "system", "content": f"Animated comparison table template (light theme):\n{NX_COMPARE_TEMPLATE_LIGHT}"},
        {"role": "user", "content": full_prompt},
      ],
      tools=TOOLS,
      tool_choice="auto",
      temperature=temperature,
      top_p=top_p,
      presence_penalty=presence_penalty,
      frequency_penalty=frequency_penalty,
      stream=True,
    )

    for chunk in stream:
      choice = chunk.choices[0]
      delta = choice.delta

      if getattr(delta, "content", None):
        txt = delta.content
        full_text_chunks.append(txt)
        yield sse("token", {"text": txt})

      if getattr(delta, "tool_calls", None):
        for tc in delta.tool_calls:
          idx = tc.index
          buf = tool_buf.setdefault(idx, {"name": None, "arguments": []})
          fn = getattr(tc, "function", None)
          if fn and getattr(fn, "name", None):
            buf["name"] = fn.name
          if fn and getattr(fn, "arguments", None):
            buf["arguments"].append(fn.arguments)

    for idx, buf in list(tool_buf.items()):
      if buf["name"] and buf["arguments"]:
        args_json = "".join(buf["arguments"])
        args_obj = try_json(args_json)
        if args_obj is not None:
          tool_queue.append({"name": buf["name"], "args": args_obj})

    # ---- finalize narrative
    final_text_raw = ("".join(full_text_chunks)).strip()
    final_text, promoted_tools = _promote_blocks(final_text_raw)
    if promoted_tools:
      tool_queue.extend(promoted_tools)

    final_text = _polish_markdown(final_text)

    # ---- auto-compare table from narrative bullets if present
    auto_tbl = _auto_compare_table(final_text)
    if auto_tbl:
      tool_queue.append(auto_tbl)

    # ---- dynamic links panel and subtle Lottie
    links = _extract_links(final_text)
    if links:
      tool_queue.append({"name": "render_html", "args": {"html": _links_card_html(links)}})
      tool_queue.append({
        "name": "render_lottie",
        "args": {
          "json": {
            "v": "5.7.4", "fr": 30, "ip": 0, "op": 45, "w": 80, "h": 80, "nm": "pulse-dot", "ddd": 0, "assets": [],
            "layers": [
              {"ty":4,"nm":"dot","ks":{"o":{"a":0,"k":100},"r":{"a":0,"k":0},"p":{"a":0,"k":[40,40,0]},
               "a":{"a":0,"k":[0,0,0]},"s":{"a":0,"k":[100,100,100]}},
               "shapes":[{"ty":"el","p":{"a":0,"k":[0,0]},"s":{"a":0,"k":[10,10]},"nm":"circle"},
                         {"ty":"fl","c":{"a":0,"k":[0.149,0.388,0.922,1]},"o":{"a":0,"k":100},"nm":"fill"}]},
              {"ty":4,"nm":"ring","ks":{"o":{"a":1,"k":[{"t":0,"s":[60]},{"t":45,"s":[0]}]},
               "r":{"a":0,"k":0},"p":{"a":0,"k":[40,40,0]},"a":{"a":0,"k":[0,0,0]},
               "s":{"a":1,"k":[{"t":0,"s":[100,100,100]},{"t":45,"s":[260,260,100]}]}},
               "shapes":[{"ty":"el","p":{"a":0,"k":[0,0]},"s":{"a":0,"k":[10,10]},"nm":"circle"},
                         {"ty":"st","c":{"a":0,"k":[0.149,0.388,0.922,1]},"o":{"a":0,"k":50},"w":{"a":0,"k":2},"lc":1,"lj":1,"ml":4,"nm":"stroke"}]}
            ]
          },
          "title": "references-loaded"
        }
      })

    # ---- emit narrative first
    yield sse("final", {"text": final_text})

    # ---- cache both text and tools (TTL 6h)
    payload = {"text": final_text, "tools": tool_queue}
    redis_client.setex(cache_key, 21600, json.dumps(payload, ensure_ascii=False))

    # ---- always inject global Markdown theme first
    tool_queue.insert(0, {"name": "render_html", "args": {"html": _md_theme_html()}})

    # ---- emit tools
    for ev in tool_queue:
      yield sse("tool", ev)

    yield sse("done", {})

  return Response(stream_with_context(generate()), mimetype="text/event-stream")
