/* ES Invoices & Expenses — plain JS, no build step. */
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const cfg = window.APP_CONFIG || {};
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.includes("YOUR-PROJECT")) {
    document.body.innerHTML = '<p style="padding:40px;font-family:sans-serif">Edit <b>config.js</b> with your Supabase URL and anon key, then reload.</p>';
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const SM = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DEFAULT_CATS = ["Software & subscriptions","Internet & phone","Hardware","Travel","Bank charges","Professional fees","Office & supplies","Training & certification","Other"];
  const S = { user: null, profile: null, clients: [], invoices: [], expenses: [], series: [], rates: [], mailReqs: [], mailInv: null, fy: null, editInv: null, editExp: null, editCli: null, fxAuto: true, eFxAuto: true };
  const BASE_CURRENCIES = ["INR", "AED", "USD", "EUR", "GBP", "SAR", "QAR", "OMR", "KWD", "BHD", "SGD", "AUD", "CAD"];
  const SERIES_DEFAULTS = {
    regular: { kind: "regular", name: "Regular invoices", prefix: "ESR-", pattern: "{PREFIX}{DD}{MM}{YY}", next_seq: 1, reset_every: "never", last_reset_key: null },
    special: { kind: "special", name: "Special invoices", prefix: "ESS-", pattern: "{PREFIX}{DD}{MM}{YY}", next_seq: 1, reset_every: "never", last_reset_key: null }
  };

  /* ---------------- helpers ---------------- */
  const pad = n => String(n).padStart(2, "0");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const fmtDate = iso => { if (!iso) return ""; const [y, m, d] = iso.slice(0, 10).split("-"); return `${d}-${SM[+m - 1]}-${y}`; };
  const money = (n, cur = "INR") => (cur === "INR" ? "₹" : cur + " ") + Number(n || 0).toLocaleString(cur === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money0 = n => "₹" + Math.round(Number(n || 0)).toLocaleString("en-IN");
  const monthLabel = ym => { if (!ym) return ""; const [y, m] = ym.slice(0, 7).split("-"); return `${MONTHS[+m - 1]} ${y}`; };
  const monthEnd = ym => { const [y, m] = ym.slice(0, 7).split("-").map(Number); return `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`; };
  const addMonth = (ym, k = 1) => { let [y, m] = ym.slice(0, 7).split("-").map(Number); m += k; while (m > 12) { m -= 12; y++; } while (m < 1) { m += 12; y--; } return `${y}-${pad(m)}`; };
  const fyOf = iso => { const [y, m] = iso.split("-").map(Number); return m >= 4 ? y : y - 1; };
  const fyLabel = y => `FY ${y}-${String(y + 1).slice(2)}`;
  const inFY = (iso, y) => iso && iso >= `${y}-04-01` && iso <= `${y + 1}-03-31`;
  const fyShort = iso => { const y = fyOf(iso); return `${pad(y % 100)}-${pad((y + 1) % 100)}`; };
  const seriesFor = kind => S.series.find(x => x.kind === kind) || SERIES_DEFAULTS[kind];
  const usesSeq = pattern => /\{SEQ/.test(pattern || "");
  function formatDocNo(pattern, prefix, iso, seq) {
    return String(pattern || "").split("{PREFIX}").join(prefix || "").split("{YYYY}").join(iso.slice(0, 4)).split("{YY}").join(iso.slice(2, 4))
      .split("{MM}").join(iso.slice(5, 7)).split("{DD}").join(iso.slice(8, 10)).split("{FY}").join(fyShort(iso))
      .replace(/\{SEQ(?::(\d+))?\}/g, (_, w) => String(seq).padStart(+(w || 1), "0"));
  }
  const resetKey = (r, iso) => r === "year" ? iso.slice(0, 4) : r === "fy" ? fyShort(iso) : r === "month" ? iso.slice(0, 7) : "all";
  // mirrors the database trigger, so the number you see is the number you get
  function previewNo(kind, iso, excludeId, series) {
    if (!iso) return "";
    const s = series || seriesFor(kind), taken = no => S.invoices.some(i => i.invoice_no === no && i.id !== excludeId);
    if (usesSeq(s.pattern)) {
      const key = resetKey(s.reset_every, iso);
      let seq = s.last_reset_key && s.last_reset_key !== key ? 1 : (+s.next_seq || 1), no;
      do { no = formatDocNo(s.pattern, s.prefix, iso, seq++); } while (taken(no));
      return no;
    }
    const base = formatDocNo(s.pattern, s.prefix, iso, 0); let no = base, n = 1;
    while (taken(no)) { n++; no = `${base}-${n}`; }
    return no;
  }
  /* currency */
  const currencyList = () => [...new Set([...BASE_CURRENCIES, ...S.rates.map(r => r.currency)])];
  function rateOn(cur, iso) {
    if (!cur || cur === "INR") return { rate: 1 };
    const r = S.rates.filter(x => x.currency === cur && x.rate_date <= (iso || todayISO())).sort((a, b) => b.rate_date.localeCompare(a.rate_date))[0];
    return r ? { rate: +r.rate, date: r.rate_date } : null;
  }
  const invINR = (i, f) => +(i[f + "_inr"] ?? (+i[f === "subtotal" ? "subtotal" : f === "net" ? "net_amount" : "tds_amount"] * (+i.fx_rate || 1)));
  const expINR = x => +(x.amount_inr ?? (+x.amount * (+x.fx_rate || 1)));
  const curOptions = sel => currencyList().map(c => `<option ${c === sel ? "selected" : ""}>${c}</option>`).join("");
  const clientName = id => (S.clients.find(c => c.id === id) || {}).name || "—";
  function toast(msg, err) {
    const t = $("toast"); t.textContent = msg; t.className = err ? "err" : ""; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, err ? 6000 : 3000);
  }
  const fail = (e, what) => { console.error(e); toast(`${what}: ${e?.message || e}`, true); };
  function csvDownload(name, rows) {
    const csv = rows.map(r => r.map(v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv" })); a.download = name; a.click();
  }
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => b.closest("dialog").close()));

  /* ---------------- auth ---------------- */
  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault(); $("lgMsg").textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email: $("lgEmail").value.trim(), password: $("lgPass").value });
    if (error) $("lgMsg").textContent = error.message;
  });
  $("btnLogout").addEventListener("click", () => sb.auth.signOut());
  sb.auth.onAuthStateChange((_ev, session) => {
    const u = session?.user || null;
    if (u && (!S.user || S.user.id !== u.id)) { S.user = u; start(); }
    if (!u) { S.user = null; $("appView").hidden = true; $("loginView").hidden = false; }
  });

  async function start() {
    $("loginView").hidden = true; $("appView").hidden = false; $("whoEmail").textContent = S.user.email;
    S.fy = fyOf(todayISO());
    await loadAll();
  }
  async function loadAll() {
    try {
      const [p, c, i, x, ns, fx, mr] = await Promise.all([
        sb.from("profile").select("*").maybeSingle(),
        sb.from("clients").select("*").order("name"),
        sb.from("invoices").select("*").order("invoice_date", { ascending: false }).order("invoice_no", { ascending: false }),
        sb.from("expenses").select("*").order("expense_date", { ascending: false }),
        sb.from("number_series").select("*"),
        sb.from("exchange_rates").select("*").order("currency").order("rate_date", { ascending: false }),
        sb.from("email_requests").select("id,invoice_id,status,error,requested_at,processed_at,send_to").order("requested_at", { ascending: false }).limit(300)
      ]);
      for (const r of [p, c, i, x, ns, fx, mr]) if (r.error) throw r.error;
      S.mailReqs = mr.data;
      S.profile = p.data; S.clients = c.data; S.invoices = i.data; S.expenses = x.data; S.series = ns.data; S.rates = fx.data;
      const missing = ["regular", "special"].filter(k => !S.series.some(r => r.kind === k));
      if (missing.length) {
        const ins = await sb.from("number_series").upsert(missing.map(k => ({ ...SERIES_DEFAULTS[k], last_reset_key: null })), { onConflict: "user_id,kind", ignoreDuplicates: true }).select();
        if (!ins.error && ins.data) S.series = S.series.concat(ins.data);
      }
      renderAll();
    } catch (e) { fail(e, "Couldn't load data"); }
  }
  function renderAll() { renderFY(); renderDash(); renderInvoices(); renderExpenses(); renderClients(); renderSettings(); }

  /* ---------------- tabs ---------------- */
  $("nav").addEventListener("click", e => {
    const b = e.target.closest("button[data-tab]"); if (!b) return;
    document.querySelectorAll("#nav button").forEach(x => x.removeAttribute("aria-current"));
    b.setAttribute("aria-current", "page");
    document.querySelectorAll("main > section").forEach(s => s.hidden = s.id !== "tab-" + b.dataset.tab);
  });

  /* ---------------- dashboard ---------------- */
  function renderFY() {
    const years = new Set([fyOf(todayISO())]);
    S.invoices.forEach(i => years.add(fyOf(i.invoice_date)));
    S.expenses.forEach(x => years.add(fyOf(x.expense_date)));
    $("fySel").innerHTML = [...years].sort((a, b) => b - a).map(y => `<option value="${y}" ${y === S.fy ? "selected" : ""}>${fyLabel(y)}</option>`).join("");
  }
  $("fySel").addEventListener("change", () => { S.fy = +$("fySel").value; renderDash(); renderInvoices(); renderExpenses(); });

  function nextRegularFor(client) {
    const done = S.invoices.filter(i => i.client_id === client.id && i.kind === "regular" && i.status !== "cancelled" && i.service_month)
      .map(i => i.service_month.slice(0, 7)).sort();
    return done.length ? addMonth(done[done.length - 1]) : addMonth(todayISO(), -1);
  }
  function renderDash() {
    const today = todayISO();
    const cards = S.clients.filter(c => c.active && Number(c.monthly_rate) > 0).map(c => {
      const ym = nextRegularFor(c), due = monthEnd(ym), overdue = due <= today;
      const autoOn = c.auto_invoice && (!c.auto_from_month || ym >= c.auto_from_month.slice(0, 7));
      if (autoOn) {
        const sendOn = `${addMonth(ym, 1)}-01`;
        return `<div class="card due ok"><b>Automatic: ${esc(c.name)}</b><br><span class="small">${esc(monthLabel(ym))} invoice <span class="mono">${previewNo("regular", due)}</span> will be created and emailed on ${fmtDate(sendOn)}${sendOn < today ? " — it's past that date, check the GitHub Actions run" : ""}.</span></div>`;
      }
      return `<div class="card due ${overdue ? "" : "ok"}" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <div style="flex:1;min-width:220px"><b>${overdue ? "Regular invoice due" : "Next regular invoice"}: ${esc(c.name)}</b><br>
        <span class="small">${esc(monthLabel(ym))} · <span class="mono">${previewNo("regular", due)}</span> · dated ${fmtDate(due)} · ${money(c.monthly_rate, c.currency || "INR")}</span></div>
        <button type="button" data-raise="${c.id}" ${overdue ? "" : 'class="ghost"'}>Create ${overdue ? "now" : "early"}</button></div>`;
    });
    $("dueCards").innerHTML = cards.join("");
    $("dueCards").querySelectorAll("[data-raise]").forEach(b => b.onclick = () => openInvoice(null, "regular", b.dataset.raise));

    const y = S.fy;
    const inv = S.invoices.filter(i => inFY(i.invoice_date, y) && i.status !== "cancelled" && i.status !== "draft");
    const gross = inv.reduce((s, i) => s + invINR(i, "subtotal"), 0);
    const tds = inv.reduce((s, i) => s + invINR(i, "tds"), 0);
    const recv = inv.filter(i => i.status === "paid").reduce((s, i) => s + +(i.amount_received ?? invINR(i, "net")), 0);
    const outstanding = inv.filter(i => i.status === "issued").reduce((s, i) => s + invINR(i, "net"), 0);
    const ex = S.expenses.filter(x => inFY(x.expense_date, y));
    const exINR = ex.reduce((s, x) => s + expINR(x), 0);
    const foreign = ex.filter(x => x.currency !== "INR").length;
    const otherEx = foreign ? `incl. ${foreign} converted from other currencies` : "";
    $("kpis").innerHTML = [
      ["Invoiced (gross)", money0(gross), `${inv.length} invoices`],
      ["TDS deducted", money0(tds), "claim in your return"],
      ["Received", money0(recv), ""],
      ["Outstanding", money0(outstanding), `${inv.filter(i => i.status === "issued").length} unpaid`],
      ["Expenses", money0(exINR), otherEx || `${ex.length} entries`],
      ["Received − expenses", money0(recv - exINR), "all in INR"]
    ].map(([k, v, s]) => `<div class="card kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="small muted">${esc(s)}</div></div>`).join("");

    // month bars Apr..Mar
    const months = Array.from({ length: 12 }, (_, k) => addMonth(`${y}-04`, k));
    const invM = months.map(m => inv.filter(i => i.invoice_date.startsWith(m)).reduce((s, i) => s + invINR(i, "subtotal"), 0));
    const exM = months.map(m => ex.filter(x => x.expense_date.startsWith(m)).reduce((s, x) => s + expINR(x), 0));
    const max = Math.max(1, ...invM, ...exM);
    $("chart").innerHTML = `<div class="bars">${months.map((m, k) => `<div class="col" title="${monthLabel(m)}: invoiced ${money(invM[k])}, expenses ${money(exM[k])}">
      <div class="pair"><div class="b inv" style="height:${invM[k] / max * 100}%"></div><div class="b exp" style="height:${exM[k] / max * 100}%"></div></div>
      <div class="m">${SM[+m.slice(5) - 1]}</div></div>`).join("")}</div>
      <div class="legend"><span class="li">Invoiced</span><span class="le">Expenses</span><span>all in INR</span></div>`;

    const cats = {}; ex.forEach(x => { cats[x.category] = (cats[x.category] || 0) + expINR(x); });
    const rows = Object.entries(cats).sort((a, b) => b[1] - a[1]);
    $("catTable").innerHTML = rows.length ? `<table class="list">${rows.map(([c, v]) => `<tr><td>${esc(c)}</td><td class="num">${money(v)}</td></tr>`).join("")}</table>`
      : `<p class="empty">No expenses in ${fyLabel(y)}.</p>`;
  }

  /* ---------------- invoices list ---------------- */
  $("invKind").addEventListener("change", renderInvoices);
  $("invStatus").addEventListener("change", renderInvoices);
  function filteredInvoices() {
    const k = $("invKind").value, st = $("invStatus").value;
    return S.invoices.filter(i => inFY(i.invoice_date, S.fy) && (!k || i.kind === k) && (!st || i.status === st));
  }
  function renderInvoices() {
    const rows = filteredInvoices();
    $("invBody").innerHTML = rows.length ? rows.map(i => `<tr>
      <td class="mono">#${esc(i.invoice_no)}</td><td>${fmtDate(i.invoice_date)}</td><td>${esc(clientName(i.client_id))}</td>
      <td><span class="pill ${i.kind}">${i.kind}</span></td>
      <td class="num">${money(i.subtotal, i.currency || "INR")}</td><td class="num">${money(i.net_amount, i.currency || "INR")}${(i.currency || "INR") !== "INR" ? `<div class="small muted">${money(invINR(i, "net"))}</div>` : ""}</td>
      <td><span class="pill ${i.status}">${i.status}${i.status === "paid" && i.paid_date ? " " + fmtDate(i.paid_date) : ""}</span>${mailPill(i)}${i.created_by === "auto" ? ' <span class="small muted">auto</span>' : ""}</td>
      <td class="acts"><button class="ghost small" data-pdf="${i.id}">PDF</button> <button class="ghost small" data-mail="${i.id}">Email</button>${i.status === "issued" ? ` <button class="ghost small" data-pay="${i.id}">Mark paid</button>` : ""} <button class="ghost small" data-edit="${i.id}">Edit</button></td>
    </tr>`).join("") : `<tr><td colspan="8" class="empty">No invoices in ${fyLabel(S.fy)} for this filter.</td></tr>`;
    $("invBody").querySelectorAll("[data-pdf]").forEach(b => b.onclick = () => downloadPdf(S.invoices.find(i => i.id === b.dataset.pdf)));
    $("invBody").querySelectorAll("[data-mail]").forEach(b => b.onclick = () => openMail(S.invoices.find(i => i.id === b.dataset.mail)));
    $("invBody").querySelectorAll("[data-edit]").forEach(b => b.onclick = () => openInvoice(S.invoices.find(i => i.id === b.dataset.edit)));
    $("invBody").querySelectorAll("[data-pay]").forEach(b => b.onclick = () => {
      const i = S.invoices.find(x => x.id === b.dataset.pay); openInvoice(i);
      $("fStatus").value = "paid"; $("fPaidDate").value = todayISO(); $("fRecv").value = invINR(i, "net").toFixed(2); syncPaid(); $("fPayRef").focus();
    });
  }
  $("newRegular").addEventListener("click", () => openInvoice(null, "regular"));
  $("newSpecial").addEventListener("click", () => openInvoice(null, "special"));
  $("invCsv").addEventListener("click", () => {
    const rows = filteredInvoices();
    csvDownload(`invoices_${fyLabel(S.fy).replace(" ", "_")}.csv`, [["Invoice No", "Date", "Client", "Type", "Service month", "Currency", "Rate to INR", "Gross", "TDS", "Net", "Gross INR", "Net INR", "Status", "Paid on", "Payment ref", "Received INR"],
      ...rows.map(i => [i.invoice_no, i.invoice_date, clientName(i.client_id), i.kind, i.service_month ? monthLabel(i.service_month) : "", i.currency || "INR", i.fx_rate || 1, i.subtotal, i.tds_amount, i.net_amount, invINR(i, "subtotal"), invINR(i, "net"), i.status, i.paid_date || "", i.payment_ref || "", i.amount_received ?? ""])]);
  });

  function pdfData(inv) {
    const notes = [...(inv.notes || [])];
    if (inv.status === "paid" && inv.paid_date) notes.push(`Paid on ${fmtDate(inv.paid_date)}${inv.payment_ref ? ", ref. " + inv.payment_ref : ""}.`);
    return { profile: S.profile || {}, client: S.clients.find(c => c.id === inv.client_id) || {}, invoice: { ...inv, notes } };
  }
  function downloadPdf(inv) {
    if (!S.profile || !S.profile.name) toast("Add your details in Settings first — the invoice header is empty.", true);
    window.InvoicePDF.buildInvoicePdf(window.jspdf.jsPDF, pdfData(inv)).save(`${String(inv.invoice_no).replace(/[^\w.-]+/g, "-")}.pdf`);
  }

  /* ---------------- email (manual) ---------------- */
  const lastReq = inv => S.mailReqs.find(r => r.invoice_id === inv.id);
  function mailPill(i) {
    const r = lastReq(i);
    if (r && (r.status === "queued" || r.status === "sending")) return ` <span class="pill queued" title="To ${esc(r.send_to)}">✉ queued</span>`;
    if (r && r.status === "failed" && (!i.emailed_at || r.requested_at > i.emailed_at)) return ` <span class="pill failed" title="${esc(r.error)}">✉ failed</span>`;
    return i.emailed_at ? ` <span class="pill draft" title="Emailed to ${esc(i.emailed_to)}">✉ ${fmtDate(i.emailed_at.slice(0, 10))}</span>` : "";
  }
  function mailVars(inv, client) {
    const p = S.profile || {}, cur = inv.currency || "INR", m = n => window.InvoicePDF.inr(n, cur);
    const ym = (inv.service_month || inv.invoice_date).slice(0, 7);
    const bank = [p.account_name && `Account name: ${p.account_name}`, p.bank_name && `Bank: ${p.bank_name}`,
      p.account_no && `Account no.: ${p.account_no}`, p.ifsc && `IFSC: ${p.ifsc}`].filter(Boolean).join("\n");
    return { invoice_no: inv.invoice_no, invoice_date: fmtDate(inv.invoice_date), month: monthLabel(ym),
      description: (inv.items && inv.items[0] && inv.items[0].title) || "services", currency: cur,
      gross: m(inv.subtotal), tds: m(inv.tds_amount), tds_pct: Number(inv.tds_pct) || 0, net: m(inv.net_amount),
      client: client.name || "", name: p.name || "", contact: p.contact || "", bank_details: bank };
  }
  const fillTpl = (t, v) => String(t || "").replace(/\{(\w+)\}/g, (mm, k) => (k in v ? v[k] : mm));
  function openMail(inv) {
    if (!inv) return;
    S.mailInv = inv;
    const c = S.clients.find(x => x.id === inv.client_id) || {}, v = mailVars(inv, c), r = lastReq(inv);
    $("mailTitle").textContent = `Email #${inv.invoice_no}`;
    $("mTo").value = c.email_to || ""; $("mCc").value = c.email_cc || "";
    $("mSubj").value = fillTpl(c.email_subject || DEFAULT_SUBJECT, v);
    $("mBody").value = fillTpl(c.email_body || DEFAULT_BODY, v);
    const pending = r && (r.status === "queued" || r.status === "sending");
    $("mailInfo").innerHTML = pending ? `<b>Already queued</b> at ${new Date(r.requested_at).toLocaleString()} — sending soon.`
      : r && r.status === "failed" ? `<span style="color:var(--bad)">Last attempt failed: ${esc(r.error)}</span>`
      : inv.emailed_at ? `Already emailed to ${esc(inv.emailed_to)} on ${fmtDate(inv.emailed_at.slice(0, 10))}. Sending again is fine.`
      : inv.status === "draft" ? `This invoice is a draft — it will be marked issued when you send.` : "";
    $("mailCancelQ").hidden = !(r && r.status === "queued");
    $("mailSend").disabled = !!pending;
    $("mailDlg").showModal();
  }
  $("mailForm").addEventListener("submit", async e => {
    e.preventDefault();
    const inv = S.mailInv; if (!inv) return;
    const to = $("mTo").value.trim();
    if (!/\S+@\S+\.\S+/.test(to)) return toast("Enter at least one valid 'To' address.", true);
    $("mailSend").disabled = true;
    try {
      if (inv.status === "draft") { const { error } = await sb.from("invoices").update({ status: "issued" }).eq("id", inv.id); if (error) throw error; }
      const { error } = await sb.from("email_requests").insert({ invoice_id: inv.id, send_to: to, send_cc: $("mCc").value.trim(), subject: $("mSubj").value.trim(), body: $("mBody").value });
      if (error) throw error;
      $("mailDlg").close(); toast(`#${inv.invoice_no} queued — it will go out within about 10–15 minutes.`); loadAll();
    } catch (err) { fail(err, "Couldn't queue email"); } finally { $("mailSend").disabled = false; }
  });
  $("mailSelf").addEventListener("click", () => {
    const inv = S.mailInv; if (!inv) return;
    downloadPdf(inv);
    const q = [$("mCc").value.trim() && "cc=" + encodeURIComponent($("mCc").value.trim()), "subject=" + encodeURIComponent($("mSubj").value),
      "body=" + encodeURIComponent($("mBody").value + "\n\n[Attach " + String(inv.invoice_no).replace(/[^\w.-]+/g, "-") + ".pdf from your Downloads]")].filter(Boolean).join("&");
    window.location.href = `mailto:${$("mTo").value.split(/[,;]/).map(x => x.trim()).filter(Boolean).join(",")}?${q}`;
    toast("PDF downloaded — attach it to the email draft that just opened.");
  });
  $("mailCancelQ").addEventListener("click", async () => {
    const r = S.mailInv && lastReq(S.mailInv); if (!r) return;
    const { error } = await sb.from("email_requests").update({ status: "cancelled" }).eq("id", r.id).eq("status", "queued");
    if (error) return fail(error, "Couldn't cancel");
    $("mailDlg").close(); toast("Queued email cancelled"); loadAll();
  });

  /* ---------------- expense bills on invoices ---------------- */
  async function syncExpenseLinks(invoiceId, ids) {
    const was = S.expenses.filter(x => x.invoice_id === invoiceId).map(x => x.id);
    const drop = was.filter(id => !ids.includes(id));
    if (ids.length) { const { error } = await sb.from("expenses").update({ invoice_id: invoiceId }).in("id", ids); if (error) throw error; }
    if (drop.length) { const { error } = await sb.from("expenses").update({ invoice_id: null }).in("id", drop); if (error) throw error; }
  }
  const invNoOf = id => (S.invoices.find(i => i.id === id) || {}).invoice_no;
  function pickable() {
    const onForm = new Set(readItems().map(i => i.expense_id).filter(Boolean));
    const me = S.editInv?.id, cid = $("fClient").value, scope = $("pickScope").value;
    return S.expenses.filter(x => !onForm.has(x.id) && (!x.invoice_id || x.invoice_id === me) &&
      (scope === "all" || !x.client_id || x.client_id === cid));
  }
  function renderPick() {
    const rows = pickable();
    $("pickBody").innerHTML = rows.length ? rows.map(x => `<tr>
      <td><input type="checkbox" data-pick="${x.id}" style="width:auto" aria-label="Select"></td>
      <td>${fmtDate(x.expense_date)}</td><td>${esc(x.category)}</td>
      <td>${esc(x.description)}${x.client_id ? `<div class="small muted">${esc(clientName(x.client_id))}</div>` : ""}</td>
      <td class="num">${money(x.amount, x.currency)}${x.currency !== "INR" ? `<div class="small muted">${money(expINR(x))}</div>` : ""}</td>
      <td>${x.receipt_path ? "📎" : '<span class="muted small">none</span>'}</td></tr>`).join("")
      : `<tr><td colspan="6" class="empty">No unbilled expenses${$("pickScope").value === "client" ? " for this client — try “All unbilled expenses”" : ""}.</td></tr>`;
    const upd = () => {
      const sel = [...$("pickBody").querySelectorAll("[data-pick]:checked")].map(c => S.expenses.find(x => x.id === c.dataset.pick));
      $("pickSum").textContent = sel.length ? `${sel.length} selected · ${money(sel.reduce((t, x) => t + expINR(x), 0))}` : "";
      $("pickAdd").disabled = !sel.length;
    };
    $("pickBody").querySelectorAll("[data-pick]").forEach(c => c.addEventListener("change", upd)); upd();
  }
  $("addExp").addEventListener("click", () => { $("pickScope").value = "client"; renderPick(); $("pickDlg").showModal(); });
  $("pickScope").addEventListener("change", renderPick);
  $("pickForm").addEventListener("submit", e => {
    e.preventDefault();
    const cur = $("fCur").value || "INR", fx = cur === "INR" ? 1 : (+$("fFx").value || 0);
    if (cur !== "INR" && !fx) return toast(`Enter the ${cur} → INR rate on the invoice first.`, true);
    const sel = [...$("pickBody").querySelectorAll("[data-pick]:checked")].map(c => S.expenses.find(x => x.id === c.dataset.pick));
    // replace an empty first line instead of leaving it blank
    const first = $("items").children[0];
    if (first && !first.dataset.exp && !first.querySelector('[data-f="title"]').value.trim() && !+first.querySelector('[data-f="rate"]').value) first.remove();
    sel.forEach(x => {
      const amt = x.currency === cur ? +x.amount : Math.round(expINR(x) / fx * 100) / 100;
      $("items").appendChild(itemRow({
        expense_id: x.id, tds: false, title: `Reimbursement – ${x.category}`,
        detail: `${x.description ? x.description + ", " : ""}${fmtDate(x.expense_date)}${x.currency !== cur ? ` (${money(x.amount, x.currency)} @ ${+x.fx_rate})` : ""}. Bill attached.`.replace(" Bill attached.", x.receipt_path ? " Bill attached." : ""),
        qty: 1, rate: amt
      }));
    });
    $("pickDlg").close(); calcSums(); toast(`${sel.length} expense${sel.length > 1 ? "s" : ""} added`);
  });

  /* ---------------- invoice editor ---------------- */
  const kindNow = () => document.querySelector('#invForm input[name="kind"]:checked').value;
  function itemRow(it = {}) {
    const d = document.createElement("div"); d.className = "item";
    if (it.expense_id) d.dataset.exp = it.expense_id;
    d.innerHTML = (it.expense_id ? `<span class="xtag">Expense bill${S.expenses.find(x => x.id === it.expense_id)?.receipt_path ? " · receipt attached to email" : ""}</span>` : "") + `<label>Service title</label><input data-f="title" value="${esc(it.title)}" required>
      <label>Detail</label><textarea data-f="detail" rows="2">${esc(it.detail)}</textarea>
      <div class="row"><div></div>
        <div><label>Qty</label><input data-f="qty" type="number" step="0.01" min="0" value="${esc(it.qty ?? 1)}"></div>
        <div><label>Rate (INR)</label><input data-f="rate" type="number" step="0.01" min="0" value="${esc(it.rate ?? "")}"></div>
        <div><button type="button" class="danger small" data-rm>Remove</button></div></div>
      <label class="tdschk"><input type="checkbox" data-f="tds" ${it.tds === false ? "" : "checked"}> TDS applies to this line</label>`;
    d.querySelector("[data-rm]").onclick = () => { if ($("items").children.length > 1 || d.dataset.exp) { d.remove(); if (!$("items").children.length) $("items").appendChild(itemRow({ qty: 1 })); calcSums(); } };
    d.querySelectorAll("input,textarea").forEach(x => x.addEventListener("input", calcSums));
    d.querySelector('[data-f="tds"]').addEventListener("change", calcSums);
    return d;
  }
  const readItems = () => [...$("items").children].map(d => Object.assign({
    title: d.querySelector('[data-f="title"]').value.trim(),
    detail: d.querySelector('[data-f="detail"]').value.trim(),
    qty: Number(d.querySelector('[data-f="qty"]').value) || 0,
    rate: Number(d.querySelector('[data-f="rate"]').value) || 0
  }, d.querySelector('[data-f="tds"]').checked ? {} : { tds: false }, d.dataset.exp ? { expense_id: d.dataset.exp } : {}));
  function calcSums() {
    const t = window.InvoicePDF.totals({ items: readItems(), tds_pct: $("fTds").value });
    const cur = $("fCur").value || "INR", fx = cur === "INR" ? 1 : (+$("fFx").value || 0);
    $("sums").innerHTML = `<span>Invoice total</span><span class="num">${money(t.subtotal, cur)}</span>
      <span>Less TDS @ ${t.tdsPct}%${Math.abs(t.tdsBase - t.subtotal) > 0.004 ? ` on ${money(t.tdsBase, cur)}` : ""}</span><span class="num">(${money(t.tds, cur)})</span>
      <span class="t">Net receivable</span><span class="num t">${money(t.net, cur)}</span>` +
      (cur !== "INR" ? `<span class="muted">In INR @ ${fx || "?"}</span><span class="num muted">${fx ? money(t.net * fx) : "set a rate"}</span>` : "");
    updateNumBox();
  }
  function updateNumBox() {
    const k = kindNow(), d = $("fDate").value, e = S.editInv;
    const same = e && e.kind === k && e.invoice_date === d;
    const no = same ? e.invoice_no : previewNo(k, d, e?.id);
    const sr = seriesFor(k);
    $("numBox").innerHTML = no ? `${same ? "Invoice number" : "Will be numbered"} <b class="mono">#${esc(no)}</b> <span class="small">· ${esc(sr.name || k)} series${e?.emailed_at ? ` · emailed to ${esc(e.emailed_to)} on ${fmtDate(e.emailed_at.slice(0, 10))}` : ""}</span>` : "";
  }
  function fillFx(force) {
    const cur = $("fCur").value, info = rateOn(cur, $("fDate").value);
    $("fxWrap").hidden = cur === "INR"; $("fCurLbl").textContent = cur;
    if (cur === "INR") { $("fFx").value = 1; $("fxInfo").textContent = ""; return; }
    if ((force || S.fxAuto) && info) $("fFx").value = info.rate;
    if ((force || S.fxAuto) && !info) $("fFx").value = "";
    $("fxInfo").textContent = info ? `Rate on file: ${info.rate} from ${fmtDate(info.date)}` : `No ${cur} rate on file yet — enter one, or add it in Settings.`;
  }
  $("fCur").addEventListener("change", () => { S.fxAuto = true; fillFx(true); calcSums(); });
  $("fFx").addEventListener("input", () => { S.fxAuto = false; calcSums(); });
  function syncKind() {
    const reg = kindNow() === "regular";
    $("svcWrap").style.visibility = reg ? "visible" : "hidden";
    updateNumBox();
  }
  function syncPaid() { $("paidWrap").hidden = $("fStatus").value !== "paid"; }
  function regularDefaults(client, ym) {
    const mL = monthLabel(ym);
    const tds = Number(client.tds_pct) || 0;
    return {
      date: monthEnd(ym),
      items: [{ title: client.monthly_title || "IT Support Services", detail: (client.monthly_detail || "").replace(/\{month\}/g, mL), qty: 1, rate: Number(client.monthly_rate) || 0 }],
      tds, currency: client.currency || "INR",
      notes: [`Monthly IT support invoice for ${mL}.`].concat(tds ? [`TDS @ ${tds}% to be deducted at source.`] : [])
    };
  }
  function openInvoice(inv, kind = "regular", clientId) {
    if (!S.clients.length) { toast("Add a client first.", true); return; }
    S.editInv = inv || null;
    const k = inv ? inv.kind : kind;
    document.querySelectorAll('#invForm input[name="kind"]').forEach(r => r.checked = r.value === k);
    $("fClient").innerHTML = S.clients.filter(c => c.active || (inv && c.id === inv.client_id)).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("items").innerHTML = "";
    $("fCur").innerHTML = curOptions(inv ? inv.currency || "INR" : "INR");
    if (inv) {
      $("invDlgTitle").textContent = "Edit invoice";
      $("fClient").value = inv.client_id; $("fDate").value = inv.invoice_date; $("fSvc").value = inv.service_month ? inv.service_month.slice(0, 7) : "";
      (inv.items || []).forEach(it => $("items").appendChild(itemRow(it)));
      $("fTds").value = inv.tds_pct; $("fTax").value = inv.tax_note || "As applicable"; $("fStatus").value = inv.status;
      $("fPaidDate").value = inv.paid_date || ""; $("fPayRef").value = inv.payment_ref || ""; $("fRecv").value = inv.amount_received ?? "";
      $("fNotes").value = (inv.notes || []).join("\n");
      $("fCur").value = inv.currency || "INR"; $("fFx").value = inv.fx_rate || 1; S.fxAuto = false; fillFx(false);
    } else {
      $("invDlgTitle").textContent = k === "regular" ? "New regular invoice" : "New special invoice";
      const client = S.clients.find(c => c.id === clientId) || S.clients.find(c => c.active && Number(c.monthly_rate) > 0) || S.clients[0];
      $("fClient").value = client.id;
      $("fTax").value = "As applicable"; $("fStatus").value = "issued";
      $("fPaidDate").value = ""; $("fPayRef").value = ""; $("fRecv").value = "";
      if (k === "regular") applyRegular(client, nextRegularFor(client));
      else {
        $("fSvc").value = ""; $("fDate").value = todayISO(); $("fTds").value = client.tds_pct || 0;
        $("items").appendChild(itemRow({ qty: 1 })); $("fNotes").value = "";
      }
      $("fCur").value = client.currency || "INR"; S.fxAuto = true; fillFx(true);
    }
    if (!$("items").children.length) $("items").appendChild(itemRow({ qty: 1 }));
    $("invDelete").hidden = !inv; $("invMail").hidden = !inv;
    syncKind(); syncPaid(); calcSums();
    $("invDlg").showModal();
  }
  function applyRegular(client, ym) {
    const d = regularDefaults(client, ym);
    $("fSvc").value = ym; $("fDate").value = d.date; $("fTds").value = d.tds;
    $("items").innerHTML = ""; d.items.forEach(it => $("items").appendChild(itemRow(it)));
    $("fNotes").value = d.notes.join("\n");
    $("fCur").value = d.currency; S.fxAuto = true; fillFx(true);
  }
  document.querySelectorAll('#invForm input[name="kind"]').forEach(r => r.addEventListener("change", () => {
    if (!S.editInv && kindNow() === "regular") { const c = S.clients.find(x => x.id === $("fClient").value); if (c) applyRegular(c, nextRegularFor(c)); calcSums(); }
    syncKind();
  }));
  $("fSvc").addEventListener("change", () => {
    if (!$("fSvc").value) return;
    const c = S.clients.find(x => x.id === $("fClient").value);
    if (!S.editInv && c) { applyRegular(c, $("fSvc").value); calcSums(); }
    else { $("fDate").value = monthEnd($("fSvc").value); updateNumBox(); }
  });
  $("fClient").addEventListener("change", () => {
    const c = S.clients.find(x => x.id === $("fClient").value); if (!c || S.editInv) return;
    if (kindNow() === "regular") applyRegular(c, nextRegularFor(c)); else { $("fTds").value = c.tds_pct || 0; $("fCur").value = c.currency || "INR"; S.fxAuto = true; fillFx(true); }
    calcSums();
  });
  $("fDate").addEventListener("input", () => { fillFx(false); calcSums(); });
  $("fTds").addEventListener("input", calcSums);
  $("fStatus").addEventListener("change", () => {
    syncPaid();
    if ($("fStatus").value === "paid" && !$("fPaidDate").value) {
      $("fPaidDate").value = todayISO();
      const fx = $("fCur").value === "INR" ? 1 : (+$("fFx").value || 1);
      $("fRecv").value = (window.InvoicePDF.totals({ items: readItems(), tds_pct: $("fTds").value }).net * fx).toFixed(2);
    }
  });
  $("addItem").addEventListener("click", () => { $("items").appendChild(itemRow({ qty: 1 })); });

  function formInvoice() {
    const k = kindNow();
    return {
      kind: k, client_id: $("fClient").value, invoice_date: $("fDate").value,
      service_month: k === "regular" && $("fSvc").value ? $("fSvc").value + "-01" : null,
      items: readItems().filter(i => i.title || i.rate),
      tds_pct: Number($("fTds").value) || 0, tax_note: $("fTax").value.trim() || "As applicable",
      currency: $("fCur").value || "INR", fx_rate: $("fCur").value === "INR" ? 1 : Number($("fFx").value) || 0,
      notes: $("fNotes").value.split("\n").map(s => s.trim()).filter(Boolean),
      status: $("fStatus").value,
      paid_date: $("fStatus").value === "paid" ? ($("fPaidDate").value || null) : null,
      payment_ref: $("fStatus").value === "paid" ? ($("fPayRef").value.trim() || null) : null,
      amount_received: $("fStatus").value === "paid" && $("fRecv").value !== "" ? Number($("fRecv").value) : null
    };
  }
  $("invMail").addEventListener("click", () => {
    if (!S.editInv) return toast("Save the invoice first, then email it.", true);
    $("invDlg").close(); openMail(S.invoices.find(i => i.id === S.editInv.id) || S.editInv);
  });
  $("invPreview").addEventListener("click", () => {
    const f = formInvoice(), t = window.InvoicePDF.totals(f);
    const no = S.editInv && S.editInv.kind === f.kind && S.editInv.invoice_date === f.invoice_date ? S.editInv.invoice_no : previewNo(f.kind, f.invoice_date, S.editInv?.id);
    const doc = window.InvoicePDF.buildInvoicePdf(window.jspdf.jsPDF, pdfData({ ...f, invoice_no: no, net_amount: t.net }));
    window.open(doc.output("bloburl"), "_blank");
  });
  $("invForm").addEventListener("submit", async e => {
    e.preventDefault();
    const f = formInvoice();
    if (!f.items.length) return toast("Add at least one line.", true);
    if (f.currency !== "INR" && !(f.fx_rate > 0)) return toast(`Enter the ${f.currency} → INR exchange rate.`, true);
    if (f.kind === "regular" && !f.service_month) return toast("Pick the service month for a regular invoice.", true);
    if (f.kind === "regular") {
      const dup = S.invoices.find(i => i.kind === "regular" && i.client_id === f.client_id && i.status !== "cancelled" && i.service_month === f.service_month && (!S.editInv || i.id !== S.editInv.id));
      if (dup && !confirm(`#${dup.invoice_no} already covers ${monthLabel(f.service_month)} for this client. Save anyway?`)) return;
    }
    $("invSave").disabled = true;
    try {
      const q = S.editInv ? sb.from("invoices").update(f).eq("id", S.editInv.id) : sb.from("invoices").insert({ ...f, invoice_no: "auto" });
      const { data, error } = await q.select().single();
      if (error) throw error;
      await syncExpenseLinks(data.id, f.items.map(i => i.expense_id).filter(Boolean));
      $("invDlg").close(); toast(`Saved #${data.invoice_no}`);
      await loadAll();
    } catch (err) { fail(err, "Couldn't save invoice"); }
    finally { $("invSave").disabled = false; }
  });
  $("invDelete").addEventListener("click", async () => {
    const i = S.editInv; if (!i) return;
    if (i.status !== "draft" && !confirm(`#${i.invoice_no} has been issued. Usually you should mark it cancelled instead, so the number stays accounted for. Delete anyway?`)) return;
    if (i.status === "draft" && !confirm(`Delete draft #${i.invoice_no}?`)) return;
    const { error } = await sb.from("invoices").delete().eq("id", i.id);
    if (error) return fail(error, "Couldn't delete");
    $("invDlg").close(); toast("Deleted"); loadAll();
  });

  /* ---------------- expenses ---------------- */
  function renderExpenses() {
    const cats = new Set(DEFAULT_CATS); S.expenses.forEach(x => cats.add(x.category));
    const cur = $("expCat").value;
    $("expCat").innerHTML = `<option value="">All categories</option>` + [...cats].sort().map(c => `<option ${c === cur ? "selected" : ""}>${esc(c)}</option>`).join("");
    $("catList").innerHTML = [...cats].sort().map(c => `<option value="${esc(c)}">`).join("");
    const vias = new Set(["Card", "UPI", "Cash", "Bank transfer"]); S.expenses.forEach(x => x.paid_via && vias.add(x.paid_via));
    $("viaList").innerHTML = [...vias].map(v => `<option value="${esc(v)}">`).join("");

    const rows = filteredExpenses();
    const tot = {}; rows.forEach(x => tot[x.currency] = (tot[x.currency] || 0) + +x.amount);
    const totINR = rows.reduce((s, x) => s + expINR(x), 0);
    $("expTotals").textContent = rows.length ? `${rows.length} entries · ${money(totINR)} in INR` + (Object.keys(tot).some(k => k !== "INR") ? " (" + Object.entries(tot).map(([k, v]) => money(v, k)).join(" + ") + ")" : "") : "";
    $("expBody").innerHTML = rows.length ? rows.map(x => `<tr>
      <td>${fmtDate(x.expense_date)}</td><td>${esc(x.category)}</td><td>${esc(x.description)}${x.paid_via ? `<div class="small muted">${esc(x.paid_via)}</div>` : ""}${x.invoice_id ? `<div class="small"><span class="pill paid">billed on #${esc(invNoOf(x.invoice_id) || "?")}</span></div>` : ""}</td>
      <td>${x.client_id ? esc(clientName(x.client_id)) : '<span class="muted">—</span>'}</td>
      <td class="num">${money(x.amount, x.currency)}${x.currency !== "INR" ? `<div class="small muted">${money(expINR(x))} @ ${+x.fx_rate}</div>` : ""}</td>
      <td>${x.receipt_path ? `<button class="ghost small" data-rcpt="${x.id}">View</button>` : '<span class="muted small">none</span>'}</td>
      <td class="acts"><button class="ghost small" data-xcopy="${x.id}" title="New expense with the same details">Copy</button> <button class="ghost small" data-xedit="${x.id}">Edit</button></td></tr>`).join("")
      : `<tr><td colspan="7" class="empty">No expenses for this filter.</td></tr>`;
    $("expBody").querySelectorAll("[data-xedit]").forEach(b => b.onclick = () => openExpense(S.expenses.find(x => x.id === b.dataset.xedit)));
    $("expBody").querySelectorAll("[data-xcopy]").forEach(b => b.onclick = () => openExpense(S.expenses.find(x => x.id === b.dataset.xcopy), true));
    $("expBody").querySelectorAll("[data-rcpt]").forEach(b => b.onclick = () => viewReceipt(S.expenses.find(x => x.id === b.dataset.rcpt)));
  }
  function filteredExpenses() {
    const m = $("expMonth").value, c = $("expCat").value;
    return S.expenses.filter(x => (m ? x.expense_date.startsWith(m) : inFY(x.expense_date, S.fy)) && (!c || x.category === c));
  }
  $("expMonth").addEventListener("change", renderExpenses);
  $("expCat").addEventListener("change", renderExpenses);
  $("newExp").addEventListener("click", () => openExpense(null));
  $("expCsv").addEventListener("click", () => {
    const rows = filteredExpenses();
    csvDownload(`expenses_${$("expMonth").value || fyLabel(S.fy).replace(" ", "_")}.csv`, [["Date", "Category", "Description", "Paid via", "Client", "Amount", "Currency", "Rate to INR", "Amount INR", "Receipt"],
      ...rows.map(x => [x.expense_date, x.category, x.description, x.paid_via, x.client_id ? clientName(x.client_id) : "", x.amount, x.currency, x.fx_rate || 1, expINR(x), x.receipt_path ? "yes" : ""])]);
  });
  function openExpense(x, clone) {
    S.editExp = clone ? null : (x || null);
    $("expDlgTitle").textContent = clone ? "New expense (copy)" : x ? "Edit expense" : "Add expense";
    $("eClient").innerHTML = `<option value="">— none —</option>` + S.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    $("eDate").value = x && !clone ? x.expense_date : todayISO(); $("eCat").value = x ? x.category : "";
    $("eVia").value = x ? x.paid_via || "" : ""; $("eDesc").value = x ? x.description || "" : "";
    $("eCur").innerHTML = curOptions(x ? x.currency : "INR");
    $("eAmt").value = x ? x.amount : ""; $("eClient").value = x?.client_id || "";
    $("eFx").value = x ? x.fx_rate || 1 : 1; S.eFxAuto = !x || !!clone; syncEFx(!x || !!clone);
    $("eFile").value = "";
    $("eFileNow").textContent = clone ? "Copied from an existing expense — dated today, attach this bill's receipt." :
      x?.receipt_path ? "A receipt is attached. Choosing a new file replaces it." : "";
    if (x && !clone && x.invoice_id) $("eFileNow").textContent += ` Billed on invoice #${invNoOf(x.invoice_id) || "?"}.`;
    $("expDelete").hidden = !x || !!clone; $("expDup").hidden = !x || !!clone;
    $("expDlg").dataset.src = x ? x.id : "";
    $("expDlg").showModal();
  }
  function syncEFx(force) {
    const cur = $("eCur").value; $("eFxWrap").hidden = cur === "INR"; $("eCurLbl").textContent = cur;
    if (cur === "INR") $("eFx").value = 1;
    else if (force || S.eFxAuto) { const r = rateOn(cur, $("eDate").value); $("eFx").value = r ? r.rate : ""; }
    const amt = +$("eAmt").value || 0, fx = +$("eFx").value || 0;
    $("eInr").textContent = cur === "INR" ? "" : (fx ? `= ${money(amt * fx)}` : `No ${cur} rate on file — enter one.`);
  }
  $("eCur").addEventListener("change", () => { S.eFxAuto = true; syncEFx(true); });
  $("eDate").addEventListener("change", () => syncEFx(false));
  $("eAmt").addEventListener("input", () => syncEFx(false));
  $("eFx").addEventListener("input", () => { S.eFxAuto = false; syncEFx(false); });
  $("expForm").addEventListener("submit", async e => {
    e.preventDefault(); $("expSave").disabled = true;
    try {
      const rec = {
        expense_date: $("eDate").value, category: $("eCat").value.trim(), description: $("eDesc").value.trim(),
        amount: Number($("eAmt").value), currency: $("eCur").value, paid_via: $("eVia").value.trim(), client_id: $("eClient").value || null,
        fx_rate: $("eCur").value === "INR" ? 1 : Number($("eFx").value) || 0
      };
      if (rec.currency !== "INR" && !(rec.fx_rate > 0)) throw new Error(`enter the ${rec.currency} → INR rate`);
      const file = $("eFile").files[0];
      if (file) {
        if (file.size > 10 * 1024 * 1024) throw new Error("Receipt is over 10 MB");
        const path = `${S.user.id}/${Date.now()}-${file.name.replace(/[^\w.\-]+/g, "_")}`;
        const up = await sb.storage.from("receipts").upload(path, file, { upsert: false });
        if (up.error) throw up.error;
        if (S.editExp?.receipt_path) await sb.storage.from("receipts").remove([S.editExp.receipt_path]);
        rec.receipt_path = path;
      }
      const q = S.editExp ? sb.from("expenses").update(rec).eq("id", S.editExp.id) : sb.from("expenses").insert(rec);
      const { error } = await q; if (error) throw error;
      $("expDlg").close(); toast("Expense saved"); await loadAll();
    } catch (err) { fail(err, "Couldn't save expense"); }
    finally { $("expSave").disabled = false; }
  });
  $("expDup").addEventListener("click", () => { const x = S.editExp; if (!x) return; $("expDlg").close(); openExpense(x, true); });
  $("expDelete").addEventListener("click", async () => {
    const x = S.editExp; if (!x || !confirm(x.invoice_id ? `This expense is billed on #${invNoOf(x.invoice_id)}. Delete it anyway? (Remove its line from that invoice too.)` : "Delete this expense?")) return;
    if (x.receipt_path) await sb.storage.from("receipts").remove([x.receipt_path]);
    const { error } = await sb.from("expenses").delete().eq("id", x.id);
    if (error) return fail(error, "Couldn't delete");
    $("expDlg").close(); toast("Deleted"); loadAll();
  });
  async function viewReceipt(x) {
    const { data, error } = await sb.storage.from("receipts").createSignedUrl(x.receipt_path, 300);
    if (error) return fail(error, "Couldn't open receipt");
    window.open(data.signedUrl, "_blank", "noopener");
  }

  /* ---------------- clients ---------------- */
  function renderClients() {
    $("cliBody").innerHTML = S.clients.length ? S.clients.map(c => `<tr>
      <td><b>${esc(c.name)}</b><div class="small muted">${esc(c.address)}</div></td>
      <td>${Number(c.monthly_rate) > 0 ? money(c.monthly_rate, c.currency || "INR") : '<span class="muted">—</span>'}</td>
      <td>${Number(c.tds_pct) || 0}%</td>
      <td>${c.active ? "Active" : '<span class="muted">Inactive</span>'}${c.auto_invoice && c.active ? ' <span class="pill paid">auto-email</span>' : ""}</td>
      <td class="acts"><button class="ghost small" data-cedit="${c.id}">Edit</button></td></tr>`).join("")
      : `<tr><td colspan="5" class="empty">No clients yet.</td></tr>`;
    $("cliBody").querySelectorAll("[data-cedit]").forEach(b => b.onclick = () => openClient(S.clients.find(c => c.id === b.dataset.cedit)));
  }
  $("newCli").addEventListener("click", () => openClient(null));
  const DEFAULT_SUBJECT = "Invoice {invoice_no} – {description} – {month}";
  const DEFAULT_BODY = "Dear Accounts Team,\n\nPlease find attached invoice {invoice_no} dated {invoice_date} for {description} for {month}.\n\nInvoice value: {currency} {gross}\nLess TDS @ {tds_pct}%: {currency} {tds}\nNet payable: {currency} {net}\n\nPayment details:\n{bank_details}\n\nKindly process the payment at your earliest convenience.\n\nRegards,\n{name}\n{contact}";
  function syncAuto() {
    $("autoFields").hidden = !$("cAuto").checked;
    const ym = $("cAutoFrom").value;
    $("cAutoHint").textContent = ym ? `First automatic invoice: ${monthLabel(ym)}, dated ${fmtDate(monthEnd(ym))}, emailed on 1 ${MONTHS[+addMonth(ym, 1).slice(5) - 1]} ${addMonth(ym, 1).slice(0, 4)}.` : "";
  }
  $("cAuto").addEventListener("change", syncAuto);
  $("cAutoFrom").addEventListener("change", syncAuto);
  function openClient(c) {
    S.editCli = c || null;
    $("cliDlgTitle").textContent = c ? "Edit client" : "Add client";
    $("cName").value = c?.name || ""; $("cAddr").value = c?.address || ""; $("cGst").value = c?.gstin || "";
    $("cTds").value = c?.tds_pct ?? 0; $("cRate").value = c?.monthly_rate ?? "";
    $("cCur").innerHTML = curOptions(c?.currency || "INR");
    $("cTitle").value = c?.monthly_title ?? "IT Support Services – ERP (Oracle APEX)";
    $("cDetail").value = c?.monthly_detail ?? "Monthly ERP support, maintenance and development for {month}.";
    $("cActive").checked = c ? c.active : true;
    $("cAuto").checked = !!c?.auto_invoice;
    $("cAutoFrom").value = c?.auto_from_month ? c.auto_from_month.slice(0, 7) : addMonth(todayISO(), 0);
    $("cTo").value = c?.email_to || ""; $("cCc").value = c?.email_cc || "";
    $("cSubj").value = c?.email_subject ?? DEFAULT_SUBJECT; $("cBody").value = c?.email_body ?? DEFAULT_BODY;
    syncAuto();
    $("cliDlg").showModal();
  }
  $("cliForm").addEventListener("submit", async e => {
    e.preventDefault();
    const rec = { name: $("cName").value.trim(), address: $("cAddr").value.trim(), gstin: $("cGst").value.trim(),
      tds_pct: Number($("cTds").value) || 0, currency: $("cCur").value || "INR", monthly_rate: $("cRate").value === "" ? null : Number($("cRate").value),
      monthly_title: $("cTitle").value.trim(), monthly_detail: $("cDetail").value.trim(), active: $("cActive").checked,
      auto_invoice: $("cAuto").checked, auto_from_month: $("cAutoFrom").value ? $("cAutoFrom").value + "-01" : null,
      email_to: $("cTo").value.trim(), email_cc: $("cCc").value.trim(), email_subject: $("cSubj").value, email_body: $("cBody").value };
    if (rec.auto_invoice && !rec.email_to) return toast("Add an 'Email to' address for automatic invoices.", true);
    if (rec.auto_invoice && !(rec.monthly_rate > 0)) return toast("Set the monthly fee for automatic invoices.", true);
    const q = S.editCli ? sb.from("clients").update(rec).eq("id", S.editCli.id) : sb.from("clients").insert(rec);
    const { error } = await q; if (error) return fail(error, "Couldn't save client");
    $("cliDlg").close(); toast("Client saved"); loadAll();
  });

  /* ---------------- settings ---------------- */
  const PF = { pfName: "name", pfTitle: "title", pfAddress: "address", pfContact: "contact", pfPan: "pan", pfAccName: "account_name", pfBank: "bank_name", pfAccNo: "account_no", pfIfsc: "ifsc", pfFooter: "footer" };
  function renderSettings() {
    const p = S.profile || {}; Object.entries(PF).forEach(([id, k]) => $(id).value = p[k] ?? (k === "footer" ? "Invoice for professional consultancy services" : ""));
    renderSeries(); renderRates();
  }
  function renderSeries() {
    const today = todayISO();
    $("seriesBody").innerHTML = ["regular", "special"].map(k => { const s = seriesFor(k); return `<tr data-k="${k}">
      <td><input data-s="name" value="${esc(s.name)}" style="min-width:140px"><div class="small muted">${k}</div></td>
      <td><input data-s="prefix" value="${esc(s.prefix)}" style="width:90px"></td>
      <td><input data-s="pattern" value="${esc(s.pattern)}" style="min-width:220px"></td>
      <td><input data-s="next_seq" type="number" min="1" value="${esc(s.next_seq)}" style="width:80px"></td>
      <td><select data-s="reset_every">${[["never", "Never"], ["fy", "Each financial year"], ["year", "Each calendar year"], ["month", "Each month"]].map(([v, l]) => `<option value="${v}" ${s.reset_every === v ? "selected" : ""}>${l}</option>`).join("")}</select></td>
      <td class="mono" data-preview></td>
      <td class="acts"><button class="small" type="button" data-save>Save</button></td></tr>`; }).join("");
    $("seriesBody").querySelectorAll("tr").forEach(tr => {
      const read = () => { const o = { ...seriesFor(tr.dataset.k) }; tr.querySelectorAll("[data-s]").forEach(i => o[i.dataset.s] = i.type === "number" ? +i.value || 1 : i.value); return o; };
      const prev = () => {
        const o = read(), orig = seriesFor(tr.dataset.k);
        if (o.next_seq !== +orig.next_seq || o.reset_every !== orig.reset_every || o.pattern !== orig.pattern) o.last_reset_key = null;
        tr.querySelector("[data-preview]").textContent = "#" + previewNo(tr.dataset.k, today, null, o) + (usesSeq(o.pattern) ? "" : "");
      };
      tr.querySelectorAll("[data-s]").forEach(i => i.addEventListener("input", prev)); prev();
      tr.querySelector("[data-save]").onclick = async () => {
        const o = read(), orig = seriesFor(tr.dataset.k);
        if (!o.pattern.trim()) return toast("Pattern can't be empty.", true);
        if (!/\{(SEQ|DD)/.test(o.pattern) && !confirm("This pattern has no {SEQ} or {DD}, so most invoices will need a -2, -3 suffix. Save anyway?")) return;
        const rec = { kind: o.kind, name: o.name.trim(), prefix: o.prefix, pattern: o.pattern.trim(), next_seq: +o.next_seq || 1, reset_every: o.reset_every, updated_at: new Date().toISOString() };
        if (rec.next_seq !== +orig.next_seq || rec.reset_every !== orig.reset_every || rec.pattern !== orig.pattern) rec.last_reset_key = null;
        const { error } = await sb.from("number_series").upsert({ user_id: S.user.id, ...rec }, { onConflict: "user_id,kind" });
        if (error) return fail(error, "Couldn't save series");
        toast(`${rec.name} saved`); loadAll();
      };
    });
  }
  function renderRates() {
    $("rCur").innerHTML = currencyList().filter(c => c !== "INR").map(c => `<option>${c}</option>`).join("");
    if (!$("rDate").value) $("rDate").value = todayISO();
    $("rateBody").innerHTML = S.rates.length ? S.rates.map(r => {
      const latest = rateOn(r.currency, todayISO());
      return `<tr><td><b>${esc(r.currency)}</b>${latest && latest.date === r.rate_date ? ' <span class="pill paid">current</span>' : ""}</td>
      <td>${fmtDate(r.rate_date)}</td><td class="num">${(+r.rate).toLocaleString("en-IN", { maximumFractionDigits: 6 })}</td><td class="small muted">${esc(r.note)}</td>
      <td class="acts"><button class="danger small" type="button" data-rdel="${r.id}">Delete</button></td></tr>`; }).join("")
      : `<tr><td colspan="5" class="empty">No exchange rates yet. Add one above to bill or record expenses in another currency.</td></tr>`;
    $("rateBody").querySelectorAll("[data-rdel]").forEach(b => b.onclick = async () => {
      if (!confirm("Delete this rate? Documents already saved keep the rate they used.")) return;
      const { error } = await sb.from("exchange_rates").delete().eq("id", b.dataset.rdel);
      if (error) return fail(error, "Couldn't delete rate"); loadAll();
    });
  }
  $("rateForm").addEventListener("submit", async e => {
    e.preventDefault();
    const rec = { currency: $("rCur").value, rate_date: $("rDate").value, rate: Number($("rRate").value), note: $("rNote").value.trim() };
    if (!(rec.rate > 0)) return toast("Rate must be more than zero.", true);
    const { error } = await sb.from("exchange_rates").upsert({ user_id: S.user.id, ...rec }, { onConflict: "user_id,currency,rate_date" });
    if (error) return fail(error, "Couldn't save rate");
    $("rRate").value = ""; $("rNote").value = ""; toast(`1 ${rec.currency} = ${rec.rate} INR from ${fmtDate(rec.rate_date)}`); loadAll();
  });
  $("profileForm").addEventListener("submit", async e => {
    e.preventDefault();
    const rec = { user_id: S.user.id, updated_at: new Date().toISOString() };
    Object.entries(PF).forEach(([id, k]) => rec[k] = $(id).value.trim());
    const { error } = await sb.from("profile").upsert(rec);
    if (error) return fail(error, "Couldn't save settings");
    toast("Settings saved"); loadAll();
  });
})();
