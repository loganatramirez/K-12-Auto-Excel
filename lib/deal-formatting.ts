import type { FieldValue, ModuleKey } from "./data";

export type DealTeamFieldKey = "MA" | "UW" | "Underwriter" | "BC";

type DealTeamRole = "MA" | "UW" | "BC";

type NameMapping = {
  role: DealTeamRole;
  original: string;
  shortName: string;
};

const revisedNameMappings: NameMapping[] = [
  { role: "MA", original: "Fieldman Rolapp & Associates Inc", shortName: "Fieldman" },
  { role: "MA", original: "Keygent LLC", shortName: "Keygent" },
  { role: "MA", original: "Isom Advisors, A Division of Urban Futures, Inc", shortName: "Isom" },
  { role: "MA", original: "CFW Advisory Services, LLC", shortName: "CFW" },
  { role: "MA", original: "Dale Scott & Company Inc", shortName: "DSC" },
  { role: "MA", original: "KNN Public Finance", shortName: "KNN" },
  { role: "MA", original: "Piper Sandler & Co", shortName: "Piper" },
  { role: "MA", original: "Government Financial Services Joint Powers Authority", shortName: "GFS" },
  { role: "MA", original: "Fieldman, Rolapp & Associates, Inc.", shortName: "Fieldman" },
  { role: "MA", original: "California Financial Services", shortName: "CFS" },
  { role: "MA", original: "Montague DeRose & Associates LLC", shortName: "Montague" },
  { role: "MA", original: "NHA Advisors LLC", shortName: "NHA" },
  { role: "MA", original: "KeyAnalytics (California Financial Services)", shortName: "CFS" },
  { role: "MA", original: "Columbia Capital Management", shortName: "Columbia" },
  { role: "UW", original: "Piper Sandler & Co", shortName: "Piper" },
  { role: "UW", original: "Stifel Nicolaus & Company Inc", shortName: "Stifel" },
  { role: "UW", original: "BofA Securities", shortName: "BofA" },
  { role: "UW", original: "D.A. Davidson & Co.", shortName: "D.A. D." },
  { role: "UW", original: "Robert W Baird & Co", shortName: "Baird" },
  { role: "UW", original: "TD Securities (USA) LLC", shortName: "TD" },
  { role: "UW", original: "Morgan Stanley & Co LLC", shortName: "MS" },
  { role: "UW", original: "J.P. Morgan Securities Inc.", shortName: "JPM" },
  { role: "UW", original: "Janney Montgomery Scott LLC", shortName: "JMS" },
  { role: "UW", original: "(none)", shortName: "-" },
  { role: "UW", original: "Raymond James & Associates Inc", shortName: "RJ" },
  { role: "UW", original: "JP Morgan Chase Bank", shortName: "JPM" },
  { role: "UW", original: "RBC Capital Markets LLC", shortName: "RBC" },
  { role: "UW", original: "RBC Capital Markets", shortName: "RBC" },
  { role: "UW", original: "Raymond James & Associates, Inc.", shortName: "RJ" },
  { role: "UW", original: "Mesirow Financial Inc", shortName: "Mesirow" },
  { role: "UW", original: "Loop Capital Markets LLC", shortName: "Loop" },
  { role: "UW", original: "Jefferies LLC", shortName: "Jefferies" },
  { role: "UW", original: "JP Morgan Securities LLC", shortName: "JPM" },
  { role: "BC", original: "Best Best & Krieger LLP", shortName: "BBK" },
  { role: "BC", original: "Stradling Yocca Carlson & Rauth", shortName: "Stradling" },
  { role: "BC", original: "Jones Hall LLP", shortName: "JH" },
  { role: "BC", original: "Dannis Woliver Kelley", shortName: "DWK" },
  { role: "BC", original: "Orrick, Herrington & Sutcliffe LLP", shortName: "Orrick" },
  { role: "BC", original: "Atkinson Andelson Loya Ruud & Romo", shortName: "Atkinson" },
  { role: "BC", original: "Norton Rose Fulbright US LLP", shortName: "Norton" },
  { role: "BC", original: "Hawkins Delafield & Wood LLP", shortName: "Hawkins" },
  { role: "BC", original: "Parker & Covert LLP", shortName: "Parker & C." },
  { role: "BC", original: "(none)", shortName: "-" },
  { role: "BC", original: "Nixon Peabody LLP", shortName: "Nixon" },
  { role: "BC", original: "Lozano Smith LLP", shortName: "Lozano" }
];

export const revisedDealTeamNames = {
  MA: revisedNameMappings.filter((mapping) => mapping.role === "MA"),
  UW: revisedNameMappings.filter((mapping) => mapping.role === "UW"),
  BC: revisedNameMappings.filter((mapping) => mapping.role === "BC")
} satisfies Record<DealTeamRole, NameMapping[]>;

const shortNamesByRole = new Map<DealTeamRole, Set<string>>();
const exactMappingsByRole = new Map<DealTeamRole, Map<string, string>>();
const canonicalMappingsByRole = new Map<DealTeamRole, Array<{ canonical: string; shortName: string }>>();

for (const role of ["MA", "UW", "BC"] as const) {
  shortNamesByRole.set(
    role,
    new Set(
      revisedNameMappings
        .filter((mapping) => mapping.role === role)
        .flatMap((mapping) => [mapping.shortName, mapping.original])
        .map(normalizeExactName)
    )
  );
  exactMappingsByRole.set(role, new Map());
  canonicalMappingsByRole.set(role, []);
}

for (const mapping of revisedNameMappings) {
  const exactMap = exactMappingsByRole.get(mapping.role);
  const canonicalMap = canonicalMappingsByRole.get(mapping.role);

  exactMap?.set(normalizeExactName(mapping.original), mapping.shortName);
  exactMap?.set(normalizeExactName(mapping.shortName), mapping.shortName);

  const canonical = normalizeOrganizationName(mapping.original);
  if (canonical) {
    canonicalMap?.push({ canonical, shortName: mapping.shortName });
  }
}

for (const role of ["MA", "UW", "BC"] as const) {
  canonicalMappingsByRole.get(role)?.sort((left, right) => right.canonical.length - left.canonical.length);
}

export function formatWorkbookFieldValue(moduleKey: ModuleKey, fieldKey: string, value: FieldValue | null | undefined) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);

  if (isDealTeamField(fieldKey)) {
    return formatDealTeamValue(fieldKey, text);
  }

  if ((moduleKey === "k12-targets" || moduleKey === "ccd-targets") && fieldKey === "Last Deal") {
    return formatLastDealValue(text);
  }

  return text;
}

export function formatDealTeamValue(fieldKey: string, value: string | null | undefined) {
  const role = dealTeamRoleForField(fieldKey);

  if (!role) {
    return String(value ?? "");
  }

  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  const pieces = splitFirmList(text);

  if (pieces.length > 1) {
    return pieces.map((piece) => abbreviateFirm(role, piece)).join(" / ");
  }

  return abbreviateFirm(role, text);
}

export function formatLastDealValue(value: string | null | undefined) {
  const text = String(value ?? "").trim();

  if (!text) {
    return "";
  }

  const date = extractDealDate(text);
  const amount = extractDealAmount(text);
  const dealKind = inferDealKind(text);

  if (!date || !amount) {
    return text;
  }

  return [date, amount, dealKind].filter(Boolean).join(" / ");
}

export function formatLastDealParts(input: {
  dealName?: string | null;
  dealType?: string | null;
  parAmount?: number | string | null;
  refundingType?: string | null;
  saleDate?: string | null;
}) {
  const saleDate = formatSaleMonthYear(input.saleDate);
  const parAmount = formatParAmount(input.parAmount);
  const dealKind = inferDealKind([input.refundingType, input.dealType, input.dealName].filter(Boolean).join(" "));

  return [saleDate, parAmount, dealKind].filter(Boolean).join(" / ");
}

export function equivalentFormattedValue(moduleKey: ModuleKey, fieldKey: string, left: string, right: string) {
  const formattedLeft = formatWorkbookFieldValue(moduleKey, fieldKey, left);
  const formattedRight = formatWorkbookFieldValue(moduleKey, fieldKey, right);

  return normalizeComparableValue(formattedLeft) === normalizeComparableValue(formattedRight);
}

export function isDealTeamField(fieldKey: string): fieldKey is DealTeamFieldKey {
  return Boolean(dealTeamRoleForField(fieldKey));
}

function dealTeamRoleForField(fieldKey: string): DealTeamRole | null {
  if (fieldKey === "MA") {
    return "MA";
  }

  if (fieldKey === "UW" || fieldKey === "Underwriter") {
    return "UW";
  }

  if (fieldKey === "BC") {
    return "BC";
  }

  return null;
}

function abbreviateFirm(role: DealTeamRole, value: string) {
  const text = value.trim();

  if (!text) {
    return "";
  }

  const exact = normalizeExactName(text);
  const exactMatch = exactMappingsByRole.get(role)?.get(exact);

  if (exactMatch) {
    return exactMatch;
  }

  if (shortNamesByRole.get(role)?.has(exact)) {
    return text;
  }

  const canonical = normalizeOrganizationName(text);
  const canonicalMatches = canonicalMappingsByRole.get(role) ?? [];
  const containedMatch = canonicalMatches.find(
    (mapping) =>
      mapping.canonical.length >= 4 &&
      (canonical === mapping.canonical ||
        canonical.includes(mapping.canonical) ||
        mapping.canonical.includes(canonical))
  );

  return containedMatch?.shortName ?? text;
}

function splitFirmList(value: string) {
  return value
    .split(/\s*(?:;|\||\n|\s\/\s)\s*/g)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

function extractDealDate(value: string) {
  const monthYear = value.match(
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+20\d{2}\b/i
  )?.[0];

  if (monthYear) {
    return formatMonthName(monthYear);
  }

  const isoDate = value.match(/\b(20\d{2})-(\d{1,2})(?:-\d{1,2})?\b/);

  if (isoDate) {
    return formatSaleMonthYear(`${isoDate[1]}-${isoDate[2].padStart(2, "0")}`);
  }

  const slashDate = value.match(/\b(\d{1,2})\/(?:\d{1,2}\/)?(20\d{2})\b/);

  if (slashDate) {
    return formatSaleMonthYear(`${slashDate[2]}-${slashDate[1].padStart(2, "0")}`);
  }

  const yearOnly = value.match(/\b20\d{2}\b/)?.[0];
  return yearOnly ?? "";
}

function extractDealAmount(value: string) {
  const explicitDollar = value.match(/\$\s?\d[\d,]*(?:\.\d+)?\s?(?:million|mm|m)?/i)?.[0];

  if (explicitDollar) {
    return normalizeDollarAmount(explicitDollar);
  }

  const millionAmount = value.match(/\b\d[\d,]*(?:\.\d+)?\s?(?:million|mm|m)\b/i)?.[0];

  if (millionAmount) {
    return normalizeDollarAmount(millionAmount);
  }

  return "";
}

function normalizeDollarAmount(value: string) {
  const cleaned = value.trim();
  const numeric = cleaned
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\s*(?:million|mm|m)\s*$/i, "");
  const numberValue = Number(numeric);

  if (!Number.isFinite(numberValue)) {
    return cleaned.startsWith("$") ? cleaned : `$${cleaned}`;
  }

  const millions = /(?:million|mm|m)\s*$/i.test(cleaned) ? numberValue : numberValue / 1_000_000;
  const rounded = Math.round(millions * 1000) / 1000;
  const formatted = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, "").replace(/\.$/, "");

  return `$${formatted}M`;
}

function inferDealKind(value: string) {
  const normalized = normalizeComparableValue(value);

  if (/\bref(?:unding|unded)?\b/.test(normalized) || normalized.includes("refunding")) {
    return "Ref";
  }

  return "NM";
}

function formatSaleMonthYear(value: string | null | undefined) {
  if (!value) {
    return "";
  }

  const [year, month] = value.split("-");
  const monthIndex = Number(month) - 1;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  if (!year || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return value;
  }

  return `${monthNames[monthIndex]} ${year}`;
}

function formatParAmount(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  const numberValue = typeof value === "number" ? value : Number(String(value).replace(/[$,]/g, ""));

  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    return String(value);
  }

  const millions = numberValue / 1_000_000;
  const rounded = Math.round(millions * 1000) / 1000;
  const formatted = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, "").replace(/\.$/, "");

  return `$${formatted}M`;
}

function formatMonthName(value: string) {
  const [rawMonth, year] = value.replace(".", "").split(/\s+/);
  const month = rawMonth.slice(0, 3).toLowerCase();
  const monthNames: Record<string, string> = {
    apr: "Apr",
    aug: "Aug",
    dec: "Dec",
    feb: "Feb",
    jan: "Jan",
    jul: "Jul",
    jun: "Jun",
    mar: "Mar",
    may: "May",
    nov: "Nov",
    oct: "Oct",
    sep: "Sep"
  };

  return `${monthNames[month] ?? rawMonth} ${year}`;
}

function normalizeExactName(value: string) {
  return normalizeComparableValue(value).replace(/\s+/g, " ").trim();
}

function normalizeOrganizationName(value: string) {
  return normalizeComparableValue(value)
    .replace(
      /\b(?:a|an|the|advisors?|advisory|associates?|capital|co|company|corp|corporation|division|financial|finance|inc|incorporated|jpa|joint|llc|llp|lp|markets?|of|public|securities|services?|usa|us)\b/g,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeComparableValue(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9'\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
