# ES Invoices & Expenses

A small invoicing and expense tracker for consultancy work. It is a static web app hosted on GitHub Pages, with data stored in Supabase.

## What it does

**Two number series**

Regular and special invoices each have their own series, set in **Settings → Number series**:

| Series | Default pattern | Example |
|---|---|---|
| Regular (monthly) | `{PREFIX}{DD}{MM}{YY}` with prefix `ESR-` | `ESR-300926` |
| Special (one-off) | `{PREFIX}{DD}{MM}{YY}` with prefix `ESS-` | `ESS-011026` |

You can change the prefix and pattern. The tokens are:
- `{DD}` `{MM}` `{YY}` `{YYYY}` for the invoice date
- `{FY}` for the Indian financial year, for example `26-27`
- `{SEQ}` or `{SEQ:4}` for a running number, for example `0041`

A running number can restart never, each financial year, each calendar year or each month. You can also set the next number by hand, which is useful if you're continuing an existing series. For example, `{PREFIX}{FY}/{SEQ:4}` with prefix `ESS/` gives `ESS/26-27/0001`, `ESS/26-27/0002`, and then `ESS/27-28/0001` from April.

The database assigns the number when you save. Changing a series only affects new invoices; issued numbers never change. If a date-only pattern produces a number that's already taken, a suffix is added: `ESS-011026-2`.

**Currencies and exchange rates**

- INR is the base currency.
- You can add rates in **Settings → Exchange rates** (1 USD = ? INR, with an effective date and source).
- An invoice or expense in another currency picks the latest rate on or before its date. You can override the rate on that document.
- Each document keeps the rate it was saved with, so later rate changes never alter past figures.
- Invoice PDFs show amounts in the invoice currency, with an INR equivalent line and the amount in words in that currency (US Dollars, UAE Dirhams and so on).
- Clients have a billing currency, so their invoices start in it.
- The dashboard and CSV exports convert everything to INR. The "amount received" on a paid invoice is entered in INR, which is what reached your bank.

**Regular invoices**

- Each client can have a monthly fee, a TDS % and a line-item template.
- The dashboard shows the next regular invoice due. It is dated the last day of the service month and pre-filled from the client's template.

**PDFs**

PDFs are drawn in the green consultancy template: letterhead, Bill To, PAN, line items, fee/GST/total, TDS and net, amount in words, bank details, notes and the footer. When an invoice is marked paid, the PDF adds a "Paid on …, ref …" note.

**Payments**

You can mark an invoice paid with the paid date, the client's payment reference and the amount received.

**Expenses**

- Each expense records a date, category, description, amount and currency (INR, AED or USD).
- It can optionally record how it was paid and which client it was for.
- You can attach a receipt (image or PDF). Receipts go to a private storage bucket.

**Dashboard**

The dashboard covers one Indian financial year (Apr–Mar). It shows:
- invoiced, TDS deducted, received and outstanding totals
- expenses
- a month-by-month chart
- an expense breakdown by category

**Export**

You can export invoices and expenses to CSV.

**Recurring invoices by email**

For each client with *auto invoice* turned on, a GitHub Actions job (which runs every 10 minutes) does this on the 1st of every month, from 09:00 IST. It:
1. creates last month's regular invoice from the client's monthly fee, using the Regular number series
2. emails the PDF to the client's *Email to* and *Cc* addresses, with a copy to you
3. marks the invoice as emailed (✉ in the invoice list)

Safety checks:
- It never creates two invoices for the same month and never emails the same invoice twice.
- If you've already raised that month's invoice yourself, it emails that one instead of creating another, unless it's already marked emailed or paid.
- If the 1st is missed, it catches up on days 2–5.
- *Start with service month* stops it from touching earlier months.
- If anything fails, the run fails and GitHub emails you.

**Emailing an invoice yourself**

Every invoice has an **Email** button, which opens a draft filled from the client's template. You can edit the recipients, subject and message, then pick one of two options:
- **Send.** The email is queued, and the mail job sends the PDF from your address within about 10–15 minutes, with a copy to you. The invoice list shows ✉ queued, then the sent date, or ✉ failed with the reason. You can cancel a queued email until it goes out.
- **Use my email app.** This downloads the PDF and opens a ready draft in Outlook or Gmail, so you attach the file and send it yourself.

**Expense bills on invoices**

- **Copying an expense.** **Copy**, in the list or in the expense window, starts a new expense with the same details, dated today. You then attach the new bill.
- **Billing expenses to a client.** In an invoice, **Add expense bills…** lets you tick one or more unbilled expenses. Each one becomes its own "Reimbursement" line at cost, converted to the invoice currency.
- **Tracking.** The expense is then marked *billed on #invoice*, so it can't be billed twice. Removing the line from the invoice frees the expense again.
- **Receipts.** When the invoice is emailed, the expense receipts go out as attachments alongside the invoice PDF.
- **TDS.** Each line has a *TDS applies* tick. Expense lines start with it off, so TDS is worked out only on your fee. Tick it for any expense where the client should deduct TDS. When some lines are excluded, the PDF shows the base, for example *Less: TDS @ 10% on 55,000 (reimbursements excluded)*.

## Files

```
index.html        app shell + styles
app.js            app logic
invoice-pdf.js    invoice PDF template (jsPDF)
config.js         your Supabase URL + anon key
automation/recurring.js   monthly create-and-email job (run by GitHub Actions)
.github/workflows/recurring.yml   schedule for that job
supabase/schema.sql   tables, numbering trigger, row-level security, receipts bucket
.github/workflows/deploy.yml   publishes to GitHub Pages on every push to main
```

## Setup (about 15 minutes)

### 1. Supabase

1. Create a project at supabase.com. The free tier is enough.
2. Open **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it. It is safe to run again.
3. Go to **Authentication → Users → Add user**. Create your login with an email and password, and tick *Auto confirm*.
4. Go to **Authentication → Sign In / Providers** and turn off **Allow new users to sign up**. You are the only user.
5. Go to **Project Settings → API** and copy the **Project URL** and the **anon public** key.

### Upgrading from the first version

Run the new `supabase/schema.sql` again. It adds the number series, the exchange rates, and the currency columns in place. Existing invoices keep their numbers, and every existing amount is treated as INR.

### 2. Load your existing data (optional)

Run `seed_PRIVATE.sql` in the SQL Editor. Set your login email at the top first.

It loads:
- your profile
- Bioingredia as a client
- the six paid regular invoices for March–August 2026
- the One View special invoice

**Keep that file out of GitHub.** It contains your PAN and bank details. The `.gitignore` already excludes it.

### 3. GitHub

1. Create a repository, for example `es-invoices`, and push these files to `main`.
2. Edit `config.js` with your Project URL and anon key. The anon key is meant to be public; row-level security means it can only read rows belonging to the signed-in user.
3. Go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
4. Push to `main`. The workflow publishes the site to `https://<your-user>.github.io/es-invoices/`.

GitHub Pages on a free account needs a **public** repository. That is fine here because no personal data lives in the code. Your details, clients and invoices stay in Supabase behind your login.

### 4. Turn on recurring invoices and email

**Get an email account that can send.** For Gmail, turn on 2-step verification, then create an **App password** at myaccount.google.com → Security → App passwords. Any SMTP account works the same way.

**Add these secrets** under GitHub → repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `SUPABASE_URL` | Your project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → `service_role` key. Keep this secret; it bypasses row-level security. |
| `SMTP_HOST` / `SMTP_PORT` | `smtp.gmail.com` / `465` |
| `SMTP_USER` / `SMTP_PASS` | Your Gmail address / the app password |
| `MAIL_FROM` | `Eldho Skaria <you@gmail.com>` |
| `MAIL_COPY_TO` | Where your copies and test runs go (usually your own address) |

**Set up the client.** In the app, open **Clients → Edit** and tick the automatic option. Then fill in:
- *Start with service month*
- *Email to* and *Cc*
- the subject and message, which can use fields like `{invoice_no}`, `{month}`, `{net}` and `{bank_details}`

**Test it.** Go to **Actions → Recurring invoices → Run workflow** and leave *Test run* ticked. Put a month in *Service month* (for example `2026-10`). You'll get an email with exactly what the client would receive. The subject is marked `[TEST]` and nothing is saved.

**Resend one invoice.** Run the workflow with *Test run* unticked and an *invoice no*. It emails that invoice now.

Notes:
- **Public logs.** Logs of public repositories are public, so the job never prints names, email addresses or amounts.
- **Run log.** After a month's invoices go out, the job commits `automation/run-log.md` (dates and counts only). This also keeps GitHub from switching off the schedule, which it does after 60 days with no repository activity.
- **Free-tier pausing.** The job touches Supabase every day, which stops a free project from pausing.

## Monthly routine

**For clients on automatic invoicing**, nothing is needed on the 1st. Check the ✉ mark in the invoice list, and when the money arrives, click **Mark paid** and enter their voucher number.

**For other clients:**
1. Open the dashboard. The yellow card shows the regular invoice that is due.
2. Click **Create now**, check the details, and click **Save**.
3. Click **PDF** and email it.
4. When the money arrives, click **Mark paid** and enter the date and their voucher number.

## Notes

- **Deleting issued invoices.** The app warns you before deleting an issued invoice. Mark it **cancelled** instead, so every number stays accounted for.
- **Free-tier pausing.** Supabase pauses free projects after about a week with no activity. Opening the app wakes the project, which can take a minute. Using it monthly keeps it alive most of the time. If it does pause, restore it from the Supabase dashboard.
- **Backups.** Use the CSV export each quarter, or **Database → Backups** on paid plans.
