# Logan Project Handoff And Operating Runbook

This document is the day-to-day operating guide for the K-12 Auto Excel app.
It explains what the project does, how the data moves through the system, how
to refresh CDIAC/DebtWatch data, and how to troubleshoot the failures we have
already seen.

The short version:

1. The workbook row lists live in code.
2. Editable cells and update suggestions live in Supabase.
3. CDIAC/DebtWatch deal rows must be imported into Supabase.
4. Broad CDIAC rows must be remapped onto the workbook's static row ids.
5. Update Center creates suggestions. It does not directly overwrite the sheet.
6. A human approves or rejects suggestions.

## 1. What This App Is

The app is a private workbook and research queue for three tabs:

- `K-12 Targets`: school district target research.
- `CCD Targets`: community college district target research.
- `FY25&26`: revenue plan / mandate pipeline.

There is also an `Update Center` at `/updates`. Update Center is where the app
creates reviewable suggestions such as Last Deal, MA, UW, BC, leadership names,
and FY25&26 deal facts.

The deployed app is a Next.js app on Vercel. It stores user edits and research
suggestions in Supabase.

## 2. The Most Important Mental Model

The app separates "fixed workbook structure" from "changing workbook data".

Fixed structure lives in code:

- Workbook modules and routes: `lib/data.ts`
- Built-in row ids: generated from `lib/data.ts`
- Built-in row titles and group headers: `lib/data.ts`
- Column definitions: `lib/data.ts`

Changing data lives in Supabase:

- Saved cell edits: `workbook_field_values`
- User-added rows: `workbook_custom_rows`
- Pending / approved / rejected suggestions: `update_suggestions`
- Imported public-finance facts: `muni_deal_facts`
- Issuer identity profiles: `muni_issuer_profiles`
- Source metadata: `source_checks`, `muni_source_documents`

This means a successful CDIAC import is not enough by itself. The deal rows
must connect to the workbook row ids the app actually uses.

Valid static workbook ids look like:

```text
k12-03-01
ccd-02-04
plan-01-03
```

Broad generated CDIAC import ids look like:

```text
k12-cdiac-los-angeles-unified-school-district-...
k12-cdiac-state-of-california-...
k12-cdiac-california-school-finance-authority-...
```

The broad generated rows are useful source material, but Update Center works
best after those rows are copied onto the static workbook ids.

## 3. What Each Module Means

### K-12 Targets

Use this tab for school district target research.

Important fields:

- `District`: locked system field.
- `Area`: locked system field.
- `MA`: Municipal Advisor.
- `UW`: Underwriter.
- `BC`: Bond Counsel.
- `Auth`: authorization notes.
- `Last Deal`: latest supported transaction.
- `Sup`, `CBO`, `Board 1` through `Board 7`: leadership.
- `Notes`: manual.

Update Center can help with:

- `Last Deal / MA / UW / BC`
- `Sup / CBO / Board`
- `Auth`

### CCD Targets

Use this tab for community college district target research.

Important fields:

- `CCD Targets`: locked system field.
- `Authorizations`
- `Refundings`
- `Last Deal`
- `Chancellor`
- `CFO`
- `Underwriter`
- `MA`
- `BC`
- `Notes`

Update Center can help with:

- `Last Deal / Underwriter / MA / BC`
- `Chancellor / CFO`

### FY25&26

Use this tab for the internal revenue / mandate plan.

This is not the same kind of research list as K-12 or CCD. It is closer to a
pipeline or plan table.

The app can fill objective public deal facts from CDIAC/DebtWatch:

- `MA`
- `Deal`
- `Date`
- `Par ($M)`

These fields stay manual:

- `Role sale`
- `Fee`
- `Liab.`
- `Prob.`
- `Lead`
- `SRSupp.`
- `Supp.`

These fields are calculated by the app:

- `EST Rev`
- `ADJ Rev`

Current formula behavior:

```text
EST Rev = Par ($M) * Fee * Liab.
ADJ Rev = EST Rev * Prob.
```

Examples:

- `Par ($M) = $300`
- `Fee = 1.91`
- `Liab. = 50%`
- `Prob. = 100%`

Then the app displays estimated revenue in the workbook style, for example
`$287`.

## 4. Required Services And Environments

### GitHub

The source repo is:

```text
loganatramirez/K-12-Auto-Excel
```

Normal deployment flow:

1. Code changes are committed to `main`.
2. GitHub receives the push.
3. Vercel automatically builds and deploys production.

### Vercel

Vercel hosts the app and stores production environment variables.

Required environment variables:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SIGNUP_ACCESS_CODE
PERPLEXITY_API_KEY
OPENAI_API_KEY
K12_EXTRACTION_PROVIDER
```

Notes:

- `NEXT_PUBLIC_SUPABASE_URL` must be the intended Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` must be the anon key from the same project.
- `SUPABASE_SERVICE_ROLE_KEY` must be the service_role key from the same project.
- The service role key is secret. Never expose it as `NEXT_PUBLIC_*`.
- If any `NEXT_PUBLIC_*` value changes, redeploy Vercel.

Use `/api/config-status` on the deployed app to verify safe configuration
metadata. It shows whether keys exist, key lengths, and the Supabase host/ref.
It never shows the secret values.

The Supabase project ref shown by `/api/config-status` must match the intended
Supabase project. During this handoff, the intended project ref was:

```text
knpqxevevracvehktuyw
```

If `/api/config-status` shows a different ref, Vercel is pointed at the wrong
Supabase project.

### Supabase

Supabase stores app users, workbook edits, imported deal facts, and update
suggestions.

The required tables are created by:

```text
lib/schema.sql
```

Run `lib/schema.sql` only when setting up a new Supabase project or repairing a
missing schema. Do not rerun it for every CDIAC data refresh.

## 5. One-Time Setup Checklist

Use this when setting up the project from scratch or repairing a broken
deployment.

### Step 1: Pull the latest code

```bash
git pull
npm install
```

### Step 2: Confirm Supabase schema exists

Open Supabase SQL Editor and run:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in (
    'workbook_field_values',
    'workbook_custom_rows',
    'update_suggestions',
    'source_checks',
    'muni_issuer_profiles',
    'muni_deal_facts',
    'muni_source_documents'
  )
order by table_name;
```

Expected result: 7 rows.

If tables are missing, run the full SQL from:

```text
lib/schema.sql
```

Then reload the PostgREST schema cache:

```sql
select pg_notify('pgrst', 'reload schema');
```

### Step 3: Set Vercel environment variables

In Vercel:

1. Open the project.
2. Go to `Settings`.
3. Go to `Environment Variables`.
4. Add or update the required variables.
5. Make sure they apply to `Production` and `Preview` if preview deployments are used.
6. Save.
7. Redeploy production.

Important: Supabase and Vercel integrations can accidentally create or connect
to a new empty Supabase project. If login or tables suddenly break, check
`/api/config-status` first.

### Step 4: Confirm deployed config

Open:

```text
https://k-12-auto-excel.vercel.app/api/config-status
```

Confirm:

- `supabaseConfigured` is `true`.
- `supabaseProjectRef` is the intended project.
- `supabaseAnonKeyPresent` is `true`.
- `supabaseServiceRoleKeyPresent` is `true`.
- `signupConfigured` is `true`.

### Step 5: Test sign up / sign in

Go to:

```text
https://k-12-auto-excel.vercel.app/login
```

Create an account with the registration code stored in `SIGNUP_ACCESS_CODE`.

If sign up shows `fetch failed`, check:

- Supabase URL is correct.
- Anon key is correct.
- Service role key is correct.
- Vercel was redeployed after env changes.

If sign in says `Invalid login credentials`, check:

- You may be signing into a different Supabase project than the one where the
  user was created.
- Check `/api/config-status`.
- If the app was pointed to a new Supabase project, create the user again or
  fix Vercel env vars back to the correct project.

## 6. Normal Monthly CDIAC/DebtWatch Refresh

Run this when new CDIAC/DebtWatch rows need to be available in Update Center.

Recommended cadence:

- Monthly for active K-12 and CCD targets.
- Ad hoc when someone notices a new OS/POS, agenda item, or CDIAC filing.
- Before a major targeting or pipeline review.

### Step 1: Import new CDIAC/DebtWatch data into Supabase

The import can come from the app's upload flow or a generated SQL import. The
important thing is that rows land in:

```text
muni_deal_facts
```

For a broad California CDIAC/DebtWatch import, it is normal to see thousands of
eligible rows. That does not mean they are connected to workbook targets yet.

### Step 2: Confirm broad import exists

In Supabase SQL Editor:

```sql
select
  count(*) as eligible_rows,
  count(distinct record_id) as eligible_record_ids
from muni_deal_facts
where module = 'k12-targets'
  and scope_included = true
  and deal_sale_date >= date '2023-01-01';
```

Healthy broad import signs:

- `eligible_rows` is greater than zero.
- It may be thousands.
- Many record ids may look like `k12-cdiac-*`.

### Step 3: Generate static remap SQL locally

In the repo folder:

```bash
npm run prepare:k12-static-remap
npm run prepare:ccd-static-remap
npm run prepare:plan-static-remap
```

These commands create:

```text
tmp/k12-targets-static-deal-remap.sql
tmp/ccd-targets-static-deal-remap.sql
tmp/plans-static-deal-remap.sql
```

What they do:

- Read the current target lists from `lib/data.ts`.
- Match broad generated CDIAC rows to workbook issuers by name and aliases.
- Copy matched facts to static row ids like `k12-03-01`, `ccd-02-01`, and
  `plan-01-03`.
- Use upserts, so rerunning is safe.

### Step 4: Run the generated SQL files in Supabase

Open each generated file and paste it into Supabase SQL Editor:

```text
tmp/k12-targets-static-deal-remap.sql
tmp/ccd-targets-static-deal-remap.sql
tmp/plans-static-deal-remap.sql
```

Run them one at a time.

At the bottom of each result, look for:

```text
static remap summary
static facts now
```

Good result:

- `matched_generated_rows` is greater than zero.
- `matched_static_issuers` is greater than zero.
- `matched_deals` is greater than zero.

If all values are zero, the broad import probably did not contain matching rows,
or Vercel/Supabase is pointed at the wrong project.

### Step 5: Check static remap coverage

Run:

```sql
select
  count(*) filter (
    where module = 'k12-targets'
      and record_id ~ '^k12-[0-9]{2}-[0-9]{2}$'
  ) as k12_static_rows,
  count(distinct record_id) filter (
    where module = 'k12-targets'
      and record_id ~ '^k12-[0-9]{2}-[0-9]{2}$'
  ) as k12_static_issuers,
  count(*) filter (
    where module = 'ccd-targets'
      and record_id ~ '^ccd-[0-9]{2}-[0-9]{2}$'
  ) as ccd_static_rows,
  count(distinct record_id) filter (
    where module = 'ccd-targets'
      and record_id ~ '^ccd-[0-9]{2}-[0-9]{2}$'
  ) as ccd_static_issuers,
  count(*) filter (
    where module = 'plans'
      and record_id ~ '^plan-[0-9]{2}-[0-9]{2}$'
  ) as plan_static_rows,
  count(distinct record_id) filter (
    where module = 'plans'
      and record_id ~ '^plan-[0-9]{2}-[0-9]{2}$'
  ) as plan_static_issuers
from muni_deal_facts
where module in ('k12-targets', 'ccd-targets', 'plans');
```

Good result: each module you plan to refresh should have static rows and static
issuers.

### Step 6: Clear stale pending suggestions if needed

Update Center does not create duplicate suggestions when a pending suggestion
already exists. Before a clean rerun, approve/reject old suggestions in the UI
or delete stale pending rows.

K-12:

```sql
delete from update_suggestions
where module = 'k12-targets'
  and field_key in ('Last Deal', 'MA', 'UW', 'BC')
  and status = 'pending';
```

CCD:

```sql
delete from update_suggestions
where module = 'ccd-targets'
  and field_key in ('Last Deal', 'Underwriter', 'MA', 'BC')
  and status = 'pending';
```

FY25&26:

```sql
delete from update_suggestions
where module = 'plans'
  and field_key in ('MA', 'Deal', 'Date', 'Par ($M)')
  and status = 'pending';
```

Do not delete approved history unless you intentionally want to wipe review
history.

### Step 7: Run Update Center

Open:

```text
https://k-12-auto-excel.vercel.app/updates
```

For K-12:

1. Select `K-12 Targets`.
2. Select `Last Deal / MA / UW / BC`.
3. Select rows.
4. Click `Run research`.
5. Review suggestions.
6. Approve or reject.

For CCD:

1. Select `CCD Targets`.
2. Select `Last Deal / Underwriter / MA / BC`.
3. Select rows.
4. Click `Run research`.
5. Review suggestions.
6. Approve or reject.

For FY25&26:

1. Select `FY25&26`.
2. Select `CDIAC Deal Facts`.
3. Select rows.
4. Click `Run research`.
5. Review suggestions for `MA`, `Deal`, `Date`, and `Par ($M)`.
6. Approve or reject.
7. Open `/plans` and confirm `EST Rev` and `ADJ Rev` calculate automatically.

### Step 8: Validate suggestions

Run:

```sql
select module, field_key, status, count(*)
from update_suggestions
where module in ('k12-targets', 'ccd-targets', 'plans')
group by module, field_key, status
order by module, field_key, status;
```

Or inspect recent suggestions:

```sql
select module, record_id, field_key, proposed_value, status, created_at
from update_suggestions
where module in ('k12-targets', 'ccd-targets', 'plans')
order by created_at desc
limit 100;
```

## 7. When To Use Each Command

### `npm run prepare:k12-static-remap`

Use after importing broad CDIAC/DebtWatch rows when K-12 Last Deal / MA / UW /
BC should be refreshed.

Output:

```text
tmp/k12-targets-static-deal-remap.sql
```

### `npm run prepare:ccd-static-remap`

Use after importing broad CDIAC/DebtWatch rows when CCD Last Deal /
Underwriter / MA / BC should be refreshed.

Output:

```text
tmp/ccd-targets-static-deal-remap.sql
```

This intentionally reads broad source rows from `module = 'k12-targets'` and
writes matched rows into `module = 'ccd-targets'`.

### `npm run prepare:plan-static-remap`

Use after importing broad CDIAC/DebtWatch rows when FY25&26 should receive
objective deal facts.

Output:

```text
tmp/plans-static-deal-remap.sql
```

This intentionally reads broad source rows from `module = 'k12-targets'` and
writes matched rows into `module = 'plans'`.

### `npm run prepare:muni-import`

Use only if you have a raw DebtWatch/CDIAC CSV and want the repo to generate a
Supabase-ready import SQL file.

Example:

```bash
npm run prepare:muni-import -- ~/Downloads/debtwatch.csv --module k12-targets --out tmp/muni-deal-import.sql --alias-file scripts/muni-aliases.example.json
```

Then run:

```text
tmp/muni-deal-import.sql
```

in Supabase SQL Editor.

## 8. Deployment Workflow

### Normal code deploy

```bash
git status
npm run typecheck
npm run build
git add .
git commit -m "Describe the change"
git push
```

Vercel should auto-deploy from GitHub.

### Manual redeploy in Vercel

Use this after changing Vercel environment variables.

1. Open Vercel project.
2. Go to `Deployments`.
3. Find the latest production deployment.
4. Click the three-dot menu.
5. Click `Redeploy`.
6. Do not use old build cache if env behavior looks suspicious.
7. Wait until status is `Ready`.
8. Open `/api/config-status` and verify the Supabase ref.

## 9. Common Problems And Exact Fixes

### Problem: `Could not find the table 'public.workbook_field_values' in the schema cache`

Most likely causes:

1. Vercel is pointed at the wrong Supabase project.
2. The table really does not exist in the current Supabase project.
3. Supabase PostgREST schema cache is stale.

Fix:

1. Open `/api/config-status`.
2. Confirm `supabaseProjectRef` is the intended project.
3. In Supabase SQL Editor, run the required-table check.
4. If tables are missing, run `lib/schema.sql`.
5. Reload schema:

```sql
select pg_notify('pgrst', 'reload schema');
```

### Problem: Login says `Invalid login credentials`

Most likely causes:

1. User exists in one Supabase project, but Vercel points to another.
2. The account was never created in the current Supabase project.
3. Wrong password.

Fix:

1. Check `/api/config-status`.
2. Confirm Supabase project ref.
3. If project ref changed, create the user again using the registration code.
4. If the project ref is wrong, fix Vercel env vars and redeploy.

### Problem: Sign up says `fetch failed`

Most likely causes:

1. Bad Supabase URL.
2. Bad anon key.
3. Bad service role key.
4. Vercel env vars changed but production was not redeployed.

Fix:

1. Recopy all three Supabase values from the same Supabase project.
2. In Vercel, update:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
3. Redeploy production.
4. Recheck `/api/config-status`.

### Problem: Imported 28 files but only 15 to 18 Last Deals appear

Most likely cause:

The database has broad generated CDIAC rows, but not enough static workbook rows.

Fix:

1. Run:

```bash
npm run prepare:k12-static-remap
npm run prepare:ccd-static-remap
npm run prepare:plan-static-remap
```

2. Run the generated SQL files in Supabase.
3. Clear stale pending suggestions.
4. Rerun Update Center.

### Problem: Supabase import says success and row count is huge

That only proves data exists. It does not prove the workbook can use it.

Run the static coverage check from Section 6.

### Problem: A specific district should have a deal but Update Center finds none

Search source facts:

```sql
select
  record_id,
  issuer_name_reported,
  related_entity_name,
  deal_name,
  deal_sale_date,
  deal_par_amount,
  deal_state_id,
  scope_included
from muni_deal_facts
where module in ('k12-targets', 'ccd-targets', 'plans')
  and (
    issuer_name_reported ilike '%district name fragment%'
    or related_entity_name ilike '%district name fragment%'
    or deal_name ilike '%district name fragment%'
    or record_id ilike '%district-name-fragment%'
  )
order by deal_sale_date desc
limit 50;
```

If the issuer name is different from the workbook name, add an alias in:

```text
scripts/prepare-static-deal-remap-sql.mjs
```

Then regenerate and rerun the static remap SQL.

### Problem: Update Center creates no new suggestions

Check pending suggestions:

```sql
select module, record_id, field_key, status, proposed_value, created_at
from update_suggestions
where status = 'pending'
order by created_at desc
limit 100;
```

Pending suggestions block duplicates. Approve/reject them or delete stale
pending rows.

Also check whether the proposed value already exists in the workbook. If the
cell already has the same value, the app does not create a suggestion.

### Problem: Vercel is connected to GitHub but app still uses wrong data

GitHub connection only controls code deployment. It does not guarantee the app
is pointed at the right Supabase database.

Always check:

```text
/api/config-status
```

### Problem: Supabase Vercel integration created a new empty database

This can happen when connecting from Vercel Marketplace.

Fix:

1. Decide which Supabase project is the real production database.
2. Copy URL, anon key, and service role key from that exact project.
3. Paste them into Vercel env vars.
4. Redeploy.
5. Confirm `/api/config-status`.
6. Do not rely only on the Marketplace connection screen.

## 10. Safe Reset Commands

Use these only when intentionally reloading data. Do not run them casually.

### Clear K-12 imported deal data and source checks

```sql
delete from update_suggestions
where module = 'k12-targets'
  and field_key = 'Last Deal';

delete from muni_deal_facts
where module = 'k12-targets';

delete from muni_issuer_profiles
where module = 'k12-targets';

delete from muni_source_documents
where module = 'k12-targets';

delete from source_checks
where module = 'k12-targets';
```

After running this, reimport CDIAC/DebtWatch rows and rerun static remap.

### Clear only stale pending suggestions

This is usually safer than deleting imported facts:

```sql
delete from update_suggestions
where status = 'pending'
  and module in ('k12-targets', 'ccd-targets', 'plans');
```

## 11. What Not To Do

Do not paste a service role key into a `NEXT_PUBLIC_*` variable.

Do not assume Vercel's Supabase integration points at the correct database.
Always verify `/api/config-status`.

Do not rerun `lib/schema.sql` as part of every data refresh. It is a schema
setup file, not a monthly refresh step.

Do not expect broad `k12-cdiac-*` rows to behave exactly like workbook rows.
Run the static remap scripts.

Do not leave hundreds of old pending suggestions before rerunning Update
Center. Pending rows block duplicates.

Do not let automation fill FY25&26 probability, internal staffing, or business
judgment fields. Those are manual.

Do not commit raw CSV exports, downloaded data files, or generated SQL under
`tmp/`.

## 12. Quick Monthly Checklist

Use this as the fastest normal operating path.

1. Pull latest code:

```bash
git pull
```

2. Import latest CDIAC/DebtWatch rows into Supabase.
3. Generate remap SQL:

```bash
npm run prepare:k12-static-remap
npm run prepare:ccd-static-remap
npm run prepare:plan-static-remap
```

4. Run these SQL files in Supabase:

```text
tmp/k12-targets-static-deal-remap.sql
tmp/ccd-targets-static-deal-remap.sql
tmp/plans-static-deal-remap.sql
```

5. Clear stale pending suggestions if you need a clean rerun.
6. Open `/updates`.
7. Run K-12, CCD, or FY25&26 workflows.
8. Approve/reject suggestions.
9. Open the workbook tabs and spot-check results.

## 13. Quick Health Check SQL

Run this after a refresh:

```sql
select
  'eligible K-12 static deal rows' as check_name,
  count(*)::text as actual
from muni_deal_facts
where module = 'k12-targets'
  and scope_included = true
  and deal_sale_date >= date '2023-01-01'
  and record_id ~ '^k12-[0-9]{2}-[0-9]{2}$'
union all
select
  'eligible CCD static deal rows',
  count(*)::text
from muni_deal_facts
where module = 'ccd-targets'
  and scope_included = true
  and deal_sale_date >= date '2023-01-01'
  and record_id ~ '^ccd-[0-9]{2}-[0-9]{2}$'
union all
select
  'eligible FY25&26 static deal rows',
  count(*)::text
from muni_deal_facts
where module = 'plans'
  and scope_included = true
  and deal_sale_date >= date '2023-01-01'
  and record_id ~ '^plan-[0-9]{2}-[0-9]{2}$'
union all
select
  'pending suggestions',
  count(*)::text
from update_suggestions
where module in ('k12-targets', 'ccd-targets', 'plans')
  and status = 'pending';
```

## 14. Copy/Paste Ticket For Future Codex

If you need Codex to debug the project later, paste this:

```text
You are working in loganatramirez/K-12-Auto-Excel.

Before changing code, verify whether the issue is data mapping:

1. Check /api/config-status and confirm Vercel points at the intended Supabase project.
2. Confirm required tables exist: workbook_field_values, workbook_custom_rows,
   update_suggestions, source_checks, muni_issuer_profiles, muni_deal_facts,
   muni_source_documents.
3. Check whether muni_deal_facts has static workbook ids:
   k12-[0-9]{2}-[0-9]{2}, ccd-[0-9]{2}-[0-9]{2}, plan-[0-9]{2}-[0-9]{2}.
4. If only broad k12-cdiac-* rows exist, run:
   npm run prepare:k12-static-remap
   npm run prepare:ccd-static-remap
   npm run prepare:plan-static-remap
   Then run the generated SQL files in Supabase.
5. Clear stale pending suggestions before rerunning Update Center.
6. Only change code after proving the data and environment are correct.
```

