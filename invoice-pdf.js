/*
 * invoice-pdf.js — draws an invoice in the "Eldho Skaria" template (US Letter, green theme).
 * Works in the browser (window.InvoicePDF) and in Node (module.exports) with jsPDF 2.x.
 *
 * buildInvoicePdf(jsPDF, { profile, client, invoice }) -> jsPDF document
 *   profile: { name, title, address, contact, pan, account_name, bank_name, account_no, ifsc, footer }
 *   client:  { name, address, gstin }
 *   invoice: { kind, invoice_no, invoice_date, items:[{title, detail, qty, rate}], tds_pct,
 *              tax_note, notes:[...], status, paid_date, payment_ref }
 */
(function (root) {
  const GREEN = [31, 91, 79], TINT = [234, 243, 240], PANEL = [248, 250, 251];
  const INK = [38, 50, 56], MUTED = [102, 112, 133], BORDER = [208, 216, 222], WHITE = [255, 255, 255];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function longDate(iso) {
    if (!iso) return "";
    const [y, m, d] = String(iso).slice(0, 10).split("-");
    return `${d} ${MONTHS[+m - 1]} ${y}`;
  }
  const CURRENCY_WORDS = { INR: ["Rupees", "Paise"], USD: ["US Dollars", "Cents"], AED: ["UAE Dirhams", "Fils"], EUR: ["Euros", "Cents"],
    GBP: ["Pounds Sterling", "Pence"], SAR: ["Saudi Riyals", "Halalas"], QAR: ["Qatari Riyals", "Dirhams"], OMR: ["Omani Rials", "Baisa"],
    KWD: ["Kuwaiti Dinars", "Fils"], BHD: ["Bahraini Dinars", "Fils"], SGD: ["Singapore Dollars", "Cents"], AUD: ["Australian Dollars", "Cents"], CAD: ["Canadian Dollars", "Cents"] };
  function inr(n, cur) {
    const v = Number(n || 0);
    const frac = Math.abs(v % 1) > 0.0001;
    return v.toLocaleString(!cur || cur === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: frac || (cur && cur !== "INR") ? 2 : 0, maximumFractionDigits: 2 });
  }
  function wordsIntl(num) {
    if (num === 0) return "Zero";
    const parts = []; const scales = [[1e9, "Billion"], [1e6, "Million"], [1e3, "Thousand"]];
    for (const [v, nm] of scales) { const q = Math.floor(num / v); if (q) { parts.push(words(q) + " " + nm); num %= v; } }
    if (num) parts.push(words(num));
    return parts.join(" ");
  }
  function amountWords(amount, cur) {
    cur = cur || "INR";
    const [major, minor] = CURRENCY_WORDS[cur] || [cur, "cents"];
    const whole = Math.floor(Math.round(Number(amount || 0) * 100) / 100);
    const fr = Math.round((Number(amount || 0) - whole) * 100);
    const w = cur === "INR" ? words(whole) : wordsIntl(whole);
    return `${major} ${w}${fr ? " and " + (cur === "INR" ? words(fr) : wordsIntl(fr)) + " " + minor : ""}`;
  }
  function words(num) {
    num = Math.round(Number(num) || 0);
    if (num === 0) return "Zero";
    const a = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
    const b = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
    const two = n => n < 20 ? a[n] : b[Math.floor(n / 10)] + (n % 10 ? "-" + a[n % 10] : "");
    const three = n => { const h = Math.floor(n / 100), r = n % 100; return (h ? a[h] + " Hundred" + (r ? " " : "") : "") + (r ? two(r) : ""); };
    const parts = [];
    const cr = Math.floor(num / 1e7); num %= 1e7;
    const lk = Math.floor(num / 1e5); num %= 1e5;
    const th = Math.floor(num / 1e3); num %= 1e3;
    if (cr) parts.push(three(cr) + " Crore");
    if (lk) parts.push(two(lk) + " Lakh");
    if (th) parts.push(two(th) + " Thousand");
    if (num) parts.push(three(num));
    return parts.join(" ");
  }
  function totals(inv) {
    const items = inv.items || [];
    const line = it => (Number(it.qty) || 0) * (Number(it.rate) || 0);
    const subtotal = items.reduce((s, it) => s + line(it), 0);
    // lines marked tds:false (e.g. re-billed expenses) are not subject to TDS
    const tdsBase = items.filter(it => it.tds !== false).reduce((s, it) => s + line(it), 0);
    const tdsPct = Number(inv.tds_pct) || 0;
    const tds = Math.round(tdsBase * tdsPct) / 100;
    return { subtotal, tdsBase, tdsPct, tds, net: subtotal - tds };
  }

  function buildInvoicePdf(jsPDF, data) {
    const p = data.profile || {}, c = data.client || {}, inv = data.invoice || {};
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    const L = 43.2, R = 612 - 43.2, W = R - L;
    const t = totals(inv);
    const cur = (inv.currency || "INR").toUpperCase();
    const fx = Number(inv.fx_rate) || 1;
    const m = n => inr(n, cur);
    const taxNote = inv.tax_note || "As applicable";

    const font = (style, size, color) => { doc.setFont("helvetica", style); doc.setFontSize(size); doc.setTextColor(...color); };
    const lines = (txt, width) => doc.splitTextToSize(String(txt || ""), width);
    const lh = size => size * 1.28;

    // ---- header ----
    let y = 52;
    font("bold", 17, GREEN); doc.text((p.name || "").toUpperCase(), L, y);
    font("bold", 23, GREEN); doc.text("INVOICE", R, y + 2, { align: "right" });
    y += 14;
    font("normal", 9.5, MUTED); if (p.title) { doc.text(p.title, L, y); }
    let ly = y + 10;
    font("normal", 8, MUTED);
    if (p.address) { lines("Address: " + p.address, W / 2).forEach(s => { doc.text(s, L, ly); ly += 10; }); }
    if (p.contact) { lines("Email / Phone: " + p.contact, W / 2).forEach(s => { doc.text(s, L, ly); ly += 10; }); }
    // right block
    let ry = y;
    const noLabel = "Invoice No.: ";
    font("normal", 8.5, MUTED);
    const noW = doc.getStringUnitWidth("#" + inv.invoice_no) * 8.5;
    font("bold", 8.5, INK); doc.text("#" + (inv.invoice_no || ""), R, ry, { align: "right" });
    font("normal", 8.5, MUTED); doc.text(noLabel, R - noW - 1, ry, { align: "right" });
    ry += 11; doc.text("Invoice Date: " + longDate(inv.invoice_date), R, ry, { align: "right" });
    if (inv.status === "cancelled") { ry += 11; font("bold", 8.5, [180, 35, 24]); doc.text("CANCELLED", R, ry, { align: "right" }); }
    y = Math.max(ly, ry + 8) + 2;
    doc.setDrawColor(...GREEN); doc.setLineWidth(1); doc.line(L, y, R, y);

    // ---- bill to / tax details ----
    y += 12;
    const half = W / 2;
    const billLines = lines(c.address || "", half - 16);
    const taxRows = [];
    if (p.pan) taxRows.push("PAN: " + p.pan);
    if (c.gstin) taxRows.push("Client GSTIN: " + c.gstin);
    const boxH = Math.max(22 + lh(9.5) + billLines.length * lh(8.5), 26 + taxRows.length * lh(8.5));
    doc.setLineWidth(0.6); doc.setDrawColor(...BORDER);
    doc.setFillColor(...TINT); doc.rect(L, y, half, boxH, "FD");
    doc.setFillColor(...PANEL); doc.rect(L + half, y, half, boxH, "FD");
    font("bold", 7.5, GREEN); doc.text("BILL TO", L + 7, y + 12); doc.text("CONSULTANT TAX DETAILS", L + half + 7, y + 12);
    font("bold", 9.5, INK); doc.text(lines(c.name || "", half - 14)[0] || "", L + 7, y + 25);
    font("normal", 8, MUTED);
    billLines.forEach((s, i) => doc.text(s, L + 7, y + 25 + lh(9.5) - 1 + i * lh(8.5)));
    taxRows.forEach((s, i) => doc.text(s, L + half + 7, y + 25 + i * lh(8.5)));
    y += boxH + 14;

    // ---- items table ----
    const cw = W / 4;
    const headH = 18;
    doc.setFillColor(...GREEN); doc.setDrawColor(...BORDER); doc.rect(L, y, W, headH, "F");
    font("bold", 8, WHITE);
    ["Description of Services", "Qty", `Rate (${cur})`, `Amount (${cur})`].forEach((h, i) => {
      if (i === 0) doc.text(h, L + 6, y + 12); else doc.text(h, L + cw * i + cw / 2, y + 12, { align: "center" });
    });
    for (let i = 1; i < 4; i++) { doc.setDrawColor(...WHITE); doc.setLineWidth(0.6); doc.line(L + cw * i, y, L + cw * i, y + headH); }
    y += headH;
    (inv.items || []).forEach(it => {
      font("bold", 9, INK); const tl = lines(it.title, cw - 12);
      font("normal", 7.8, MUTED); const dl = lines(it.detail, cw - 12);
      const rowH = Math.max(42, 10 + tl.length * lh(9) + dl.length * lh(7.8) + 8);
      doc.setDrawColor(...BORDER); doc.setLineWidth(0.6); doc.rect(L, y, W, rowH);
      for (let i = 1; i < 4; i++) doc.line(L + cw * i, y, L + cw * i, y + rowH);
      let ty = y + 13;
      font("bold", 9, INK); tl.forEach(s => { doc.text(s, L + 6, ty); ty += lh(9); });
      font("normal", 7.8, MUTED); dl.forEach(s => { doc.text(s, L + 6, ty); ty += lh(7.8); });
      const mid = y + rowH / 2 + 3;
      font("normal", 9, INK);
      doc.text(String(it.qty ?? ""), L + cw * 1.5, mid, { align: "center" });
      doc.text(m(it.rate), L + cw * 3 - 6, mid, { align: "right" });
      font("bold", 9, INK); doc.text(m((Number(it.qty) || 0) * (Number(it.rate) || 0)), L + cw * 4 - 6, mid, { align: "right" });
      y += rowH;
    });

    // ---- totals ----
    y += 14;
    const pre = cur === "INR" ? "" : cur + " ";
    const lineAmt = it => (Number(it.qty) || 0) * (Number(it.rate) || 0);
    const reimb = (inv.items || []).filter(it => it.expense_id).reduce((s2, it) => s2 + lineAmt(it), 0);
    const rows = reimb > 0
      ? [["Professional Fee", pre + m(t.subtotal - reimb)], ["Reimbursement of expenses (at cost)", pre + m(reimb)], ["GST / Taxes", taxNote]]
      : [["Professional Fee", pre + m(t.subtotal)], ["GST / Taxes", taxNote]];
    const excludedAreExpenses = (inv.items || []).filter(it => it.tds === false).every(it => it.expense_id);
    const totalText = taxNote.toLowerCase() === "as applicable" ? `${pre}${m(t.subtotal)} + applicable taxes` : pre + m(t.subtotal);
    rows.push(["Total Invoice Value", totalText, "total"]);
    if (t.tdsPct > 0) {
      rows.push([`Less: TDS @ ${t.tdsPct}%` + (Math.abs(t.tdsBase - t.subtotal) > 0.004 ? ` on ${pre}${m(t.tdsBase)}${excludedAreExpenses ? " (excl. reimbursements)" : ""}` : ""), `(${pre}${m(t.tds)})`]);
      rows.push(["Net Amount Receivable", pre + m(t.net), "total"]);
    }
    if (cur !== "INR") {
      const fxs = fx.toLocaleString("en-US", { maximumFractionDigits: 6 });
      rows.push([`INR equivalent @ 1 ${cur} = ${fxs} INR`, "INR " + inr(Math.round((t.tdsPct > 0 ? t.net : t.subtotal) * fx * 100) / 100, "INR")]);
    }
    const rh = 15;
    rows.forEach(([k, v, kind]) => {
      doc.setDrawColor(...BORDER); doc.setLineWidth(0.6);
      if (kind === "total") { doc.setFillColor(...TINT); doc.rect(L, y, W, rh, "FD"); } else doc.rect(L, y, W, rh);
      doc.line(L + half, y, L + half, y + rh);
      font(kind === "total" ? "bold" : "normal", 8, kind === "total" ? GREEN : INK);
      doc.text(k, L + 6, y + 10.5); doc.text(v, R - 6, y + 10.5, { align: "right" });
      y += rh;
    });

    // ---- amount in words ----
    y += 15;
    font("bold", 8.5, INK); doc.text("Amount in words:", L, y);
    const aw = doc.getStringUnitWidth("Amount in words: ") * 8.5;
    font("normal", 8.5, INK);
    const wtxt = `${amountWords(t.subtotal, cur)} only${taxNote.toLowerCase() === "as applicable" ? ", plus applicable taxes, if any" : ""}.`;
    const wl = lines(wtxt, W - aw);
    wl.forEach((s, i) => doc.text(s, L + aw, y + i * lh(8.5)));
    y += (wl.length - 1) * lh(8.5) + 10;

    // ---- bank / notes / signature ----
    const third = W / 3;
    const bank = [];
    if (p.account_name) bank.push("Account Name: " + p.account_name);
    if (p.bank_name) bank.push("Bank: " + p.bank_name);
    if (p.account_no) bank.push("Account No.: " + p.account_no);
    if (p.ifsc) bank.push("IFSC: " + p.ifsc);
    font("normal", 7.8, MUTED);
    const noteLines = [];
    (inv.notes || []).filter(Boolean).forEach(n => lines("\u2022 " + n, third - 14).forEach((s, i) => noteLines.push(i ? "  " + s : s)));
    const bankLines = bank.flatMap(b => lines(b, third - 14));
    const fh = Math.max(bankLines.length, noteLines.length, 2) * lh(7.8) + 24;
    doc.setDrawColor(...BORDER); doc.setFillColor(...PANEL);
    doc.rect(L, y, W, fh, "FD");
    doc.line(L + third, y, L + third, y + fh); doc.line(L + third * 2, y, L + third * 2, y + fh);
    font("bold", 7.5, GREEN); doc.text("PAYMENT / BANK DETAILS", L + 6, y + 11); doc.text("NOTES", L + third + 6, y + 11);
    font("normal", 7.8, MUTED);
    bankLines.forEach((s, i) => doc.text(s, L + 6, y + 22 + i * lh(7.8)));
    noteLines.forEach((s, i) => doc.text(s, L + third + 6, y + 22 + i * lh(7.8)));
    font("bold", 8.5, INK);
    lines("Computer generated invoice no signature required", third - 14).forEach((s, i) => doc.text(s, R - 6, y + 12 + i * lh(8.5), { align: "right" }));

    // ---- footer ----
    font("normal", 7, MUTED);
    doc.text(p.footer || "Invoice for professional consultancy services", 306, 792 - 26, { align: "center" });

    doc.setProperties({ title: "Invoice " + (inv.invoice_no || ""), author: p.name || "" });
    return doc;
  }

  const api = { buildInvoicePdf, totals, words, amountWords, inr, longDate, CURRENCY_WORDS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.InvoicePDF = api;
})(typeof window !== "undefined" ? window : this);
