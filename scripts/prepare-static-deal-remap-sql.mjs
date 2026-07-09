#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const minimumDealYear = 2023;
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const moduleKey = args.module ?? "k12-targets";
const sourceModuleKey = args.sourceModule ?? moduleKey;
const outputPath = args.out ?? path.join(repoRoot, "tmp", `${moduleKey}-static-deal-remap.sql`);
const aliasFilePath = args.aliasFile;
const targets = buildTargetMap(moduleKey);
const extraAliases = aliasFilePath ? readAliasFile(path.resolve(aliasFilePath)) : {};
const sql = buildRemapSql(moduleKey, sourceModuleKey, targets, extraAliases);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, sql);

console.log(
  `Prepared static deal remap SQL for ${targets.length} ${moduleKey} target(s) from ${sourceModuleKey} source rows.`
);
console.log(`Wrote ${outputPath}`);

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }

    if (value === "--module") {
      parsed.module = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--source-module") {
      parsed.sourceModule = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--out") {
      parsed.out = argv[index + 1];
      index += 1;
      continue;
    }

    if (value === "--alias-file") {
      parsed.aliasFile = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/prepare-static-deal-remap-sql.mjs [--module k12-targets] [--source-module k12-targets] [--out tmp/k12-targets-static-deal-remap.sql] [--alias-file aliases.json]

Purpose:
  Generates SQL that remaps existing generated CDIAC/DebtWatch muni_deal_facts rows
  such as k12-cdiac-* onto the workbook's static target record ids such as k12-03-01.
  Use --source-module when broad CDIAC rows were imported under one module but should
  be copied onto another workbook module, for example ccd-targets from k12-targets.

Workflow:
  1. Import broad CDIAC rows into Supabase.
  2. Run this script.
  3. Paste the generated SQL into Supabase SQL Editor.
  4. Clear pending Last Deal suggestions and rerun Last Deal.
`);
}

function buildTargetMap(moduleKey) {
  const dataPath = path.join(repoRoot, "lib", "data.ts");
  const source = fs.readFileSync(dataPath, "utf8");

  if (moduleKey === "k12-targets") {
    return extractGroupedTargets(source, "k12Groups", "districts", "k12");
  }

  if (moduleKey === "ccd-targets") {
    return extractGroupedTargets(source, "ccdGroups", "targets", "ccd");
  }

  throw new Error(`Unsupported module "${moduleKey}". Use k12-targets or ccd-targets.`);
}

function extractGroupedTargets(source, constName, listKey, recordPrefix) {
  const block = extractConstArray(source, constName);
  const groupRegex = new RegExp(`\\{\\s*name:\\s*"([^"]+)"[\\s\\S]*?${listKey}:\\s*\\[([\\s\\S]*?)\\]\\s*\\}`, "g");
  const targets = [];
  let groupMatch;
  let groupIndex = 0;

  while ((groupMatch = groupRegex.exec(block))) {
    const groupName = groupMatch[1];
    const values = Array.from(groupMatch[2].matchAll(/"([^"]+)"/g)).map((match) => match[1]);

    values.forEach((title, targetIndex) => {
      targets.push({
        groupName,
        recordId: `${recordPrefix}-${String(groupIndex + 1).padStart(2, "0")}-${String(targetIndex + 1).padStart(2, "0")}`,
        title
      });
    });

    groupIndex += 1;
  }

  return targets;
}

function extractConstArray(source, constName) {
  const start = source.indexOf(`const ${constName} = [`);

  if (start === -1) {
    throw new Error(`Could not find ${constName} in lib/data.ts.`);
  }

  const arrayStart = source.indexOf("[", start);
  let depth = 0;

  for (let index = arrayStart; index < source.length; index += 1) {
    const character = source[index];

    if (character === "[") {
      depth += 1;
    }

    if (character === "]") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(arrayStart, index + 1);
      }
    }
  }

  throw new Error(`Could not parse ${constName} array.`);
}

function readAliasFile(filePath) {
  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

  return Object.fromEntries(
    Object.entries(data).map(([target, aliases]) => [
      target,
      Array.isArray(aliases) ? aliases.map(String) : []
    ])
  );
}

function targetAliases(target, extraAliases = []) {
  const baseAliases = new Set([target.title, ...extraAliases]);
  const title = target.title;

  const knownAliases = {
    "Riverside USD": [
      "Riverside Unified School District",
      "Riverside Unified School District Financing Authority",
      "RUSD Financing Authority"
    ],
    "San Mateo-Foster City SD": [
      "San Mateo-Foster City School District",
      "San Mateo Foster City School District",
      "San Mateo-Foster City Elementary School District"
    ],
    "Berryessa Union SD": ["Berryessa Union School District"],
    "Long Beach CCD": ["Long Beach Community College District", "Long Beach City College", "LBCCD"],
    "Berkeley CCD": ["Peralta Community College District", "Berkeley City College"],
    "San Bernardino CCD": ["San Bernardino Community College District", "SBCCD"],
    "Santa Monica CCD": ["Santa Monica Community College District", "Santa Monica College", "SMC"],
    "Southwestern CCD": ["Southwestern Community College District", "Southwestern College"],
    "Los Rios CCD": ["Los Rios Community College District", "LRCCD"],
    "Los Angeles CCD": ["Los Angeles Community College District", "LACCD"],
    "Desert CCD": ["Desert Community College District", "College of the Desert"],
    "West Hills CCD": ["West Hills Community College District", "WHCCD"],
    "San Diego CCD": ["San Diego Community College District", "SDCCD"],
    "San Joaquin Delta": ["San Joaquin Delta Community College District", "San Joaquin Delta College"],
    "Cerritos CCD": ["Cerritos Community College District", "Cerritos College"],
    "San Francisco CCD": ["City College of San Francisco", "San Francisco Community College District"],
    "Pasadena CCD": ["Pasadena Area Community College District", "Pasadena City College"],
    "San Mateo Cnty CCD": ["San Mateo County Community College District", "SMCCCD"],
    "State Center CCD": ["State Center Community College District", "SCCCD"],
    "Riverside CCD": ["Riverside Community College District", "RCCD"],
    "Foothill De Anza CCD": ["Foothill-De Anza Community College District", "FHDA"],
    Peralta: ["Peralta Community College District"],
    "West Valley Mission": ["West Valley-Mission Community College District", "WVMCCD"],
    "Mt. Sac CCD": ["Mt. San Antonio Community College District", "Mt. SAC"],
    "Glendale CCD": ["Glendale Community College District", "Glendale Community College"],
    "Rio Hondo CCD": ["Rio Hondo Community College District", "Rio Hondo College"],
    "Gavilan JCCD": ["Gavilan Joint Community College District", "Gavilan College"],
    "Contra Costa CCD": ["Contra Costa Community College District", "4CD"],
    "San Jose-Evergreen": [
      "San Jose Evergreen Community College District",
      "San José-Evergreen Community College District",
      "San Jose-Evergreen Community College District",
      "SJECCD"
    ]
  };

  (knownAliases[title] ?? []).forEach((alias) => baseAliases.add(alias));

  [
    [/\s+USD$/i, " Unified School District"],
    [/\s+SD$/i, " School District"],
    [/\s+ESD$/i, " Elementary School District"],
    [/\s+HSD$/i, " High School District"],
    [/\s+UHSD$/i, " Union High School District"],
    [/\s+JUHSD$/i, " Joint Union High School District"],
    [/\s+JUSHD$/i, " Joint Union High School District"],
    [/\s+JUSD$/i, " Joint Unified School District"],
    [/\s+CSD$/i, " City School District"],
    [/\s+CCD$/i, " Community College District"],
    [/\s+JCCD$/i, " Joint Community College District"]
  ].forEach(([pattern, replacement]) => {
    if (pattern.test(title)) {
      baseAliases.add(title.replace(pattern, replacement));
    }
  });

  return Array.from(baseAliases)
    .map((alias) => normalizeIdentity(alias))
    .filter((alias) => alias.length >= 5);
}

function buildRemapSql(moduleKey, sourceModuleKey, targets, extraAliases) {
  const targetRows = targets.map((target) => {
    const aliases = targetAliases(target, extraAliases[target.title]);

    return `(${[
      sqlString(moduleKey),
      sqlString(target.recordId),
      sqlString(stableIssuerId(moduleKey, target.recordId)),
      sqlString(target.title),
      sqlArray(aliases)
    ].join(", ")})`;
  });

  return `-- Generated by scripts/prepare-static-deal-remap-sql.mjs
-- Source module: ${sourceModuleKey}
-- Target module: ${moduleKey}
-- Target count: ${targets.length}
-- Purpose: copy generated CDIAC/DebtWatch facts onto static workbook record ids.

create or replace function pg_temp.k12_import_norm(value text)
returns text
language sql
immutable
as $$
  select trim(
    regexp_replace(
      translate(
        lower(coalesce(value, '')),
        'áàäâãåéèëêíìïîóòöôõúùüûñç’‘\`&',
        'aaaaaaeeeeiiiiooooouuuunc    '
      ),
      '[^a-z0-9]+',
      ' ',
      'g'
    )
  );
$$;

drop table if exists _target_static_map;

create temporary table _target_static_map (
  module text not null,
  record_id text not null,
  issuer_id text not null,
  issuer_name_legal text not null,
  aliases text[] not null
);

insert into _target_static_map (module, record_id, issuer_id, issuer_name_legal, aliases)
values
${targetRows.join(",\n")};

insert into muni_issuer_profiles (
  module,
  record_id,
  issuer_id,
  issuer_name_legal,
  issuer_name_display,
  issuer_name_aliases,
  scope_rule,
  state
)
select
  module,
  record_id,
  issuer_id,
  issuer_name_legal,
  issuer_name_legal,
  aliases,
  'issuer_plus_related_entities',
  'CA'
from _target_static_map
on conflict (issuer_id) do update set
  record_id = excluded.record_id,
  issuer_name_legal = excluded.issuer_name_legal,
  issuer_name_display = excluded.issuer_name_display,
  issuer_name_aliases = excluded.issuer_name_aliases,
  scope_rule = excluded.scope_rule,
  state = excluded.state,
  updated_at = now();

drop table if exists _static_deal_matches;

create temporary table _static_deal_matches as
select
  source_facts.id as source_fact_id,
  target_map.record_id as target_record_id,
  target_map.issuer_id as target_issuer_id,
  target_map.issuer_name_legal as target_issuer_name_legal,
  source_facts.*
from muni_deal_facts source_facts
join _target_static_map target_map
  on exists (
    select 1
    from unnest(target_map.aliases) as alias(value)
    where pg_temp.k12_import_norm(
      concat_ws(
        ' ',
        source_facts.issuer_name_reported,
        source_facts.related_entity_name,
        source_facts.deal_name,
        source_facts.source_excerpt,
        source_facts.record_id,
        source_facts.issuer_id
      )
    ) like '%' || alias.value || '%'
  )
where source_facts.module = ${sqlString(sourceModuleKey)}
  and source_facts.scope_included = true
  and source_facts.deal_sale_date >= date '${minimumDealYear}-01-01'
  and source_facts.record_id !~ '^(k12|ccd)-[0-9]{2}-[0-9]{2}$'
  and nullif(trim(source_facts.deal_state_id), '') is not null;

insert into muni_deal_facts (
  module,
  record_id,
  issuer_profile_id,
  issuer_id,
  issuer_name_reported,
  related_entity_name,
  scope_included,
  deal_name,
  deal_sale_date,
  deal_par_amount,
  deal_state_id,
  deal_type,
  refunding_type,
  ma,
  municipal_advisor,
  uw,
  underwriters,
  bc,
  bond_counsel,
  auth_type,
  auth_detail,
  source_url_primary,
  source_title_primary,
  source_excerpt,
  source_layer,
  verified_date,
  confidence,
  raw_payload
)
select
  ${sqlString(moduleKey)},
  matches.target_record_id,
  profiles.id,
  matches.target_issuer_id,
  matches.issuer_name_reported,
  matches.related_entity_name,
  matches.scope_included,
  matches.deal_name,
  matches.deal_sale_date,
  matches.deal_par_amount,
  matches.deal_state_id,
  matches.deal_type,
  matches.refunding_type,
  matches.ma,
  matches.municipal_advisor,
  matches.uw,
  matches.underwriters,
  matches.bc,
  matches.bond_counsel,
  matches.auth_type,
  matches.auth_detail,
  matches.source_url_primary,
  matches.source_title_primary,
  matches.source_excerpt,
  matches.source_layer,
  current_date,
  matches.confidence,
  coalesce(matches.raw_payload, '{}'::jsonb) || jsonb_build_object(
    'static_remap_source_record_id', matches.record_id,
    'static_remap_target_record_id', matches.target_record_id,
    'static_remap_target_issuer_name', matches.target_issuer_name_legal
  )
from _static_deal_matches matches
join muni_issuer_profiles profiles
  on profiles.issuer_id = matches.target_issuer_id
on conflict (module, record_id, deal_state_id) do update set
  issuer_profile_id = excluded.issuer_profile_id,
  issuer_id = excluded.issuer_id,
  issuer_name_reported = excluded.issuer_name_reported,
  related_entity_name = excluded.related_entity_name,
  scope_included = excluded.scope_included,
  deal_name = excluded.deal_name,
  deal_sale_date = excluded.deal_sale_date,
  deal_par_amount = excluded.deal_par_amount,
  deal_type = excluded.deal_type,
  refunding_type = excluded.refunding_type,
  ma = excluded.ma,
  municipal_advisor = excluded.municipal_advisor,
  uw = excluded.uw,
  underwriters = excluded.underwriters,
  bc = excluded.bc,
  bond_counsel = excluded.bond_counsel,
  auth_type = excluded.auth_type,
  auth_detail = excluded.auth_detail,
  source_url_primary = excluded.source_url_primary,
  source_title_primary = excluded.source_title_primary,
  source_excerpt = excluded.source_excerpt,
  source_layer = excluded.source_layer,
  confidence = excluded.confidence,
  raw_payload = excluded.raw_payload,
  verified_date = current_date,
  updated_at = now();

select
  'static remap summary' as check_name,
  count(*) as matched_generated_rows,
  count(distinct target_record_id) as matched_static_issuers,
  count(distinct deal_state_id) as matched_deals
from _static_deal_matches
union all
select
  'static facts now',
  count(*),
  count(distinct record_id),
  count(distinct deal_state_id)
from muni_deal_facts
where module = ${sqlString(moduleKey)}
  and record_id ~ ${sqlString(`^${staticRecordPrefix(moduleKey)}-[0-9]{2}-[0-9]{2}$`)};
`;
}

function staticRecordPrefix(moduleKey) {
  if (moduleKey === "ccd-targets") {
    return "ccd";
  }

  return "k12";
}

function stableIssuerId(moduleKey, recordId) {
  return `${moduleKey}:${recordId}`;
}

function sqlString(value) {
  if (value === null || value === undefined || value === "") {
    return "null";
  }

  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlArray(values) {
  return `array[${values.map(sqlString).join(", ")}]::text[]`;
}

function normalizeIdentity(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
