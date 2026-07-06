#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const minimumDealYear = 2023;
const debtWatchUrl = "https://debtwatch.treasurer.ca.gov/";

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.input) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

const moduleKey = args.module ?? "k12-targets";
const outputPath = args.out ?? path.join(repoRoot, "tmp", "muni-deal-import.sql");
const aliasFilePath = args.aliasFile;
const inputPath = path.resolve(args.input);
const targetMap = buildTargetMap(moduleKey);
const extraAliases = aliasFilePath ? readAliasFile(path.resolve(aliasFilePath)) : {};
const csvRows = parseCsv(fs.readFileSync(inputPath, "utf8"));
const matchedDeals = [];
const unmatchedTargets = new Set(targetMap.map((target) => target.title));

for (const target of targetMap) {
  const aliases = targetAliases(target, extraAliases[target.title]);
  const rows = csvRows
    .map((row) => normalizeDebtRow(row))
    .filter((row) => row.saleDate && Number(row.saleDate.slice(0, 4)) >= minimumDealYear)
    .filter((row) => debtRowMatchesTarget(row, aliases));

  if (!rows.length) {
    continue;
  }

  unmatchedTargets.delete(target.title);

  for (const row of rows) {
    matchedDeals.push({
      ...row,
      module: moduleKey,
      recordId: target.recordId,
      targetTitle: target.title
    });
  }
}

const sql = buildImportSql(moduleKey, targetMap, matchedDeals, unmatchedTargets);

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, sql);

console.log(`Prepared ${matchedDeals.length} muni deal row(s).`);
console.log(`Wrote ${outputPath}`);

if (unmatchedTargets.size) {
  console.log(`Unmatched targets: ${unmatchedTargets.size}`);
  console.log(Array.from(unmatchedTargets).slice(0, 25).join(", "));
  if (unmatchedTargets.size > 25) {
    console.log("...");
  }
}

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

    if (!parsed.input) {
      parsed.input = value;
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage:
  node scripts/prepare-muni-deal-import.mjs <debtwatch.csv> [--module k12-targets] [--out tmp/muni-deal-import.sql] [--alias-file aliases.json]

Examples:
  node scripts/prepare-muni-deal-import.mjs ~/Downloads/debtwatch.csv
  node scripts/prepare-muni-deal-import.mjs ~/Downloads/debtwatch.csv --module ccd-targets --alias-file scripts/muni-aliases.example.json

Output:
  A SQL file that can be pasted into the Supabase SQL Editor.
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
    Peralta: ["Peralta Community College District"],
    "San Jose-Evergreen": ["San Jose Evergreen Community College District", "San Jose-Evergreen Community College District"]
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

function debtRowMatchesTarget(row, aliases) {
  const haystack = normalizeIdentity(
    [row.issuer, row.relatedEntity, row.dealName, row.rawIssuer, row.rawProject].filter(Boolean).join(" ")
  );

  return aliases.some((alias) => haystack.includes(alias));
}

function normalizeDebtRow(row) {
  const issuer = getColumn(row, [
    "issuer",
    "issuer name",
    "agency",
    "agency name",
    "public agency",
    "reporting agency",
    "lead agency"
  ]);
  const dealName = getColumn(row, [
    "deal name",
    "issue name",
    "issue",
    "debt issue",
    "project",
    "project name",
    "financing name",
    "debt name"
  ]);
  const saleDate = parseDate(getColumn(row, ["sale date", "date of sale", "sale_date", "sold date"]));
  const parAmount = parseAmount(getColumn(row, [
    "principal amount",
    "principal",
    "par amount",
    "amount",
    "issue amount",
    "debt amount"
  ]));

  return {
    bc: getColumn(row, ["bond counsel", "bc"]),
    dealName,
    dealStateId: getColumn(row, ["cdiac number", "cdiac no", "cdiac no.", "issue id", "report number", "debt id"]),
    dealType: getColumn(row, ["debt type", "financing type", "issue type", "type"]),
    issuer,
    ma: getColumn(row, [
      "municipal advisor",
      "municipal adviser",
      "financial advisor",
      "financial adviser",
      "advisor",
      "fa",
      "ma"
    ]),
    parAmount,
    rawIssuer: issuer,
    rawProject: dealName,
    refundingType: getColumn(row, ["refunding", "refunding type", "new money/refunding", "purpose"]),
    relatedEntity: getColumn(row, ["conduit issuer", "obligor", "borrower", "related entity", "financing authority"]),
    saleDate,
    sourceExcerpt: "",
    uw: getColumn(row, ["underwriter", "underwriters", "senior manager", "purchaser", "placement agent", "dealer"])
  };
}

function getColumn(row, aliases) {
  for (const alias of aliases) {
    const value = row[normalizeHeader(alias)];

    if (value !== undefined && String(value).trim()) {
      return String(value).trim();
    }
  }

  return "";
}

function parseCsv(text) {
  const rows = [];
  const records = [];
  let field = "";
  let row = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const nextCharacter = text[index + 1];

    if (character === '"' && inQuotes && nextCharacter === '"') {
      field += '"';
      index += 1;
      continue;
    }

    if (character === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (character === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((character === "\n" || character === "\r") && !inQuotes) {
      if (character === "\r" && nextCharacter === "\n") {
        index += 1;
      }

      row.push(field);
      field = "";

      if (row.some((value) => value.trim())) {
        records.push(row);
      }

      row = [];
      continue;
    }

    field += character;
  }

  row.push(field);

  if (row.some((value) => value.trim())) {
    records.push(row);
  }

  const headers = (records.shift() ?? []).map(normalizeHeader);

  for (const record of records) {
    rows.push(
      Object.fromEntries(headers.map((header, index) => [header, (record[index] ?? "").trim()]))
    );
  }

  return rows;
}

function normalizeHeader(value) {
  return String(value)
    .replace(/^\uFEFF/, "")
    .replace(/[_/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseDate(value) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);

  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
  }

  const usMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);

  if (usMatch) {
    const year = usMatch[3].length === 2 ? `20${usMatch[3]}` : usMatch[3];
    return `${year}-${usMatch[1].padStart(2, "0")}-${usMatch[2].padStart(2, "0")}`;
  }

  return trimmed;
}

function parseAmount(value) {
  const trimmed = value.replace(/[$,]/g, "").trim();

  if (!trimmed) {
    return null;
  }

  const numeric = Number(trimmed);

  return Number.isFinite(numeric) ? numeric : null;
}

function buildImportSql(moduleKey, targets, deals, unmatchedTargets) {
  const profileRows = targets.map((target) => {
    const issuerId = stableIssuerId(moduleKey, target.recordId);
    const aliases = targetAliases(target);

    return `(${sqlString(moduleKey)}, ${sqlString(target.recordId)}, ${sqlString(issuerId)}, ${sqlString(
      target.title
    )}, ${sqlArray(aliases)}, ${sqlString("issuer_plus_related_entities")})`;
  });
  const dealRows = deals.map((deal) => {
    const issuerId = stableIssuerId(moduleKey, deal.recordId);
    const dealStateId = deal.dealStateId || fallbackDealId(deal);
    const sourceExcerpt = [
      `Reported issuer: ${deal.issuer || deal.targetTitle}`,
      deal.saleDate ? `Sale date: ${deal.saleDate}` : "",
      deal.parAmount ? `Par: ${deal.parAmount}` : "",
      deal.ma ? `Municipal Advisor: ${deal.ma}` : "",
      deal.uw ? `Underwriter: ${deal.uw}` : "",
      deal.bc ? `Bond Counsel: ${deal.bc}` : ""
    ]
      .filter(Boolean)
      .join("; ");

    return `(${[
      sqlString(moduleKey),
      sqlString(deal.recordId),
      `(select id from muni_issuer_profiles where issuer_id = ${sqlString(issuerId)} limit 1)`,
      sqlString(issuerId),
      sqlString(deal.issuer || deal.targetTitle),
      sqlString(deal.relatedEntity),
      "true",
      sqlString(deal.dealName || "Unnamed debt issue"),
      sqlDate(deal.saleDate),
      sqlNumber(deal.parAmount),
      sqlString(dealStateId),
      sqlString(deal.dealType),
      sqlString(deal.refundingType),
      sqlString(deal.ma),
      sqlString(deal.ma),
      sqlString(deal.uw),
      sqlJson(deal.uw ? [{ name: deal.uw }] : []),
      sqlString(deal.bc),
      sqlString(deal.bc),
      sqlString(debtWatchUrl),
      sqlString("CDIAC DebtWatch export"),
      sqlString(sourceExcerpt),
      sqlString("L1"),
      sqlString("high"),
      sqlJson(deal)
    ].join(", ")})`;
  });

  return `-- Generated by scripts/prepare-muni-deal-import.mjs
-- Source module: ${moduleKey}
-- Matched deal rows: ${deals.length}
-- Unmatched targets: ${unmatchedTargets.size}

begin;

insert into muni_issuer_profiles (
  module, record_id, issuer_id, issuer_name_legal, issuer_name_aliases, scope_rule
)
values
${profileRows.join(",\n")}
on conflict (issuer_id) do update set
  issuer_name_legal = excluded.issuer_name_legal,
  issuer_name_aliases = excluded.issuer_name_aliases,
  scope_rule = excluded.scope_rule,
  updated_at = now();

${dealRows.length ? `insert into muni_deal_facts (
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
  source_url_primary,
  source_title_primary,
  source_excerpt,
  source_layer,
  confidence,
  raw_payload
)
values
${dealRows.join(",\n")}
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
  source_url_primary = excluded.source_url_primary,
  source_title_primary = excluded.source_title_primary,
  source_excerpt = excluded.source_excerpt,
  source_layer = excluded.source_layer,
  confidence = excluded.confidence,
  raw_payload = excluded.raw_payload,
  verified_date = current_date,
  updated_at = now();
` : "-- No matching deal rows were found for this CSV.\n"}
commit;
`;
}

function stableIssuerId(moduleKey, recordId) {
  return `${moduleKey}:${recordId}`;
}

function fallbackDealId(deal) {
  const hash = crypto
    .createHash("sha1")
    .update([deal.module, deal.recordId, deal.saleDate, deal.dealName, deal.parAmount].join("|"))
    .digest("hex")
    .slice(0, 12);

  return `import-${hash}`;
}

function sqlString(value) {
  if (value === null || value === undefined || value === "") {
    return "null";
  }

  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlDate(value) {
  return value ? `${sqlString(value)}::date` : "null";
}

function sqlNumber(value) {
  return Number.isFinite(value) ? String(value) : "null";
}

function sqlArray(values) {
  return `array[${values.map(sqlString).join(", ")}]::text[]`;
}

function sqlJson(value) {
  return `${sqlString(JSON.stringify(value))}::jsonb`;
}

function normalizeIdentity(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9'\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
