# K-12 Targets MVP

This is a working Next.js workbook for three Excel-like sheets plus an update review queue:

- K-12 Targets
- CCD Targets
- FY25&26
- Update Center

The fixed target lists live in `lib/data.ts`. Supabase stores the parts that can change:

- saved field edits
- custom rows
- reviewable update suggestions
- source-check metadata for future AI/web/PDF scans

System-owned fields are locked in the UI for built-in rows:

- K-12 Targets: `District` and `Area`
- CCD Targets: `CCD Targets`
- FY25&26: `Issuer`
- all section/group header rows

Those values are intended to stay in code. The remaining cells are editable and can be persisted through Supabase.

If Supabase environment variables are not configured, the deployed app redirects to `/login` and shows setup instructions instead of exposing the workbook.

## Start locally

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Supabase setup

1. Create a Supabase project.
2. Open the Supabase SQL Editor.
3. Run the full SQL in `lib/schema.sql`.
4. In Supabase Auth, Email can stay enabled, but the app creates confirmed users through its own registration-code signup route.
5. In Vercel, add these environment variables:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SIGNUP_ACCESS_CODE=ramirezcointern2026
PERPLEXITY_API_KEY=
OPENAI_API_KEY=
K12_EXTRACTION_PROVIDER=auto
```

The app also accepts `PUBFIN_API_KEY` as a fallback name for the Perplexity key.

Copy the full Supabase keys from Project Settings -> API. Do not paste a shortened preview like `eyJ...`; the anon key is usually much longer than a few dozen characters.

6. Redeploy the Vercel project.

After that, unauthenticated users are sent to `/login`, and workbook edits persist to Supabase. Any email can create an account if the user enters the registration code.

If you already ran the earlier `@ramirezco.com`-restricted SQL, run `lib/invite-code-rls.sql` once in the Supabase SQL Editor to switch the database policies back to authenticated users created through the invite-code flow.

`SUPABASE_SERVICE_ROLE_KEY` must be the Supabase `service_role` key and must not be prefixed with `NEXT_PUBLIC`. It is used only by `/api/signup` to create confirmed users after they enter `SIGNUP_ACCESS_CODE`.

You can check deployment configuration at `/api/config-status`; it only returns whether variables exist and their lengths, never the secret values.

## K-12 research automation

The Update Center includes three K-12 research groups. Each run scans only the selected institutions, caps the batch at 100 institutions, and creates reviewable suggestions:

- `Last Deal / MA / UW / BC`
- `Sup / CBO / Board 1` through `Board 7`
- `Auth`

`Notes` stays manual. Automation does not overwrite the workbook directly; suggested updates must be approved in Update Center before they are saved into `workbook_field_values`.

Add `PERPLEXITY_API_KEY` in Vercel before using it. If the key is already stored as `PUBFIN_API_KEY`, the app will use that as a fallback. Optional: set `PERPLEXITY_MODEL`; otherwise the app uses `sonar-pro`.

For better accuracy, add `OPENAI_API_KEY`. The app uses OpenAI and Perplexity/PubFin for source search, then extracts fields from those sources using:

- `K12_EXTRACTION_PROVIDER=auto`: all configured providers vote on leadership fields; OpenAI and Perplexity are used when available.
- `K12_EXTRACTION_PROVIDER=openai`: force OpenAI extraction.
- `K12_EXTRACTION_PROVIDER=perplexity`: force Perplexity extraction.

For `Sup / CBO / Board` fields, the app requires at least two configured providers to agree on the same normalized person name before creating an update suggestion. This is stricter and creates fewer suggestions, but it is much safer for people data.

`Sup` and `CBO` use position replacement logic. `Board 1` through `Board 7` use roster diff logic: the app compares the current consensus board roster against the saved workbook roster, then suggests new members, replacements for possibly removed members, or clearing a saved member who is no longer found. Verified existing members do not create suggestions, and board order changes alone are ignored.

Deal team research (`Last Deal / MA / UW / BC`) works as a deal package. It searches for high-quality public finance sources first: Official Statement/POS PDFs, EMMA, CDIAC/DebtWatch, district board agenda packets, staff reports, resolutions, BondLink, and MuniOS pages. The extractor prefers one latest supported transaction from 2023 or later and then suggests Last Deal, Municipal Advisor, Underwriter, and Bond Counsel fields from that package. Older deals are intentionally ignored. The suggestions are still stored field-by-field so reviewers can approve only the fields they trust.

Source discovery runs multiple targeted searches per institution, dedupes the results, ranks likely official sources first, and lightly expands the top web pages into evidence text. This helps board rosters and deal team extraction because search snippets often omit the full list of trustees or financing participants.

### Muni deal lookup pipeline

For deal-team fields, the intended source hierarchy is now:

1. `L1`: state filing data such as CDIAC/DebtWatch. This should be the primary path for California issuers because it can provide sale date, par, municipal advisor, underwriter, and bond counsel without open-web guessing.
2. `L2`: OS/POS PDFs, issuer agenda packets, minutes, staff reports, resolutions, BondLink, and MuniOS mirrors. These sources are used to confirm the deal package and fill authorization or refunding details.
3. `L3`: manual EMMA/MuniOS browser download. Public EMMA pages are not reliable for server-side scraping, so downloaded PDFs should be fed back into the L2 extraction path later.

Run the latest `lib/schema.sql` in Supabase to create:

- `muni_issuer_profiles`: legal name, aliases, CUSIP-6 values, related entities, and scope rule.
- `muni_deal_facts`: normalized state filing / OS facts by workbook row. The current `Last Deal / MA / UW / BC` workflow checks this table first.
- `muni_source_documents`: traceable source records for OS/POS/PDF/CSV/manual documents.

When `muni_deal_facts` contains a scoped, 2023-or-newer row for a K-12 target, Update Center will create suggestions from that L1 record before spending API calls on web search. If the table is empty or has not been created yet, the app silently falls back to the existing OpenAI/Perplexity source discovery.

Minimum columns needed for an L1 deal row:

```sql
module, record_id, issuer_name_reported, deal_name, deal_sale_date,
deal_par_amount, deal_state_id, ma, uw, bc, source_url_primary,
source_layer, confidence
```

Use `scope_included=false` for related entities that should be stored for reference but not treated as the issuer's latest deal under the current scope rule. If multiple scoped deals have the same latest sale date, the app flags them for manual review instead of choosing one automatically.

#### Import CDIAC/DebtWatch CSV

1. Download/export the CDIAC/DebtWatch issue-level CSV for the years you care about. Start with 2023-current so the import stays small.
2. Save the file locally, for example `~/Downloads/debtwatch.csv`.
3. Generate a Supabase-ready SQL import:

```bash
npm run prepare:muni-import -- ~/Downloads/debtwatch.csv --module k12-targets --out tmp/muni-deal-import.sql --alias-file scripts/muni-aliases.example.json
```

4. Open `tmp/muni-deal-import.sql`, paste it into the Supabase SQL Editor, and run it.
5. Return to Update Center and run `Last Deal / MA / UW / BC`. If `muni_deal_facts` has a scoped 2023+ match, the suggestion comes from L1 before any AI/web search.

The import script reads `lib/data.ts` to map workbook rows to stable `record_id` values. It accepts flexible CSV column names such as `Issuer`, `Issue Name`, `Sale Date`, `Principal Amount`, `Financial Advisor`, `Underwriter`, and `Bond Counsel`.

If a target is missing because CDIAC uses a related-entity name, copy `scripts/muni-aliases.example.json`, add aliases for that target, and rerun the command with your alias file.

Optional model overrides:

- `OPENAI_MODEL`, default `gpt-4.1-mini`
- `PERPLEXITY_MODEL`, default `sonar-pro`

Recommended manual update cadence:

- Deal team (`Last Deal / MA / UW / BC`): monthly for active targets, plus ad hoc scans when a district has a new agenda/OS/CDIAC signal.
- Leadership (`Sup / CBO / Board`): quarterly for all districts, plus ad hoc scans before meetings or pitches.
- Authorization (`Auth`): quarterly.
- Notes: manual only.

These are manual recommendations shown in the Update Center, not automatic scheduled jobs. To save API usage, scan selected institutions instead of the whole list and approve/reject pending suggestions before re-running the same group. The automation already skips fields with pending suggestions.

## Data model

- `workbook_field_values`: editable field overrides by row id and column key.
- `workbook_custom_rows`: user-added rows.
- `update_suggestions`: pending, approved, or rejected update recommendations.
- `source_checks`: low-cost source tracking for future scheduled web/PDF checks.
- `muni_issuer_profiles`: legal issuer identity, aliases, CUSIP-6 values, related entities, and scope rules.
- `muni_deal_facts`: normalized L1/L2/L3 deal facts used by the deal-team workflow before web search.
- `muni_source_documents`: source-document traceability and extracted field payloads.

The fixed row ids are generated from `lib/data.ts`, so static lists can remain versioned in code while changing fields stay in the database.
