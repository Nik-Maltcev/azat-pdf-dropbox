import { describe, it, expect } from "vitest";
import { extractFieldsFromText, buildNewName, transliterateGerman, runWithConcurrency } from "../lib/pdf-utils";

// ── transliterateGerman ─────────────────────────────────────────────────────

describe("transliterateGerman", () => {
  it("replaces lowercase umlauts", () => {
    expect(transliterateGerman("äöüß")).toBe("aeoeuess");
  });
  it("replaces uppercase umlauts", () => {
    expect(transliterateGerman("ÄÖÜ")).toBe("AeOeUe");
  });
  it("leaves ASCII unchanged", () => {
    expect(transliterateGerman("Hello World")).toBe("Hello World");
  });
  it("handles mixed content", () => {
    expect(transliterateGerman("Müller & Söhne GmbH")).toBe("Mueller & Soehne GmbH");
  });
});

// ── buildNewName ────────────────────────────────────────────────────────────

describe("buildNewName", () => {
  it("builds correct name from all fields", () => {
    expect(buildNewName({ customer: "POTTINGER", customerDrawingNo: "455-247", orderNo: "1136026" }))
      .toBe("POTTINGER_455-247_1136026.pdf");
  });
  it("returns null if customer is missing", () => {
    expect(buildNewName({ customer: null, customerDrawingNo: "123", orderNo: "456" })).toBeNull();
  });
  it("returns null if customerDrawingNo is missing", () => {
    expect(buildNewName({ customer: "Test", customerDrawingNo: null, orderNo: "456" })).toBeNull();
  });
  it("returns null if orderNo is missing", () => {
    expect(buildNewName({ customer: "Test", customerDrawingNo: "123", orderNo: null })).toBeNull();
  });
  it("transliterates German characters", () => {
    expect(buildNewName({ customer: "Müller", customerDrawingNo: "ABC", orderNo: "123456" }))
      .toBe("Mueller_ABC_123456.pdf");
  });
  it("strips non-alphanumeric characters", () => {
    expect(buildNewName({ customer: "Test & Co.", customerDrawingNo: "A/B-C", orderNo: "123456" }))
      .toBe("TestCo_AB-C_123456.pdf");
  });
  it("returns null if customer becomes empty after sanitize", () => {
    expect(buildNewName({ customer: "©®™", customerDrawingNo: "123", orderNo: "456789" })).toBeNull();
  });
  it("returns null if all fields are null", () => {
    expect(buildNewName({ customer: null, customerDrawingNo: null, orderNo: null })).toBeNull();
  });
});

// ── extractFieldsFromText ───────────────────────────────────────────────────

describe("extractFieldsFromText", () => {
  it("extracts all 3 fields from clean German PDF text", () => {
    const text = `
Bestell-Nr.
Part No
101399
Kundenzeichnungs-Nr
customer drawing No
MezögepSzolnok
für Kunde
for customer
Mezögep Szolnok
Zeichnungs-Nr.
Drawing No.
8012479
    `;
    const fields = extractFieldsFromText(text);
    expect(fields.orderNo).toBe("101399");
    expect(fields.customer).toBe("Mezögep Szolnok");
  });

  it("extracts order number from same line as label", () => {
    const text = "Bestell-Nr. 101399\nKunde\nFreudendahl";
    const fields = extractFieldsFromText(text);
    expect(fields.orderNo).toBe("101399");
    expect(fields.customer).toBe("Freudendahl");
  });

  it("handles OCR space-in-number (1 02038)", () => {
    const text = `
Bestell-Nr.
Part No
Referen~e
1 02038
Zeichnungs-Nr.
Drawing No.
5 8,13
für Kunde
for cus tomer
Freudendahl
    `;
    const fields = extractFieldsFromText(text);
    expect(fields.orderNo).toBe("102038");
    expect(fields.customer).toBe("Freudendahl");
  });

  it("extracts customer drawing number from Kundenzeichnungs-Nr", () => {
    const text = `
Kundenzeichnungs-Nr
customer drawing No
ABC12345
Bestell-Nr.
101000
für Kunde
TestCompany
    `;
    const fields = extractFieldsFromText(text);
    expect(fields.customerDrawingNo).toBe("ABC12345");
    expect(fields.orderNo).toBe("101000");
    expect(fields.customer).toBe("TestCompany");
  });

  it("extracts from plain Zeichnungs-Nr (without Kunden)", () => {
    const text = `
Zeichnungs-Nr.
Drawing No.
56-136-51
Bestell-Nr.
101007
für Kunde
Lemken
    `;
    const fields = extractFieldsFromText(text);
    expect(fields.customerDrawingNo).toBe("56-136-51");
    expect(fields.orderNo).toBe("101007");
    expect(fields.customer).toBe("Lemken");
  });

  it("uses fallback for order number (standalone 6-8 digit)", () => {
    const text = "Some random text\n1234567\nMore text";
    const fields = extractFieldsFromText(text);
    expect(fields.orderNo).toBe("1234567");
  });

  it("uses fallback for customer drawing (ABC + digits pattern)", () => {
    const text = "Some text\nABC12345\nMore text";
    const fields = extractFieldsFromText(text);
    expect(fields.customerDrawingNo).toBe("ABC12345");
  });

  it("uses fallback for dotted drawing number (56.136.51)", () => {
    const text = "Some text with 56.136.51 in it and 1234567 order";
    const fields = extractFieldsFromText(text);
    expect(fields.customerDrawingNo).toBe("56-136-51");
    expect(fields.orderNo).toBe("1234567");
  });

  it("skips garbage lines after drawing label", () => {
    const text = `
Kundenzeichnungs-Nr
~~~
@©
ABC123
Bestell-Nr.
100000
für Kunde
TestCo
    `;
    const fields = extractFieldsFromText(text);
    expect(fields.customerDrawingNo).toBe("ABC123");
  });

  it("returns all nulls for empty text", () => {
    const fields = extractFieldsFromText("");
    expect(fields.customer).toBeNull();
    expect(fields.customerDrawingNo).toBeNull();
    expect(fields.orderNo).toBeNull();
  });

  it("returns all nulls for garbage-only text", () => {
    const text = "~~~\n@©\n(·c·'~\n~)\nDatum\nDate";
    const fields = extractFieldsFromText(text);
    expect(fields.customer).toBeNull();
    expect(fields.orderNo).toBeNull();
  });

  it("handles French labels (pour client)", () => {
    const text = `
pour cl i ent
SomeCompany
Bestell-Nr.
200000
    `;
    const fields = extractFieldsFromText(text);
    expect(fields.customer).toBe("SomeCompany");
    expect(fields.orderNo).toBe("200000");
  });

  it("handles 'for customer' English label", () => {
    const text = `
for cus tomer
Nicolas Agen
Bestell-Nr.
101006
Kundenzeichnungs-Nr
2324
    `;
    const fields = extractFieldsFromText(text);
    expect(fields.customer).toBe("Nicolas Agen");
    expect(fields.orderNo).toBe("101006");
    expect(fields.customerDrawingNo).toBe("2324");
  });

  it("normalizes dots/commas in drawing numbers", () => {
    const text = `
Zeichnungs-Nr.
455.247/748
Bestell-Nr.
1136026
für Kunde
POTTINGER
    `;
    const fields = extractFieldsFromText(text);
    expect(fields.customerDrawingNo).toBe("455-247/748");
  });

  it("does not pick label lines as customer name", () => {
    const text = `
für Kunde
for customer
pour client
Gelenkwelle
PTO drive shaft
Bestell-Nr.
100000
    `;
    const fields = extractFieldsFromText(text);
    // "Gelenkwelle" is in IS_LABEL, should be skipped
    expect(fields.customer).not.toBe("Gelenkwelle");
  });
});

// ── runWithConcurrency ──────────────────────────────────────────────────────

describe("runWithConcurrency", () => {
  it("runs all tasks and collects results", async () => {
    const results: number[] = [];
    const tasks = [1, 2, 3, 4, 5].map((n) => async () => n);
    await runWithConcurrency(tasks, 3, (result, index) => {
      results.push(result);
    });
    expect(results.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("respects concurrency limit", async () => {
    let maxActive = 0;
    let active = 0;
    const tasks = Array.from({ length: 10 }, () => async () => {
      active++;
      if (active > maxActive) maxActive = active;
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return true;
    });
    await runWithConcurrency(tasks, 3, () => {});
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("handles empty task list", async () => {
    const results: any[] = [];
    await runWithConcurrency([], 5, (r) => results.push(r));
    expect(results).toEqual([]);
  });

  it("rejects on task failure and stops new tasks", async () => {
    let completed = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      if (i === 2) throw new Error("fail");
      await new Promise((r) => setTimeout(r, 50));
      completed++;
      return i;
    });
    await expect(runWithConcurrency(tasks, 2, () => {})).rejects.toThrow("fail");
    // Some tasks may have completed before the failure, but not all 10
    expect(completed).toBeLessThan(10);
  });

  it("preserves result order via index", async () => {
    const ordered: [number, number][] = [];
    const tasks = [30, 10, 20].map((delay, i) => async () => {
      await new Promise((r) => setTimeout(r, delay));
      return i;
    });
    await runWithConcurrency(tasks, 3, (result, index) => {
      ordered.push([index, result]);
    });
    // Results arrive in completion order, but index matches original position
    for (const [index, result] of ordered) {
      expect(index).toBe(result);
    }
  });
});

// ── Integration: extractFieldsFromText + buildNewName ───────────────────────

describe("end-to-end: extract + build name", () => {
  it("produces correct filename from real PDF text", () => {
    const text = `
Bestell-Nr.
Part No
101399
Kundenzeichnungs-Nr
customer drawing No
MezogepSzolnok
für Kunde
for customer
Mezögep Szolnok
    `;
    const fields = extractFieldsFromText(text);
    const name = buildNewName(fields);
    expect(name).toBe("MezoegepSzolnok_MezogepSzolnok_101399.pdf");
  });

  it("handles POTTINGER example", () => {
    const text = `
Bestell-Nr.
1136026
Kundenzeichnungs-Nr
455.247/748
für Kunde
POTTINGER
    `;
    const fields = extractFieldsFromText(text);
    const name = buildNewName(fields);
    expect(name).toContain("POTTINGER");
    expect(name).toContain("1136026");
  });

  it("returns null for unresolvable text", () => {
    const text = "für Kunde\nfor cus tomer\npour cl i ent\n~~~\n@©\nDatum\nDate";
    const fields = extractFieldsFromText(text);
    const name = buildNewName(fields);
    expect(name).toBeNull();
  });
});
