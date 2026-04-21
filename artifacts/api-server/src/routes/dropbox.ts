import { Router, type Request, type Response } from "express";
import { Dropbox } from "dropbox";

const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = (globalThis as any).require("pdf-parse");

const router = Router();

const DROPBOX_FOLDER = "/Walterscheid";
const BATCH_CONCURRENCY = 5;

// ── Token management with mutex ─────────────────────────────────────────────

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;
let refreshPromise: Promise<string> | null = null;

async function getAccessToken(): Promise<string> {
  const staticToken = process.env.DROPBOX_ACCESS_TOKEN;
  if (staticToken && !process.env.DROPBOX_REFRESH_TOKEN) return staticToken;

  const refreshToken = process.env.DROPBOX_REFRESH_TOKEN;
  const appKey = process.env.DROPBOX_APP_KEY;
  const appSecret = process.env.DROPBOX_APP_SECRET;

  if (!refreshToken || !appKey || !appSecret) {
    throw new Error("Set DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, DROPBOX_APP_SECRET");
  }

  if (cachedAccessToken && Date.now() < tokenExpiresAt - 300000) {
    return cachedAccessToken;
  }

  // Mutex: if refresh is already in progress, wait for it
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: appKey,
          client_secret: appSecret,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Failed to refresh Dropbox token: ${res.status} ${text}`);
      }
      const data = await res.json();
      cachedAccessToken = data.access_token;
      tokenExpiresAt = Date.now() + data.expires_in * 1000;
      return cachedAccessToken!;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// Fresh client per call — never reuse stale tokens
async function getDropboxClient(): Promise<Dropbox> {
  const token = await getAccessToken();
  return new Dropbox({ accessToken: token });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadWithRetry(path: string, maxRetries = 5): Promise<Buffer> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Fresh client each attempt — token may have refreshed between retries
      const dbx = await getDropboxClient();
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
      if (status === 401 && attempt < maxRetries) {
        // Token expired mid-job — force refresh
        cachedAccessToken = null;
        tokenExpiresAt = 0;
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded for Dropbox download");
}

async function dropboxMoveWithRetry(fromPath: string, toPath: string, maxRetries = 3): Promise<void> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const dbx = await getDropboxClient();
      await dbx.filesMoveV2({ from_path: fromPath, to_path: toPath, autorename: false });
      return;
    } catch (err: any) {
      const status = err?.status || err?.error?.status;
      if (status === 429 && attempt < maxRetries) {
        const waitMs = (2 ** attempt) * 2000;
        await sleep(waitMs);
        continue;
      }
      if (status === 401 && attempt < maxRetries) {
        cachedAccessToken = null;
        tokenExpiresAt = 0;
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }
  throw new Error("Max retries exceeded for Dropbox move");
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

function transliterateGerman(s: string): string {
  return s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss");
}

function buildNewName(fields: PdfFields): string | null {
  const { customer, customerDrawingNo, orderNo } = fields;
  if (!customer || !customerDrawingNo || !orderNo) return null;
  const safe = (s: string) => transliterateGerman(s).replace(/[^A-Za-z0-9_-]/g, "").trim();
  const c = safe(customer);
  const d = safe(customerDrawingNo);
  const o = safe(orderNo);
  if (!c || !d || !o) return null;
  return `${c}_${d}_${o}.pdf`;
}

// ── PDF field extraction (regex) ────────────────────────────────────────────

function extractFieldsFromText(text: string): PdfFields {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  let customer: string | null = null;
  let customerDrawingNo: string | null = null;
  let orderNo: string | null = null;

  const CUST_LABEL = /\bkunde\b|f\s*o\s*r\s+cus\s*t\s*o\s*m\s*e\s*r|pour\s+c[l\s]+i\s*ent/i;
  const CD_LABEL = /kunden\s*[-–]?\s*zeichnungs\s*[-–]?\s*nr|customer\s*[-–]?\s*drawing\s+no|ref\s*\.?\s*du\s+plan\s+client|~~to~er\s+drawing/i;
  const ORDER_LABEL = /bestell\s*[-–]?\s*nr|part\s+no/i;
  const PLAIN_DRAWING_LABEL = /^zeichnungs\s*[-–.]?\s*nr/i;
  const IS_LABEL = /\bkunde\b|f\s*o\s*r\s+cus|pour\s+c[l\s]|^pour\b|^c\s*l\s*i\s*ent\b|^i\s*ent\b|kunden|customer\s*draw|zeichnungs|bestell|part\s*no|drawing\s+no|datum|date\b|^machine\b|t[~y]pe|maschinenart|stückzahl|quantity|^pos\b|^repere|^reference\b|ref[\.\s]+du|technisch|technicol|angaben|quant|pos\.-nr|gelenkwelle|kupplung|^clutch\b|^limiteur\b|^pto\b|transm|^seite\b|^page\b|benennung|^oraw|^ref\s*~|~~to~er|plan\s+cl/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!customer && CUST_LABEL.test(line)) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const candidate = lines[j].split(/\s{3,}/)[0].trim();
        if (candidate.length >= 3 && /[A-Za-zÄÖÜäöüß]{2}/.test(candidate) && !IS_LABEL.test(candidate)) { customer = candidate; break; }
      }
    }
    if (!customerDrawingNo && (CD_LABEL.test(line) || PLAIN_DRAWING_LABEL.test(line))) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const raw = lines[j].split(/\s{3,}/)[0].trim();
        const candidate = raw.replace(/\s+/g, "");
        if (candidate.length < 2) continue;
        if (/^[~@©()\[\]{}|\\\/\-_.,:;!?#$%^&*+=<>]+$/.test(candidate)) continue;
        if (IS_LABEL.test(raw)) continue;
        if (candidate.length >= 3 && /^[\dA-Za-zÄÖÜäöüß]/.test(candidate) && /[\dA-Za-z]{2}/.test(candidate)) { customerDrawingNo = candidate.replace(/[.,]/g, "-"); break; }
      }
    }
    if (!orderNo && ORDER_LABEL.test(line)) {
      const sameLineMatch = line.match(/(?:bestell\s*[-–]?\s*nr|part\s+no)[.\s:]*(\d{5,})/i);
      if (sameLineMatch) { orderNo = sameLineMatch[1]; }
      else {
        for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
          const tokens = lines[j].split(/\s+/).filter(Boolean);
          const firstToken = tokens[0] || "";
          if (/^\d{5,}$/.test(firstToken)) {
            orderNo = firstToken;
            if (!customerDrawingNo && tokens[1] && /^\d+[\.\-]\d+/.test(tokens[1])) customerDrawingNo = tokens[1].replace(/\./g, "-");
            break;
          }
          const digitTokens = tokens.filter((t) => /^\d+$/.test(t));
          if (digitTokens.length > 1) { const joined = digitTokens.join(""); if (/^\d{5,8}$/.test(joined)) { orderNo = joined; break; } }
        }
      }
    }
  }
  if (!customerDrawingNo) { const m = text.match(/\b([A-ZÄÖÜ]{2,5}\s*\d{3,7})\b/); if (m) customerDrawingNo = m[1].replace(/\s+/g, ""); }
  if (!customerDrawingNo) { const m = text.match(/\b(\d{1,5}[.,]\d{1,5}(?:[.,]\d{1,5})?)\b/); if (m) customerDrawingNo = m[1].replace(/[.,]/g, "-"); }
  if (!orderNo) { const m = text.match(/\b(\d{6,8})\b/); if (m) orderNo = m[1]; }
  if (!customer) {
    const m = text.match(/(?:für\s+Kunde|for\s+cus\s*tomer|pour\s+cl[i\s]+ent)[^\n]*\n\s*([A-ZÄÖÜa-zäöüß][A-Za-zÄÖÜäöüß\s&.()\-]{2,35})/i);
    if (m) { const val = m[1].trim(); if (!IS_LABEL.test(val)) customer = val; }
  }
  if (!customer) {
    const custIdx = lines.findIndex((l) => CUST_LABEL.test(l));
    if (custIdx >= 0) {
      for (let j = custIdx + 1; j < Math.min(custIdx + 8, lines.length); j++) {
        const candidate = lines[j].split(/\s{3,}/)[0].trim();
        if (candidate.length >= 3 && /^[A-ZÄÖÜa-zäöüß]/.test(candidate) && /[A-Za-zÄÖÜäöüß]{3}/.test(candidate) && !IS_LABEL.test(candidate) && !/^[~@©()\[\]{}|\\\/\-_.,:;!?#$%^&*+=<>\d]+$/.test(candidate)) { customer = candidate; break; }
      }
    }
  }
  return { customer, customerDrawingNo, orderNo };
}

// ── AI extraction (GPT-4o-mini text / GPT-4o vision) ────────────────────────

async function extractFieldsWithAI(text: string): Promise<PdfFields> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { customer: null, customerDrawingNo: null, orderNo: null };
  const truncated = text.slice(0, 3000);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini", temperature: 0, max_tokens: 200,
      messages: [
        { role: "system", content: `You extract structured data from OCR text of Walterscheid PDF technical drawings.\nReturn ONLY valid JSON with these fields:\n- customer: company name (Kunde / for customer / pour client)\n- customerDrawingNo: customer drawing number (Kundenzeichnungs-Nr / customer drawing No / ref. du plan client)\n- orderNo: order number (Bestell-Nr / Part No / Reference), typically 5-8 digits\n\nUse null for fields you cannot find. No explanation, just JSON.` },
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
  } catch { return { customer: null, customerDrawingNo: null, orderNo: null }; }
}

async function extractFieldsWithVision(pdfBuffer: Buffer, model = "gpt-4o-mini"): Promise<PdfFields> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { customer: null, customerDrawingNo: null, orderNo: null };

  // Convert PDF first page to PNG
  const { execFile } = await import("child_process");
  const { writeFile, readFile: fsReadFile, unlink, mkdtemp } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const dir = await mkdtemp(join(tmpdir(), "vision-"));
  const pdfPath = join(dir, "input.pdf");
  const imgPrefix = join(dir, "page");

  try {
    await writeFile(pdfPath, pdfBuffer);
    await execFileAsync("pdftoppm", ["-png", "-f", "1", "-l", "1", "-r", "200", pdfPath, imgPrefix]);

    const { readdir } = await import("fs/promises");
    const files = await readdir(dir);
    const imgFile = files.find((f) => f.startsWith("page") && f.endsWith(".png"));
    if (!imgFile) return { customer: null, customerDrawingNo: null, orderNo: null };

    const imgBuffer = await fsReadFile(join(dir, imgFile));
    const base64 = imgBuffer.toString("base64");

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model, temperature: 0, max_tokens: 200,
        messages: [
          { role: "system", content: `Extract from this Walterscheid technical drawing:\n- customer: company name (für Kunde / for customer / pour client)\n- customerDrawingNo: customer drawing number (Kundenzeichnungs-Nr)\n- orderNo: order number (Bestell-Nr / Part No), typically 5-8 digits\n\nReturn ONLY valid JSON. Use null for missing fields.` },
          { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${base64}`, detail: "low" } }] },
        ],
      }),
    });

    if (!res.ok) return { customer: null, customerDrawingNo: null, orderNo: null };
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content?.trim();
    if (!content) return { customer: null, customerDrawingNo: null, orderNo: null };
    const clean = content.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(clean);
    return { customer: parsed.customer || null, customerDrawingNo: parsed.customerDrawingNo || null, orderNo: parsed.orderNo || null };
  } catch {
    return { customer: null, customerDrawingNo: null, orderNo: null };
  } finally {
    try {
      const { readdir } = await import("fs/promises");
      const files = await readdir(dir);
      for (const f of files) await unlink(join(dir, f)).catch(() => {});
      const { rmdir } = await import("fs/promises");
      await rmdir(dir).catch(() => {});
    } catch {}
  }
}

// ── Tesseract OCR (free, local) ─────────────────────────────────────────────

async function extractTextWithTesseract(pdfBuffer: Buffer): Promise<string> {
  const { execFile } = await import("child_process");
  const { writeFile, readFile: fsReadFile, unlink, mkdtemp } = await import("fs/promises");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const dir = await mkdtemp(join(tmpdir(), "ocr-"));
  const pdfPath = join(dir, "input.pdf");
  const imgPrefix = join(dir, "page");

  try {
    await writeFile(pdfPath, pdfBuffer);

    // Convert first page of PDF to PNG using pdftoppm
    await execFileAsync("pdftoppm", ["-png", "-f", "1", "-l", "1", "-r", "300", pdfPath, imgPrefix]);

    // Find the generated image
    const { readdir } = await import("fs/promises");
    const files = await readdir(dir);
    const imgFile = files.find((f) => f.startsWith("page") && f.endsWith(".png"));
    if (!imgFile) return "";

    const imgPath = join(dir, imgFile);

    // Run Tesseract OCR
    const { stdout } = await execFileAsync("tesseract", [imgPath, "-", "-l", "deu+eng+fra"]);
    return stdout;
  } catch {
    return "";
  } finally {
    // Cleanup temp files
    const { readdir } = await import("fs/promises");
    try {
      const files = await readdir(dir);
      for (const f of files) await unlink(join(dir, f)).catch(() => {});
      const { rmdir } = await import("fs/promises");
      await rmdir(dir).catch(() => {});
    } catch {}
  }
}

// ── Process one PDF ─────────────────────────────────────────────────────────

async function processOnePdf(file: { path_lower: string; name: string; id: string }): Promise<ProcessedFile> {
  try {
    const buffer = await downloadWithRetry(file.path_lower);

    // Step 1: Try pdf-parse (fast, text-layer extraction)
    const parsed = await pdfParse(buffer);
    const text1 = parsed.text.normalize("NFC");
    const fields1 = extractFieldsFromText(text1);
    const name1 = buildNewName(fields1);
    if (name1) {
      return { id: file.id, originalName: file.name, path: file.path_lower, fields: fields1, newName: name1, status: "ready" };
    }

    // Step 2: Try Tesseract OCR (free, image-based)
    const text2 = await extractTextWithTesseract(buffer);
    if (text2.length > 20) {
      const fields2 = extractFieldsFromText(text2.normalize("NFC"));
      // Merge: prefer pdf-parse results, fill gaps with Tesseract
      const merged = {
        customer: fields1.customer || fields2.customer,
        customerDrawingNo: fields1.customerDrawingNo || fields2.customerDrawingNo,
        orderNo: fields1.orderNo || fields2.orderNo,
      };
      const name2 = buildNewName(merged);
      if (name2) {
        return { id: file.id, originalName: file.name, path: file.path_lower, fields: merged, newName: name2, status: "ready" };
      }
      return { id: file.id, originalName: file.name, path: file.path_lower, fields: merged, newName: null, status: "unresolved" };
    }

    return { id: file.id, originalName: file.name, path: file.path_lower, fields: fields1, newName: null, status: "unresolved" };
  } catch (err: any) {
    return { id: file.id, originalName: file.name, path: file.path_lower, fields: { customer: null, customerDrawingNo: null, orderNo: null }, newName: null, status: "error", error: err.message };
  }
}

// ── Concurrency runner (fixed: errors don't leave dangling tasks) ───────────

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number, onResult: (result: T, index: number) => void): Promise<void> {
  let index = 0;
  let active = 0;
  let failed = false;
  return new Promise((resolve, reject) => {
    function startNext() {
      if (failed) return;
      while (active < concurrency && index < tasks.length) {
        const currentIndex = index++;
        active++;
        tasks[currentIndex]()
          .then((result) => {
            if (failed) return;
            active--;
            onResult(result, currentIndex);
            if (index < tasks.length) startNext();
            else if (active === 0) resolve();
          })
          .catch((err) => {
            if (failed) return;
            failed = true;
            reject(err);
          });
      }
      if (tasks.length === 0) resolve();
    }
    startNext();
  });
}

// ── Job stores with cleanup ─────────────────────────────────────────────────

interface ScanJob {
  status: "listing" | "processing" | "done" | "error";
  total: number;
  processed: number;
  files: ProcessedFile[];
  error?: string;
  startedAt: number;
  autoAiJobId?: string;
  autoRenameJobId?: string;
}

interface AiJob {
  status: "processing" | "done" | "error";
  total: number;
  processed: number;
  results: ProcessedFile[];
  error?: string;
  startedAt: number;
}

const jobs = new Map<string, ScanJob>();
const aiJobs = new Map<string, AiJob>();
let jobCounter = 0;
let aiJobCounter = 0;

// Clean up jobs older than 24 hours every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of jobs) { if (job.startedAt < cutoff) jobs.delete(id); }
  for (const [id, job] of aiJobs) { if (job.startedAt < cutoff) aiJobs.delete(id); }
}, 30 * 60 * 1000);

// ── Background scan job ─────────────────────────────────────────────────────

async function runScanJob(jobId: string) {
  const job = jobs.get(jobId)!;
  try {
    const dbx = await getDropboxClient();
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
      for (const e of entries) allPdfs.push({ path_lower: e.path_lower, name: e.name, id: e.id });
      if (!listRes.result.has_more) break;
      cursor = (listRes.result as any).cursor;
    }

    job.total = allPdfs.length;
    job.status = "processing";
    if (allPdfs.length === 0) { job.status = "done"; return; }

    // processOnePdf gets fresh dbx internally via downloadWithRetry
    const tasks = allPdfs.map((file) => () => processOnePdf(file));
    await runWithConcurrency(tasks, BATCH_CONCURRENCY, (result) => {
      job.processed++;
      job.files.push(result);
    });

    job.status = "done";

    // Auto-launch AI for unresolved files
    if (process.env.OPENAI_API_KEY) {
      const unresolved = job.files.filter((f) => f.status === "unresolved");
      if (unresolved.length > 0) {
        const aiJobId = String(++aiJobCounter);
        const aiFiles = unresolved.map((f) => ({ path: f.path, originalName: f.originalName, id: f.id, fields: f.fields }));
        aiJobs.set(aiJobId, { status: "processing", total: aiFiles.length, processed: 0, results: [], startedAt: Date.now() });
        job.autoAiJobId = aiJobId;
        runAiJob(aiJobId, aiFiles, jobId).catch(() => {});
      } else {
        // No unresolved — auto-rename ready files now
        autoRenameReady(job, jobId);
      }
    } else {
      // No AI key — auto-rename ready files now
      autoRenameReady(job, jobId);
    }
  } catch (err: any) {
    job.status = "error";
    job.error = err.message;
  }
}

async function runAiJob(aiJobId: string, files: Array<{ path: string; originalName: string; id: string; fields: PdfFields }>, scanJobId?: string) {
  const aiJob = aiJobs.get(aiJobId)!;
  const tasks = files.map((f) => async () => {
    try {
      const buffer = await downloadWithRetry(f.path);
      const parsed = await pdfParse(buffer);
      const normalizedText = parsed.text.normalize("NFC");

      // Step 1: GPT-4o-mini (text-based, cheap)
      const aiFields = await extractFieldsWithAI(normalizedText);
      const merged1: PdfFields = {
        customer: f.fields.customer || aiFields.customer,
        customerDrawingNo: f.fields.customerDrawingNo || aiFields.customerDrawingNo,
        orderNo: f.fields.orderNo || aiFields.orderNo,
      };
      const name1 = buildNewName(merged1);
      if (name1) {
        return { id: f.id, originalName: f.originalName, path: f.path, fields: merged1, newName: name1, status: "ready" } as ProcessedFile;
      }

      // Step 2: GPT-4o-mini vision (image-based, still cheap)
      const visionFieldsMini = await extractFieldsWithVision(buffer, "gpt-4o-mini");
      const merged2: PdfFields = {
        customer: merged1.customer || visionFieldsMini.customer,
        customerDrawingNo: merged1.customerDrawingNo || visionFieldsMini.customerDrawingNo,
        orderNo: merged1.orderNo || visionFieldsMini.orderNo,
      };
      const name2 = buildNewName(merged2);
      if (name2) {
        return { id: f.id, originalName: f.originalName, path: f.path, fields: merged2, newName: name2, status: "ready" } as ProcessedFile;
      }

      // Step 3: GPT-4o vision (more expensive but most accurate)
      const visionFields4o = await extractFieldsWithVision(buffer, "gpt-4o");
      const merged3: PdfFields = {
        customer: merged2.customer || visionFields4o.customer,
        customerDrawingNo: merged2.customerDrawingNo || visionFields4o.customerDrawingNo,
        orderNo: merged2.orderNo || visionFields4o.orderNo,
      };
      const name3 = buildNewName(merged3);
      return { id: f.id, originalName: f.originalName, path: f.path, fields: merged3, newName: name3, status: name3 ? "ready" : "unresolved" } as ProcessedFile;
    } catch (err: any) {
      return { id: f.id, originalName: f.originalName, path: f.path, fields: f.fields, newName: null, status: "error", error: err.message } as ProcessedFile;
    }
  });

  try {
    await runWithConcurrency(tasks, 3, (result) => {
      aiJob.processed++;
      aiJob.results.push(result);
      if (scanJobId && jobs.has(scanJobId)) {
        const scanJob = jobs.get(scanJobId)!;
        const idx = scanJob.files.findIndex((f) => f.path === result.path);
        if (idx >= 0) scanJob.files[idx] = result;
      }
    });
    aiJob.status = "done";

    // Auto-rename all ready files after AI completes
    if (scanJobId && jobs.has(scanJobId)) {
      const scanJob = jobs.get(scanJobId)!;
      const readyFiles = scanJob.files.filter((f) => f.status === "ready" && f.newName);
      if (readyFiles.length > 0) {
        const renameId = String(++renameJobCounter);
        const filesToRename = readyFiles.map((f) => ({ path: f.path, newName: f.newName! }));
        renameJobs.set(renameId, { status: "processing", total: filesToRename.length, processed: 0, results: [], startedAt: Date.now() });
        scanJob.autoRenameJobId = renameId;
        runRenameJob(renameId, filesToRename).catch(() => {});
      }
    }
  } catch (err: any) {
    aiJob.status = "error";
    aiJob.error = err.message;
  }
}

// ── Routes ──────────────────────────────────────────────────────────────────

function autoRenameReady(job: ScanJob, jobId: string) {
  const readyFiles = job.files.filter((f) => f.status === "ready" && f.newName);
  if (readyFiles.length > 0) {
    const renameId = String(++renameJobCounter);
    const filesToRename = readyFiles.map((f) => ({ path: f.path, newName: f.newName! }));
    renameJobs.set(renameId, { status: "processing", total: filesToRename.length, processed: 0, results: [], startedAt: Date.now() });
    job.autoRenameJobId = renameId;
    runRenameJob(renameId, filesToRename).catch(() => {});
  }
}

router.post("/dropbox/scan/start", (_req: Request, res: Response) => {
  const jobId = String(++jobCounter);
  jobs.set(jobId, { status: "listing", total: 0, processed: 0, files: [], startedAt: Date.now() });
  runScanJob(jobId).catch(() => {});
  res.json({ jobId });
});

router.get("/dropbox/scan/status", (req: Request, res: Response) => {
  const jobId = req.query.jobId as string;
  const cursor = Number(req.query.cursor || 0);
  if (!jobId || !jobs.has(jobId)) { res.status(404).json({ error: "Job not found" }); return; }
  const job = jobs.get(jobId)!;
  const newFiles = job.files.slice(cursor);
  res.json({
    status: job.status, total: job.total, processed: job.processed,
    files: newFiles, cursor: cursor + newFiles.length,
    error: job.error, autoAiJobId: job.autoAiJobId,
  });
});

router.delete("/dropbox/scan/job", (req: Request, res: Response) => {
  const jobId = req.query.jobId as string;
  if (jobId) jobs.delete(jobId);
  res.json({ ok: true });
});

// ── Rename (background job) ──────────────────────────────────────────────────

interface RenameJob {
  status: "processing" | "done" | "error";
  total: number;
  processed: number;
  results: Array<{ path: string; newName?: string; newPath?: string; status: string; error?: string; reason?: string }>;
  error?: string;
  startedAt: number;
}

const renameJobs = new Map<string, RenameJob>();
let renameJobCounter = 0;

// Clean up rename jobs too
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, job] of renameJobs) { if (job.startedAt < cutoff) renameJobs.delete(id); }
}, 30 * 60 * 1000);

async function runRenameJob(renameJobId: string, files: Array<{ path: string; newName: string }>) {
  const job = renameJobs.get(renameJobId)!;

  let remaining = files;
  let round = 0;
  const maxRounds = 3;

  while (remaining.length > 0 && round < maxRounds) {
    if (round > 0) {
      // Wait before retry round — exponential backoff
      await sleep(round * 30000); // 30s, 60s
    }

    const retryList: Array<{ path: string; newName: string }> = [];

    const tasks = remaining.map((f) => async () => {
      try {
        const dir = f.path.substring(0, f.path.lastIndexOf("/"));
        const newPath = `${dir}/${f.newName}`;
        if (f.path.toLowerCase() === newPath.toLowerCase()) return { path: f.path, newName: f.newName, status: "skipped", reason: "same name", _retry: false };
        await dropboxMoveWithRetry(f.path, newPath);
        return { path: f.path, newPath, newName: f.newName, status: "renamed", _retry: false };
      } catch (err: any) {
        const is429 = err?.message?.includes("429") || err?.status === 429;
        if (is429) {
          retryList.push(f);
          return { path: f.path, newName: f.newName, status: "pending_retry", error: "429 - will retry", _retry: true };
        }
        return { path: f.path, newName: f.newName, status: "error", error: err.message, _retry: false };
      }
    });

    await runWithConcurrency(tasks, 5, (result) => {
      if (!result._retry) {
        job.processed++;
        job.results.push(result);
      }
    });

    remaining = retryList;
    round++;
  }

  // Any still remaining after all rounds — mark as error
  for (const f of remaining) {
    job.processed++;
    job.results.push({ path: f.path, newName: f.newName, status: "error", error: "429 after all retries" });
  }

  job.status = "done";
}

router.post("/dropbox/rename/start", (req: Request, res: Response) => {
  const { files } = req.body as { files: Array<{ path: string; newName: string }> };
  if (!Array.isArray(files) || files.length === 0) { res.status(400).json({ error: "files array is required" }); return; }
  const renameJobId = String(++renameJobCounter);
  renameJobs.set(renameJobId, { status: "processing", total: files.length, processed: 0, results: [], startedAt: Date.now() });
  runRenameJob(renameJobId, files).catch(() => {});
  res.json({ renameJobId });
});

router.get("/dropbox/rename/status", (req: Request, res: Response) => {
  const renameJobId = req.query.renameJobId as string;
  const cursor = Number(req.query.cursor || 0);
  if (!renameJobId || !renameJobs.has(renameJobId)) { res.status(404).json({ error: "Rename job not found" }); return; }
  const job = renameJobs.get(renameJobId)!;
  const newResults = job.results.slice(cursor);
  res.json({
    status: job.status, total: job.total, processed: job.processed,
    results: newResults, cursor: cursor + newResults.length, error: job.error,
  });
});

router.get("/dropbox/inspect", async (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath) { res.status(400).json({ error: "path query parameter is required" }); return; }
  try {
    const buffer = await downloadWithRetry(filePath);
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
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post("/dropbox/ai-resolve/start", (req: Request, res: Response) => {
  const { files, scanJobId } = req.body as { files: Array<{ path: string; originalName: string; id: string; fields: PdfFields }>; scanJobId?: string };
  if (!Array.isArray(files) || files.length === 0) { res.status(400).json({ error: "files array is required" }); return; }
  if (!process.env.OPENAI_API_KEY) { res.status(400).json({ error: "OPENAI_API_KEY is not configured" }); return; }
  const aiJobId = String(++aiJobCounter);
  aiJobs.set(aiJobId, { status: "processing", total: files.length, processed: 0, results: [], startedAt: Date.now() });
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
    status: aiJob.status, total: aiJob.total, processed: aiJob.processed,
    results: newResults, cursor: cursor + newResults.length, error: aiJob.error,
  });
});

// ── CSV export ───────────────────────────────────────────────────────────────

router.get("/dropbox/export-csv", (req: Request, res: Response) => {
  const jobId = req.query.jobId as string;
  if (!jobId || !jobs.has(jobId)) { res.status(404).json({ error: "Job not found" }); return; }

  const job = jobs.get(jobId)!;
  const readyFiles = job.files.filter((f) => f.status === "ready" && f.fields.customer && f.fields.customerDrawingNo && f.fields.orderNo);

  // BOM for Excel UTF-8 detection
  const BOM = "\uFEFF";
  const header = "№;OEM;Original PN;PN WPG";
  const rows = readyFiles.map((f, i) => {
    const oem = (f.fields.customer || "").replace(/;/g, ",");
    const originalPn = (f.fields.customerDrawingNo || "").replace(/;/g, ",");
    const pnWpg = (f.fields.orderNo || "").replace(/;/g, ",");
    return `${i + 1};${oem};${originalPn};${pnWpg}`;
  });

  const csv = BOM + header + "\n" + rows.join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=walterscheid_catalog.csv");
  res.send(csv);
});

export default router;
