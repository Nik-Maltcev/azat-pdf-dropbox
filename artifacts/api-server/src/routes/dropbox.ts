import { Router, type Request, type Response } from "express";
import { Dropbox } from "dropbox";

// pdf-parse v1 is a CJS module externalized from esbuild, loaded at runtime
// v1 exports a function directly as module.exports
const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = (globalThis as any).require("pdf-parse");

const router = Router();

const DROPBOX_FOLDER = "/Walterscheid";
const BATCH_CONCURRENCY = 15; // concurrent downloads

function getDropboxClient(): Dropbox {
  const token = process.env.DROPBOX_ACCESS_TOKEN;
  if (!token) throw new Error("DROPBOX_ACCESS_TOKEN is not set");
  return new Dropbox({ accessToken: token });
}

interface PdfFields {
  customer: string | null;
  customerDrawingNo: string | null;
  orderNo: string | null;
}

function extractFieldsFromText(text: string): PdfFields {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let customer: string | null = null;
  let customerDrawingNo: string | null = null;
  let orderNo: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/für kunde|for customer|pour client/i.test(line)) {
      const nextLine = lines[i + 1] || "";
      if (nextLine && !/für kunde|for customer|pour client|kunden|zeichnungs/i.test(nextLine)) {
        customer = customer || nextLine.split(/\s{2,}/)[0].trim();
      }
    }

    if (/Kunden-Zeichnungs-Nr|Customer drawing No|Réf\. du plan/i.test(line)) {
      const nextVal = lines[i + 1] || "";
      if (nextVal && !/Kunden|Customer|Réf|drawing/i.test(nextVal)) {
        customerDrawingNo = customerDrawingNo || nextVal.split(/\s{2,}/)[0].trim();
      }
    }

    if (/Bestell-Nr|Part No|Reference/i.test(line)) {
      const nextVal = lines[i + 1] || "";
      if (nextVal && !/Bestell|Part No|Reference/i.test(nextVal)) {
        const candidate = nextVal.split(/\s{2,}/)[0].trim();
        if (/^\d{5,}$/.test(candidate)) {
          orderNo = orderNo || candidate;
        }
      }
      const sameLineMatch = line.match(/(?:Bestell-Nr|Part No|Reference)[.:]\s*(\d{5,})/i);
      if (sameLineMatch) orderNo = orderNo || sameLineMatch[1];
    }
  }

  // Fallback patterns
  if (!customerDrawingNo) {
    const cdMatch = text.match(/([A-Z]{1,4}\s\d{2,5})/);
    if (cdMatch) customerDrawingNo = cdMatch[1].replace(/\s+/, "");
  }

  if (!orderNo) {
    const onMatch = text.match(/\b(\d{6,8})\b/);
    if (onMatch) orderNo = onMatch[1];
  }

  if (!customer) {
    const custMatch = text.match(/(?:für Kunde|for customer|pour client)[^\n]*\n\s*([A-Za-z][A-Za-z\s&.-]{2,30})/i);
    if (custMatch) customer = custMatch[1].trim();
  }

  return { customer, customerDrawingNo, orderNo };
}

function buildNewName(fields: PdfFields): string | null {
  const { customer, customerDrawingNo, orderNo } = fields;
  if (!customer || !customerDrawingNo || !orderNo) return null;
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "").trim();
  return `${safe(customer)}_${safe(customerDrawingNo)}_${safe(orderNo)}.pdf`;
}

async function processOnePdf(dbx: Dropbox, file: { path_lower: string; name: string; id: string }) {
  try {
    const dlRes = await dbx.filesDownload({ path: file.path_lower });
    const buffer = (dlRes.result as any).fileBinary as Buffer;
    const parsed = await pdfParse(buffer);
    const fields = extractFieldsFromText(parsed.text);
    const newName = buildNewName(fields);
    return {
      id: file.id,
      originalName: file.name,
      path: file.path_lower,
      fields,
      newName,
      status: newName ? "ready" : "unresolved",
      error: undefined as string | undefined,
    };
  } catch (err: any) {
    return {
      id: file.id,
      originalName: file.name,
      path: file.path_lower,
      fields: { customer: null, customerDrawingNo: null, orderNo: null },
      newName: null,
      status: "error" as const,
      error: err.message as string,
    };
  }
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  onResult: (result: T, index: number) => void
): Promise<void> {
  let index = 0;
  let active = 0;

  return new Promise((resolve, reject) => {
    function startNext() {
      while (active < concurrency && index < tasks.length) {
        const currentIndex = index++;
        active++;
        tasks[currentIndex]()
          .then((result) => {
            active--;
            onResult(result, currentIndex);
            if (index < tasks.length) startNext();
            else if (active === 0) resolve();
          })
          .catch((err) => {
            active--;
            reject(err);
          });
      }
      if (tasks.length === 0) resolve();
    }
    startNext();
  });
}

// GET /api/dropbox/scan — SSE stream: lists all PDFs and processes them
router.get("/dropbox/scan", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const dbx = getDropboxClient();

    // 1. Collect all PDF entries (paginated)
    send("status", { message: "Получаем список файлов из Dropbox..." });

    const allPdfs: Array<{ path_lower: string; name: string; id: string }> = [];
    let cursor: string | null = null;

    while (true) {
      const listRes = cursor
        ? await dbx.filesListFolderContinue({ cursor })
        : await dbx.filesListFolder({ path: DROPBOX_FOLDER, limit: 2000, recursive: false });

      const entries = (listRes.result.entries as any[]).filter(
        (e) => e[".tag"] === "file" && e.name.toLowerCase().endsWith(".pdf")
      );

      for (const e of entries) {
        allPdfs.push({ path_lower: e.path_lower, name: e.name, id: e.id });
      }

      if (!listRes.result.has_more) break;
      cursor = (listRes.result as any).cursor;

      send("listing", { found: allPdfs.length, message: `Найдено файлов: ${allPdfs.length}...` });
    }

    send("total", { total: allPdfs.length });

    if (allPdfs.length === 0) {
      send("done", { total: 0, processed: 0 });
      res.end();
      return;
    }

    // 2. Process files with concurrency
    let processed = 0;
    const tasks = allPdfs.map((file) => () => processOnePdf(dbx, file));

    await runWithConcurrency(tasks, BATCH_CONCURRENCY, (result) => {
      processed++;
      send("file", { ...result, processed, total: allPdfs.length });
    });

    send("done", { total: allPdfs.length, processed });
    res.end();
  } catch (err: any) {
    send("error", { message: err.message });
    res.end();
  }
});

// POST /api/dropbox/rename — rename files in Dropbox in parallel
router.post("/dropbox/rename", async (req: Request, res: Response) => {
  const { files } = req.body as {
    files: Array<{ path: string; newName: string }>;
  };

  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "files array is required" });
    return;
  }

  const dbx = getDropboxClient();
  const results: Array<{
    path: string;
    newName?: string;
    newPath?: string;
    status: string;
    error?: string;
    reason?: string;
  }> = [];
  const mu = new Array(files.length).fill(null);

  const tasks = files.map((f) => async () => {
    try {
      const dir = f.path.substring(0, f.path.lastIndexOf("/"));
      const newPath = `${dir}/${f.newName}`;
      if (f.path.toLowerCase() === newPath.toLowerCase()) {
        return { path: f.path, newName: f.newName, status: "skipped", reason: "same name" };
      }
      await dbx.filesMoveV2({ from_path: f.path, to_path: newPath, autorename: false });
      return { path: f.path, newPath, newName: f.newName, status: "renamed" };
    } catch (err: any) {
      return { path: f.path, newName: f.newName, status: "error", error: err.message };
    }
  });

  await runWithConcurrency(tasks, 10, (result, i) => {
    mu[i] = result;
  });

  res.json({ results: mu.filter(Boolean) });
});

export default router;
