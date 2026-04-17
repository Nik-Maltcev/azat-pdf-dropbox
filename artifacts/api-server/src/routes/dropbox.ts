import { Router } from "express";
import { Dropbox } from "dropbox";
// pdf-parse is a CJS module, use require via globalThis.require
const pdfParse: (buffer: Buffer) => Promise<{ text: string }> = (globalThis as any).require("pdf-parse");

const router = Router();

const DROPBOX_FOLDER = "/Walterscheid";

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

    // Für Kunde / For customer / pour client
    if (
      /für kunde|for customer|pour client/i.test(line) ||
      /Kunden-Zeichnungs-Nr|Customer drawing No|Réf\. du plan/i.test(line)
    ) {
      // customer is usually on next meaningful line or on same line after colon
      const nextLine = lines[i + 1] || "";
      if (/für kunde|for customer|pour client/i.test(line)) {
        if (nextLine && !/kunden|customer|pour/i.test(nextLine)) {
          customer = customer || nextLine.split(/\s{2,}/)[0].trim();
        }
      }
      if (/Kunden-Zeichnungs-Nr|Customer drawing No|Réf\. du plan/i.test(line)) {
        const nextVal = lines[i + 1] || "";
        if (nextVal && !/Kunden|Customer|Réf/i.test(nextVal)) {
          customerDrawingNo = customerDrawingNo || nextVal.split(/\s{2,}/)[0].trim();
        }
      }
    }

    // Bestell-Nr / Part No / Reference — order number
    if (/Bestell-Nr|Part No|Reference/i.test(line)) {
      const nextVal = lines[i + 1] || "";
      if (nextVal && !/Bestell|Part|Reference/i.test(nextVal)) {
        const candidate = nextVal.split(/\s{2,}/)[0].trim();
        if (/^\d{6,}$/.test(candidate)) {
          orderNo = orderNo || candidate;
        }
      }
      // Also check same line: "Reference 692710"
      const sameLineMatch = line.match(/(?:Bestell-Nr|Part No|Reference)[.:]\s*(\d{5,})/i);
      if (sameLineMatch) orderNo = orderNo || sameLineMatch[1];
    }

    // Maschinen-Nr / Machine No — can be order ref too
    // Sometimes order no appears standalone as large number on page
    if (!orderNo) {
      const bigNum = line.match(/^(\d{6,8})$/);
      if (bigNum) orderNo = bigNum[1];
    }
  }

  // Fallback: scan all text for patterns
  if (!customer || !customerDrawingNo || !orderNo) {
    // Customer drawing no pattern: letters + space + digits (e.g. "EJ 441")
    if (!customerDrawingNo) {
      const cdMatch = text.match(/([A-Z]{1,4}\s\d{2,5})/);
      if (cdMatch) customerDrawingNo = cdMatch[1].replace(/\s+/, "");
    }

    // Order number: 6-8 digit standalone number
    if (!orderNo) {
      const onMatch = text.match(/\b(\d{6,8})\b/);
      if (onMatch) orderNo = onMatch[1];
    }

    // Customer: look for "Amazone" or similar word near "für Kunde"
    if (!customer) {
      const custMatch = text.match(/(?:für Kunde|for customer|pour client)[^\n]*\n\s*([A-Za-z][A-Za-z\s&.-]{2,30})/i);
      if (custMatch) customer = custMatch[1].trim();
    }
  }

  return { customer, customerDrawingNo, orderNo };
}

function buildNewName(fields: PdfFields, originalName: string): string | null {
  const { customer, customerDrawingNo, orderNo } = fields;
  if (!customer || !customerDrawingNo || !orderNo) return null;
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "").trim();
  return `${safe(customer)}_${safe(customerDrawingNo)}_${safe(orderNo)}.pdf`;
}

// GET /api/dropbox/list — list PDFs and preview new names
router.get("/dropbox/list", async (req, res) => {
  try {
    const dbx = getDropboxClient();
    const listRes = await dbx.filesListFolder({ path: DROPBOX_FOLDER, limit: 200 });

    const pdfFiles = (listRes.result.entries as any[]).filter(
      (e) => e[".tag"] === "file" && e.name.toLowerCase().endsWith(".pdf")
    );

    const results = await Promise.all(
      pdfFiles.map(async (file) => {
        try {
          const dlRes = await dbx.filesDownload({ path: file.path_lower });
          const buffer = (dlRes.result as any).fileBinary as Buffer;
          const parsed = await pdfParse(buffer);
          const fields = extractFieldsFromText(parsed.text);
          const newName = buildNewName(fields, file.name);
          return {
            id: file.id,
            originalName: file.name,
            path: file.path_lower,
            fields,
            newName,
            status: newName ? "ready" : "unresolved",
          };
        } catch (err: any) {
          return {
            id: file.id,
            originalName: file.name,
            path: file.path_lower,
            fields: { customer: null, customerDrawingNo: null, orderNo: null },
            newName: null,
            status: "error",
            error: err.message,
          };
        }
      })
    );

    res.json({ folder: DROPBOX_FOLDER, files: results });
  } catch (err: any) {
    req.log.error({ err }, "Failed to list Dropbox files");
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dropbox/rename — rename files in Dropbox
router.post("/dropbox/rename", async (req, res) => {
  const { files } = req.body as {
    files: Array<{ path: string; newName: string }>;
  };

  if (!Array.isArray(files) || files.length === 0) {
    res.status(400).json({ error: "files array is required" });
    return;
  }

  const dbx = getDropboxClient();
  const results = [];

  for (const f of files) {
    try {
      const dir = f.path.substring(0, f.path.lastIndexOf("/"));
      const newPath = `${dir}/${f.newName}`;

      if (f.path.toLowerCase() === newPath.toLowerCase()) {
        results.push({ path: f.path, newName: f.newName, status: "skipped", reason: "same name" });
        continue;
      }

      await dbx.filesMoveV2({
        from_path: f.path,
        to_path: newPath,
        autorename: false,
      });
      results.push({ path: f.path, newPath, newName: f.newName, status: "renamed" });
    } catch (err: any) {
      results.push({ path: f.path, newName: f.newName, status: "error", error: err.message });
    }
  }

  res.json({ results });
});

export default router;
