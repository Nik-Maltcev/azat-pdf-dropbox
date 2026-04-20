// Pure functions extracted for testability

export interface PdfFields {
  customer: string | null;
  customerDrawingNo: string | null;
  orderNo: string | null;
}

export function transliterateGerman(s: string): string {
  return s.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss");
}

export function buildNewName(fields: PdfFields): string | null {
  const { customer, customerDrawingNo, orderNo } = fields;
  if (!customer || !customerDrawingNo || !orderNo) return null;

  // Validate orderNo: must be 5-8 digits
  if (!/^\d{5,8}$/.test(orderNo)) return null;

  // Validate customer: must have at least 3 consecutive letters (not garbage)
  if (!/[A-Za-zÄÖÜäöüß]{3}/.test(customer)) return null;

  // Validate customerDrawingNo: at least 3 chars, must contain letter or digit
  if (customerDrawingNo.length < 3) return null;
  if (!/[A-Za-z0-9]{2}/.test(customerDrawingNo)) return null;

  const safe = (s: string) => transliterateGerman(s).replace(/[^A-Za-z0-9_-]/g, "").trim();
  const c = safe(customer);
  const d = safe(customerDrawingNo);
  const o = safe(orderNo);
  if (!c || c.length < 3 || !d || d.length < 3 || !o) return null;
  return `${c}_${d}_${o}.pdf`;
}

export function extractFieldsFromText(text: string): PdfFields {
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

export async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], concurrency: number, onResult: (result: T, index: number) => void): Promise<void> {
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
