import type { IExternalSaveLoadAdapter } from '../types';

/**
 * Chart save/load adapter.
 *
 * Backed by localStorage today because the gateway exposes no chart-storage
 * endpoint (verified against internal/httpapi/handlers/mount.go). The adapter
 * interface is the seam: a server-backed implementation drops in without any
 * component changing.
 *
 * Supplying an adapter is NOT optional. Without one, TradingView's auto-save
 * falls back to its own undefined server URLs and issues requests to
 * `/undefined/undefined/charts` — the bug the working integration hit and fixed.
 */

interface StoredChart {
  id: string;
  name: string;
  symbol: string;
  resolution: string;
  timestamp: number;
  content: string;
}

interface StoredStudyTemplate {
  name: string;
  content: string;
}

interface StoredDrawingTemplate {
  name: string;
  toolName: string;
  content: string;
}

interface StoredChartTemplate {
  name: string;
  content: unknown;
}

const KEYS = {
  charts: 'tradeplatform.tv.charts',
  studyTemplates: 'tradeplatform.tv.studyTemplates',
  drawingTemplates: 'tradeplatform.tv.drawingTemplates',
  chartTemplates: 'tradeplatform.tv.chartTemplates',
  drawings: 'tradeplatform.tv.drawings',
} as const;

/**
 * Implements the subset of `IExternalSaveLoadAdapter` the Trading Platform
 * actually calls. Cast at the boundary because the library's interface is
 * broader than the persistence this build supports, and the unsupported
 * members resolve to empty rather than throwing.
 */
export class LocalChartStorageAdapter {
  private charts: StoredChart[];
  private studyTemplates: StoredStudyTemplate[];
  private drawingTemplates: StoredDrawingTemplate[];
  private chartTemplates: StoredChartTemplate[];
  private drawings: Record<string, Record<string, unknown>>;
  private readonly storage: Storage | null;

  constructor(storage?: Storage) {
    this.storage = storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
    this.charts = this.read(KEYS.charts, []);
    this.studyTemplates = this.read(KEYS.studyTemplates, []);
    this.drawingTemplates = this.read(KEYS.drawingTemplates, []);
    this.chartTemplates = this.read(KEYS.chartTemplates, []);
    this.drawings = this.read(KEYS.drawings, {});
  }

  // ── charts ─────────────────────────────────────────────────────────────────

  async getAllCharts(): Promise<StoredChart[]> {
    return this.charts;
  }

  async removeChart(id: string | number): Promise<void> {
    this.charts = this.charts.filter((chart) => chart.id !== String(id));
    this.write(KEYS.charts, this.charts);
  }

  async saveChart(chartData: {
    id?: string | number;
    name: string;
    symbol: string;
    resolution: string;
    content: string;
  }): Promise<string> {
    const id = chartData.id ? String(chartData.id) : `chart-${Date.now().toString(36)}`;
    const record: StoredChart = {
      id,
      name: chartData.name,
      symbol: chartData.symbol,
      resolution: chartData.resolution,
      content: chartData.content,
      timestamp: Math.floor(Date.now() / 1000),
    };
    this.charts = [...this.charts.filter((chart) => chart.id !== id), record];
    this.write(KEYS.charts, this.charts);
    return id;
  }

  async getChartContent(id: string | number): Promise<string> {
    const chart = this.charts.find((c) => c.id === String(id));
    if (!chart) throw new Error(`Chart ${id} not found`);
    return chart.content;
  }

  // ── study templates ────────────────────────────────────────────────────────

  async getAllStudyTemplates(): Promise<StoredStudyTemplate[]> {
    return this.studyTemplates;
  }

  async removeStudyTemplate(info: { name: string }): Promise<void> {
    this.studyTemplates = this.studyTemplates.filter((t) => t.name !== info.name);
    this.write(KEYS.studyTemplates, this.studyTemplates);
  }

  async saveStudyTemplate(template: { name: string; content: string }): Promise<void> {
    this.studyTemplates = [
      ...this.studyTemplates.filter((t) => t.name !== template.name),
      { name: template.name, content: template.content },
    ];
    this.write(KEYS.studyTemplates, this.studyTemplates);
  }

  async getStudyTemplateContent(info: { name: string }): Promise<string> {
    const template = this.studyTemplates.find((t) => t.name === info.name);
    if (!template) throw new Error(`Study template ${info.name} not found`);
    return template.content;
  }

  // ── drawing templates ──────────────────────────────────────────────────────

  async getDrawingTemplates(toolName: string): Promise<string[]> {
    return this.drawingTemplates.filter((t) => t.toolName === toolName).map((t) => t.name);
  }

  async loadDrawingTemplate(toolName: string, templateName: string): Promise<string> {
    const template = this.drawingTemplates.find(
      (t) => t.toolName === toolName && t.name === templateName,
    );
    if (!template) throw new Error(`Drawing template ${templateName} not found`);
    return template.content;
  }

  async saveDrawingTemplate(
    toolName: string,
    templateName: string,
    content: string,
  ): Promise<void> {
    this.drawingTemplates = [
      ...this.drawingTemplates.filter((t) => !(t.toolName === toolName && t.name === templateName)),
      { toolName, name: templateName, content },
    ];
    this.write(KEYS.drawingTemplates, this.drawingTemplates);
  }

  async removeDrawingTemplate(toolName: string, templateName: string): Promise<void> {
    this.drawingTemplates = this.drawingTemplates.filter(
      (t) => !(t.toolName === toolName && t.name === templateName),
    );
    this.write(KEYS.drawingTemplates, this.drawingTemplates);
  }

  // ── chart templates ────────────────────────────────────────────────────────

  async getAllChartTemplates(): Promise<string[]> {
    return this.chartTemplates.map((t) => t.name);
  }

  async saveChartTemplate(name: string, content: unknown): Promise<void> {
    this.chartTemplates = [
      ...this.chartTemplates.filter((t) => t.name !== name),
      { name, content },
    ];
    this.write(KEYS.chartTemplates, this.chartTemplates);
  }

  async removeChartTemplate(name: string): Promise<void> {
    this.chartTemplates = this.chartTemplates.filter((t) => t.name !== name);
    this.write(KEYS.chartTemplates, this.chartTemplates);
  }

  async getChartTemplateContent(name: string): Promise<{ content?: unknown }> {
    const template = this.chartTemplates.find((t) => t.name === name);
    return { content: template?.content };
  }

  // ── drawings (line tools) ──────────────────────────────────────────────────

  async saveLineToolsAndGroups(
    layoutId: string | undefined,
    chartId: string | number,
    state: { sources?: Map<string, unknown> } | null,
  ): Promise<void> {
    if (!state?.sources) return;
    const key = `${layoutId ?? 'default'}/${chartId}`;
    const layout: Record<string, unknown> = { ...(this.drawings[key] ?? {}) };

    for (const [id, source] of state.sources) {
      // A null state is how the library signals a deleted drawing.
      if (source === null) delete layout[id];
      else layout[id] = source;
    }

    this.drawings = { ...this.drawings, [key]: layout };
    this.write(KEYS.drawings, this.drawings);
  }

  async loadLineToolsAndGroups(
    layoutId: string | undefined,
    chartId: string | number,
  ): Promise<{ sources: Map<string, unknown> } | null> {
    const key = `${layoutId ?? 'default'}/${chartId}`;
    const layout = this.drawings[key];
    if (!layout) return null;
    return { sources: new Map(Object.entries(layout)) };
  }

  // ── storage helpers ────────────────────────────────────────────────────────

  private read<T>(key: string, fallback: T): T {
    if (!this.storage) return fallback;
    try {
      const raw = this.storage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      // Corrupt chart storage must not stop the chart from opening.
      return fallback;
    }
  }

  private write(key: string, value: unknown): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      // Chart layouts are large; a quota failure loses a save but nothing else.
    }
  }
}

/** Typed as the library's interface at the single boundary point. */
export function createSaveLoadAdapter(storage?: Storage): IExternalSaveLoadAdapter {
  return new LocalChartStorageAdapter(storage) as unknown as IExternalSaveLoadAdapter;
}
