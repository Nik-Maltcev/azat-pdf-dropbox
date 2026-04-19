import { Router, type Request, type Response } from "express";
import { Dropbox } from "dropbox";

// pdf-parse v1 is a CJS module externalized from esbuild, loaded at runtime
const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = (globalThis as any).require("pdf-parse");

const router = Router();

const DROPBOX_FOLDER = "/Walterscheid";
const BATCH_CONCURRENCY = 5;

function getDropboxClient(): Dropbox {
  const token = process.env.DROPBOX_ACCESS_TOKEN;
  if (!token) throw new Error("DROPBOX_ACCESS_TOKEN is not set");
  return new Dropbox({ accessToken: token });
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadWithRetry(dbx: Dropbox, path: string, maxRetries = 5): Promise<Buffer> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const dlRes = await dbx.filesDownload({ path });
      return (dlRes.result as any).fileBinary as Buffer;
    } catch (err: any) {
      const status = err?.status || err?.error?.status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfter = err?.headers?.["retry-after"];
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : (2 ** attempt) * 3000;
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded for Dropbox download");
}

interface PdfFields {
  customer: string | null;
  customerDrawingNo: string | null;
  orderNo: string | null;
}

interface ProcessedFile {
  id: string;
  originalName: string;
  path: string;
  fields: PdfFields;
  newName: string | null;
  status: string;
  error?: string;
}

// ── In-memory job store ─────────────────────────────────────────────────────
interface ScanJob {
  status: "listing" | "processing" | "done" | "error";
  total: number;
  processed: number;
  files: ProcessedFile[];
  error?: string;
  startedAt: number;
  /** Cursor: index of last file the client has fetched */
}

const jobs = new Map<string, ScanJob>();
let jobCounter = 0;

// ── PDF field extraction (regex) ────────────────────────────────────────────

function extractFieldsFromText(text: string): PdfFields {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  let customer: string | null = null;
  let customerDrawingNo: string | null = null;
  let orderNo: string | null = null;

  const CUST_LABEL    = /\bkunde\b|f\s*o\s*r\s+cus\s*t\s*o\s*m\s*e\s*r|pour\s+c[l\s]+i\s*ent/i;
  const CD_LABEL      = /kunden\s*[-–]?\s*zeichnungs\s*[-–]?\s*nr|customer\s*[-–]?\s*drawing\s+no|ref\s*\.?\s*du\s+plan\s+client|~~to~er\s+drawing/i;
  const ORDER_LABEL   = /bestell\s*[-–]?\s*nr|part\s+no/i;
  const PLAIN_DRAWING_LABEL = /^zeichnungs\s*[-–.]?\s*nr/i;
  const IS_LABEL      = /\bkunde\b|f\s*o\s*r\s+cus|pour\s+c[l\s]|^pour\b|^c\s*l\s*i\s*ent\b|^i\s*ent\b|kunden|customer\s*draw|zeichnungs|bestell|part\s*no|drawing\s+no|datum|date\b|^machine\b|t[~y]pe|maschinenart|stückzahl|quantity|^pos\b|^repere|^reference\b|ref[\.\s]+du|technisch|technicol|angaben|quant|pos\.-nr|gelenkwelle|kupplung|^clutch\b|^limiteur\b|^pto\b|transm|^seite\b|^page\b|benennung|^oraw|^ref\s*~|~~to~er|plan\s+cl/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!customer && CUST_LABEL.test(line)) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const candidate = lines[j].split(/\s{3,}/)[0].trim();
        if (candidate.length >= 3 && /[A-Za-zÄÖÜäöüß]{2}/.test(candidate) && !IS_LABEL.test(candidate)) {
          customer = candidate;
          break;
        }
      }
    }

    if (!customerDrawingNo && (CD_LABEL.test(line) || PLAIN_DRAWING_LABEL.test(line))) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const raw = lines[j].split(/\s{3,}/)[0].trim();
        const candidate = raw.replace(/\s+/g, "");
        if (candidate.length < 2) continue;
        if (/^[~@©()\[\]{}|\\\/\-_.,:;!?#$%^&*+=<>]+$/.test(candidate)) continue;
        if (IS_LABEL.test(raw)) continue;
        if (candidate.length >= 3 && /^[\dA-Za-zÄÖÜäöüß]/.test(candidate) && /[\dA-Za-z]{2}/.test(candidate)) {
          customerDrawingNo = candidate.replace(/[.,]/g, "-");
          break;
        }
      }
    }

    if (!orderNo && ORDER_LABEL.test(line)) {
      const sameLineMatch = line.match(/(?:bestell\s*[-–]?\s*nr|part\s+no)[.\s:]*(\d{5,})/i);
      if (sameLineMatch) {
        orderNo = sameLineMatch[1];
      } else {
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const tokens = lines[j].split(/\s+/).filter(Boolean);
          const firstToken = tokens[0] || "";
          if (/^\d{5,}$/.test(firstToken)) {
            orderNo = firstToken;
            if (!customerDrawingNo && tokens[1] && /^\d+[\.\-]\d+/.test(tokens[1])) {
              customerDrawingNo = tokens[1].replace(/\./g, "-");
            }
            break;
          }
          const digitTokens = tokens.filter((t) => /^\d+$/.test(t));
          if (digitTokens.length > 1) {
            const joined = digitTokens.join("");
            if (/^\d{5,8}$/.test(joined)) { orderNo = joined; break; }
          }
        }
      }
    }
  }

  // Fallbacks
  if (!customerDrawingNo) {
    const m = text.match(/\b([A-ZÄÖÜ]{2,5}\s*\d{3,7})\b/);
    if (m) customerDrawingNo = m[1].replace(/\s+/g, "");
  }
  if (!customerDrawingNo) {
    const m = text.match(/\b(\d{1,5}[.,]\d{1,5}(?:[.,]\d{1,5})?)\b/);
    if (m) customerDrawingNo = m[1].replace(/[.,]/g, "-");
  }
  if (!orderNo) {
    const m = text.match(/\b(\d{6,8})\b/);
    if (m) orderNo = m[1];
  }
  if (!customer) {
    const m = text.match(/(?:für\s+Kunde|for\s+cus\s*tomer|pour\s+cl[i\s]+ent)[^\n]*\n\s*([A-ZÄÖÜa-zäöüß][A-Za-zÄÖÜäöüß\s&.()\-]{2,35})/i);
    if (m) { const val = m[1].trim(); if (!IS_LABEL.test(val)) customer = val; }
  }
  if (!customer) {
    const custIdx = lines.findIndex((l) => CUST_LABEL.test(l));
    if (custIdx >= 0) {
      for (let j = custIdx + 1; j < Math.min(custIdx + 8, lines.length); j++) {
        const candidate = lines[j].split(/\s{3,}/)[0].trim();
        if (candidate.length >= 3 && /^[A-ZÄÖÜa-zäöüß]/.test(candidate) && /[A-Za-zÄÖÜäöüß]{3}/.test(candidate) && !IS_LABEL.test(candidate) && !/^[~@©()\[\]{}|\\\/\-_.,:;!?#$%^&*+=<>\d]+$/.test(candidate)) {
          customer = candidate;
          break;
        }
      }
    }
  }

  return { customer, customerDrawingNo, orderNo };
}

// ── AI extraction ───────────────────────────────────────────────────────────

async function extractFieldsWithAI(text: string): Promise<PdfFields> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { customer: null, customerDrawingNo: null, orderNo: null };

  const truncated = text.slice(0, 3000);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
      max_tokens: 200,
      messages: [
        {
          role: "system",
          content: `You extract structured data from OCR text of Walterscheid PDF technical drawings.
Return ONLY valid JSON with these fields:
- customer: company name (Kunde / for customer / pour client)
- customerDrawingNo: customer drawing number (Kundenzeichnungs-Nr / customer drawing No / ref. du plan client)
- orderNo: order number (Bestell-Nr / Part No / Reference), typically 5-8 digits

Use null for fields you cannot find. No explanation, just JSON.`,
        },
        { role: "user", content: truncated },
      ],
    }),
  });

  if (!res.ok) return { customer: null, customerDrawingNo: null, orderNo: null };
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content?.trim();
  if (!content) return { customer: null, customerDrawingNo: null, orderNo: null };

  try {
    const clean = content.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(clean);
    return { customer: parsed.customer || null, customerDrawingNo: parsed.customerDrawingNo || null, orderNo: parsed.orderNo || null };
  } catch {
    return { customer: null, customerDrawingNo: null, orderNo: null };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function transliterateGerman(s: string): string {
  return s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss");
}

function buildNewName(fields: PdfFields): string | null {
  const { customer, customerDrawingNo, orderNo } = fields;
  if (!customer || !customerDrawingNo || !orderNo) return null;
  const safe = (s: string) => transliterateGerman(s).replace(/[^A-Za-z0-9_-]/g, "").trim();
  return `${safe(customer)}_${safe(customerDrawingNo)}_${safe(orderNo)}.pdf`;
}

async function processOnePdf(dbx: Dropbox, file: { path_lower: string; name: string; id: string }): Promise<ProcessedFile> {
  try {
    const buffer = await downloadWithRetry(dbx, file.path_lower);
    const parsed = await pdfParse(buffer);
    const normalizedText = parsed.text.normalize("NFC");
    const fields = extractFieldsFromText(normalizedText);
    const newName = buildNewName(fields);
    return { id: file.id, originalName: file.name, path: file.path_lower, fields, newName, status: newName ? "ready" : "unresolved" };
  } catch (err: any) {
    return { id: file.id, originalName: file.name, path: file.path_lower, fields: { customer: null, customerDrawingNo: null, orderNo: null }, newName: null, status: "error", error: err.message };
  }
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number, onResult: (result: T, index: number) => void): Promise<void> {
  let index = 0;
  let active = 0;
  return new Promise((resolve, reject) => {
    function startNext() {
      while (active < concurrency && index < tasks.length) {
        const currentIndex = index++;
        active++;
        tasks[currentIndex]()
          .then((result) => { active--; onResult(result, currentIndex); if (index < tasks.length) startNext(); else if (active === 0) resolve(); })
          .catch((err) => { active--; reject(err); });
      }
      if (tasks.length === 0) resolve();
    }
    startNext();
  });
}

// ── Background scan job ─────────────────────────────────────────────────────

async function runScanJob(jobId: string) {
  const job = jobs.get(jobId)!;
  try {
    const dbx = getDropboxClient();
    job.status = "listing";

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
    }

    job.total = allPdfs.length;
    job.status = "processing";

    if (allPdfs.length === 0) {
      job.status = "done";
      return;
    }

    const tasks = allPdfs.map((file) => () => processOnePdf(dbx, file));
    await runWithConcurrency(tasks, BATCH_CONCURRENCY, (result) => {
      job.processed++;
      job.files.push(result);
    });

    job.status = "done";
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
  }
}

// POST /api/dropbox/scan/start — start background scan, returns jobId
router.post("/dropbox/scan/start", (_req: Request, res: Response) => {
  const jobId = String(++jobCounter);
  jobs.set(jobId, { status: "listing", total: 0, processed: 0, files: [], startedAt: Date.now() });

  // Fire and forget
  runScanJob(jobId).catch(() => {});

  res.json({ jobId });
});

// GET /api/dropbox/scan/status?jobId=...&cursor=0 — poll for results
router.get("/dropbox/scan/status", (req: Request, res: Response) => {
  const jobId = req.query.jobId as string;
  const cursor = Number(req.query.cursor || 0);

  if (!jobId || !jobs.has(jobId)) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const job = jobs.get(jobId)!;

  // Return only new files since cursor
  const newFiles = job.files.slice(cursor);

  res.json({
    status: job.status,
    total: job.total,
    processed: job.processed,
    files: newFiles,
    cursor: cursor + newFiles.length,
    error: job.error,
  });
});

// DELETE /api/dropbox/scan/job?jobId=... — clean up job from memory
router.delete("/dropbox/scan/job", (req: Request, res: Response) => {
  const jobId = req.query.jobId as string;
  if (jobId) jobs.delete(jobId);
  res.json({ ok: true });
});

// POST /api/dropbox/scan/update-files — update files in job (e.g. after AI resolve)
router.post("/dropbox/scan/update-files", (req: Request, res: Response) => {
  const { jobId, files } = req.body as { jobId: string; files: ProcessedFile[] };
  if (!jobId || !jobs.has(jobId)) { res.status(404).json({ error: "Job not found" }); return; }
  if (!Array.isArray(files)) { res.status(400).json({ error: "files array required" }); return; }

  const job = jobs.get(jobId)!;
  for (const updated of files) {
    const idx = job.files.findIndex((f) => f.path === updated.path);
    if (idx >= 0) {
      job.files[idx] = updated;
    }
  }
  res.json({ ok: true });
});

// ── Rename ──────────────────────────────────────────────────────────────────

router.post("/dropbox/rename", async (req: Request, res: Response) => {
  const { files } = req.body as { files: Array<{ path: string; newName: string }> };
  if (!Array.isArray(files) || files.length === 0) { res.status(400).json({ error: "files array is required" }); return; }

  const dbx = getDropboxClient();
  const mu = new Array(files.length).fill(null);
  const tasks = files.map((f) => async () => {
    try {
      const dir = f.path.substring(0, f.path.lastIndexOf("/"));
      const newPath = `${dir}/${f.newName}`;
      if (f.path.toLowerCase() === newPath.toLowerCase()) return { path: f.path, newName: f.newName, status: "skipped", reason: "same name" };
      await dbx.filesMoveV2({ from_path: f.path, to_path: newPath, autorename: false });
      return { path: f.path, newPath, newName: f.newName, status: "renamed" };
    } catch (err: any) {
      return { path: f.path, newName: f.newName, status: "error", error: err.message };
    }
  });
  await runWithConcurrency(tasks, 10, (result, i) => { mu[i] = result; });
  res.json({ results: mu.filter(Boolean) });
});

// ── Inspect ─────────────────────────────────────────────────────────────────

router.get("/dropbox/inspect", async (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: "path query parameter is required" }); return; }
  try {
    const dbx = getDropboxClient();
    const buffer = await downloadWithRetry(dbx, filePath);
    const parsed = await pdfParse(buffer);
    const rawText = parsed.text;
    const normalizedText = rawText.normalize("NFC");
    const lines = normalizedText.split("\n").map((l: string) => l.trim()).filter(Boolean);
    const fields = extractFieldsFromText(normalizedText);
    const newName = buildNewName(fields);
    const hexSample = Array.from(rawText.slice(0, 200)).map((c: string) => {
      const code = c.codePointAt(0)!;
      return code > 127 ? `[U+${code.toString(16).toUpperCase().padStart(4, "0")} ${c}]` : c;
    }).join("");
    res.json({ path: filePath, fields, newName, hexSample, lines: lines.slice(0, 80), rawTextLength: rawText.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI resolve (background job) ─────────────────────────────────────────────

interface AiJob {
  status: "processing" | "done" | "error";
  total: number;
  processed: number;
  results: ProcessedFile[];
  error?: string;
}

const aiJobs = new Map<string, AiJob>();
let aiJobCounter = 0;

async function runAiJob(aiJobId: string, files: Array<{ path: string; originalName: string; id: string; fields: PdfFields }>, scanJobId?: string) {
  const aiJob = aiJobs.get(aiJobId)!;
  const dbx = getDropboxClient();

  const tasks = files.map((f) => async () => {
    try {
      const buffer = await downloadWithRetry(dbx, f.path);
      const parsed = await pdfParse(buffer);
      const normalizedText = parsed.text.normalize("NFC");
      const aiFields = await extractFieldsWithAI(normalizedText);
      const merged: PdfFields = {
        customer: f.fields.customer || aiFields.customer,
        customerDrawingNo: f.fields.customerDrawingNo || aiFields.customerDrawingNo,
        orderNo: f.fields.orderNo || aiFields.orderNo,
      };
      const newName = buildNewName(merged);
      return { id: f.id, originalName: f.originalName, path: f.path, fields: merged, newName, status: newName ? "ready" : "unresolved" } as ProcessedFile;
    } catch (err: any) {
      return { id: f.id, originalName: f.originalName, path: f.path, fields: f.fields, newName: null, status: "error", error: err.message } as ProcessedFile;
    }
  });

  try {
    await runWithConcurrency(tasks, 3, (result) => {
      aiJob.processed++;
      aiJob.results.push(result);

      // Also update the scan job if it exists
      if (scanJobId && jobs.has(scanJobId)) {
        const scanJob = jobs.get(scanJobId)!;
        const idx = scanJob.files.findIndex((f) => f.path === result.path);
        if (idx >= 0) scanJob.files[idx] = result;
      }
    });
    aiJob.status = "done";
  } catch (err: any) {
    aiJob.status = "error";
    aiJob.error = err.message;
  }
}

router.post("/dropbox/ai-resolve/start", (req: Request, res: Response) => {
  const { files, scanJobId } = req.body as { files: Array<{ path: string; originalName: string; id: string; fields: PdfFields }>; scanJobId?: string };
  if (!Array.isArray(files) || files.length === 0) { res.status(400).json({ error: "files array is required" }); return; }
  if (!process.env.OPENAI_API_KEY) { res.status(400).json({ error: "OPENAI_API_KEY is not configured" }); return; }

  const aiJobId = String(++aiJobCounter);
  aiJobs.set(aiJobId, { status: "processing", total: files.length, processed: 0, results: [] });
  runAiJob(aiJobId, files, scanJobId).catch(() => {});
  res.json({ aiJobId });
});

router.get("/dropbox/ai-resolve/status", (req: Request, res: Response) => {
  const aiJobId = req.query.aiJobId as string;
  const cursor = Number(req.query.cursor || 0);
  if (!aiJobId || !aiJobs.has(aiJobId)) { res.status(404).json({ error: "AI job not found" }); return; }

  const aiJob = aiJobs.get(aiJobId)!;
  const newResults = aiJob.results.slice(cursor);
  res.json({
    status: aiJob.status,
    total: aiJob.total,
    processed: aiJob.processed,
    results: newResults,
    cursor: cursor + newResults.length,
    error: aiJob.error,
  });
});

export default router;
