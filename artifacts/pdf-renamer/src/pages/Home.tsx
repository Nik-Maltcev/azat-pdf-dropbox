import { useState, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";

interface PdfFields {
  customer: string | null;
  customerDrawingNo: string | null;
  orderNo: string | null;
}

interface PdfFile {
  id: string;
  originalName: string;
  path: string;
  fields: PdfFields;
  newName: string | null;
  status: "ready" | "unresolved" | "error";
  error?: string;
  processed: number;
  total: number;
}

type RenameStatus = "idle" | "renamed" | "error" | "skipped";

interface RenameResult {
  path: string;
  newName?: string;
  newPath?: string;
  status: RenameStatus;
  error?: string;
  reason?: string;
}

type FilterType = "all" | "ready" | "unresolved" | "error";

const PAGE_SIZE = 100;

export default function Home() {
  const { toast } = useToast();
  const [scanning, setScanning] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [total, setTotal] = useState(0);
  const [processed, setProcessed] = useState(0);
  const [done, setDone] = useState(false);

  const [files, setFiles] = useState<PdfFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renameResults, setRenameResults] = useState<Record<string, RenameResult>>({});
  const [filter, setFilter] = useState<FilterType>("all");
  const [page, setPage] = useState(0);

  const esRef = useRef<EventSource | null>(null);

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  const startScan = useCallback(() => {
    if (esRef.current) esRef.current.close();
    setFiles([]);
    setSelected(new Set());
    setRenameResults({});
    setTotal(0);
    setProcessed(0);
    setDone(false);
    setFilter("all");
    setPage(0);
    setScanning(true);
    setStatusMsg("Подключение к Dropbox...");

    const es = new EventSource(`${BASE}/api/dropbox/scan`);
    esRef.current = es;

    es.addEventListener("status", (e) => {
      const d = JSON.parse(e.data);
      setStatusMsg(d.message);
    });

    es.addEventListener("listing", (e) => {
      const d = JSON.parse(e.data);
      setStatusMsg(`Получаем список: найдено ${d.found} PDF...`);
    });

    es.addEventListener("total", (e) => {
      const d = JSON.parse(e.data);
      setTotal(d.total);
      setStatusMsg(`Начинаем обработку ${d.total} файлов...`);
    });

    es.addEventListener("file", (e) => {
      const d: PdfFile = JSON.parse(e.data);
      setProcessed(d.processed);
      setFiles((prev) => [...prev, d]);
      if (d.status === "ready") {
        setSelected((prev) => {
          const next = new Set(prev);
          next.add(d.path);
          return next;
        });
      }
    });

    es.addEventListener("done", (e) => {
      const d = JSON.parse(e.data);
      setDone(true);
      setScanning(false);
      setStatusMsg(`Готово. Обработано: ${d.processed} из ${d.total} файлов.`);
      es.close();
    });

    es.addEventListener("error", (e) => {
      const d = JSON.parse((e as MessageEvent).data || '{"message":"Неизвестная ошибка"}');
      setScanning(false);
      setStatusMsg(`Ошибка: ${d.message}`);
      toast({ title: "Ошибка сканирования", description: d.message, variant: "destructive" });
      es.close();
    });

    es.onerror = () => {
      if (done) return;
      setScanning(false);
      es.close();
    };
  }, [BASE, done, toast]);

  async function renameSelected() {
    const toRename = files
      .filter((f) => selected.has(f.path) && f.newName && !renameResults[f.path])
      .map((f) => ({ path: f.path, newName: f.newName! }));

    if (toRename.length === 0) {
      toast({ title: "Нечего переименовывать", description: "Выберите файлы со статусом Готов, которые ещё не переименованы." });
      return;
    }

    setRenaming(true);
    try {
      const CHUNK = 500;
      const allResults: RenameResult[] = [];
      for (let i = 0; i < toRename.length; i += CHUNK) {
        const chunk = toRename.slice(i, i + CHUNK);
        const res = await fetch(`${BASE}/api/dropbox/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: chunk }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || res.statusText);
        }
        const json: { results: RenameResult[] } = await res.json();
        allResults.push(...json.results);
      }

      const resultMap: Record<string, RenameResult> = {};
      for (const r of allResults) resultMap[r.path] = r;
      setRenameResults((prev) => ({ ...prev, ...resultMap }));

      const renamed = allResults.filter((r) => r.status === "renamed").length;
      const errors = allResults.filter((r) => r.status === "error").length;
      toast({
        title: renamed > 0 ? `Переименовано: ${renamed} файл(ов)` : "Готово",
        description: errors > 0 ? `Ошибок: ${errors}` : undefined,
        variant: errors > 0 ? "destructive" : "default",
      });
    } catch (e: any) {
      toast({ title: "Ошибка переименования", description: e.message, variant: "destructive" });
    } finally {
      setRenaming(false);
    }
  }

  function toggleSelect(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  const filteredFiles = files.filter((f) => {
    if (filter === "all") return true;
    return f.status === filter;
  });

  const totalPages = Math.ceil(filteredFiles.length / PAGE_SIZE);
  const pageFiles = filteredFiles.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const readyCount = files.filter((f) => f.status === "ready").length;
  const unresolvedCount = files.filter((f) => f.status === "unresolved").length;
  const errorCount = files.filter((f) => f.status === "error").length;
  const renamedCount = Object.values(renameResults).filter((r) => r.status === "renamed").length;

  const progress = total > 0 ? Math.round((processed / total) * 100) : 0;

  const allReadySelected = readyCount > 0 && files.filter((f) => f.status === "ready").every((f) => selected.has(f.path));

  function toggleAllReady() {
    const readyPaths = files.filter((f) => f.status === "ready").map((f) => f.path);
    if (allReadySelected) setSelected(new Set());
    else setSelected(new Set(readyPaths));
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card shadow-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0">
            <svg className="w-4 h-4 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-semibold text-foreground leading-tight">PDF Renamer</h1>
            <p className="text-xs text-muted-foreground">Dropbox / Walterscheid</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={startScan}
              disabled={scanning}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
            >
              {scanning ? (
                <>
                  <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Сканирование...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {files.length > 0 ? "Обновить" : "Загрузить из Dropbox"}
                </>
              )}
            </button>

            {files.length > 0 && (
              <button
                onClick={renameSelected}
                disabled={renaming || selected.size === 0}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition disabled:opacity-50"
              >
                {renaming ? (
                  <>
                    <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    Переименование...
                  </>
                ) : (
                  <>
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    Переименовать ({selected.size})
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-5 space-y-4">
        {/* Progress bar */}
        {(scanning || (files.length > 0 && !done)) && (
          <div className="bg-card border border-card-border rounded-xl p-4 shadow-sm space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground font-medium">{statusMsg}</span>
              <span className="text-muted-foreground tabular-nums">
                {processed.toLocaleString()} / {total > 0 ? total.toLocaleString() : "..."} файлов
              </span>
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: total > 0 ? `${progress}%` : "0%" }}
              />
            </div>
            {total > 0 && (
              <p className="text-xs text-muted-foreground">{progress}% — обрабатывается по {15} файлов параллельно</p>
            )}
          </div>
        )}

        {done && statusMsg && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-2.5 text-sm text-green-800 flex items-center gap-2">
            <svg className="w-4 h-4 text-green-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {statusMsg}
          </div>
        )}

        {/* Stats */}
        {files.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Всего", value: files.length, color: "text-foreground", f: "all" as FilterType },
              { label: "Готовы", value: readyCount, color: "text-blue-600", f: "ready" as FilterType },
              { label: "Не распознаны", value: unresolvedCount, color: "text-amber-600", f: "unresolved" as FilterType },
              { label: "Переименовано", value: renamedCount, color: "text-green-600", f: "all" as FilterType },
            ].map((s) => (
              <button
                key={s.label}
                onClick={() => { setFilter(s.f); setPage(0); }}
                className={`bg-card border rounded-xl p-3 shadow-sm text-left hover:opacity-80 transition ${filter === s.f && s.f !== "all" ? "border-primary ring-1 ring-primary" : "border-card-border"}`}
              >
                <div className={`text-xl font-bold tabular-nums ${s.color}`}>{s.value.toLocaleString()}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{s.label}</div>
              </button>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!scanning && files.length === 0 && (
          <div className="border-2 border-dashed border-border rounded-2xl p-16 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent flex items-center justify-center">
              <svg className="w-8 h-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-foreground">Нет загруженных файлов</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Нажмите «Загрузить из Dropbox» для сканирования папки /Walterscheid. Результаты появятся в реальном времени.
            </p>
          </div>
        )}

        {/* Filter tabs + select all */}
        {files.length > 0 && (
          <div className="flex items-center gap-3 flex-wrap">
            {(["all", "ready", "unresolved", "error"] as FilterType[]).map((f) => {
              const labels: Record<FilterType, string> = { all: "Все", ready: "Готовы", unresolved: "Не распознаны", error: "Ошибки" };
              return (
                <button
                  key={f}
                  onClick={() => { setFilter(f); setPage(0); }}
                  className={`px-3 py-1 rounded-full text-sm font-medium transition ${filter === f ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70"}`}
                >
                  {labels[f]}
                </button>
              );
            })}
            <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
              <button onClick={toggleAllReady} className="hover:text-foreground transition">
                {allReadySelected ? "Снять все Готовые" : "Выбрать все Готовые"}
              </button>
              <span>·</span>
              <span>{filteredFiles.length.toLocaleString()} в фильтре</span>
            </div>
          </div>
        )}

        {/* File table */}
        {pageFiles.length > 0 && (
          <div className="bg-card border border-card-border rounded-xl shadow-sm overflow-hidden">
            <div className="divide-y divide-border">
              {pageFiles.map((file) => {
                const result = renameResults[file.path];
                const isSelected = selected.has(file.path);
                const canSelect = file.status === "ready" && !result;

                return (
                  <div
                    key={file.path}
                    className={`px-4 py-2.5 transition-colors ${isSelected && !result ? "bg-blue-50/50" : result?.status === "renamed" ? "bg-green-50/30" : "hover:bg-muted/10"}`}
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => canSelect && toggleSelect(file.path)}
                        disabled={!canSelect}
                        className="w-4 h-4 rounded accent-primary cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
                      />
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-mono text-foreground" title={file.originalName}>
                            {file.originalName}
                          </span>
                          <StatusBadge status={file.status} result={result} />
                        </div>

                        <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
                          <span>Клиент: <span className="text-foreground">{file.fields.customer ?? "—"}</span></span>
                          <span>Чертёж: <span className="text-foreground">{file.fields.customerDrawingNo ?? "—"}</span></span>
                          <span>Заказ: <span className="text-foreground">{file.fields.orderNo ?? "—"}</span></span>
                        </div>

                        {file.newName && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <span>→</span>
                            <span className={`font-mono ${result?.status === "renamed" ? "text-green-600 font-semibold" : ""}`}>
                              {result?.newName ?? file.newName}
                            </span>
                          </div>
                        )}

                        {(file.error || result?.error) && (
                          <p className="text-xs text-destructive">{file.error ?? result?.error}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 rounded-lg bg-muted text-sm font-medium disabled:opacity-40 hover:bg-muted/70 transition"
            >
              ← Назад
            </button>
            <span className="text-sm text-muted-foreground">
              Страница {page + 1} из {totalPages} ({filteredFiles.length.toLocaleString()} файлов)
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-3 py-1.5 rounded-lg bg-muted text-sm font-medium disabled:opacity-40 hover:bg-muted/70 transition"
            >
              Вперёд →
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function StatusBadge({ status, result }: { status: PdfFile["status"]; result?: RenameResult }) {
  if (result) {
    if (result.status === "renamed") {
      return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          Переименован
        </span>
      );
    }
    if (result.status === "error") {
      return <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Ошибка</span>;
    }
    if (result.status === "skipped") {
      return <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Пропущен</span>;
    }
  }

  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
        Готов
      </span>
    );
  }
  if (status === "error") {
    return <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Ошибка чтения</span>;
  }
  return <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">Не распознан</span>;
}
