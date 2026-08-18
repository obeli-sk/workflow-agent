// The single-page-app shell: one static HTML document (inline CSS + browser
// JS) that boots the polling UI. The browser script is embedded as a template
// literal, so it deliberately avoids backticks and ${...} in its own code.

export function htmlShell() {
    const uiUrl = (process.env["OBELISK_UI_URL"] || "http://localhost:8080").replace(/\/$/, "");
    const html = SHELL_HTML.replace("__OBELISK_UI_URL__", uiUrl);
    return new Response(html, {
        status: 200,
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store, max-age=0",
        },
    });
}

const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>obelisk-agent</title>
<style>
  :root {
    --bg: #fafafa; --panel: #fff; --line: #e5e5e5; --muted: #777;
    --accent: #2868c8; --accent-bg: #eef3fb;
    --ok: #2a7a3a; --ok-bg: #ebf6ee;
    --err: #b32626; --err-bg: #fcecec;
    --warn: #965c00;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body { font: 14px/1.45 -apple-system, system-ui, sans-serif; color: #1d1d1f; background: var(--bg); display: flex; }
  aside { width: 300px; border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; }
  main { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
  #detail { flex: 1; overflow-y: auto; padding: 1.5rem 2rem; }
  aside header { padding: 1rem; border-bottom: 1px solid var(--line); }
  aside header h1 { margin: 0 0 0.6rem; font-size: 1rem; font-weight: 600; }
  #new-convo { width: 100%; padding: 0.55em 0.9em; font: inherit; font-weight: 600; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 4px; }
  #new-convo:hover { background: #1f57ad; }
  #composer { border-top: 1px solid var(--line); background: var(--panel); padding: 0.7rem 2rem 1rem; }
  #composer form textarea { width: 100%; resize: vertical; min-height: 3em; max-height: 40vh; padding: 0.5em 0.7em; border: 1px solid var(--line); border-radius: 6px; font: inherit; }
  #composer form textarea:disabled { background: #f4f4f4; }
  .composer-row { display: flex; gap: 0.5em; align-items: center; margin-top: 0.5em; }
  .composer-selects { display: flex; gap: 0.5em; flex: 1; flex-wrap: wrap; min-width: 0; }
  #composer select { padding: 0.4em; border: 1px solid var(--line); border-radius: 4px; font: inherit; background: var(--panel); max-width: 100%; }
  #composer-send { margin-left: auto; padding: 0.5em 1.3em; font: inherit; font-weight: 600; cursor: pointer; border: 1px solid var(--accent); background: var(--accent); color: white; border-radius: 6px; }
  #composer-send:disabled { opacity: 0.5; cursor: not-allowed; }
  .working { display: flex; align-items: center; gap: 0.5em; margin-bottom: 0.5em; color: var(--warn); font-size: 0.85em; font-weight: 600; }
  .working[hidden] { display: none; }
  .working .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); animation: workpulse 1s ease-in-out infinite; }
  @keyframes workpulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.3; transform: scale(0.7); } }
  .runs { flex: 1; overflow-y: auto; }
  .run-item { display: block; padding: 0.7rem 1rem; border-bottom: 1px solid var(--line); cursor: pointer; text-decoration: none; color: inherit; }
  .run-item:hover { background: #f4f4f4; }
  .run-item.active { background: var(--accent-bg); border-left: 3px solid var(--accent); padding-left: calc(1rem - 3px); }
  .run-prompt { font-weight: 500; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .run-meta { color: var(--muted); font-size: 0.8em; margin-top: 0.2em; display: flex; justify-content: space-between; }
  .run-meta .status { font-weight: 600; }
  .run-meta .status.finished { color: var(--ok); }
  .run-meta .status.pending_now, .run-meta .status.locked, .run-meta .status.unfinished { color: var(--warn); }
  .run-meta .status.paused, .meta .status.paused { color: var(--accent); }
  .run-meta .status.working, .meta .status.working { color: var(--warn); }
  .run-meta .status.awaiting, .meta .status.awaiting { color: var(--accent); font-weight: 700; }
  .run-meta .status.timeout, .run-meta .status.permanently_failed, .run-meta .status.permanently_timed_out, .run-meta .status.err { color: var(--err); }
  main .empty { color: var(--muted); margin-top: 4rem; text-align: center; }
  main h2 { margin: 0 0 0.5rem; font-size: 1.05rem; font-weight: 600; }
  .meta { color: var(--muted); font-size: 0.85em; margin-bottom: 1.5rem; }
  .meta code { font-size: 1em; }
  .bubble { padding: 0.8em 1em; border-radius: 8px; margin: 0.6em 0; max-width: 720px; }
  .bubble-head, .response-head { display: flex; align-items: baseline; gap: 0.7em; margin-bottom: 0.25em; }
  .bubble-head .label, .response-head .key { margin-bottom: 0; }
  .latency { margin-left: auto; color: var(--muted); font: 11px/1.2 ui-monospace, monospace; white-space: nowrap; }
  .bubble.user { background: var(--accent-bg); border: 1px solid #d0deef; }
  .bubble.final { background: var(--ok-bg); border: 1px solid #c6e0ce; }
  .bubble.error { background: var(--err-bg); border: 1px solid #e5b8b8; color: var(--err); }
  .bubble.thinking { background: #faf7ff; border: 1px solid #e0d6f0; color: #4a4458; }
  .bubble.thinking .label { color: #7a5ea8; }
  .bubble pre { margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; }
  .bubble.markdown { background: var(--panel); border: 1px solid var(--line); }
  .rendered-markdown > :first-child { margin-top: 0; }
  .rendered-markdown > :last-child { margin-bottom: 0; }
  .rendered-markdown pre { padding: 0.6em; background: #f7f7f7; border-radius: 4px; overflow-x: auto; font: 12px/1.45 ui-monospace, monospace; }
  .rendered-markdown code { font-family: ui-monospace, monospace; }
  .bubble.mermaid-block { max-width: 960px; overflow-x: auto; background: white; border: 1px solid var(--line); }
  .bubble.mermaid-block svg { max-width: 100%; height: auto; }
  .bubble.mermaid-block .render-error { color: var(--err); white-space: pre-wrap; }
  .label { font-size: 0.75em; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.25em; }
  .turn { margin: 1.2em 0; }
  .turn .bubble { max-width: none; }
  .turn-header { display: flex; align-items: baseline; gap: 0.7em; font-weight: 600; color: var(--muted); font-size: 0.85em; margin-bottom: 0.3em; }
  .step { margin: 0.6em 0; padding-left: 0.8em; border-left: 2px solid var(--line); }
  .step-header { display: flex; align-items: baseline; gap: 0.7em; font-weight: 600; color: var(--muted); font-size: 0.8em; margin-bottom: 0.3em; }
  .turn-final { font-size: 0.75em; color: var(--ok); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 0.3em; }
  .calls { display: flex; flex-direction: column; gap: 0.4em; }
  .call { border: 1px solid var(--line); border-radius: 6px; background: white; }
  .call summary { padding: 0.5em 0.8em; cursor: pointer; display: flex; gap: 0.5em; align-items: baseline; }
  .call summary code { font-weight: 600; color: var(--accent); }
  .call summary .child-link { font: 11px/1 ui-monospace, monospace; color: var(--muted); text-decoration: none; padding: 0.1em 0.4em; border-radius: 3px; background: #f0f0f0; }
  .call summary .child-link:hover { background: #e3e3e3; color: var(--accent); }
  .meta a { color: var(--accent); text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  .meta button { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; }
  .meta button:hover { text-decoration: underline; }
  .call summary .call-meta { margin-left: auto; display: flex; align-items: baseline; gap: 0.5em; }
  .call summary .call-meta .latency { margin-left: 0; }
  .call summary .status-pill { font-size: 0.8em; padding: 0.05em 0.5em; border-radius: 3px; }
  .call summary .status-pill.ok { background: var(--ok-bg); color: var(--ok); }
  .call summary .status-pill.err { background: var(--err-bg); color: var(--err); }
  .call summary .status-pill.pending { background: #f0f0f0; color: var(--muted); }
  .call .args, .call .result { padding: 0 0.8em 0.6em; }
  .call pre { margin: 0; padding: 0.5em 0.8em; background: #f7f7f7; border-radius: 4px; font: 12px/1.4 ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; max-height: 14em; overflow-y: auto; }
  .call pre.stderr { color: var(--err); background: var(--err-bg); }
  .call .args .key, .call .result .key { color: var(--muted); font-size: 0.8em; margin: 0.5em 0 0.2em; }
  form.ask { background: #fffaf2; border: 1px solid #f0d8a8; border-radius: 6px; padding: 0.8em 1em; margin: 1.4em 0; max-width: 720px; }
  form.ask p { margin: 0 0 0.5em; font-weight: 600; }
  form.ask .ask-question { margin-bottom: 0.6em; font-weight: 600; }
  form.ask textarea { width: 100%; min-height: 4em; padding: 0.4em; border: 1px solid var(--line); border-radius: 4px; font: inherit; }
  form.ask button { margin-top: 0.4em; }
  .logs { max-width: 960px; border: 1px solid var(--line); border-radius: 6px; background: #111; color: #ddd; margin: 0.8em 0 1.2em; }
  .logs .logs-head { padding: 0.5em 0.8em; border-bottom: 1px solid #333; display: flex; justify-content: space-between; }
  .logs .logs-head button { color: #9cc2ff; border: 0; background: none; cursor: pointer; }
  .logs pre { margin: 0; padding: 0.8em; max-height: 32em; overflow: auto; white-space: pre-wrap; word-break: break-word; font: 12px/1.45 ui-monospace, monospace; }
  .logs .source { color: #8eaccf; }
  .logs .level-error { color: #ff9b9b; }
  .logs .level-warn { color: #ffd27d; }
  .meta #pause-btn, .meta #unpause-btn { border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; }
  .meta #pause-btn:hover, .meta #unpause-btn:hover { text-decoration: underline; }
  .meta #cancel-btn { border: 0; background: none; color: var(--err); cursor: pointer; padding: 0; font: inherit; }
  .meta #cancel-btn:hover { text-decoration: underline; }
  .meta #cancel-confirm { color: var(--err); font-weight: 700; text-decoration: underline; cursor: pointer; }
  .err-box { background: var(--err-bg); border: 1px solid #f4c0c0; color: var(--err); padding: 0.6em 0.9em; border-radius: 4px; margin: 1em 0; }
  .ago { color: var(--muted); font-size: 0.8em; }
</style>
<script src="https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js"></script>
<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.12.0/dist/mermaid.esm.min.mjs";
  mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  window.renderMermaidBlocks = async (nodes) => {
    await mermaid.run({ nodes, suppressErrors: false });
  };
</script>
</head>
<body>
<aside>
  <header>
    <h1>obelisk-agent</h1>
    <button type="button" id="new-convo">+ New conversation</button>
  </header>
  <div class="runs" id="runs"></div>
</aside>
<main>
  <div id="detail" class="transcript">
    <p class="empty">Start a new conversation below, or pick a run from the sidebar.</p>
  </div>
  <div id="composer">
    <div id="working" class="working" hidden><span class="dot"></span><span id="working-label">Agent is working…</span></div>
    <form id="composer-form">
      <textarea id="composer-input" placeholder="Message the agent, or type $ ls to run a shell command..." rows="3"></textarea>
      <div class="composer-row">
        <div class="composer-selects" id="composer-selects">
          <select id="new-backend" title="model"></select>
          <select id="new-effort" title="reasoning effort">
            <option value="">effort: default</option>
            <option value="off">off</option>
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
        </div>
        <button type="submit" id="composer-send">Send</button>
      </div>
    </form>
  </div>
</main>
<script>
const OBELISK_UI_URL = "__OBELISK_UI_URL__";
const state = {
  selected: null,
  runs: [],
  detail: null,
  // Accumulated records plus the last server positions already fetched.
  transcript: null,
  lastSig: null,
  logs: null,
  logsCursor: '',
  logsOpen: false,
  pendingShell: null,
};
const SIDEBAR_POLL_MS = 10000;
const DETAIL_POLL_MS = 3000;
const BUSY_DETAIL_POLL_MS = 200;
const AGENT_DETAIL_POLL_MS = 500;
let sidebarTimer = null;
let detailTimer = null;
let sidebarRequest = null;
let detailRequest = null;
let detailAbort = null;
let logsRequest = null;

function execLink(id) {
  return OBELISK_UI_URL + '/execution/' + encodeURIComponent(id);
}

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// The HTML parser silently drops a single newline immediately after a <pre>
// start tag, so command output or a script that begins with a blank line loses
// its first line. Emit one guard newline (built without a literal newline, which
// the SHELL_HTML template literal would turn into a raw line break) for the
// parser to eat, leaving the content's own leading newline intact.
const PRE_LF = String.fromCharCode(10);
function preBlock(text, cls) {
  const open = cls ? '<pre class="' + cls + '">' : '<pre>';
  return open + PRE_LF + esc(text) + '</pre>';
}

function ago(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function statusLabel(status, result_kind) {
  if (status !== 'finished') return status.replaceAll('_', ' ');
  if (typeof result_kind === 'string') return result_kind;
  if (result_kind && typeof result_kind === 'object') {
    if (result_kind.ok !== undefined || result_kind.Ok !== undefined) return 'ok';
    if (result_kind.err !== undefined || result_kind.Err !== undefined) return 'err';
  }
  return 'finished';
}

// A blocked run is waiting on a join set whose name suffix is the function it
// dispatched (e.g. "o:20-ask-user"). Translate that into a specific label + a
// css class so the sidebar/detail say what the run is actually doing.
const JOIN_LABELS = {
  'ask-user': ['awaiting reply', 'awaiting'],
  'completion': ['thinking', 'working'],
  'user': ['your turn', 'awaiting'],
};
function describeStatus(status, result_kind, joinName) {
  if (status === 'blocked_by_join_set') {
    const hit = JOIN_LABELS[joinName];
    if (hit) return { label: hit[0], cls: hit[1] };
    if (joinName) return { label: joinName.replaceAll('-', ' '), cls: 'working' };
    return { label: 'blocked', cls: 'working' };
  }
  const label = statusLabel(status, result_kind);
  return { label, cls: label.replaceAll(' ', '_') };
}

function readSelectedFromUrl() {
  const m = window.location.search.match(/[?&]run=([^&]+)/);
  state.selected = m ? decodeURIComponent(m[1]) : null;
}

function setSelected(id) {
  if (id !== state.selected && detailAbort) detailAbort.abort();
  state.selected = id;
  state.detail = null;
  state.transcript = null;
  state.lastSig = null;
  state.logs = null;
  state.logsCursor = '';
  state.logsOpen = false;
  state.pendingShell = null;
  clearTimeout(detailTimer);
  const u = new URL(window.location.href);
  if (id) u.searchParams.set('run', id); else u.searchParams.delete('run');
  window.history.replaceState({}, '', u.toString());
  renderSidebar();
  refreshDetail();
}

function scheduleSidebarRefresh() {
  clearTimeout(sidebarTimer);
  if (document.hidden) return;
  sidebarTimer = setTimeout(refreshSidebar, SIDEBAR_POLL_MS);
}

function refreshSidebar() {
  if (sidebarRequest) return sidebarRequest;
  clearTimeout(sidebarTimer);
  sidebarRequest = (async () => {
    try {
      const r = await fetch('/api/runs', { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const data = await r.json();
      state.runs = data.runs || [];
      renderSidebar();
    } catch (_) {
    } finally {
      sidebarRequest = null;
      scheduleSidebarRefresh();
    }
  })();
  return sidebarRequest;
}

function renderSidebar() {
  const box = document.getElementById('runs');
  if (state.runs.length === 0) {
    box.innerHTML = '<p style="padding: 1rem; color: var(--muted)">No runs yet.</p>';
    return;
  }
  box.innerHTML = state.runs.map((r) => {
    let { label, cls } = describeStatus(r.status, r.result_kind, r.join_name);
    if (r.join_name === 'user' && r.working) { label = 'thinking'; cls = 'working'; }
    return '<a class="run-item' + (r.id === state.selected ? ' active' : '') + '" href="?run=' + encodeURIComponent(r.id) + '" data-id="' + esc(r.id) + '">'
      + '<div class="run-prompt">' + esc(r.prompt_preview || '(no prompt)') + '</div>'
      + '<div class="run-meta"><span class="status ' + esc(cls) + '">' + esc(label) + '</span><span class="ago">' + esc(ago(r.created_at)) + '</span></div>'
      + '</a>';
  }).join('');
  for (const a of box.querySelectorAll('.run-item')) {
    a.addEventListener('click', (ev) => { ev.preventDefault(); setSelected(a.dataset.id); });
  }
}

function scheduleDetailRefresh() {
  clearTimeout(detailTimer);
  if (document.hidden || !state.selected || runPhase(state.detail?.status) === 'terminal') return;
  const delay = shellIsWorking(state.detail)
    ? BUSY_DETAIL_POLL_MS
    : (agentIsWorking(state.detail) ? AGENT_DETAIL_POLL_MS : DETAIL_POLL_MS);
  detailTimer = setTimeout(refreshDetail, delay);
}

function refreshDetail() {
  const main = document.getElementById('detail');
  if (!state.selected) {
    main.innerHTML = '<p class="empty">Start a new conversation below, or pick a run from the sidebar.</p>';
    state.detail = null;
    renderComposer();
    return Promise.resolve();
  }
  const selected = state.selected;
  if (detailRequest) {
    if (detailRequest.id === selected) return detailRequest.promise;
    detailAbort?.abort();
  }
  clearTimeout(detailTimer);
  const controller = new AbortController();
  detailAbort = controller;
  const promise = (async () => {
    try {
      const query = new URLSearchParams();
      if (state.transcript?.workflow_id) {
        query.set('workflow_id', state.transcript.workflow_id);
        query.set('response_cursor', String(state.transcript.response_cursor || 0));
      }
      const suffix = query.toString() ? '?' + query.toString() : '';
      const r = await fetch('/api/runs/' + encodeURIComponent(selected) + suffix, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
      if (selected !== state.selected) return;
      if (!r.ok) {
        main.innerHTML = '<div class="err-box">Failed to load run: HTTP ' + r.status + '</div>';
        return;
      }
      const detail = await r.json();
      const contentChanged = mergeTranscript(detail.transcript);
      const started = state.transcript?.session_started;
      if (started) {
        detail.prompt = started.prompt || null;
        detail.backend = started.backend || null;
        detail.effort = started.effort || null;
      }
      detail.pending_asks = state.transcript?.pending_asks || [];
      detail.input_offer = state.transcript?.input_offer || null;
      detail.agent_working = state.transcript?.agent_working === true;
      detail.turns = buildCachedTurns(detail.created_at, detail.prompt);
      delete detail.transcript;
      if (state.pendingShell && detail.turns.some((turn) =>
        turn.source === 'shell' && turn.id === state.pendingShell.id
          && turn.calls?.[0] && 'ok' in turn.calls[0])) {
        state.pendingShell = null;
      }
      state.detail = detail;
      if (selected === state.selected) {
        renderDetail(contentChanged);
        if (state.logsOpen) refreshLogs();
      }
    } catch (e) {
      if (e.name !== 'AbortError' && selected === state.selected) {
        main.innerHTML = '<div class="err-box">' + esc(String(e)) + '</div>';
      }
    } finally {
      if (detailRequest?.promise === promise) {
        detailRequest = null;
        detailAbort = null;
        scheduleDetailRefresh();
      }
    }
  })();
  detailRequest = { id: selected, promise };
  return promise;
}

function mergeTranscript(delta) {
  if (!delta) return false;
  const reset = delta.reset || !state.transcript
    || state.transcript.workflow_id !== delta.workflow_id;
  if (reset) {
    state.transcript = {
      workflow_id: delta.workflow_id || '',
      replies: [],
      user_messages: [],
      shell_events: [],
      turn_starts: [],
      sent_results: [],
      pending_asks: [],
      session_started: null,
      input_offer: null,
      agent_working: false,
      response_cursor: 0,
    };
  }
  const contentChanged = reset
    || (delta.replies || []).length > 0
    || (delta.user_messages || []).length > 0
    || (delta.shell_events || []).length > 0
    || (delta.turn_starts || []).length > 0
    || (delta.sent_results || []).length > 0
    || (delta.human_input_events || []).length > 0
    || (Object.prototype.hasOwnProperty.call(delta, 'session_started')
      && delta.session_started !== null)
    || (Object.prototype.hasOwnProperty.call(delta, 'input_offer')
      && delta.input_offer?.id !== state.transcript.input_offer?.id)
    || (Object.prototype.hasOwnProperty.call(delta, 'agent_working')
      && delta.agent_working !== state.transcript.agent_working);
  state.transcript.replies.push(...(delta.replies || []));
  mergeUserMessages(state.transcript.user_messages, delta.user_messages || []);
  mergeShellEvents(state.transcript.shell_events, delta.shell_events || []);
  mergeTurnStarts(state.transcript.turn_starts, delta.turn_starts || []);
  mergeToolResults(state.transcript.sent_results, delta.sent_results || []);
  mergeHumanInputEvents(state.transcript.pending_asks, delta.human_input_events || []);
  if (delta.session_started) state.transcript.session_started = delta.session_started;
  if (Object.prototype.hasOwnProperty.call(delta, 'input_offer')) {
    state.transcript.input_offer = delta.input_offer || null;
  }
  if (Object.prototype.hasOwnProperty.call(delta, 'agent_working')) {
    state.transcript.agent_working = delta.agent_working === true;
  }
  state.transcript.response_cursor = delta.response_cursor || state.transcript.response_cursor;
  return contentChanged;
}

function mergeHumanInputEvents(target, incoming) {
  for (const event of incoming) {
    if (!event?.id) continue;
    const index = target.findIndex((ask) => ask?.id === event.id);
    if (event.kind === 'resolved') {
      if (index !== -1) target.splice(index, 1);
    } else if (event.kind === 'requested') {
      const ask = { id: event.id, question: event.question || '', turn_index: event.turn_index };
      if (index === -1) target.push(ask);
      else target[index] = ask;
    }
  }
}

function mergeUserMessages(target, incoming) {
  for (const message of incoming) {
    if (!message) continue;
    const existing = message.id
      ? target.find((item) => item?.id === message.id)
      : null;
    if (existing) Object.assign(existing, message);
    else target.push(message);
  }
}

function mergeShellEvents(target, incoming) {
  const keys = new Set(target.map((event) =>
    event && event.id && event.kind ? event.kind + ':' + event.id : '').filter(Boolean));
  for (const event of incoming) {
    if (!event) continue;
    const key = event.id && event.kind ? event.kind + ':' + event.id : '';
    if (key && keys.has(key)) {
      const existing = target.find((item) => item?.kind === event.kind && item?.id === event.id);
      if (existing) Object.assign(existing, event);
      continue;
    }
    if (key) keys.add(key);
    target.push(event);
  }
}

function mergeTurnStarts(target, incoming) {
  const byId = new Set(target.map((item) => item?.id).filter(Boolean));
  for (const item of incoming) {
    if (!item || (item.id && byId.has(item.id))) continue;
    if (item.id) byId.add(item.id);
    target.push(item);
  }
}

function mergeToolResults(target, incoming) {
  const byId = new Set(target.map((item) => item?.id).filter(Boolean));
  for (const item of incoming) {
    if (!item) continue;
    if (item.id && byId.has(item.id)) continue;
    if (item.id) byId.add(item.id);
    target.push(item);
  }
}

function buildCachedTurns(initialPromptAt, initialPrompt) {
  const cached = state.transcript;
  if (!cached) return [];
  const turns = [];
  const startsById = new Map(
    (cached.turn_starts || []).filter((start) => start?.id).map((start) => [start.id, start]),
  );
  const startsByTurn = new Map();
  const rememberTurnStart = (turnIndex, createdAt) => {
    if (!Number.isInteger(turnIndex) || !createdAt) return;
    const current = startsByTurn.get(turnIndex);
    if (!current || createdAt < current) startsByTurn.set(turnIndex, createdAt);
  };
  if (typeof initialPrompt === 'string' && initialPrompt.trim()) {
    rememberTurnStart(0, initialPromptAt);
  }
  for (const message of cached.user_messages || []) {
    rememberTurnStart(message?.turn_index, startsById.get(message?.id)?.created_at);
  }
  for (const event of cached.shell_events || []) {
    rememberTurnStart(event?.turn_index, startsById.get(event?.id)?.created_at);
  }
  const wholeTurnLatency = (item) => item?.turn_complete === true
    ? elapsedTimestampMilliseconds(startsByTurn.get(item.turn_index), item.created_at)
    : null;
  const sentResultsById = new Map(
    (cached.sent_results || []).filter((result) => result?.id).map((result) => [result.id, result]),
  );
  let sequence = 0;
  for (const item of cached.replies) {
    const reply = item && item.reply;
    if (!reply || typeof reply !== 'object') continue;
    const llmLatency = item.duration_milliseconds;
    const responseText = reply.response;
    const blocks = splitCachedMermaid(
      typeof responseText === 'string' ? responseText : item.narration,
      typeof responseText === 'string' ? 'markdown' : 'thinking',
    );
    if (typeof responseText === 'string') {
      turns.push({
        kind: 'assistant_response',
        text: responseText,
        blocks,
        llm_latency_ms: llmLatency,
        total_latency_ms: wholeTurnLatency(item),
        created_at: item.created_at,
        turn_index: item.turn_index,
        turn_complete: item.turn_complete === true,
        sequence: sequence++,
      });
    } else if (typeof reply.error === 'string') {
      turns.push({
        kind: 'error',
        text: reply.error,
        blocks,
        llm_latency_ms: llmLatency,
        total_latency_ms: wholeTurnLatency(item),
        created_at: item.created_at,
        turn_index: item.turn_index,
        turn_complete: item.turn_complete === true,
        sequence: sequence++,
      });
    } else if (Array.isArray(reply.tool_calls)) {
      const calls = reply.tool_calls.map((call) => {
        const sent = call?.id ? sentResultsById.get(call.id) : null;
        const rendered = {
          id: call?.id || '',
          name: call?.name,
          args: call?.args || {},
        };
        const result = sent;
        rendered.latency_ms = sent?.duration_milliseconds;
        if (result && 'ok' in result) rendered.ok = result.ok;
        else if (result && 'err' in result) rendered.err = result.err;
        return rendered;
      });
      turns.push({
        kind: 'tool_calls',
        calls,
        blocks,
        llm_latency_ms: llmLatency,
        total_latency_ms: wholeTurnLatency(item),
        created_at: item.created_at,
        turn_index: item.turn_index,
        turn_complete: item.turn_complete === true,
        sequence: sequence++,
      });
    }
  }
  for (const msg of cached.user_messages || []) {
    if (!msg || typeof msg.text !== 'string') continue;
    turns.push({
      kind: 'user_message',
      id: msg.id || '',
      text: msg.text,
      created_at: startsById.get(msg.id)?.created_at || msg.created_at,
      turn_index: msg.turn_index,
      sequence: sequence++,
    });
  }
  // The optimistic shell command and durable shell output merge by input id.
  const shellTurns = new Map();
  for (const event of cached.shell_events || []) {
    if (!event || typeof event.kind !== 'string') continue;
    let turn = event.id ? shellTurns.get(event.id) : null;
    if (!turn) {
      turn = {
        kind: 'tool_calls',
        source: 'shell',
        id: event.id || '',
        calls: [{
          id: event.id || '',
          name: 'bash',
          open: true,
          args: {
            script: event.script || '',
            ...(event.stdin ? { stdin: event.stdin } : {}),
          },
        }],
        blocks: [],
        created_at: startsById.get(event.id)?.created_at || event.created_at,
        turn_index: event.turn_index,
        sequence: sequence++,
      };
      if (event.id) shellTurns.set(event.id, turn);
      turns.push(turn);
    }
    const call = turn.calls[0];
    if (event.kind === 'shell_command') {
      call.args.script = event.script || call.args.script;
      if (event.stdin) call.args.stdin = event.stdin;
      turn.created_at = startsById.get(event.id)?.created_at || event.created_at || turn.created_at;
      turn.turn_index = event.turn_index ?? turn.turn_index;
    } else if (event.kind === 'shell_output') {
      call.args.script = event.script || call.args.script;
      call.ok = event.result || {};
      turn.output_created_at = event.created_at;
      turn.turn_index = event.turn_index ?? turn.turn_index;
      turn.turn_complete = event.turn_complete === true;
    }
    call.latency_ms = event.duration_milliseconds;
    turn.total_latency_ms = turn.turn_complete
      ? elapsedTimestampMilliseconds(startsById.get(event.id)?.created_at, event.created_at)
      : null;
  }
  turns.sort((a, b) => {
    if (a.created_at && b.created_at && a.created_at !== b.created_at) {
      return a.created_at.localeCompare(b.created_at);
    }
    return a.sequence - b.sequence;
  });
  return turns;
}

function elapsedTimestampMilliseconds(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = Date.parse(end || '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return Math.max(0, endMs - startMs);
}

function splitCachedMermaid(text, proseKind) {
  const source = String(text || '').replace(
    /\`\`\`markdown\\s*\\n([\\s\\S]*?)\\nmermaid\\s*\\n([\\s\\S]*?)\`\`\`/gi,
    (_, prose, diagram) => prose.trim() + '\\n\\n\`\`\`mermaid\\n' + diagram.trim() + '\\n\`\`\`',
  );
  const blocks = [];
  const pattern = /\`\`\`mermaid\\s*\\n([\\s\\S]*?)\`\`\`/gi;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const prose = source.slice(cursor, match.index).trim();
    if (prose) blocks.push({ kind: proseKind, content: prose });
    const diagram = match[1].trim();
    if (diagram) blocks.push({ kind: 'mermaid', content: diagram });
    cursor = pattern.lastIndex;
  }
  const tail = source.slice(cursor).trim();
  if (tail) blocks.push({ kind: proseKind, content: tail });
  return blocks;
}

function renderDetail(forceScroll = false) {
  const d = state.detail;
  if (!d) return;
  const main = document.getElementById('detail');

  // The composer (new-prompt / steer box) + working indicator live outside the
  // transcript and reflect the live status every poll, even when the transcript
  // itself is unchanged.
  renderComposer();

  // Skip rendering when nothing changed - otherwise the 2 s poll trashes any
  // <details> the user opened.
  const sig = JSON.stringify({
    id: d.id, status: d.status, result_kind: d.result_kind, join_name: d.join_name,
    prompt: d.prompt, backend: d.backend, effort: d.effort, turns: d.turns, final_result: d.final_result,
    pending_asks: d.pending_asks,
    input_offer: d.input_offer,
    agent_working: d.agent_working,
  });
  if (sig === state.lastSig) {
    if (forceScroll) {
      scrollTranscriptToBottom();
      focusComposer();
    }
    return;
  }

  // Capture which call cards are currently open so we can restore them.
  const openKeys = new Set();
  for (const el of main.querySelectorAll('details.call[open]')) {
    if (el.dataset.key) openKeys.add(el.dataset.key);
  }

  state.lastSig = sig;

  const phase = runPhase(d.status);
  let { label, cls: statusCls } = describeStatus(d.status, d.result_kind, d.join_name);
  // The completion child shares the per-turn user join set (so user input
  // can race the model), so a run mid-completion still reports blocked on
  // 'user' -> "your turn". Keep the chip in step with the "Agent is working…"
  // banner while the model is actually thinking.
  if (d.join_name === 'user' && agentIsWorking(d)) {
    label = 'thinking';
    statusCls = 'working';
  }
  let turnsHtml;
  if (d.turns.length > 0) {
    turnsHtml = groupTurns(d.turns).map((g, i) => renderTurnGroup(g, i)).join('');
  } else if (phase === 'terminal') {
    turnsHtml = '<p style="color: var(--muted)">No messages were recorded.</p>';
  } else if (d.input_offer) {
    turnsHtml = '<p style="color: var(--muted)">Session ready. Explore with shell or prompt the agent below.</p>';
  } else {
    turnsHtml = '<p style="color: var(--muted)">Preparing the session filesystem...</p>';
  }

  const asksHtml = (d.pending_asks && d.pending_asks.length) ? d.pending_asks.map((a) =>
    '<form class="ask" data-child="' + esc(a.id) + '">'
    + renderedMarkdownHtml('ask-question', a.question || '(no question)')
    + '<textarea name="answer" required></textarea>'
    + '<button type="submit">Answer</button>'
    + '</form>'
  ).join('') : '';

  const finalHtml = renderFinal(d);
  const pauseBtn = phase === 'active'
    ? ' &middot; <button type="button" id="pause-btn">pause</button>'
    : (phase === 'paused' ? ' &middot; <button type="button" id="unpause-btn">unpause</button>' : '');
  const cancelBtn = phase === 'terminal'
    ? ''
    : ' &middot; <button type="button" id="cancel-btn">cancel</button>';

  main.innerHTML = ''
    + '<h2>' + esc(d.prompt ? truncate(d.prompt, 80) : 'Run') + '</h2>'
    + '<div class="meta">'
    +   '<a href="' + esc(execLink(d.id)) + '" target="_blank" rel="noopener"><code>' + esc(d.id) + '</code></a>'
    +   ' &middot; <span class="status ' + esc(statusCls) + '">' + esc(label) + '</span>'
    +   ' &middot; ' + esc(ago(d.created_at))
    +   (d.backend ? ' &middot; <code>' + esc(d.backend) + '</code>' : '')
    +   (d.effort ? ' &middot; <code>effort: ' + esc(d.effort) + '</code>' : '')
    +   ' &middot; <button type="button" id="logs-toggle">logs (including nested)</button>'
    +   pauseBtn
    +   cancelBtn
    + '</div>'
    + '<div id="logs-slot">' + renderLogs() + '</div>'
    + (d.prompt ? '<div class="bubble user"><div class="label">prompt</div>' + preBlock(d.prompt) + '</div>' : '')
    + turnsHtml
    + finalHtml
    + asksHtml;

  hydrateDisplayBlocks(main, 0, forceScroll);

  for (const el of main.querySelectorAll('details.call')) {
    if (el.dataset.key && openKeys.has(el.dataset.key)) el.open = true;
  }

  for (const f of main.querySelectorAll('form.ask')) {
    f.addEventListener('submit', (ev) => {
      ev.preventDefault();
      submitAnswer(f.dataset.child, f.querySelector('textarea').value);
    });
  }

  main.querySelector('#logs-toggle')?.addEventListener('click', toggleLogs);
  main.querySelector('#pause-btn')?.addEventListener('click', () => setPaused(state.selected, false));
  main.querySelector('#unpause-btn')?.addEventListener('click', () => setPaused(state.selected, true));
  main.querySelector('#cancel-btn')?.addEventListener('click', (ev) => {
    // Two-step inline confirm: swap "cancel" for a "confirm cancel" link in place.
    const link = document.createElement('a');
    link.id = 'cancel-confirm';
    link.href = '#';
    link.textContent = 'confirm cancel';
    link.title = 'The agent stops and the run cannot be resumed';
    link.addEventListener('click', (e) => { e.preventDefault(); cancelRun(state.selected); });
    ev.currentTarget.replaceWith(link);
  });
  if (forceScroll) {
    scrollTranscriptToBottom();
    focusComposer();
  }
}

// Status -> control phase. Active runs can expose the live "send to agent" box.
function runPhase(status) {
  if (status === 'finished' || /^permanently/.test(status)) return 'terminal';
  if (status === 'paused') return 'paused';
  return 'active';
}

// The persistent composer at the bottom of the right pane is context-sensitive:
//   - no run / terminal run  -> "new conversation": create a run (model+effort).
//   - active or paused run   -> "say": steer/reply to the running agent.
// A pending ask gate owns its own inline input, so the composer defers.
function hasHumanGate(d) {
  return Boolean(d && d.pending_asks && d.pending_asks.length);
}
function shellIsWorking(d) {
  if (!d || runPhase(d.status) !== 'active') return false;
  if (state.pendingShell && state.pendingShell.runId === state.selected) return true;
  const pending = new Set();
  for (const turn of d?.turns || []) {
    if (turn.source === 'shell' && turn.id && turn.calls?.[0] && !('ok' in turn.calls[0])) {
      pending.add(turn.id);
    }
    if (turn.kind === 'tool_calls' && (turn.calls || []).some((call) =>
      call?.name === 'bash' && !('ok' in call) && !('err' in call))) return true;
  }
  return pending.size > 0;
}
function agentIsWorking(d) {
  if (!d || runPhase(d.status) !== 'active' || hasHumanGate(d)) return false;
  if (d.agent_working) return true;
  const started = new Set(d.prompt ? [0] : []);
  const completed = new Set();
  for (const turn of d.turns || []) {
    if (turn.kind === 'user_message' && Number.isInteger(turn.turn_index)) {
      started.add(turn.turn_index);
    }
    if (turn.turn_complete && Number.isInteger(turn.turn_index)) completed.add(turn.turn_index);
  }
  return [...started].some((turnIndex) => !completed.has(turnIndex));
}
function composerMode() {
  const d = state.detail;
  if (!state.selected || !d || runPhase(d.status) === 'terminal') return 'new';
  return 'say';
}
function renderComposer() {
  const d = state.detail;
  const mode = composerMode();
  const gate = hasHumanGate(d);
  const shellWorking = shellIsWorking(d);
  const agentWorking = agentIsWorking(d);
  const sessionReady = mode !== 'say' || Boolean(d?.input_offer);
  const input = document.getElementById('composer-input');
  const send = document.getElementById('composer-send');
  const selects = document.getElementById('composer-selects');
  const workingEl = document.getElementById('working');
  if (!input) return;
  const wasDisabled = input.disabled;

  workingEl.hidden = !shellWorking && !agentWorking;
  document.getElementById('working-label').textContent = shellWorking
    ? 'Shell command is running…'
    : 'Agent is working…';
  selects.style.display = mode === 'new' ? 'flex' : 'none';
  if (gate || !sessionReady) {
    input.placeholder = 'Respond to the request above...';
    if (!gate) input.placeholder = 'Preparing the session...';
    input.disabled = true;
    send.disabled = true;
  } else {
    input.disabled = false;
    send.disabled = false;
    input.placeholder = 'Message the agent, or type $ ls to run a shell command...';
  }
  if (wasDisabled && !input.disabled) setTimeout(focusComposer, 0);
}

function scrollTranscriptToBottom() {
  const main = document.getElementById('detail');
  if (!main) return;
  const scroll = () => { main.scrollTop = main.scrollHeight; };
  requestAnimationFrame(() => {
    scroll();
    requestAnimationFrame(scroll);
  });
  setTimeout(scroll, 75);
  setTimeout(scroll, 300);
  setTimeout(scroll, 1000);
}

function focusComposer() {
  const input = document.getElementById('composer-input');
  if (!input || input.disabled) return;
  try { input.focus({ preventScroll: true }); }
  catch (_) { input.focus(); }
}

function renderLogs() {
  if (!state.logsOpen) return '';
  if (!state.logs) {
    return '<div class="logs"><div class="logs-head"><span>execution logs</span></div><pre>Loading...</pre></div>';
  }
  const rows = state.logs.map((entry) => {
    const source = shortChildId(entry.execution_id || '') + ' ' + shortFfqn(entry.ffqn || '');
    const text = entry.type === 'stream' ? decodeStream(entry.payload) : String(entry.message || '');
    const level = entry.level ? ' level-' + esc(entry.level) : '';
    return '<span class="source">[' + esc(source.trim()) + ']</span> '
      + '<span class="' + level.trim() + '">' + esc(text.replace(/\\n$/, '')) + '</span>';
  });
  return '<div class="logs"><div class="logs-head"><span>execution logs · ' + rows.length
    + ' entries</span><button type="button" id="logs-refresh">refresh</button></div><pre>'
    + (rows.join('\\n') || '(no logs yet)') + '</pre></div>';
}

function shortFfqn(ffqn) {
  const slash = ffqn.lastIndexOf('/');
  return slash === -1 ? ffqn : ffqn.substring(slash + 1);
}

function decodeStream(payload) {
  try {
    const bytes = Uint8Array.from(atob(payload || ''), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch (_) { return String(payload || ''); }
}

async function toggleLogs() {
  state.logsOpen = !state.logsOpen;
  updateLogsSlot();
  if (state.logsOpen) await refreshLogs();
}

function updateLogsSlot() {
  const slot = document.getElementById('logs-slot');
  if (!slot) return;
  slot.innerHTML = renderLogs();
  slot.querySelector('#logs-refresh')?.addEventListener('click', refreshLogs);
}

async function refreshLogs() {
  if (!state.selected) return;
  if (logsRequest) return logsRequest;
  const selected = state.selected;
  const cursor = state.logsCursor;
  logsRequest = (async () => {
    try {
      const suffix = cursor ? '?cursor=' + encodeURIComponent(cursor) : '';
      const r = await fetch('/api/logs/' + encodeURIComponent(selected) + suffix, {
        headers: { accept: 'application/json' },
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
      if (selected !== state.selected) return;
      if (!state.logs) state.logs = [];
      state.logs.push(...(data.logs || []));
      state.logsCursor = data.cursor || state.logsCursor;
    } catch (e) {
      if (selected !== state.selected) return;
      if (!state.logs) state.logs = [];
      state.logs.push({ execution_id: selected, ffqn: '', level: 'error', message: String(e) });
    } finally {
      logsRequest = null;
      if (selected === state.selected) updateLogsSlot();
    }
  })();
  return logsRequest;
}

function displayBlocksHtml(blocks, latencyMs) {
  const list = blocks || [];
  // The LLM latency (request to reply) covers the whole completion, so anchor it
  // to the thinking bubble when the model narrated its reasoning; otherwise fall
  // back to the last block so the latency is never dropped.
  let anchor = -1;
  for (let i = 0; i < list.length; i += 1) if (list[i].kind === 'thinking') anchor = i;
  if (anchor === -1) anchor = list.length - 1;
  return list.map((block, index) => {
    const latency = index === anchor ? latencyHtml(latencyMs, 'LLM latency') : '';
    if (block.kind === 'thinking') {
      return '<div class="bubble thinking"><div class="bubble-head"><div class="label">thinking</div>'
        + latency + '</div>'
        + renderedMarkdownHtml('', block.content || '') + '</div>';
    }
    if (block.kind === 'mermaid') {
      return '<div class="bubble mermaid-block"><div class="bubble-head"><div class="label">diagram</div>'
        + latency + '</div>'
        + '<div class="mermaid-source" data-source="' + sourceData(block.content || '') + '"></div></div>';
    }
    return '<div class="bubble markdown"><div class="bubble-head"><div class="label">agent</div>'
      + latency + '</div>' + renderedMarkdownHtml('', block.content || '') + '</div>';
  }).join('');
}

function latencyHtml(milliseconds, title = 'latency', prefix = '') {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';
  let label;
  if (milliseconds < 1000) label = Math.round(milliseconds) + 'ms';
  else if (milliseconds < 10000) label = (milliseconds / 1000).toFixed(2) + 's';
  else if (milliseconds < 60000) label = (milliseconds / 1000).toFixed(1) + 's';
  else label = Math.floor(milliseconds / 60000) + 'm '
    + Math.round((milliseconds % 60000) / 1000) + 's';
  return '<span class="latency" title="' + esc(title) + '">' + esc(prefix + label) + '</span>';
}

function sourceData(source) {
  return esc(encodeURIComponent(source));
}

function renderedMarkdownHtml(classes, source) {
  const cls = classes ? classes + ' rendered-markdown' : 'rendered-markdown';
  return '<div class="' + esc(cls) + '" data-source="' + sourceData(source) + '"></div>';
}

function hydrateDisplayBlocks(root, attempt = 0, keepAtBottom = false) {
  let retryMarkdown = false;
  let hydrated = false;
  for (const el of root.querySelectorAll('.rendered-markdown[data-source]')) {
    const source = decodeURIComponent(el.dataset.source || '');
    if (window.marked && window.DOMPurify) {
      el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(source));
      el.removeAttribute('data-source');
      hydrated = true;
    } else {
      el.innerHTML = preBlock(source);
      retryMarkdown = true;
    }
  }
  if (hydrated && keepAtBottom) scrollTranscriptToBottom();
  if (retryMarkdown && attempt < 50) {
    setTimeout(() => hydrateDisplayBlocks(root, attempt + 1, keepAtBottom), 100);
  }

  const diagrams = [];
  for (const el of root.querySelectorAll('.mermaid-source[data-source]')) {
    el.textContent = decodeURIComponent(el.dataset.source || '');
    el.classList.add('mermaid');
    el.removeAttribute('data-source');
    diagrams.push(el);
  }
  if (diagrams.length) renderMermaidWhenReady(diagrams, 0, keepAtBottom);
}

function renderMermaidWhenReady(nodes, attempt, keepAtBottom) {
  if (typeof window.renderMermaidBlocks === 'function') {
    window.renderMermaidBlocks(nodes).catch((error) => {
      for (const el of nodes) {
        if (!el.querySelector('svg')) {
          el.className = 'render-error';
          el.textContent = 'Mermaid render failed: ' + String(error);
        }
      }
    }).finally(() => {
      if (keepAtBottom) scrollTranscriptToBottom();
    });
  } else if (attempt < 20) {
    setTimeout(() => renderMermaidWhenReady(nodes, attempt + 1, keepAtBottom), 100);
  }
}

// Group the flat timeline (agent steps, user messages, shell commands, and the
// terminal response/error) into conversation turns keyed by turn_index. A turn
// is one user input through the agent's final response, error, or yield. Items
// arrive in chronological order and carry their own turn_index; an optimistic
// item with no durable turn_index yet attaches to the turn in progress.
function groupTurns(items) {
  const groups = [];
  let current = null;
  for (const item of items) {
    const idx = Number.isInteger(item.turn_index) ? item.turn_index : null;
    if (!current || (idx !== null && current.turn_index !== null && idx !== current.turn_index)) {
      current = { turn_index: idx, items: [] };
      groups.push(current);
    }
    if (idx !== null && current.turn_index === null) current.turn_index = idx;
    current.items.push(item);
  }
  return groups;
}

// A step is one LLM invocation: a tool-calling reply or the final assistant
// response. A user-typed shell command (source 'shell') and the turn-limit
// error are turn events, not steps, so they do not count toward the step total.
function isAgentStep(item) {
  return (item.kind === 'tool_calls' && item.source !== 'shell')
    || item.kind === 'assistant_response';
}

function renderTurnGroup(group, ordinal) {
  const number = Number.isInteger(group.turn_index) ? group.turn_index + 1 : ordinal + 1;
  const stepCount = group.items.filter(isAgentStep).length;
  let toolCallCount = 0;
  for (const item of group.items) {
    if (item.kind === 'tool_calls') toolCallCount += (item.calls || []).length;
  }
  // The terminal item (final response, turn-limit error, or completed shell
  // command) carries the whole-turn latency from the user prompt to that point.
  const terminal = [...group.items].reverse().find((item) => item.turn_complete === true);
  const totalLatencyMs = terminal ? terminal.total_latency_ms : null;

  let stepNumber = 0;
  let body = '';
  for (const item of group.items) {
    if (item.kind === 'user_message') {
      body += '<div class="bubble user"><div class="label">user</div>' + preBlock(item.text) + '</div>';
    } else if (isAgentStep(item)) {
      stepNumber += 1;
      body += renderStep(item, number, stepNumber);
    } else if (item.kind === 'tool_calls') {
      body += renderShellStep(item, number);
    } else if (item.kind === 'error') {
      body += renderTurnError(item);
    }
  }
  return '<div class="turn">'
    + turnGroupHeader(number, stepCount, toolCallCount, totalLatencyMs) + body + '</div>';
}

function turnGroupHeader(number, stepCount, toolCallCount, totalLatencyMs) {
  const parts = ['Turn ' + number,
    stepCount + ' step' + (stepCount === 1 ? '' : 's'),
    toolCallCount + ' tool call' + (toolCallCount === 1 ? '' : 's')];
  return '<div class="turn-header"><span>' + esc(parts.join(' · ')) + '</span>'
    + latencyHtml(totalLatencyMs, 'total turn latency', 'total ') + '</div>';
}

// One step: the LLM latency lives in the step header (so it stays visible even
// for a silent step that emitted no narration), the narration renders beneath
// it, then the tool calls or the final-response marker.
function renderStep(step, turnNumber, stepNumber) {
  const header = '<div class="step-header"><span>Step ' + stepNumber + '</span>'
    + latencyHtml(step.llm_latency_ms, 'LLM latency', 'LLM ') + '</div>';
  if (step.kind === 'assistant_response') {
    return '<div class="step">' + header
      + '<div class="turn-final">final response</div>'
      + displayBlocksHtml(step.blocks) + '</div>';
  }
  const calls = (step.calls || []).map((call, k) =>
    renderCall(call, 't' + turnNumber + 's' + stepNumber + 'c' + k)).join('');
  return '<div class="step">' + header
    + displayBlocksHtml(step.blocks)
    + '<div class="calls">' + calls + '</div></div>';
}

// A user-typed shell command runs directly against the session, without an LLM
// step, so it renders as a bare tool call rather than a numbered step.
function renderShellStep(item, turnNumber) {
  const calls = (item.calls || []).map((call, k) =>
    renderCall(call, 't' + turnNumber + 'shell' + k)).join('');
  return '<div class="step"><div class="step-header"><span>shell command</span></div>'
    + '<div class="calls">' + calls + '</div></div>';
}

function renderTurnError(item) {
  return displayBlocksHtml(item.blocks)
    + '<div class="bubble error"><div class="bubble-head"><div class="label">error</div></div>'
    + preBlock(item.text) + '</div>';
}

function renderCall(call, keyBase) {
  const name = call && typeof call.name === 'string' ? call.name : '?';
  const callLatencyTitle = name === 'bash' ? 'bash latency' : 'tool latency';
  const argsBlock = renderCallArgs(name, call && call.args);
  const key = call.child_id || keyBase;
  const childLink = call.child_id
    ? ' <a class="child-link" href="' + esc(execLink(call.child_id)) + '" target="_blank" rel="noopener" title="open in obelisk web UI">' + esc(shortChildId(call.child_id)) + '</a>'
    : '';

  // Surface the latency in the summary so it is visible without expanding the
  // call; drop it from the expanded result heads to avoid duplication.
  const summaryLatency = latencyHtml(call.latency_ms, callLatencyTitle, 'in ');

  let pill, resultBlock;
  if ('ok' in call) {
    pill = '<span class="status-pill ok">ok</span>';
    if (name === 'bash' && isShellResult(call.ok)) {
      // Render stdout/stderr runs in write order (coalescing consecutive runs
      // of the same stream) so an error shows where it happened in the script.
      const outputChunks = call.ok.output || [];
      let streams = '';
      let ci = 0;
      while (ci < outputChunks.length) {
        const isErr = 'stderr' in outputChunks[ci];
        let text = '';
        while (ci < outputChunks.length && ('stderr' in outputChunks[ci]) === isErr) {
          text += isErr ? outputChunks[ci].stderr : outputChunks[ci].stdout;
          ci++;
        }
        streams += isErr
          ? preBlock(text, 'stderr')
          : preBlock(text);
      }
      if (!streams) streams = '<pre>(no output)</pre>';
      resultBlock = '<div class="result"><div class="response-head"><div class="key">exit '
        + esc(call.ok.exit_code) + '</div></div>' + streams + '</div>';
    } else {
      const out = typeof call.ok === 'string' ? call.ok : JSON.stringify(call.ok, null, 2);
      resultBlock = '<div class="result"><div class="response-head"><div class="key">ok</div>'
        + '</div>' + preBlock(out) + '</div>';
    }
  } else if ('err' in call) {
    pill = '<span class="status-pill err">err</span>';
    resultBlock = '<div class="result"><div class="response-head"><div class="key">err</div>'
      + '</div>' + preBlock(String(call.err)) + '</div>';
  } else {
    pill = '<span class="status-pill pending">pending</span>';
    resultBlock = '';
  }

  return '<details class="call" data-key="' + esc(key) + '"' + (call.open ? ' open' : '') + '>'
    + '<summary><code>' + esc(name) + '</code>' + childLink
    + '<span class="call-meta">' + pill + summaryLatency + '</span></summary>'
    + argsBlock
    + resultBlock
    + '</details>';
}

function isShellResult(value) {
  return value && typeof value === 'object'
    && Array.isArray(value.output)
    && Number.isInteger(value.exit_code);
}

// The bash tool's only meaningful arg is a multi-line shell script; show it
// verbatim (rendered newlines) instead of a JSON string with escaped newlines.
function renderCallArgs(name, args) {
  if (name === 'bash' && args && typeof args.script === 'string') {
    let html = '<div class="args"><div class="key">script</div>' + preBlock(args.script);
    if (typeof args.stdin === 'string' && args.stdin !== '') {
      html += '<div class="key">stdin</div>' + preBlock(args.stdin);
    }
    return html + '</div>';
  }
  const argsJson = args !== undefined ? JSON.stringify(args, null, 2) : '{}';
  return '<div class="args"><div class="key">args</div>' + preBlock(argsJson) + '</div>';
}

function shortChildId(id) {
  // Render the join_set tail (e.g. "o:7-get_1") for compactness.
  const dot = id.indexOf('.');
  return dot === -1 ? id : id.substring(dot + 1);
}

function renderFinal(d) {
  // Model-emitted responses are rendered with their turn. Fall back to the
  // workflow result only for old executions with no persisted response turn.
  const responseTurn = [...d.turns].reverse().find((t) => t.kind === 'assistant_response');
  if (responseTurn) return '';
  if (d.status !== 'finished') return '';
  const r = d.final_result;
  if (!r) return '';
  if (r.error) return '<div class="err-box">' + esc(r.error) + '</div>';
  if (typeof r.ok === 'string') return '<div class="bubble final"><div class="label">final</div>' + preBlock(r.ok) + '</div>';
  if (r.err === 'agent session cancelled') return '<p style="color: var(--muted)">Session cancelled.</p>';
  if (r.err !== undefined) return '<div class="err-box">Workflow err: ' + esc(String(r.err)) + '</div>';
  if (r.execution_failed !== undefined) return '<div class="err-box">Execution error: ' + esc(JSON.stringify(r.execution_failed)) + '</div>';
  return '';
}

function truncate(s, n) {
  return s.length > n ? s.substring(0, n) + '...' : s;
}

async function submitPrompt(prompt) {
  const btn = document.getElementById('composer-send');
  const backend = document.getElementById('new-backend')?.value || null;
  const effort = document.getElementById('new-effort')?.value || '';
  btn.disabled = true;
  try {
    const r = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, backend, effort }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    document.getElementById('composer-input').value = '';
    await refreshSidebar();
    setSelected(data.execution_id);
  } catch (e) {
    alert('Submit failed: ' + String(e));
  } finally {
    btn.disabled = false;
  }
}

async function createEmptySession() {
  const backend = document.getElementById('new-backend')?.value || null;
  const effort = document.getElementById('new-effort')?.value || '';
  try {
    const r = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend, effort }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    await refreshSidebar();
    setSelected(data.execution_id);
    return data.execution_id;
  } catch (e) {
    alert('Create session failed: ' + String(e));
    return null;
  }
}

async function createSessionForShell(script) {
  const runId = await createEmptySession();
  if (!runId) return;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await refreshDetail();
    if (state.selected === runId && state.detail?.input_offer) {
      await sendShell(runId, script);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  alert('Shell session did not become ready');
}

async function submitAnswer(childId, answer) {
  try {
    const r = await fetch('/api/answer/' + encodeURIComponent(childId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || ('HTTP ' + r.status));
    }
    await refreshDetail();
  } catch (e) {
    alert('Answer failed: ' + String(e));
  }
}

async function setPaused(runId, unpause) {
  try {
    const r = await fetch('/api/' + (unpause ? 'unpause' : 'pause') + '/' + encodeURIComponent(runId), { method: 'POST' });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || ('HTTP ' + r.status));
    }
    state.lastSig = null;
    await refreshDetail();
    await refreshSidebar();
  } catch (e) {
    alert((unpause ? 'Unpause' : 'Pause') + ' failed: ' + String(e));
  }
}

async function cancelRun(runId) {
  try {
    const r = await fetch('/api/cancel/' + encodeURIComponent(runId), { method: 'POST' });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.error || ('HTTP ' + r.status));
    }
    state.lastSig = null;
    await refreshDetail();
    await refreshSidebar();
  } catch (e) {
    alert('Cancel failed: ' + String(e));
  }
}

async function sendToAgent(runId, text) {
  const t = (text || '').trim();
  if (!t) return;
  const offer = state.detail?.input_offer || state.transcript?.input_offer;
  if (!offer?.id) return;
  const offerId = offer.id;
  const id = 'prompt-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const optimisticMessage = {
    id,
    text: t,
    created_at: new Date().toISOString(),
  };
  if (state.transcript) mergeUserMessages(state.transcript.user_messages, [optimisticMessage]);
  if (state.detail) {
    state.detail.turns = buildCachedTurns(state.detail.created_at, state.detail.prompt);
    state.detail.input_offer = null;
    if (state.transcript) state.transcript.input_offer = null;
    state.lastSig = null;
    renderDetail(true);
  }
  const box = document.getElementById('composer-input');
  if (box) box.value = '';
  scrollTranscriptToBottom();
  try {
    const r = await fetch('/api/input/' + encodeURIComponent(runId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offer_id: offerId, input: { prompt: { id, text: t } } }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    await refreshDetail();
  } catch (e) {
    if (state.transcript) {
      state.transcript.user_messages = state.transcript.user_messages.filter((message) =>
        message.id !== id);
      state.transcript.input_offer = offer;
    }
    if (state.detail) {
      state.detail.input_offer = offer;
      state.detail.turns = buildCachedTurns(state.detail.created_at, state.detail.prompt);
      state.lastSig = null;
      renderDetail();
    }
    alert('Send failed: ' + String(e));
  }
}

async function sendShell(runId, script) {
  const text = (script || '').trim();
  if (!text) return;
  const offer = state.detail?.input_offer || state.transcript?.input_offer;
  if (!offer?.id) return;
  const offerId = offer.id;
  const id = 'shell-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const optimisticEvent = {
    kind: 'shell_command',
    id,
    script: text,
    created_at: new Date().toISOString(),
  };
  state.pendingShell = { id, runId };
  if (state.transcript) mergeShellEvents(state.transcript.shell_events, [optimisticEvent]);
  if (state.detail) {
    state.detail.turns = buildCachedTurns(state.detail.created_at, state.detail.prompt);
    state.detail.input_offer = null;
    if (state.transcript) state.transcript.input_offer = null;
    state.lastSig = null;
    renderDetail(true);
  }
  const box = document.getElementById('composer-input');
  if (box) {
    box.value = '$ ';
    box.setSelectionRange(box.value.length, box.value.length);
  }
  scrollTranscriptToBottom();
  try {
    const r = await fetch('/api/input/' + encodeURIComponent(runId), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offer_id: offerId, input: { shell: { id, script: text, stdin: '' } } }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    await refreshDetail();
  } catch (e) {
    state.pendingShell = null;
    if (state.transcript) {
      state.transcript.shell_events = state.transcript.shell_events.filter((event) =>
        !(event.kind === 'shell_command' && event.id === id));
      state.transcript.input_offer = offer;
    }
    if (state.detail) {
      state.detail.input_offer = offer;
      state.detail.turns = buildCachedTurns(state.detail.created_at, state.detail.prompt);
      state.lastSig = null;
      renderDetail();
    }
    alert('Shell command failed: ' + String(e));
  }
}

function sendComposer() {
  const input = document.getElementById('composer-input');
  const raw = input.value;
  const text = raw.trim();
  if (!text) return;
  const shell = raw.startsWith('$ ');
  if (shell) {
    const script = raw.slice(2).trim();
    if (script && composerMode() === 'say') sendShell(state.selected, script);
    else if (script) createSessionForShell(script);
  } else if (composerMode() === 'say') sendToAgent(state.selected, text);
  else submitPrompt(text);
}

document.getElementById('composer-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  sendComposer();
});

// Enter sends; Shift+Enter inserts a newline (chat-composer convention).
document.getElementById('composer-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    sendComposer();
    scrollTranscriptToBottom();
  }
});

document.getElementById('new-convo').addEventListener('click', () => {
  // Reset to the empty 'new' composer so the model/effort pickers are visible and
  // the user can choose before starting. The run is created on the first prompt
  // (submitPrompt) or shell command (createSessionForShell), both of which read
  // the chosen model; creating a session here instead would lock in the default.
  setSelected(null);
  document.getElementById('composer-input').value = '';
  focusComposer();
});

async function loadModels() {
  const sel = document.getElementById('new-backend');
  if (!sel) return;
  try {
    const r = await fetch('/api/models', { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const data = await r.json();
    const models = Array.isArray(data.models) ? data.models : [];
    sel.innerHTML = models.map((m) =>
      '<option value="' + esc(m.id) + '">' + esc(m.label || m.id) + '</option>').join('');
  } catch (_) { /* leave the select empty; submit sends no backend override */ }
}

readSelectedFromUrl();
loadModels();
refreshSidebar();
refreshDetail();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearTimeout(sidebarTimer);
    clearTimeout(detailTimer);
    return;
  }
  refreshSidebar();
  refreshDetail();
});
</script>
</body>
</html>`;
