create extension if not exists pgcrypto;

create table if not exists workbook_field_values (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in ('k12-targets', 'ccd-targets', 'plans')),
  record_id text not null,
  field_key text not null,
  value text not null default '',
  updated_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (record_id, field_key)
);

create table if not exists workbook_custom_rows (
  id text primary key,
  module text not null check (module in ('k12-targets', 'ccd-targets', 'plans')),
  title text not null,
  subtitle text,
  kind text not null default 'record' check (kind in ('section', 'record')),
  tone text check (tone in ('dark')),
  fields jsonb not null default '{}'::jsonb,
  row_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists update_suggestions (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in ('k12-targets', 'ccd-targets', 'plans')),
  record_id text not null,
  field_key text not null,
  current_value text,
  proposed_value text not null,
  source_title text,
  source_url text,
  source_excerpt text,
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table if not exists source_checks (
  id uuid primary key default gen_random_uuid(),
  module text check (module in ('k12-targets', 'ccd-targets', 'plans')),
  record_id text,
  source_url text not null,
  source_kind text not null default 'web' check (source_kind in ('web', 'pdf')),
  content_hash text,
  etag text,
  last_modified text,
  last_checked_at timestamp with time zone,
  next_check_at timestamp with time zone,
  priority text not null default 'monthly' check (priority in ('weekly', 'monthly', 'quarterly')),
  last_status text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (source_url)
);

create table if not exists muni_issuer_profiles (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in ('k12-targets', 'ccd-targets', 'plans')),
  record_id text not null,
  issuer_id text not null,
  issuer_name_legal text not null,
  issuer_name_display text,
  issuer_name_aliases text[] not null default '{}'::text[],
  issuer_cusip6 text[] not null default '{}'::text[],
  related_entities jsonb not null default '[]'::jsonb,
  scope_rule text not null default 'issuer_plus_related_entities',
  state text not null default 'CA',
  notes text,
  verified_date date,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (module, record_id),
  unique (issuer_id)
);

create table if not exists muni_deal_facts (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in ('k12-targets', 'ccd-targets', 'plans')),
  record_id text not null,
  issuer_profile_id uuid references muni_issuer_profiles(id) on delete set null,
  issuer_id text,
  issuer_name_reported text not null,
  related_entity_name text,
  scope_included boolean not null default true,
  deal_name text not null,
  deal_sale_date date,
  deal_par_amount numeric,
  deal_state_id text,
  deal_type text,
  refunding_type text,
  ma text,
  municipal_advisor text,
  uw text,
  underwriters jsonb not null default '[]'::jsonb,
  bc text,
  bond_counsel text,
  auth_type text,
  auth_detail text,
  source_url_primary text,
  source_title_primary text,
  source_excerpt text,
  source_layer text not null default 'L1' check (source_layer in ('L1', 'L2', 'L3', 'manual')),
  verified_date date not null default current_date,
  confidence text not null default 'high' check (confidence in ('high', 'medium', 'low')),
  raw_payload jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (module, record_id, deal_state_id)
);

create index if not exists muni_deal_facts_lookup_idx
on muni_deal_facts (module, record_id, scope_included, deal_sale_date desc);

create table if not exists muni_source_documents (
  id uuid primary key default gen_random_uuid(),
  module text not null check (module in ('k12-targets', 'ccd-targets', 'plans')),
  record_id text not null,
  deal_fact_id uuid references muni_deal_facts(id) on delete cascade,
  source_layer text not null check (source_layer in ('L1', 'L2', 'L3', 'manual')),
  source_kind text not null default 'web' check (source_kind in ('web', 'pdf', 'csv', 'manual')),
  source_url text,
  source_title text,
  source_excerpt text,
  content_hash text,
  storage_path text,
  page_hits jsonb not null default '[]'::jsonb,
  extracted_fields jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists workbook_field_values_set_updated_at on workbook_field_values;
create trigger workbook_field_values_set_updated_at
before update on workbook_field_values
for each row execute function set_updated_at();

drop trigger if exists workbook_custom_rows_set_updated_at on workbook_custom_rows;
create trigger workbook_custom_rows_set_updated_at
before update on workbook_custom_rows
for each row execute function set_updated_at();

drop trigger if exists update_suggestions_set_updated_at on update_suggestions;
create trigger update_suggestions_set_updated_at
before update on update_suggestions
for each row execute function set_updated_at();

drop trigger if exists source_checks_set_updated_at on source_checks;
create trigger source_checks_set_updated_at
before update on source_checks
for each row execute function set_updated_at();

drop trigger if exists muni_issuer_profiles_set_updated_at on muni_issuer_profiles;
create trigger muni_issuer_profiles_set_updated_at
before update on muni_issuer_profiles
for each row execute function set_updated_at();

drop trigger if exists muni_deal_facts_set_updated_at on muni_deal_facts;
create trigger muni_deal_facts_set_updated_at
before update on muni_deal_facts
for each row execute function set_updated_at();

drop trigger if exists muni_source_documents_set_updated_at on muni_source_documents;
create trigger muni_source_documents_set_updated_at
before update on muni_source_documents
for each row execute function set_updated_at();

alter table workbook_field_values enable row level security;
alter table workbook_custom_rows enable row level security;
alter table update_suggestions enable row level security;
alter table source_checks enable row level security;
alter table muni_issuer_profiles enable row level security;
alter table muni_deal_facts enable row level security;
alter table muni_source_documents enable row level security;

drop policy if exists "authenticated read field values" on workbook_field_values;
create policy "authenticated read field values"
on workbook_field_values for select
to authenticated
using (true);

drop policy if exists "authenticated insert field values" on workbook_field_values;
create policy "authenticated insert field values"
on workbook_field_values for insert
to authenticated
with check (true);

drop policy if exists "authenticated update field values" on workbook_field_values;
create policy "authenticated update field values"
on workbook_field_values for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete field values" on workbook_field_values;
create policy "authenticated delete field values"
on workbook_field_values for delete
to authenticated
using (true);

drop policy if exists "authenticated read custom rows" on workbook_custom_rows;
create policy "authenticated read custom rows"
on workbook_custom_rows for select
to authenticated
using (true);

drop policy if exists "authenticated insert custom rows" on workbook_custom_rows;
create policy "authenticated insert custom rows"
on workbook_custom_rows for insert
to authenticated
with check (true);

drop policy if exists "authenticated update custom rows" on workbook_custom_rows;
create policy "authenticated update custom rows"
on workbook_custom_rows for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete custom rows" on workbook_custom_rows;
create policy "authenticated delete custom rows"
on workbook_custom_rows for delete
to authenticated
using (true);

drop policy if exists "authenticated read suggestions" on update_suggestions;
create policy "authenticated read suggestions"
on update_suggestions for select
to authenticated
using (true);

drop policy if exists "authenticated insert suggestions" on update_suggestions;
create policy "authenticated insert suggestions"
on update_suggestions for insert
to authenticated
with check (true);

drop policy if exists "authenticated update suggestions" on update_suggestions;
create policy "authenticated update suggestions"
on update_suggestions for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete suggestions" on update_suggestions;
create policy "authenticated delete suggestions"
on update_suggestions for delete
to authenticated
using (true);

drop policy if exists "authenticated read source checks" on source_checks;
create policy "authenticated read source checks"
on source_checks for select
to authenticated
using (true);

drop policy if exists "authenticated insert source checks" on source_checks;
create policy "authenticated insert source checks"
on source_checks for insert
to authenticated
with check (true);

drop policy if exists "authenticated update source checks" on source_checks;
create policy "authenticated update source checks"
on source_checks for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete source checks" on source_checks;
create policy "authenticated delete source checks"
on source_checks for delete
to authenticated
using (true);

drop policy if exists "authenticated read muni issuer profiles" on muni_issuer_profiles;
create policy "authenticated read muni issuer profiles"
on muni_issuer_profiles for select
to authenticated
using (true);

drop policy if exists "authenticated insert muni issuer profiles" on muni_issuer_profiles;
create policy "authenticated insert muni issuer profiles"
on muni_issuer_profiles for insert
to authenticated
with check (true);

drop policy if exists "authenticated update muni issuer profiles" on muni_issuer_profiles;
create policy "authenticated update muni issuer profiles"
on muni_issuer_profiles for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete muni issuer profiles" on muni_issuer_profiles;
create policy "authenticated delete muni issuer profiles"
on muni_issuer_profiles for delete
to authenticated
using (true);

drop policy if exists "authenticated read muni deal facts" on muni_deal_facts;
create policy "authenticated read muni deal facts"
on muni_deal_facts for select
to authenticated
using (true);

drop policy if exists "authenticated insert muni deal facts" on muni_deal_facts;
create policy "authenticated insert muni deal facts"
on muni_deal_facts for insert
to authenticated
with check (true);

drop policy if exists "authenticated update muni deal facts" on muni_deal_facts;
create policy "authenticated update muni deal facts"
on muni_deal_facts for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete muni deal facts" on muni_deal_facts;
create policy "authenticated delete muni deal facts"
on muni_deal_facts for delete
to authenticated
using (true);

drop policy if exists "authenticated read muni source documents" on muni_source_documents;
create policy "authenticated read muni source documents"
on muni_source_documents for select
to authenticated
using (true);

drop policy if exists "authenticated insert muni source documents" on muni_source_documents;
create policy "authenticated insert muni source documents"
on muni_source_documents for insert
to authenticated
with check (true);

drop policy if exists "authenticated update muni source documents" on muni_source_documents;
create policy "authenticated update muni source documents"
on muni_source_documents for update
to authenticated
using (true)
with check (true);

drop policy if exists "authenticated delete muni source documents" on muni_source_documents;
create policy "authenticated delete muni source documents"
on muni_source_documents for delete
to authenticated
using (true);

drop function if exists is_ramirez_user();
