import * as vscode from "vscode";
import type { ParseMeta, UsageRecord } from "./types.js";
import { parseCustomPricing } from "./pricing.js";
import { parseUsage } from "./adapters/index.js";
import { computeContextWindow, computeCost } from "./cost.js";
import { UsageStore } from "./store.js";
import { statusBarText, statusBarTooltip, toCsv } from "./format.js";
import { startIngestServer, type IngestHandle } from "./ingest.js";
import { SourceManager } from "./sources/index.js";
import { UsageViewProvider } from "./webview.js";

const HISTORY_KEY = "aiUsageMonitor.history";
const CONFIG_SECTION = "aiUsageMonitor";

/**
 * What this extension exposes to other extensions via `getExtension().exports`.
 * A caller hands over a raw provider response plus whatever it measured; cost
 * and context are derived here so every path applies the same pricing rules.
 */
export interface AiUsageMonitorApi {
  /** Record a raw provider response. Returns undefined if no adapter matched. */
  record(payload: unknown, meta?: Partial<ParseMeta>): UsageRecord | undefined;
  /** Record an already-built record, e.g. from a caller with its own parsing. */
  recordUsage(record: UsageRecord): void;
  history(): readonly UsageRecord[];
}

let output: vscode.OutputChannel;
let store: UsageStore;
let statusBar: vscode.StatusBarItem;
let ingest: IngestHandle | undefined;
let sources: SourceManager | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<AiUsageMonitorApi> {
  output = vscode.window.createOutputChannel("AI Token Monitor");
  context.subscriptions.push(output);

  const config = () => vscode.workspace.getConfiguration(CONFIG_SECTION);

  store = new UsageStore(
    config().get<number>("history.maxEntries", 500),
    context.globalState.get<UsageRecord[]>(HISTORY_KEY, []),
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "aiUsageMonitor.showPanel";
  context.subscriptions.push(statusBar);

  const view = new UsageViewProvider(context.extensionUri, store);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(UsageViewProvider.viewType, view, {
      // Keep the rendered list across sidebar hide/show; the view is small.
      webviewOptions: { retainContextWhenHidden: true },
    }),
    view,
  );

  // Persist and repaint on every change. Persistence is fire-and-forget: a
  // failed write must not break recording, so it is logged and dropped.
  context.subscriptions.push({
    dispose: store.onDidChange((records) => {
      updateStatusBar(config().get<boolean>("statusBar.enabled", true));
      void context.globalState
        .update(HISTORY_KEY, records)
        .then(undefined, (error: unknown) => log(`failed to persist history: ${errorText(error)}`));
    }),
  });

  updateStatusBar(config().get<boolean>("statusBar.enabled", true));

  context.subscriptions.push(
    vscode.commands.registerCommand("aiUsageMonitor.showPanel", () =>
      vscode.commands.executeCommand("aiUsageMonitor.usageView.focus"),
    ),
    vscode.commands.registerCommand("aiUsageMonitor.showOutput", () => output.show()),
    vscode.commands.registerCommand("aiUsageMonitor.clearHistory", clearHistory),
    vscode.commands.registerCommand("aiUsageMonitor.exportJson", () =>
      exportHistory("json", JSON.stringify(store.all(), null, 2)),
    ),
    vscode.commands.registerCommand("aiUsageMonitor.exportCsv", () =>
      exportHistory("csv", toCsv(store.all())),
    ),
    vscode.commands.registerCommand("aiUsageMonitor.copyIngestSnippet", copyIngestSnippet),
    vscode.commands.registerCommand("aiUsageMonitor.showSources", showSources),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      store.setMaxEntries(config().get<number>("history.maxEntries", 500));
      updateStatusBar(config().get<boolean>("statusBar.enabled", true));
      if (
        event.affectsConfiguration(`${CONFIG_SECTION}.ingest.enabled`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.ingest.port`)
      ) {
        await restartIngest();
      }
      if (event.affectsConfiguration(`${CONFIG_SECTION}.sources`)) {
        // Safe to re-run: the store dedupes on request id, so re-reading the
        // same transcripts adds nothing already held.
        await startSources(context);
      }
    }),
  );

  await restartIngest();
  await startSources(context);

  context.subscriptions.push({
    dispose: () => {
      void ingest?.close();
      ingest = undefined;
      sources?.dispose();
      sources = undefined;
    },
  });

  return {
    record: (payload, meta) => {
      const record = parseUsage(payload, { source: "api", ...meta });
      if (record) {
        ingestRecord(record);
      }
      return record;
    },
    recordUsage: ingestRecord,
    history: () => store.all(),
  };
}

export function deactivate(): void {
  void ingest?.close();
  ingest = undefined;
  sources?.dispose();
  sources = undefined;
}

/**
 * The single funnel every record passes through, whatever recorded it. Cost and
 * context are attached here rather than in the adapters so that adapters stay
 * pure parsers and pricing policy lives in one place.
 */
function ingestRecord(record: UsageRecord): void {
  const custom = parseCustomPricing(
    vscode.workspace.getConfiguration(CONFIG_SECTION).get<unknown>("pricing.custom", {}),
    (model) => log(`ignoring malformed pricing.custom entry for "${model}"`),
  );

  const cost = computeCost(record.model, record.usage, custom);
  const context = computeContextWindow(record.model, record.usage, custom);

  store.add({ ...record, cost, context });
}

function updateStatusBar(enabled: boolean): void {
  if (!enabled) {
    statusBar.hide();
    return;
  }
  const latest = store.latest();
  statusBar.text = statusBarText(latest);
  statusBar.tooltip = new vscode.MarkdownString(statusBarTooltip(latest));
  statusBar.show();
}

async function clearHistory(): Promise<void> {
  const count = store.all().length;
  if (count === 0) {
    return;
  }
  // Clearing is not undoable and the history is the whole product, so confirm.
  const confirm = await vscode.window.showWarningMessage(
    `Delete all ${count} recorded requests? This cannot be undone.`,
    { modal: true },
    "Clear History",
  );
  if (confirm === "Clear History") {
    store.clear();
  }
}

async function exportHistory(kind: "json" | "csv", contents: string): Promise<void> {
  if (store.all().length === 0) {
    void vscode.window.showInformationMessage("No recorded requests to export.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = await vscode.window.showSaveDialog({
    filters: kind === "json" ? { JSON: ["json"] } : { CSV: ["csv"] },
    defaultUri: vscode.Uri.file(`ai-usage-${stamp}.${kind}`),
  });
  if (!target) {
    return;
  }

  try {
    await vscode.workspace.fs.writeFile(target, Buffer.from(contents, "utf8"));
    void vscode.window.showInformationMessage(`Exported ${store.all().length} requests.`);
  } catch (error) {
    const message = `Export failed: ${errorText(error)}`;
    log(message);
    void vscode.window.showErrorMessage(message);
  }
}

async function copyIngestSnippet(): Promise<void> {
  if (!ingest) {
    const enable = await vscode.window.showInformationMessage(
      "The ingest endpoint is off. Turn it on to post usage from your own tools?",
      "Enable",
    );
    if (enable === "Enable") {
      await vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .update("ingest.enabled", true, vscode.ConfigurationTarget.Global);
    }
    return;
  }

  // The token is per-session: it changes on every restart, so the snippet is
  // copied on demand rather than written into a config file.
  const snippet = `curl -sS -X POST http://127.0.0.1:${ingest.port}/usage \\
  -H 'authorization: Bearer ${ingest.token}' \\
  -H 'content-type: application/json' \\
  -d '{"durationMs": 1234, "response": {"model": "claude-opus-5", "usage": {"input_tokens": 1200, "output_tokens": 350, "cache_read_input_tokens": 8000}}}'

# Token is regenerated each time the extension starts; re-copy after a reload.
# Post either a raw provider response, or {"durationMs", "provider", "response"}.`;

  await vscode.env.clipboard.writeText(snippet);
  void vscode.window.showInformationMessage("Ingest snippet copied to the clipboard.");
}

/**
 * Detect locally-installed AI tools and watch them for usage.
 *
 * This is what makes the extension work without the monitored tool
 * cooperating: it reads the transcripts those tools already write. Everything
 * found is funnelled through `ingestRecord`, so automatically-discovered usage
 * is priced by exactly the same rules as anything posted to the endpoint.
 */
async function startSources(context: vscode.ExtensionContext): Promise<void> {
  sources?.dispose();

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (!config.get<boolean>("sources.enabled", true)) {
    log("automatic source detection is disabled");
    return;
  }

  const days = config.get<number>("sources.backfillDays", 1);
  // A first run would otherwise replay months of transcripts into the view.
  // Backfilling a bounded window means recent work shows up immediately while
  // the history stays recognizable as "what I did lately".
  const backfillSince =
    days > 0 ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : new Date(Date.now() + 60_000);

  sources = new SourceManager({
    backfill: days > 0,
    backfillSince,
    onRecord: ingestRecord,
    log,
  });

  // Settings list ids to turn *off*; the manager takes an enabled map, so the
  // list is inverted here rather than making every source reason about it.
  const disabled = config.get<string[]>("sources.disabled", []);
  const enabled: Record<string, boolean> = {};
  for (const id of Array.isArray(disabled) ? disabled : []) {
    enabled[id] = false;
  }

  await sources.start(enabled);

  const statuses = sources.statuses();
  const watching = statuses.filter((s) => s.watching);
  log(
    watching.length > 0
      ? `watching ${watching.length} source(s): ${watching.map((s) => s.displayName).join(", ")}`
      : "no supported AI tools detected",
  );

  // Tell the user once that monitoring is live; without this, an empty view on
  // a machine with no recent sessions is indistinguishable from a broken setup.
  const NOTICE_KEY = "aiUsageMonitor.sourceNoticeShown";
  if (watching.length > 0 && !context.globalState.get<boolean>(NOTICE_KEY, false)) {
    void context.globalState.update(NOTICE_KEY, true);
    void vscode.window.showInformationMessage(
      `AI Token Monitor is now tracking ${watching.map((s) => s.displayName).join(", ")}.`,
    );
  }
}

/** A readable report of what was found, for when the view is unexpectedly empty. */
async function showSources(): Promise<void> {
  const statuses = sources?.statuses() ?? [];

  if (statuses.length === 0) {
    void vscode.window.showInformationMessage(
      "Automatic source detection is off. Enable aiUsageMonitor.sources.enabled to track installed AI tools.",
    );
    return;
  }

  const items: vscode.QuickPickItem[] = statuses.map((status) => ({
    label: `${status.watching ? "$(check)" : status.installed ? "$(warning)" : "$(circle-slash)"} ${status.displayName}`,
    description: status.watching ? "Tracking" : (status.detail ?? "Not tracking"),
    detail: status.paths.length > 0 ? status.paths.join(", ") : undefined,
  }));

  const pick = await vscode.window.showQuickPick(
    [...items, { label: "$(output) Open Log", description: "Show detection diagnostics" }],
    { title: "AI Tokens — Detected Tools", placeHolder: "Tools this extension can read usage from" },
  );

  if (pick?.label.includes("Open Log")) {
    output.show();
  }
}

async function restartIngest(): Promise<void> {
  await ingest?.close();
  ingest = undefined;

  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  if (!config.get<boolean>("ingest.enabled", false)) {
    return;
  }

  const port = config.get<number>("ingest.port", 7337);
  try {
    ingest = await startIngestServer({ port, onRecord: ingestRecord, log });
    log(`ingest listening on http://127.0.0.1:${ingest.port}/usage (loopback only)`);
  } catch (error) {
    const message = `Could not start the ingest endpoint on port ${port}: ${errorText(error)}`;
    log(message);
    void vscode.window.showErrorMessage(message, "Show Log").then((choice) => {
      if (choice === "Show Log") {
        output.show();
      }
    });
  }
}

function log(message: string): void {
  output.appendLine(`[${new Date().toISOString()}] ${message}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
