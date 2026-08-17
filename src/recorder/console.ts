import type { ConsoleEntry } from "./types";

type ArgV = { type: string; value?: unknown; description?: string };
type ConsoleEvt = { type: string; args?: ArgV[]; stackTrace?: { callFrames?: { url?: string; lineNumber?: number }[] } };
type ExceptionEvt = { exceptionDetails: { text?: string; exception?: { description?: string }; url?: string; lineNumber?: number; stackTrace?: unknown } };
type LogEvt = { entry: { source?: string; level?: string; text?: string; url?: string; lineNumber?: number } };

const ERROR_LEVELS = new Set(["error", "warning", "warn"]);

function argText(a: ArgV): string {
  if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  return a.description ?? "";
}

export class ConsoleBuffer {
  private entries: ConsoleEntry[] = [];
  private byKey = new Map<string, ConsoleEntry>();
  private seqMax = 0;

  private add(seq: number, level: string, text: string, extra: Partial<ConsoleEntry> = {}): void {
    this.seqMax = Math.max(this.seqMax, seq);
    const key = `${level}|${text}`;
    const existing = this.byKey.get(key);
    if (existing) { existing.count++; existing.seq = seq; return; }
    const entry: ConsoleEntry = { seq, level, text, count: 1, source: "console", ...extra };
    this.byKey.set(key, entry); this.entries.push(entry);
  }

  consoleAPICalled(seq: number, e: ConsoleEvt): void {
    const text = (e.args ?? []).map(argText).join(" ");
    const frame = e.stackTrace?.callFrames?.[0];
    this.add(seq, e.type, text, { source: "console", url: frame?.url, line: frame?.lineNumber });
  }

  exceptionThrown(seq: number, e: ExceptionEvt): void {
    const d = e.exceptionDetails;
    const text = d.exception?.description ?? d.text ?? "Uncaught exception";
    this.add(seq, "error", text.split("\n")[0]!, { source: "exception", url: d.url, line: d.lineNumber, stack: d.exception?.description ?? d.text });
  }

  logEntry(seq: number, e: LogEvt): void {
    const en = e.entry;
    this.add(seq, en.level ?? "info", en.text ?? "", { source: en.source ?? "log", url: en.url, line: en.lineNumber });
  }

  list(filter: { level?: string; pattern?: string } = {}): ConsoleEntry[] {
    let rows = [...this.entries];
    if (filter.level) rows = rows.filter((e) => e.level === filter.level);
    if (filter.pattern) { const re = new RegExp(filter.pattern, "i"); rows = rows.filter((e) => re.test(e.text)); }
    return rows;
  }

  errors(): ConsoleEntry[] { return this.entries.filter((e) => ERROR_LEVELS.has(e.level)); }
  sinceSeq(seq: number): ConsoleEntry[] { return this.entries.filter((e) => e.seq > seq); }
  maxSeq(): number { return this.seqMax; }
}
