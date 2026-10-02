/*
 * Recurring invoices — run by .github/workflows/recurring.yml
 *
 * On the 1st of each month (with a catch-up window for the next few days) it:
 *   1. finds every active client with "auto invoice" on and a monthly fee,
 *   2. creates last month's regular invoice if it doesn't exist yet
 *      (numbered by the database from your Regular number series),
 *   3. emails it as a PDF to the client, with a copy to you,
 *   4. records the send on the invoice and in invoice_emails.
 *
 * It is safe to run any number of times: an invoice is created once per client per
 * month and emailed once. Runs outside the window just touch the database, which
 * also keeps a free Supabase project from pausing.
 *
 * GitHub logs of public repositories are public, so this script never prints
 * names, email addresses or amounts.
 *
 * Env (GitHub secrets / inputs):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_COPY_TO
 *   TZ_NAME (default Asia/Kolkata), CATCHUP_DAYS (default 5)
 *   DRY_RUN=true    → build PDFs and email them ONLY to MAIL_COPY_TO, change nothing
 *   MONTH=YYYY-MM   → service month to process (default: previous month)
 *   INVOICE_NO=...  → (re)send one specific invoice instead
 *   FORCE=true      → run even outside the catch-up window
 *   SEND_HOUR=9     → scheduled runs don't create monthly invoices before this local hour
 *
 * Every run also sends any invoices you queued from the app with "Email invoice"
 * (the email_requests table) — the job runs every 10 minutes for that.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { jsPDF } = require("jspdf");
const nodemailer = require("nodemailer");
const InvoicePDF = require("../invoice-pdf.js");

const env = k => (process.env[k] || "").trim();
const bool = k => /^(1|true|yes)$/i.test(env(k));
const DRY = bool("DRY_RUN");
const FORCE = bool("FORCE");
const TZ = env("TZ_NAME") || "Asia/Kolkata";
const CATCHUP = Number(env("CATCHUP_DAYS") || 5);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SM = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) if (!env(k)) { console.error(`Missing secret ${k}`); process.exit(1); }
const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const pad = n => String(n).padStart(2, "0");
const todayInTZ = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addMonth = (ym, k) => { let [y, m] = ym.split("-").map(Number); m += k; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${pad(m)}`; };
const monthEnd = ym => { const [y, m] = ym.split("-").map(Number); return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`; };
const monthLabel = ym => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
const fmtDate = iso => `${iso.slice(8, 10)}-${SM[+iso.slice(5, 7) - 1]}-${iso.slice(0, 4)}`;
const list = s => String(s || "").split(/[,;]/).map(x => x.trim()).filter(Boolean);
const safeFile = no => String(no).replace(/[^\w.-]+/g, "-");

let mailer = null;
function getMailer() {
  if (mailer) return mailer;
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"]) if (!env(k)) throw new Error(`Missing secret ${k}`);
  const port = Number(env("SMTP_PORT") || 465);
  mailer = nodemailer.createTransport({ host: env("SMTP_HOST"), port, secure: port === 465, auth: { user: env("SMTP_USER"), pass: env("SMTP_PASS") } });
  return mailer;
}

function fill(tpl, v) { return String(tpl || "").replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)); }

function emailVars(inv, client, profile) {
  const cur = inv.currency || "INR";
  const money = n => InvoicePDF.inr(n, cur);
  const ym = inv.service_month ? inv.service_month.slice(0, 7) : inv.invoice_date.slice(0, 7);
  const bank = [profile.account_name && `Account name: ${profile.account_name}`, profile.bank_name && `Bank: ${profile.bank_name}`,
    profile.account_no && `Account no.: ${profile.account_no}`, profile.ifsc && `IFSC: ${profile.ifsc}`].filter(Boolean).join("\n");
  return {
    invoice_no: inv.invoice_no, invoice_date: fmtDate(inv.invoice_date), month: monthLabel(ym),
    description: (inv.items && inv.items[0] && inv.items[0].title) || "services",
    currency: cur, gross: money(inv.subtotal), tds: money(inv.tds_amount), tds_pct: Number(inv.tds_pct) || 0, net: money(inv.net_amount),
    client: client.name, name: profile.name || "", contact: profile.contact || "", bank_details: bank
  };
}

async function sendInvoice(inv, client, profile, { test, override }) {
  const notes = [...(inv.notes || [])];
  const doc = InvoicePDF.buildInvoicePdf(jsPDF, { profile, client, invoice: { ...inv, notes } });
  const pdf = Buffer.from(doc.output("arraybuffer"));
  const v = emailVars(inv, client, profile);
  const copy = list(env("MAIL_COPY_TO"));
  const to = test ? copy : list(override ? override.to : client.email_to);
  const cc = test ? [] : list(override ? override.cc : client.email_cc);
  if (!to.length) throw new Error(test ? "MAIL_COPY_TO is empty — set it to receive test runs" : "no 'Email to' address");
  const subject = (test ? "[TEST — not sent to client] " : "") + (override ? override.subject : fill(client.email_subject || "Invoice {invoice_no} – {month}", v));
  let text = override ? override.body : fill(client.email_body || "Please find attached invoice {invoice_no}.", v);
  if (test) text = `TEST RUN — this would have gone to ${list(client.email_to).join(", ") || "(no address set)"}${list(client.email_cc).length ? ", cc " + list(client.email_cc).join(", ") : ""}.\n\n` + text;
  const bills = await expenseBills(inv);
  if (bills.length) text += `\n\nAttached: invoice ${inv.invoice_no} and ${bills.length} supporting bill${bills.length > 1 ? "s" : ""}.`;
  const info = await getMailer().sendMail({
    from: env("MAIL_FROM"), to, cc: cc.length ? cc : undefined, bcc: test ? undefined : (copy.length ? copy : undefined),
    replyTo: env("MAIL_FROM"), subject, text,
    attachments: [{ filename: `${safeFile(inv.invoice_no)}.pdf`, content: pdf, contentType: "application/pdf" }].concat(bills)
  });
  return { to: to.join(", "), cc: cc.join(", "), messageId: info.messageId };
}

// receipts of expenses re-billed on this invoice go out as attachments (max ~15 MB in total)
async function expenseBills(inv) {
  const ids = (inv.items || []).map(i => i.expense_id).filter(Boolean);
  if (!ids.length) return [];
  const { data, error } = await sb.from("expenses").select("id,expense_date,category,receipt_path").in("id", ids);
  if (error) throw error;
  const out = []; let total = 0;
  for (const [n, x] of data.filter(x => x.receipt_path).entries()) {
    const { data: blob, error: e } = await sb.storage.from("receipts").download(x.receipt_path);
    if (e) throw new Error(`couldn't read a bill for the invoice: ${e.message}`);
    const buf = Buffer.from(await blob.arrayBuffer());
    total += buf.length;
    if (total > 15 * 1024 * 1024) throw new Error("the attached bills are over 15 MB — too large to email");
    const ext = (x.receipt_path.match(/\.[A-Za-z0-9]{1,5}$/) || [""])[0];
    out.push({ filename: `bill-${n + 1}-${x.expense_date}-${safeFile(x.category)}${ext}`, content: buf });
  }
  return out;
}

async function profileFor(userId) {
  const { data, error } = await sb.from("profile").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data || {};
}

async function rateFor(userId, cur, iso) {
  if (!cur || cur === "INR") return 1;
  const { data, error } = await sb.from("exchange_rates").select("rate").eq("user_id", userId).eq("currency", cur)
    .lte("rate_date", iso).order("rate_date", { ascending: false }).limit(1);
  if (error) throw error;
  return data && data[0] ? Number(data[0].rate) : null;
}

async function recordSend(inv, res, test, errMsg) {
  await sb.from("invoice_emails").insert({
    user_id: inv.user_id, invoice_id: inv.id, sent_to: res ? res.to : null, sent_cc: res ? res.cc : null,
    test_run: test, message_id: res ? res.messageId : null, status: errMsg ? "failed" : "sent", error: errMsg || null
  });
  if (!test && !errMsg) {
    const { error } = await sb.from("invoices").update({ emailed_at: new Date().toISOString(), emailed_to: res.to }).eq("id", inv.id);
    if (error) throw error;
  }
}

function buildInvoiceRow(client, ym, fx) {
  const mL = monthLabel(ym), tds = Number(client.tds_pct) || 0;
  return {
    user_id: client.user_id, client_id: client.id, kind: "regular", invoice_no: "auto",
    invoice_date: monthEnd(ym), service_month: `${ym}-01`,
    items: [{ title: client.monthly_title || "IT Support Services", detail: String(client.monthly_detail || "").replace(/\{month\}/g, mL), qty: 1, rate: Number(client.monthly_rate) }],
    tds_pct: tds, tax_note: "As applicable", currency: client.currency || "INR", fx_rate: fx,
    notes: [`Monthly IT support invoice for ${mL}.`].concat(tds ? [`TDS @ ${tds}% to be deducted at source.`] : []),
    status: "issued", created_by: "auto"
  };
}

// what the database trigger would produce (dry runs must not insert, as that would use up a number)
const fyShort = iso => { const y = +iso.slice(5, 7) >= 4 ? +iso.slice(0, 4) : +iso.slice(0, 4) - 1; return `${pad(y % 100)}-${pad((y + 1) % 100)}`; };
function formatDocNo(pattern, prefix, iso, seq) {
  return String(pattern).split("{PREFIX}").join(prefix || "").split("{YYYY}").join(iso.slice(0, 4)).split("{YY}").join(iso.slice(2, 4))
    .split("{MM}").join(iso.slice(5, 7)).split("{DD}").join(iso.slice(8, 10)).split("{FY}").join(fyShort(iso))
    .replace(/\{SEQ(?::(\d+))?\}/g, (_, w) => String(seq).padStart(+(w || 1), "0"));
}
async function predictNo(userId, iso) {
  const { data: rows } = await sb.from("number_series").select("*").eq("user_id", userId).eq("kind", "regular");
  const s = (rows && rows[0]) || { prefix: "ESR-", pattern: "{PREFIX}{DD}{MM}{YY}", next_seq: 1, reset_every: "never" };
  const { data: inv } = await sb.from("invoices").select("invoice_no").eq("user_id", userId);
  const taken = new Set((inv || []).map(r => r.invoice_no));
  if (/\{SEQ/.test(s.pattern)) {
    const key = s.reset_every === "year" ? iso.slice(0, 4) : s.reset_every === "fy" ? fyShort(iso) : s.reset_every === "month" ? iso.slice(0, 7) : "all";
    let seq = s.last_reset_key && s.last_reset_key !== key ? 1 : (+s.next_seq || 1), no;
    do { no = formatDocNo(s.pattern, s.prefix, iso, seq++); } while (taken.has(no));
    return no;
  }
  const base = formatDocNo(s.pattern, s.prefix, iso, 0); let no = base, n = 1;
  while (taken.has(no)) { n++; no = `${base}-${n}`; }
  return no;
}
async function previewInvoice(row) {
  const t = InvoicePDF.totals(row);
  const no = await predictNo(row.user_id, row.invoice_date).catch(() => "PREVIEW");
  return { ...row, id: null, invoice_no: no, subtotal: t.subtotal, tds_amount: t.tds, net_amount: t.net };
}

async function runMonthly(ym) {
  const { data: clients, error } = await sb.from("clients").select("*")
    .eq("auto_invoice", true).eq("active", true).gt("monthly_rate", 0).order("created_at");
  if (error) throw error;
  console.log(`Service month ${ym} · ${clients.length} client(s) on auto · ${DRY ? "DRY RUN" : "LIVE"}`);
  const out = { created: 0, sent: 0, skipped: 0, errors: [] };

  for (const [idx, c] of clients.entries()) {
    const tag = `Client #${idx + 1}`;
    try {
      if (c.auto_from_month && ym < c.auto_from_month.slice(0, 7)) { console.log(`${tag}: automation starts ${c.auto_from_month.slice(0, 7)} — skipped`); out.skipped++; continue; }
      if (!DRY && !list(c.email_to).length) throw new Error("no 'Email to' address on the client");
      const profile = await profileFor(c.user_id);

      const { data: existing, error: e1 } = await sb.from("invoices").select("*").eq("client_id", c.id).eq("kind", "regular")
        .eq("service_month", `${ym}-01`).neq("status", "cancelled").order("created_at").limit(1);
      if (e1) throw e1;
      let inv = existing && existing[0];

      if (!inv) {
        const fx = await rateFor(c.user_id, c.currency || "INR", monthEnd(ym));
        if (fx == null) throw new Error(`no ${c.currency} → INR rate on file for ${monthEnd(ym)}`);
        const row = buildInvoiceRow(c, ym, fx);
        if (DRY) inv = await previewInvoice(row);
        else {
          const { data, error: e2 } = await sb.from("invoices").insert(row).select().single();
          if (e2) throw e2;
          inv = data; out.created++;
          console.log(`${tag}: created ${inv.invoice_no}`);
        }
      } else console.log(`${tag}: ${inv.invoice_no} already exists`);

      if (!DRY && inv.emailed_at) { console.log(`${tag}: ${inv.invoice_no} already emailed — skipped`); out.skipped++; continue; }
      if (!DRY && inv.status !== "issued") { console.log(`${tag}: ${inv.invoice_no} is ${inv.status} — not emailed`); out.skipped++; continue; }

      try {
        const res = await sendInvoice(inv, c, profile, { test: DRY });
        if (inv.id) await recordSend(inv, res, DRY);
        out.sent++;
        console.log(`${tag}: ${DRY ? "test copy emailed to you" : `emailed ${inv.invoice_no}`}`);
      } catch (mailErr) {
        if (inv.id) await recordSend(inv, null, DRY, String(mailErr.message || mailErr));
        throw mailErr;
      }
    } catch (err) {
      console.error(`${tag}: FAILED — ${err.message || err}`);
      out.errors.push(`${tag}: ${err.message || err}`);
    }
  }
  return out;
}

async function runOne(invoiceNo) {
  const { data, error } = await sb.from("invoices").select("*").eq("invoice_no", invoiceNo);
  if (error) throw error;
  if (!data.length) throw new Error(`invoice ${invoiceNo} not found`);
  if (data.length > 1) throw new Error(`more than one invoice numbered ${invoiceNo}`);
  const inv = data[0];
  const { data: client, error: e2 } = await sb.from("clients").select("*").eq("id", inv.client_id).single();
  if (e2) throw e2;
  const profile = await profileFor(inv.user_id);
  const res = await sendInvoice(inv, client, profile, { test: DRY });
  await recordSend(inv, res, DRY);
  console.log(DRY ? `Test copy of ${invoiceNo} emailed to you` : `Emailed ${invoiceNo}`);
  return { created: 0, sent: 1, skipped: 0, errors: [] };
}

async function processQueue() {
  const { data: reqs, error } = await sb.from("email_requests").select("*").eq("status", "queued").order("requested_at").limit(25);
  if (error) throw error;
  const out = { created: 0, sent: 0, skipped: 0, errors: [] };
  if (!reqs.length) return out;
  console.log(`${reqs.length} queued email(s) from the app`);
  for (const [idx, r] of reqs.entries()) {
    const tag = `Request #${idx + 1}`;
    // claim it, so two overlapping runs can't send it twice
    const { data: claimed, error: ce } = await sb.from("email_requests").update({ status: "sending" }).eq("id", r.id).eq("status", "queued").select();
    if (ce) { out.errors.push(`${tag}: ${ce.message}`); continue; }
    if (!claimed || !claimed.length) { console.log(`${tag}: already taken by another run`); continue; }
    let inv = null;
    try {
      const { data: i, error: e1 } = await sb.from("invoices").select("*").eq("id", r.invoice_id).single();
      if (e1) throw e1;
      inv = i;
      if (inv.status === "cancelled") throw new Error("invoice is cancelled");
      const { data: client, error: e2 } = await sb.from("clients").select("*").eq("id", inv.client_id).single();
      if (e2) throw e2;
      const profile = await profileFor(inv.user_id);
      const res = await sendInvoice(inv, client, profile, { test: false, override: { to: r.send_to, cc: r.send_cc, subject: r.subject, body: r.body } });
      await recordSend(inv, res, false);
      await sb.from("email_requests").update({ status: "sent", processed_at: new Date().toISOString(), error: null }).eq("id", r.id);
      out.sent++;
      console.log(`${tag}: emailed ${inv.invoice_no}`);
    } catch (err) {
      const msg = String(err.message || err);
      await sb.from("email_requests").update({ status: "failed", processed_at: new Date().toISOString(), error: msg }).eq("id", r.id);
      if (inv) await recordSend(inv, null, false, msg).catch(() => {});
      console.error(`${tag}: FAILED — ${msg}`);
      out.errors.push(`${tag}: ${msg}`);
    }
  }
  return out;
}

function appendLog(today, out) {
  if (DRY || (!out.sent && !out.created)) return;
  const file = path.join(__dirname, "run-log.md");
  if (!fs.existsSync(file)) fs.writeFileSync(file, "# Recurring invoice runs\n\nCounts only; details are in the app.\n\n");
  fs.appendFileSync(file, `- ${today}: ${out.created} created, ${out.sent} emailed${out.errors.length ? `, ${out.errors.length} failed` : ""}\n`);
}

const localHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const merge = (a, b) => ({ created: a.created + b.created, sent: a.sent + b.sent, skipped: a.skipped + b.skipped, errors: a.errors.concat(b.errors) });

(async () => {
  const today = todayInTZ();
  let out;
  if (env("INVOICE_NO")) out = await runOne(env("INVOICE_NO"));
  else {
    out = DRY ? { created: 0, sent: 0, skipped: 0, errors: [] } : await processQueue();   // "Email invoice" from the app
    const day = Number(today.slice(8, 10)), hour = localHour(), sendHour = Number(env("SEND_HOUR") || 9);
    const inWindow = day <= CATCHUP && hour >= sendHour;
    if (FORCE || env("MONTH") || inWindow) {
      const ym = env("MONTH") || addMonth(today.slice(0, 7), -1);
      if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error("MONTH must look like 2026-10");
      out = merge(out, await runMonthly(ym));
    } else if (!out.sent && !out.errors.length) {
      console.log(`${today} ${pad(hour)}h (${TZ}): no queued emails, not a monthly run.`);
      return;
    }
  }
  appendLog(today, out);
  console.log(`Done: ${out.created} created, ${out.sent} emailed, ${out.skipped} skipped, ${out.errors.length} failed`);
  if (out.errors.length) process.exit(1); // GitHub emails you when a scheduled run fails
})().catch(err => { console.error("FAILED:", err.message || err); process.exit(1); });
