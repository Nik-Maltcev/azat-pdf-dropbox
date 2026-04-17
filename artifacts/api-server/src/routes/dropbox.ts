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

  // Match label lines (allow extra spaces inside words due to PDF extraction artefacts)
  const CUST_LABEL    = /\bkunde\b|for\s+cus\s*tomer|pour\s+c[l\s]+i\s*ent/i;
  const CD_LABEL      = /kunden\s*[-–]?\s*zeichnungs\s*[-–]?\s*nr|customer\s+drawing\s+no|ref\s*\.?\s*du\s+plan\s+client/i;
  const ORDER_LABEL   = /bestell\s*[-–]?\s*nr|part\s+no/i;

  // Lines that look like labels/headers (skip them as value candidates)
  const IS_LABEL      = /\bkunde\b|for\s+cus|pour\s+c[l\s]|kunden|customer\s*draw|zeichnungs|bestell|part\s*no|drawing\s+no|datum|date\b|machine|t[~y]pe|maschinenart|stückzahl|quantity|^pos\b|^repere|^reference\b|ref\.\s+du|technisch|technicol|angaben|quant|pos\.-nr/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── Customer ──────────────────────────────────────────────────────────────
    if (!customer && CUST_LABEL.test(line)) {
      // Search next 1-4 lines for a real company name
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        // Take the first column (before 3+ spaces if multi-column line)
        const candidate = lines[j].split(/\s{3,}/)[0].trim();
        if (
          candidate.length >= 3 &&
          /[A-Za-zÄÖÜäöüß]{2}/.test(candidate) &&
          !IS_LABEL.test(candidate)
        ) {
          customer = candidate;
          break;
        }
      }
    }

    // ── Customer drawing no ───────────────────────────────────────────────────
    if (!customerDrawingNo && CD_LABEL.test(line)) {
      for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
        const raw = lines[j].split(/\s{3,}/)[0].trim();
        // Strip internal spaces (e.g. "801 2479" → "8012479")
        const candidate = raw.replace(/\s+/g, "");
        if (
          candidate.length >= 3 &&
          !IS_LABEL.test(raw) &&
          /[\dA-Za-z]/.test(candidate)
        ) {
          customerDrawingNo = candidate;
          break;
        }
      }
    }

    // ── Order no (+ bonus: catch adjacent Zeichnungs-Nr.) ────────────────────
    if (!orderNo && ORDER_LABEL.test(line)) {
      // Same-line value: "Part No. 101399" or "Bestell-Nr.: 101399"
      const sameLineMatch = line.match(/(?:bestell\s*[-–]?\s*nr|part\s+no)[.\s:]*(\d{5,})/i);
      if (sameLineMatch) {
        orderNo = sameLineMatch[1];
      } else {
        // Value on next lines (look up to 5 lines ahead — number may be separated by label rows)
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const tokens = lines[j].split(/\s+/).filter(Boolean);
          const firstToken = tokens[0] || "";
          if (/^\d{5,}$/.test(firstToken)) {
            orderNo = firstToken;
            // If second token looks like a drawing number (e.g. "56.136.51"), capture it as fallback
            if (!customerDrawingNo && tokens[1] && /^\d+[\.\-]\d+/.test(tokens[1])) {
              customerDrawingNo = tokens[1].replace(/\./g, "-");
            }
            break;
          }
        }
      }
    }
  }

  // ── Fallbacks ──────────────────────────────────────────────────────────────

  // Customer drawing no: look for pattern like "ABC 1234" or "AB12345"
  if (!customerDrawingNo) {
    const m = text.match(/\b([A-ZÄÖÜ]{2,5}\s*\d{3,7})\b/);
    if (m) customerDrawingNo = m[1].replace(/\s+/g, "");
  }

  // Order no: first standalone 6-8 digit number
  if (!orderNo) {
    const m = text.match(/\b(\d{6,8})\b/);
    if (m) orderNo = m[1];
  }

  // Customer: multi-word title-case string after label keyword (cross-line fallback)
  if (!customer) {
    const m = text.match(
      /(?:für\s+Kunde|for\s+cus\s*tomer|pour\s+cl[i\s]+ent)[^\n]*\n\s*([A-ZÄÖÜa-zäöüß][A-Za-zÄÖÜäöüß\s&.()\-]{2,35})/i
    );
    if (m) customer = m[1].trim();
  }

  return { customer, customerDrawingNo, orderNo };
}

function transliterateGerman(s: string): string {
  return s
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss");
}

function buildNewName(fields: PdfFields): string | null {
  const { customer, customerDrawingNo, orderNo } = fields;
  if (!customer || !customerDrawingNo || !orderNo) return null;
  const safe = (s: string) =>
    transliterateGerman(s).replace(/[^A-Za-z0-9_-]/g, "").trim();
  return `${safe(customer)}_${safe(customerDrawingNo)}_${safe(orderNo)}.pdf`;
}

async function processOnePdf(dbx: Dropbox, file: { path_lower: string; name: string; id: string }) {
  try {
    const dlRes = await dbx.filesDownload({ path: file.path_lower });
    const buffer = (dlRes.result as any).fileBinary as Buffer;
    const parsed = await pdfParse(buffer);
    // NFC normalization fixes umlauts stored as base-letter + combining diacritic
    const fields = extractFieldsFromText(parsed.text.normalize("NFC"));
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

// GET /api/dropbox/inspect?path=... — returns raw extracted text for debugging
router.get("/dropbox/inspect", async (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: "path query parameter is required" });
    return;
  }
  try {
    const dbx = getDropboxClient();
    const dlRes = await dbx.filesDownload({ path: filePath });
    const buffer = (dlRes.result as any).fileBinary as Buffer;
    const parsed = await pdfParse(buffer);

    // Show both raw and NFC-normalized text
    const rawText = parsed.text;
    const normalizedText = rawText.normalize("NFC");
    const lines = normalizedText.split("\n").map((l: string) => l.trim()).filter(Boolean);
    const fields = extractFieldsFromText(normalizedText);
    const newName = buildNewName(fields);

    // Show hex codes for first 500 chars to debug encoding
    const hexSample = Array.from(rawText.slice(0, 200)).map((c: string) => {
      const code = c.codePointAt(0)!;
      return code > 127 ? `[U+${code.toString(16).toUpperCase().padStart(4, "0")} ${c}]` : c;
    }).join("");

    res.json({
      path: filePath,
      fields,
      newName,
      hexSample,
      lines: lines.slice(0, 80),
      rawTextLength: rawText.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
