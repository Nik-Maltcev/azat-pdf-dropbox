import { useState } from "react";
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
}

interface ListResponse {
  folder: string;
  files: PdfFile[];
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

export default function Home() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [data, setData] = useState<ListResponse | null>(null);
  const [renameResults, setRenameResults] = useState<Record<string, RenameResult>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

  async function loadFiles() {
    setLoading(true);
    setRenameResults({});
    setSelected(new Set());
    try {
      const res = await fetch(`${BASE}/api/dropbox/list`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const json: ListResponse = await res.json();
      setData(json);
      const readyPaths = new Set(
        json.files.filter((f) => f.status === "ready").map((f) => f.path)
      );
      setSelected(readyPaths);
    } catch (e: any) {
      toast({ title: "Ошибка загрузки", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  async function renameSelected() {
    if (!data) return;
    const toRename = data.files
      .filter((f) => selected.has(f.path) && f.newName)
      .map((f) => ({ path: f.path, newName: f.newName! }));

    if (toRename.length === 0) {
      toast({ title: "Нечего переименовывать", description: "Выберите файлы со статусом 'Готов'" });
      return;
    }

    setRenaming(true);
    try {
      const res = await fetch(`${BASE}/api/dropbox/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: toRename }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      const json: { results: RenameResult[] } = await res.json();
      const resultMap: Record<string, RenameResult> = {};
      for (const r of json.results) resultMap[r.path] = r;
      setRenameResults(resultMap);

      const renamed = json.results.filter((r) => r.status === "renamed").length;
      const errors = json.results.filter((r) => r.status === "error").length;
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

  function toggleAll() {
    if (!data) return;
    const ready = data.files.filter((f) => f.status === "ready").map((f) => f.path);
    if (ready.every((p) => selected.has(p))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(ready));
    }
  }

  const readyCount = data?.files.filter((f) => f.status === "ready").length ?? 0;
  const allSelected = readyCount > 0 && data?.files.filter((f) => f.status === "ready").every((f) => selected.has(f.path));

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card shadow-sm">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center">
            <svg className="w-5 h-5 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-lg font-semibold text-foreground leading-tight">PDF Renamer</h1>
            <p className="text-xs text-muted-foreground">Dropbox / Walterscheid</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {/* Controls */}
        <div className="flex items-center gap-3">
          <button
            onClick={loadFiles}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {loading ? (
              <>
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Загрузка...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Загрузить файлы из Dropbox
              </>
            )}
          </button>

          {data && (
            <button
              onClick={renameSelected}
              disabled={renaming || selected.size === 0}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition disabled:opacity-50"
            >
              {renaming ? (
                <>
                  <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                  </svg>
                  Переименование...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Переименовать ({selected.size})
                </>
              )}
            </button>
          )}
        </div>

        {/* Stats */}
        {data && (
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: "Всего файлов", value: data.files.length, color: "text-foreground" },
              { label: "Готовы к переименованию", value: readyCount, color: "text-green-600" },
              { label: "Не распознаны", value: data.files.filter((f) => f.status !== "ready").length, color: "text-amber-600" },
            ].map((s) => (
              <div key={s.label} className="bg-card border border-card-border rounded-xl p-4 shadow-sm">
                <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-sm text-muted-foreground mt-0.5">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!data && !loading && (
          <div className="border-2 border-dashed border-border rounded-2xl p-16 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent flex items-center justify-center">
              <svg className="w-8 h-8 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-foreground">Нет загруженных файлов</h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm mx-auto">
              Нажмите «Загрузить файлы из Dropbox» чтобы сканировать папку /Walterscheid и получить список PDF для переименования.
            </p>
          </div>
        )}

        {/* File table */}
        {data && data.files.length > 0 && (
          <div className="bg-card border border-card-border rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-3 bg-muted/30">
              <input
                type="checkbox"
                checked={!!allSelected}
                onChange={toggleAll}
                className="w-4 h-4 rounded accent-primary cursor-pointer"
              />
              <span className="text-sm font-medium text-foreground">Файл</span>
              <span className="ml-auto text-sm text-muted-foreground">{selected.size} выбрано</span>
            </div>
            <div className="divide-y divide-border">
              {data.files.map((file) => {
                const result = renameResults[file.path];
                const isSelected = selected.has(file.path);
                const canSelect = file.status === "ready";

                return (
                  <div
                    key={file.path}
                    className={`px-4 py-3 transition-colors ${isSelected ? "bg-accent/30" : "hover:bg-muted/20"}`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="pt-0.5">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => canSelect && toggleSelect(file.path)}
                          disabled={!canSelect}
                          className="w-4 h-4 rounded accent-primary cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        />
                      </div>
                      <div className="flex-1 min-w-0 space-y-1.5">
                        {/* Original name */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-mono text-foreground truncate max-w-xs" title={file.originalName}>
                            {file.originalName}
                          </span>
                          <StatusBadge status={file.status} result={result} />
                        </div>

                        {/* Fields */}
                        {file.fields && (
                          <div className="flex gap-4 text-xs text-muted-foreground flex-wrap">
                            <span>Клиент: <span className="text-foreground font-medium">{file.fields.customer ?? "—"}</span></span>
                            <span>Чертёж: <span className="text-foreground font-medium">{file.fields.customerDrawingNo ?? "—"}</span></span>
                            <span>Заказ: <span className="text-foreground font-medium">{file.fields.orderNo ?? "—"}</span></span>
                          </div>
                        )}

                        {/* New name */}
                        {file.newName && (
                          <div className="flex items-center gap-1.5 text-xs">
                            <svg className="w-3.5 h-3.5 text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                            </svg>
                            <span className={`font-mono ${result?.status === "renamed" ? "text-green-600 font-semibold" : "text-muted-foreground"}`}>
                              {result?.status === "renamed" ? result.newName ?? file.newName : file.newName}
                            </span>
                          </div>
                        )}

                        {/* Error */}
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

        {data && data.files.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            В папке /Walterscheid не найдено PDF файлов.
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
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          Переименован
        </span>
      );
    }
    if (result.status === "error") {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          Ошибка
        </span>
      );
    }
    if (result.status === "skipped") {
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
          Пропущен
        </span>
      );
    }
  }

  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 8 8">
          <circle cx="4" cy="4" r="3" />
        </svg>
        Готов
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
        Ошибка чтения
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
      Не распознан
    </span>
  );
}
