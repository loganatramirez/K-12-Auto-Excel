# K-12 / CCD Last Deal Data Refresh Runbook

Use this runbook when K-12 or CCD Last Deal suggestions do not appear after importing CDIAC or DebtWatch data into Supabase.

## Ticket For Codex

You are working in the `loganatramirez/K-12-Auto-Excel` repo.

Goal: make the Update Center generate Last Deal suggestions for the current workbook target list using Supabase `muni_deal_facts`.

Do not assume that a successful Supabase import means the workbook rows are connected. First prove that imported deal facts map to the current static workbook record ids.

### Context

The K-12 and CCD workbook rows are static in `lib/data.ts`.

Valid K-12 workbook target `record_id` values look like:

```text
k12-01-01
k12-03-25
k12-08-03
```

Valid CCD workbook target `record_id` values look like:

```text
ccd-01-01
ccd-03-02
ccd-05-05
```

Generated CDIAC issuer-import ids look like:

```text
k12-cdiac-state-of-california-...
k12-cdiac-los-angeles-unified-school-district-...
k12-cdiac-menifee-union-school-district-...
```

The app can use generated CDIAC ids as fallback evidence, but the best and most reliable path is to copy matching rows onto the current workbook ids.

The K-12 and CCD Last Deal workflows only create suggestions from rows that pass all of these gates:

```sql
module in ('k12-targets', 'ccd-targets')
scope_included = true
deal_sale_date >= date '2023-01-01'
```

It first tries exact `record_id` lookup. If that fails, it falls back to institution-name matching against `issuer_name_reported`, `related_entity_name`, `deal_name`, `source_excerpt`, and the generated `record_id` / `issuer_id` slug.

It will not create a suggestion when:

- a pending `Last Deal` suggestion already exists for that workbook row
- the proposed value is already the current saved value
- the latest date has multiple same-day deals and manual review is needed
- the row is older than 2023
- `scope_included` is false
- the issuer is not clearly the exact district or district-related CFD/SFID/special-tax financing

## Standard Human Workflow

### 1. Confirm Schema Exists

Run `lib/schema.sql` in the Supabase SQL Editor if the tables do not exist.

Required tables:

- `workbook_field_values`
- `workbook_custom_rows`
- `update_suggestions`
- `muni_issuer_profiles`
- `muni_deal_facts`
- `muni_source_documents`

### 2. Remove Bad CDIAC Custom Rows From The Visible Workbook

If the K-12 sheet shows a `CDIAC Issuer Records` section inside the workbook, run:

```sql
-- copy from lib/remove-cdiac-generated-custom-rows.sql
```

That removes accidental custom workbook rows. It does not remove valid `muni_deal_facts`.

### 3. Check Whether Deal Facts Are Connected To Static Workbook Rows

Run this first:

```sql
select
  count(*) as eligible_static_rows,
  count(distinct record_id) as eligible_static_record_ids
from muni_deal_facts
where module = 'k12-targets'
  and scope_included = true
  and deal_sale_date >= date '2023-01-01'
  and record_id ~ '^k12-[0-9]{2}-[0-9]{2}$';
```

Expected result:

- A healthy mapped import should return a nonzero count.
- If this returns `0`, the import did not map to the current workbook row ids.

Then inspect the imported ids:

```sql
select record_id, count(*) as rows
from muni_deal_facts
where module = 'k12-targets'
  and scope_included = true
  and deal_sale_date >= date '2023-01-01'
group by record_id
order by rows desc
limit 50;
```

If the top ids look like `k12-cdiac-state-of-california-...`, the database has a broad CDIAC issuer import, not a workbook-target import.

### 4. Check Pending Suggestions Before Re-running Automation

Pending suggestions block duplicate creation.

```sql
select record_id, field_key, status, proposed_value, created_at
from update_suggestions
where module = 'k12-targets'
  and field_key = 'Last Deal'
  and status = 'pending'
order by created_at desc;
```

If rows are pending, approve or reject them in Update Center before expecting the workflow to recreate them.

### 5. Import The Correct Mapped Deal Facts

If you have a fresh DebtWatch CSV, use the repo import script against the current `lib/data.ts`.

```bash
npm run prepare:muni-import -- /path/to/debtwatch.csv --module k12-targets --out tmp/muni-deal-import.sql --alias-file scripts/muni-aliases.example.json
```

Then open `tmp/muni-deal-import.sql` and run it in the Supabase SQL Editor.

This path is preferred because it maps imported rows to static workbook ids like `k12-03-25`.

If a target is missing because CDIAC uses a related authority name, add aliases in a copied alias file, then rerun the import:

```bash
cp scripts/muni-aliases.example.json tmp/muni-aliases.local.json
npm run prepare:muni-import -- /path/to/debtwatch.csv --module k12-targets --out tmp/muni-deal-import.sql --alias-file tmp/muni-aliases.local.json
```

Do not commit local data files or generated SQL under `tmp/`.

If the broad CDIAC import has already been loaded as generated rows, generate static remap SQL instead:

```bash
npm run prepare:k12-static-remap
npm run prepare:ccd-static-remap
```

Then run both generated SQL files in Supabase SQL Editor:

```text
tmp/k12-targets-static-deal-remap.sql
tmp/ccd-targets-static-deal-remap.sql
```

The CCD remap intentionally reads broad source rows from `module = 'k12-targets'` and writes matched rows into `module = 'ccd-targets'` with static ids like `ccd-02-01`. This is required when one broad CDIAC import feeds both K-12 and CCD workflows.

### 6. Run Update Center

In the deployed app:

1. Go to `/updates`.
2. Select `K-12 Targets` or `CCD Targets`.
3. Select `Last Deal`.
4. Select the target rows to scan.
5. Click `Run research`.
6. Review the message at the top.

Important message fields:

- `selected`: how many workbook rows were selected
- `eligible`: selected rows not blocked by pending suggestions
- `scanned`: rows actually processed
- `created`: suggestions inserted
- `Notes`: diagnostics for rows that did not create suggestions

### 7. Validate Success

Use SQL:

```sql
select record_id, proposed_value, source_title, source_url, created_at
from update_suggestions
where module in ('k12-targets', 'ccd-targets')
  and field_key = 'Last Deal'
order by created_at desc
limit 100;
```

Acceptance criteria:

- New pending Last Deal suggestions appear for mapped K-12 workbook rows.
- Suggestions are for exact districts or district-related CFD/SFID/special-tax financings.
- Statewide issuers, cities, counties, water districts, airports, housing authorities, and unrelated conduit issuers are not suggested as K-12 district Last Deals.

## Troubleshooting Matrix

### Import says success but few suggestions appear

Run the static id check in Step 3.

If `eligible_static_record_ids = 0`, the data is not mapped to the workbook. Re-import using `scripts/prepare-muni-deal-import.mjs`.

### Only 12, 15, or another small number appears

Check pending suggestions and current saved values.

Also check whether the data is a broad CDIAC issuer import. Broad imports may contain thousands of rows but only a small subset match the workbook targets.

### The database has thousands of rows

That is not automatically good. The app needs rows connected to the current target list, not every California issuer.

### A known district still does not appear

Inspect its candidate rows:

```sql
select record_id, issuer_name_reported, related_entity_name, deal_name, deal_sale_date, deal_par_amount, deal_state_id, scope_included
from muni_deal_facts
where module = 'k12-targets'
  and (
    record_id ilike '%district-name-fragment%'
    or issuer_name_reported ilike '%district name fragment%'
    or related_entity_name ilike '%district name fragment%'
    or deal_name ilike '%district name fragment%'
  )
order by deal_sale_date desc
limit 50;
```

Then add an alias if needed and re-import.

### The latest sale date has multiple deals

The app intentionally refuses to choose automatically. Manually inspect same-day rows and either approve one manually or narrow the import/scope.

### The suggested value already exists in the workbook

No suggestion is created because there is nothing to update.

## Notes For Future Codex Runs

Before changing code, first run the SQL diagnostics above. Most failures are data-mapping issues, not AI/model issues.

If code changes are needed, prefer small changes in `app/api/automation/k12-research/route.ts` and verify with:

```bash
npm run typecheck
npm run build
```

Then commit and push to `main`.
