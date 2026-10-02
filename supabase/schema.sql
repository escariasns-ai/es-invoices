-- =====================================================================
--  ES Invoices & Expenses — Supabase schema  (v2: number series + currencies)
--  Run in Supabase → SQL Editor. Idempotent: safe to run again, and it
--  upgrades a v1 database in place (existing invoices keep their numbers).
--  Every row belongs to the signed-in user (RLS: user_id = auth.uid()).
--  Base currency is INR: every amount is also stored converted to INR.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- profile ----------
create table if not exists public.profile (
  user_id       uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  name          text not null default '',
  title         text default 'IT Consultant',
  address       text default '',
  contact       text default '',
  pan           text default '',
  account_name  text default '',
  bank_name     text default '',
  account_no    text default '',
  ifsc          text default '',
  footer        text default 'Invoice for professional consultancy services',
  updated_at    timestamptz not null default now()
);

-- ---------- clients ----------
create table if not exists public.clients (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name            text not null,
  address         text default '',
  gstin           text default '',
  tds_pct         numeric(5,2) not null default 0,
  monthly_rate    numeric(14,2),
  monthly_title   text default 'IT Support Services – ERP (Oracle APEX)',
  monthly_detail  text default 'Monthly ERP support, maintenance and development for {month}.',
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
alter table public.clients add column if not exists currency text not null default 'INR';

-- recurring: generate the monthly (regular) invoice automatically and email it
alter table public.clients add column if not exists auto_invoice    boolean not null default false;
alter table public.clients add column if not exists auto_from_month date;      -- first service month to automate
alter table public.clients add column if not exists email_to        text default '';   -- comma-separated
alter table public.clients add column if not exists email_cc        text default '';
alter table public.clients add column if not exists email_subject   text default 'Invoice {invoice_no} – {description} – {month}';
alter table public.clients add column if not exists email_body      text default
'Dear Accounts Team,

Please find attached invoice {invoice_no} dated {invoice_date} for {description} for {month}.

Invoice value: {currency} {gross}
Less TDS @ {tds_pct}%: {currency} {tds}
Net payable: {currency} {net}

Payment details:
{bank_details}

Kindly process the payment at your earliest convenience.

Regards,
{name}
{contact}';

-- ---------- number series (one per invoice kind) ----------
-- pattern tokens: {PREFIX} {DD} {MM} {YY} {YYYY} {FY} (e.g. 26-27) {SEQ} {SEQ:4} (zero-padded running number)
-- reset_every: never | year | fy | month   (only matters when the pattern uses {SEQ})
create table if not exists public.number_series (
  user_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind           text not null check (kind in ('regular','special')),
  name           text not null default '',
  prefix         text not null default '',
  pattern        text not null default '{PREFIX}{DD}{MM}{YY}',
  next_seq       integer not null default 1 check (next_seq >= 1),
  reset_every    text not null default 'never' check (reset_every in ('never','year','fy','month')),
  last_reset_key text,
  updated_at     timestamptz not null default now(),
  primary key (user_id, kind)
);

create or replace function public.fy_label(d date) returns text language sql immutable as $$
  select lpad((s % 100)::text, 2, '0') || '-' || lpad(((s + 1) % 100)::text, 2, '0')
  from (select case when extract(month from d) >= 4 then extract(year from d)::int else extract(year from d)::int - 1 end as s) x
$$;

create or replace function public.format_doc_no(p_pattern text, p_prefix text, p_date date, p_seq int)
returns text language plpgsql immutable as $$
declare r text := p_pattern; m text[]; w int;
begin
  r := replace(r, '{PREFIX}', coalesce(p_prefix, ''));
  r := replace(r, '{YYYY}', to_char(p_date, 'YYYY'));
  r := replace(r, '{YY}',   to_char(p_date, 'YY'));
  r := replace(r, '{MM}',   to_char(p_date, 'MM'));
  r := replace(r, '{DD}',   to_char(p_date, 'DD'));
  r := replace(r, '{FY}',   public.fy_label(p_date));
  loop
    m := regexp_match(r, '\{SEQ(?::(\d+))?\}');
    exit when m is null;
    w := coalesce(m[1]::int, 1);
    r := regexp_replace(r, '\{SEQ(:\d+)?\}', lpad(p_seq::text, greatest(w, length(p_seq::text)), '0'));
  end loop;
  return r;
end $$;

create or replace function public.series_reset_key(p_reset text, p_date date) returns text language sql immutable as $$
  select case p_reset when 'year' then to_char(p_date,'YYYY') when 'fy' then public.fy_label(p_date)
                      when 'month' then to_char(p_date,'YYYY-MM') else 'all' end
$$;

-- ---------- exchange rates (1 unit of currency = rate INR) ----------
create table if not exists public.exchange_rates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  currency   text not null check (currency ~ '^[A-Z]{3}$' and currency <> 'INR'),
  rate_date  date not null,
  rate       numeric(18,6) not null check (rate > 0),
  note       text default '',
  created_at timestamptz not null default now(),
  constraint exchange_rates_unique unique (user_id, currency, rate_date)
);

-- latest rate on or before a date (1 for INR, null if none set up)
create or replace function public.rate_on(p_currency text, p_date date) returns numeric
language sql stable as $$
  select case when p_currency = 'INR' then 1 else
    (select rate from public.exchange_rates
      where user_id = auth.uid() and currency = p_currency and rate_date <= p_date
      order by rate_date desc limit 1) end
$$;

-- ---------- invoices ----------
create table if not exists public.invoices (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_id        uuid not null references public.clients(id) on delete restrict,
  kind             text not null check (kind in ('regular','special')),
  invoice_no       text not null,
  invoice_date     date not null,
  service_month    date,
  items            jsonb not null default '[]'::jsonb,
  subtotal         numeric(14,2) not null default 0,
  tds_pct          numeric(5,2)  not null default 0,
  tds_amount       numeric(14,2) not null default 0,
  net_amount       numeric(14,2) not null default 0,
  tax_note         text not null default 'As applicable',
  notes            text[] not null default '{}',
  status           text not null default 'issued' check (status in ('draft','issued','paid','cancelled')),
  paid_date        date,
  payment_ref      text,
  amount_received  numeric(14,2),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint invoices_no_unique unique (user_id, invoice_no)
);
alter table public.invoices add column if not exists currency text not null default 'INR';
alter table public.invoices add column if not exists fx_rate  numeric(18,6) not null default 1;
alter table public.invoices add column if not exists subtotal_inr numeric(16,2)
  generated always as (round(subtotal * fx_rate, 2)) stored;
alter table public.invoices add column if not exists net_inr numeric(16,2)
  generated always as (round(net_amount * fx_rate, 2)) stored;
alter table public.invoices add column if not exists tds_inr numeric(16,2)
  generated always as (round(tds_amount * fx_rate, 2)) stored;
-- received is entered in INR (what actually landed in your account)
alter table public.invoices add column if not exists created_by text not null default 'app';   -- 'app' | 'auto'
alter table public.invoices add column if not exists emailed_at timestamptz;
alter table public.invoices add column if not exists emailed_to text;
create index if not exists invoices_user_date_idx on public.invoices (user_id, invoice_date desc);

do $$ begin
  alter table public.invoices add constraint invoices_currency_chk check (currency ~ '^[A-Z]{3}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.invoices add constraint invoices_fx_chk check (fx_rate > 0 and (currency <> 'INR' or fx_rate = 1));
exception when duplicate_object then null; end $$;

create or replace function public.invoices_before_write()
returns trigger language plpgsql as $$
declare
  s        public.number_series%rowtype;
  sub      numeric(14,2);
  tds_base numeric(14,2);
  seq      int;
  rkey     text;
  base     text;
  n        int := 1;
  uses_seq boolean;
begin
  -- totals
  -- lines with "tds": false (re-billed expenses) are excluded from the TDS base
  select coalesce(sum(coalesce((i->>'qty')::numeric,0) * coalesce((i->>'rate')::numeric,0)),0),
         coalesce(sum(coalesce((i->>'qty')::numeric,0) * coalesce((i->>'rate')::numeric,0))
                  filter (where coalesce((i->>'tds')::boolean, true)),0)
    into sub, tds_base from jsonb_array_elements(coalesce(new.items,'[]'::jsonb)) i;
  new.subtotal   := sub;
  new.tds_amount := round(tds_base * coalesce(new.tds_pct,0) / 100, 2);
  new.net_amount := sub - new.tds_amount;
  new.updated_at := now();
  new.currency   := upper(coalesce(new.currency,'INR'));
  if new.currency = 'INR' then new.fx_rate := 1; end if;

  -- keep the number once issued, unless the kind or the date changed
  if tg_op = 'UPDATE' and new.kind = old.kind and new.invoice_date = old.invoice_date then
    new.invoice_no := old.invoice_no;
    return new;
  end if;

  -- the series for this kind (created with defaults on first use)
  select * into s from public.number_series where user_id = new.user_id and kind = new.kind for update;
  if not found then
    insert into public.number_series (user_id, kind, name, prefix)
    values (new.user_id, new.kind,
            case new.kind when 'regular' then 'Regular invoices' else 'Special invoices' end,
            case new.kind when 'regular' then 'ESR-' else 'ESS-' end)
    on conflict (user_id, kind) do nothing;
    select * into s from public.number_series where user_id = new.user_id and kind = new.kind for update;
  end if;

  uses_seq := s.pattern ~ '\{SEQ';
  if uses_seq then
    rkey := public.series_reset_key(s.reset_every, new.invoice_date);
    -- restart only when moving into a new period; a hand-set next_seq (last_reset_key null) is honoured
    seq  := case when s.last_reset_key is not null and s.last_reset_key <> rkey then 1 else s.next_seq end;
    loop
      new.invoice_no := public.format_doc_no(s.pattern, s.prefix, new.invoice_date, seq);
      exit when not exists (select 1 from public.invoices
                            where user_id = new.user_id and invoice_no = new.invoice_no and id <> new.id);
      seq := seq + 1;
    end loop;
    update public.number_series set next_seq = seq + 1, last_reset_key = rkey, updated_at = now()
     where user_id = new.user_id and kind = new.kind;
  else
    base := public.format_doc_no(s.pattern, s.prefix, new.invoice_date, 0);
    new.invoice_no := base;
    while exists (select 1 from public.invoices
                  where user_id = new.user_id and invoice_no = new.invoice_no and id <> new.id) loop
      n := n + 1;
      new.invoice_no := base || '-' || n;
    end loop;
  end if;
  return new;
end $$;

drop trigger if exists trg_invoices_before_write on public.invoices;
create trigger trg_invoices_before_write
  before insert or update on public.invoices
  for each row execute function public.invoices_before_write();

-- ---------- expenses ----------
create table if not exists public.expenses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  expense_date  date not null default current_date,
  category      text not null,
  description   text default '',
  amount        numeric(14,2) not null check (amount >= 0),
  currency      text not null default 'INR',
  paid_via      text default '',
  client_id     uuid references public.clients(id) on delete set null,
  receipt_path  text,
  created_at    timestamptz not null default now()
);
-- v1 limited currencies to INR/AED/USD; allow any ISO code now
alter table public.expenses drop constraint if exists expenses_currency_check;
do $$ begin
  alter table public.expenses add constraint expenses_currency_chk check (currency ~ '^[A-Z]{3}$');
exception when duplicate_object then null; end $$;
alter table public.expenses add column if not exists fx_rate numeric(18,6) not null default 1;
alter table public.expenses add column if not exists amount_inr numeric(16,2)
  generated always as (round(amount * fx_rate, 2)) stored;
do $$ begin
  alter table public.expenses add constraint expenses_fx_chk check (fx_rate > 0 and (currency <> 'INR' or fx_rate = 1));
exception when duplicate_object then null; end $$;
create index if not exists expenses_user_date_idx on public.expenses (user_id, expense_date desc);
-- an expense re-billed to a client: the invoice it was added to (one invoice per expense)
alter table public.expenses add column if not exists invoice_id uuid references public.invoices(id) on delete set null;
create index if not exists expenses_invoice_idx on public.expenses (invoice_id);

-- ---------- email log (written by the GitHub Actions job) ----------
create table if not exists public.invoice_emails (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  invoice_id  uuid not null references public.invoices(id) on delete cascade,
  sent_at     timestamptz not null default now(),
  sent_to     text,
  sent_cc     text,
  test_run    boolean not null default false,
  message_id  text,
  status      text not null default 'sent' check (status in ('sent','failed')),
  error       text
);
create index if not exists invoice_emails_invoice_idx on public.invoice_emails (invoice_id, sent_at desc);

-- ---------- manual "email this invoice" requests (queued by the app, sent by the GitHub job) ----------
create table if not exists public.email_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  invoice_id    uuid not null references public.invoices(id) on delete cascade,
  send_to       text not null,
  send_cc       text default '',
  subject       text not null,
  body          text not null,
  status        text not null default 'queued' check (status in ('queued','sending','sent','failed','cancelled')),
  requested_at  timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);
create index if not exists email_requests_status_idx on public.email_requests (status, requested_at);

-- ---------- row level security ----------
alter table public.profile        enable row level security;
alter table public.clients        enable row level security;
alter table public.invoices       enable row level security;
alter table public.expenses       enable row level security;
alter table public.number_series  enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.invoice_emails enable row level security;
alter table public.email_requests enable row level security;

do $$
declare t text;
begin
  foreach t in array array['profile','clients','invoices','expenses','number_series','exchange_rates','invoice_emails','email_requests'] loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated
                    using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ---------- receipts storage ----------
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists receipts_own on storage.objects;
create policy receipts_own on storage.objects for all to authenticated
  using      (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
