-- =====================================================================
--  ES Invoicing & Expenses — Supabase schema (v2: number series + currencies)
--  Run in Supabase → SQL Editor. Safe to re-run, and upgrades the first version in place.
--  Every row belongs to the signed-in user (RLS: user_id = auth.uid()).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- profile (letterhead, tax and bank details) ----------
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

-- ---------- number series (one per invoice kind) ----------
create table if not exists public.number_series (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind            text not null check (kind in ('regular','special')),
  name            text not null default '',
  prefix          text not null default '',
  pattern         text not null default '{PREFIX}{DD}{MM}{YY}',
  next_seq        int  not null default 1 check (next_seq >= 1),
  reset_every     text not null default 'never' check (reset_every in ('never','fy','year','month')),
  last_reset_key  text,
  updated_at      timestamptz not null default now(),
  constraint number_series_user_kind unique (user_id, kind)
);

-- ---------- exchange rates (1 unit of currency = rate INR, effective from rate_date) ----------
create table if not exists public.exchange_rates (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  currency    text not null,
  rate_date   date not null,
  rate        numeric(18,6) not null check (rate > 0),
  note        text default '',
  created_at  timestamptz not null default now(),
  constraint exchange_rates_unique unique (user_id, currency, rate_date)
);

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
alter table public.invoices add column if not exists currency     text not null default 'INR';
alter table public.invoices add column if not exists fx_rate      numeric(18,6) not null default 1;
alter table public.invoices add column if not exists subtotal_inr numeric(14,2) not null default 0;
alter table public.invoices add column if not exists tds_inr      numeric(14,2) not null default 0;
alter table public.invoices add column if not exists net_inr      numeric(14,2) not null default 0;
create index if not exists invoices_user_date_idx on public.invoices (user_id, invoice_date desc);

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
alter table public.expenses drop constraint if exists expenses_currency_check;   -- v1 only allowed INR/AED/USD
alter table public.expenses add column if not exists fx_rate    numeric(18,6) not null default 1;
alter table public.expenses add column if not exists amount_inr numeric(14,2) not null default 0;
create index if not exists expenses_user_date_idx on public.expenses (user_id, expense_date desc);

create or replace function public.expenses_before_write()
returns trigger language plpgsql as $$
begin
  if new.currency = 'INR' or coalesce(new.fx_rate,0) <= 0 then new.fx_rate := 1; end if;
  new.amount_inr := round(new.amount * new.fx_rate, 2);
  return new;
end $$;
drop trigger if exists trg_expenses_before_write on public.expenses;
create trigger trg_expenses_before_write before insert or update on public.expenses
  for each row execute function public.expenses_before_write();

-- ---------- invoice numbering + totals (enforced in the database) ----------
-- Tokens: {PREFIX} {DD} {MM} {YY} {YYYY} {FY} (e.g. 26-27) {SEQ} / {SEQ:4}.
-- Date-only patterns that clash get a suffix: ESS-011026-2. {SEQ} patterns advance the series counter.
create or replace function public.format_doc_no(p_pattern text, p_prefix text, p_date date, p_seq int)
returns text language plpgsql immutable as $$
declare
  fy int := case when extract(month from p_date) >= 4 then extract(year from p_date)::int else extract(year from p_date)::int - 1 end;
  w  int := coalesce(substring(p_pattern from '\{SEQ:(\d+)\}')::int, 1);
  s  text := p_pattern;
begin
  s := replace(s, '{PREFIX}', coalesce(p_prefix,''));
  s := replace(s, '{YYYY}', to_char(p_date,'YYYY'));
  s := replace(s, '{YY}',   to_char(p_date,'YY'));
  s := replace(s, '{MM}',   to_char(p_date,'MM'));
  s := replace(s, '{DD}',   to_char(p_date,'DD'));
  s := replace(s, '{FY}',   lpad((fy % 100)::text,2,'0') || '-' || lpad(((fy+1) % 100)::text,2,'0'));
  s := regexp_replace(s, '\{SEQ(:\d+)?\}', lpad(p_seq::text, w, '0'), 'g');
  return s;
end $$;

create or replace function public.invoices_before_write()
returns trigger language plpgsql as $$
declare
  ser    public.number_series%rowtype;
  sub    numeric(14,2);
  fx     numeric(18,6);
  seq    int;
  n      int := 1;
  base   text;
  rkey   text;
begin
  -- totals from items
  select coalesce(sum( coalesce((i->>'qty')::numeric,0) * coalesce((i->>'rate')::numeric,0) ),0)
    into sub from jsonb_array_elements(coalesce(new.items,'[]'::jsonb)) i;
  fx := case when coalesce(new.currency,'INR') = 'INR' or coalesce(new.fx_rate,0) <= 0 then 1 else new.fx_rate end;
  new.currency   := coalesce(new.currency,'INR');
  new.fx_rate    := fx;
  new.subtotal   := sub;
  new.tds_amount := round(sub * coalesce(new.tds_pct,0) / 100, 2);
  new.net_amount := sub - new.tds_amount;
  new.subtotal_inr := round(new.subtotal   * fx, 2);
  new.tds_inr      := round(new.tds_amount * fx, 2);
  new.net_inr      := round(new.net_amount * fx, 2);
  new.updated_at := now();

  -- number stays fixed unless kind or date changes
  if tg_op = 'UPDATE' and new.kind = old.kind and new.invoice_date = old.invoice_date then
    new.invoice_no := old.invoice_no;
    return new;
  end if;

  select * into ser from public.number_series where user_id = new.user_id and kind = new.kind for update;
  if not found then
    insert into public.number_series (user_id, kind, name, prefix)
    values (new.user_id, new.kind,
            case new.kind when 'regular' then 'Regular invoices' else 'Special invoices' end,
            case new.kind when 'regular' then 'ESR-' else 'ESS-' end)
    returning * into ser;
  end if;

  if ser.pattern like '%{SEQ%' then
    rkey := case ser.reset_every
              when 'year'  then to_char(new.invoice_date,'YYYY')
              when 'month' then to_char(new.invoice_date,'YYYY-MM')
              when 'fy'    then public.format_doc_no('{FY}','',new.invoice_date,0)
              else 'all' end;
    seq := case when ser.last_reset_key is not null and ser.last_reset_key <> rkey then 1 else ser.next_seq end;
    loop
      new.invoice_no := public.format_doc_no(ser.pattern, ser.prefix, new.invoice_date, seq);
      exit when not exists (select 1 from public.invoices
                            where user_id = new.user_id and invoice_no = new.invoice_no and id <> new.id);
      seq := seq + 1;
    end loop;
    update public.number_series set next_seq = seq + 1, last_reset_key = rkey, updated_at = now() where id = ser.id;
  else
    base := public.format_doc_no(ser.pattern, ser.prefix, new.invoice_date, 0);
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

-- back-fill INR columns on rows created by v1 (all treated as INR)
update public.invoices set subtotal_inr = subtotal, tds_inr = tds_amount, net_inr = net_amount
 where subtotal_inr = 0 and subtotal <> 0;
update public.expenses set amount_inr = amount where amount_inr = 0 and amount <> 0;

-- ---------- row level security ----------
alter table public.profile        enable row level security;
alter table public.clients        enable row level security;
alter table public.invoices       enable row level security;
alter table public.expenses       enable row level security;
alter table public.number_series  enable row level security;
alter table public.exchange_rates enable row level security;

do $$
declare t text;
begin
  foreach t in array array['profile','clients','invoices','expenses','number_series','exchange_rates'] loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated
                    using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- ---------- receipts storage (private bucket, files under <user_id>/...) ----------
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do nothing;

drop policy if exists receipts_own on storage.objects;
create policy receipts_own on storage.objects for all to authenticated
  using      (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'receipts' and (storage.foldername(name))[1] = auth.uid()::text);
