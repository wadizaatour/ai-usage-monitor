import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { UsageStore } from "./store.js";
import { buildState } from "./view-state.js";
import { UNAVAILABLE } from "./format.js";

/**
 * The Requests view.
 *
 * Structure: a summary that is always visible, then collapsible sections. The
 * history is long and mostly uninteresting at a glance, so it is collapsed by
 * default and each row stays a single line until expanded. Only the most recent
 * request is shown up front, because that is the one you are usually waiting on.
 *
 * All formatting happens here in the extension host and the webview receives
 * pre-rendered strings. That means the webview script never does arithmetic on
 * usage numbers, so there is exactly one place where "Unavailable" is decided.
 *
 * The page runs under a strict CSP with a per-load nonce: no inline handlers,
 * no remote origins, no eval. Records can contain provider-supplied text
 * (model ids, error messages), so every value is inserted with textContent,
 * never innerHTML.
 */

export class UsageViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "aiUsageMonitor.usageView";

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: UsageStore,
  ) {
    this.disposables.push({ dispose: this.store.onDidChange(() => this.refresh()) });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      // Nothing is loaded from disk today, but scoping the root now means a
      // future asset cannot accidentally be served from outside the extension.
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!isRecord(message)) {
        return;
      }
      if (message.type === "ready") {
        this.refresh();
      } else if (message.type === "command" && typeof message.command === "string") {
        // Only this view's own commands, so a compromised webview cannot reach
        // arbitrary extension commands.
        const allowed = new Set([
          "aiUsageMonitor.exportCsv",
          "aiUsageMonitor.exportJson",
          "aiUsageMonitor.clearHistory",
          "aiUsageMonitor.showSources",
        ]);
        if (allowed.has(message.command)) {
          void vscode.commands.executeCommand(message.command);
        }
      }
    });

    view.onDidDispose(() => {
      this.view = undefined;
    });

    this.refresh();
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }

  private refresh(): void {
    if (!this.view) {
      return;
    }
    void this.view.webview.postMessage({ type: "state", state: buildState(this.store.all()) });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>AI Tokens</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0 0 12px;
    margin: 0;
  }
  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(84px, 1fr));
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  .stat-label {
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }
  .stat-value { font-size: 1.15em; font-variant-numeric: tabular-nums; }
  .caveat { grid-column: 1 / -1; font-size: 0.85em; opacity: 0.75; }

  /* Collapsible section. <details>/<summary> gives us working disclosure with
     no JS state to keep in sync, and the open/closed state survives re-renders
     because we reuse the element rather than rebuilding it. */
  details { border-bottom: 1px solid var(--vscode-panel-border); }
  details > summary {
    cursor: pointer;
    padding: 7px 12px;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.8;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 6px;
    list-style: none;
  }
  details > summary::-webkit-details-marker { display: none; }
  details > summary:hover { background: var(--vscode-list-hoverBackground); }
  details > summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  /* Rotating caret, so open/closed is obvious without an icon font. */
  .caret {
    flex: none;
    width: 0; height: 0;
    border-left: 4px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    transition: transform 0.12s ease;
  }
  details[open] > summary .caret { transform: rotate(90deg); }
  .count {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
    text-transform: none;
    letter-spacing: 0;
  }

  .section-label {
    padding: 10px 12px 4px;
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    opacity: 0.7;
  }

  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th { font-weight: 600; opacity: 0.7; font-size: 0.85em; }
  td.num, th.num { text-align: right; }

  /* A request row: one line collapsed, detail grid when open. */
  .request { border-bottom: 1px solid var(--vscode-panel-border); }
  .request:last-child { border-bottom: none; }
  .request > summary { text-transform: none; letter-spacing: 0; opacity: 1; padding: 6px 12px; }
  .request-model {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .request-headline { opacity: 0.75; font-size: 0.9em; flex: none; }
  .request-cost { font-variant-numeric: tabular-nums; flex: none; margin-left: 4px; }
  .request-time { opacity: 0.55; font-size: 0.85em; flex: none; }
  .latest .request-model::before {
    content: "";
    display: inline-block;
    width: 6px; height: 6px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--vscode-charts-green, var(--vscode-progressBar-background));
    vertical-align: middle;
  }

  .fields {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 6px 12px;
    padding: 2px 12px 10px;
  }
  .field-label { font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; }
  .field-value { font-variant-numeric: tabular-nums; }
  .note { padding: 0 12px 10px; font-size: 0.9em; opacity: 0.8; }
  .note.error { color: var(--vscode-errorForeground); opacity: 1; }

  .gauge { height: 3px; background: var(--vscode-panel-border); border-radius: 2px; overflow: hidden; margin: 0 12px 10px; }
  .gauge > div { height: 100%; background: var(--vscode-progressBar-background); }

  .unavailable { opacity: 0.55; font-style: italic; }
  .error-text { color: var(--vscode-errorForeground); }

  .actions { display: flex; gap: 6px; padding: 10px 12px 0; flex-wrap: wrap; }
  button {
    font-family: inherit;
    font-size: 0.9em;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 2px;
    padding: 3px 9px;
    cursor: pointer;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

  .empty { padding: 24px 12px; opacity: 0.7; line-height: 1.5; }
  code {
    font-family: var(--vscode-editor-font-family);
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
  }
</style>
</head>
<body>
  <div class="summary" id="summary"></div>

  <div id="latest-wrap" hidden>
    <div class="section-label">Latest request</div>
    <div id="latest"></div>
  </div>

  <details id="history-section" hidden>
    <summary><span class="caret"></span>Request history<span class="count" id="history-count"></span></summary>
    <div id="history"></div>
    <div class="actions">
      <button type="button" data-command="aiUsageMonitor.exportCsv">Export CSV</button>
      <button type="button" data-command="aiUsageMonitor.exportJson">Export JSON</button>
      <button type="button" data-command="aiUsageMonitor.clearHistory">Clear</button>
    </div>
  </details>

  <details id="models-section" hidden>
    <summary><span class="caret"></span>By model<span class="count" id="models-count"></span></summary>
    <div id="models"></div>
  </details>

  <div class="empty" id="empty">
    No requests recorded yet. If you have Claude Code installed, requests appear here as you make them —
    run <code>AI Tokens: Show Detected Tools</code> to check what was found.
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const UNAVAILABLE = ${JSON.stringify(UNAVAILABLE)};

  const summaryEl = document.getElementById("summary");
  const latestWrap = document.getElementById("latest-wrap");
  const latestEl = document.getElementById("latest");
  const historySection = document.getElementById("history-section");
  const historyEl = document.getElementById("history");
  const historyCount = document.getElementById("history-count");
  const modelsSection = document.getElementById("models-section");
  const modelsEl = document.getElementById("models");
  const modelsCount = document.getElementById("models-count");
  const emptyEl = document.getElementById("empty");

  /** Every insertion point goes through here: text only, never markup. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) {
      node.textContent = text;
      if (text === UNAVAILABLE) node.classList.add("unavailable");
    }
    return node;
  }

  function stat(label, value, absent) {
    const wrap = el("div");
    const valueEl = el("div", "stat-value", value);
    if (absent) valueEl.classList.add("unavailable");
    wrap.append(el("div", "stat-label", label), valueEl);
    return wrap;
  }

  /**
   * One request as a <details>. Collapsed it is a single line; open it shows
   * the full field grid. Which rows are open is remembered across re-renders
   * so a background update does not collapse something being read.
   */
  const openRows = new Set();

  function requestRow(row, isLatest) {
    const details = el("details", isLatest ? "request latest" : "request");
    if (openRows.has(row.id) || (isLatest && openRows.has("__latest__"))) details.open = true;

    details.addEventListener("toggle", () => {
      const key = isLatest ? "__latest__" : row.id;
      if (details.open) openRows.add(key);
      else openRows.delete(key);
    });

    const summary = el("summary");
    const model = el("span", "request-model", row.model);
    if (row.status === "error") model.classList.add("error-text");

    const cost = el("span", "request-cost", row.cost);
    if (row.costAbsent) cost.classList.add("unavailable");
    cost.title = row.costTitle;

    summary.append(
      el("span", "caret"),
      model,
      el("span", "request-headline", row.headline),
      cost,
      el("span", "request-time", row.time),
    );
    details.append(summary);

    const fields = el("div", "fields");
    for (const field of row.fields) {
      const cell = el("div");
      const value = el("div", "field-value", field.value);
      if (field.absent) value.classList.add("unavailable");
      cell.append(el("div", "field-label", field.label), value);
      fields.append(cell);
    }
    details.append(fields);

    if (typeof row.contextPct === "number") {
      const gauge = el("div", "gauge");
      const fill = el("div");
      fill.style.width = Math.min(100, row.contextPct) + "%";
      gauge.append(fill);
      details.append(gauge);
    }

    if (row.note) {
      details.append(el("div", row.status === "error" ? "note error" : "note", row.note));
    }

    return details;
  }

  function render(state) {
    summaryEl.replaceChildren(
      stat("Requests", state.summary.requests, false),
      stat("Errors", state.summary.errors, false),
      stat("Tokens", state.summary.tokens, false),
      stat("Cost", state.summary.cost, state.summary.costAbsent),
    );
    if (state.summary.costCaveat) {
      summaryEl.append(el("div", "caveat", state.summary.costCaveat));
    }

    if (state.latest) {
      latestEl.replaceChildren(requestRow(state.latest, true));
      latestWrap.hidden = false;
    } else {
      latestEl.replaceChildren();
      latestWrap.hidden = true;
    }

    historyEl.replaceChildren();
    for (const row of state.history) historyEl.append(requestRow(row, false));
    historyCount.textContent = String(state.history.length);
    historySection.hidden = state.history.length === 0;

    modelsEl.replaceChildren();
    if (state.models.length > 0) {
      const table = el("table");
      const head = el("tr");
      head.append(el("th", null, "Model"), el("th", "num", "Reqs"), el("th", "num", "Tokens"), el("th", "num", "Cost"));
      table.append(head);
      for (const m of state.models) {
        const tr = el("tr");
        tr.append(el("td", null, m.model), el("td", "num", m.requests), el("td", "num", m.tokens), el("td", "num", m.cost));
        table.append(tr);
      }
      modelsEl.append(table);
    }
    modelsCount.textContent = String(state.models.length);
    modelsSection.hidden = state.models.length === 0;

    emptyEl.hidden = state.latest !== undefined;
  }

  // Delegated, so the CSP-forbidden inline handlers are never needed.
  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-command]");
    if (button) vscode.postMessage({ type: "command", command: button.dataset.command });
  });

  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "state") render(event.data.state);
  });

  vscode.postMessage({ type: "ready" });
</script>
</body>
</html>`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
