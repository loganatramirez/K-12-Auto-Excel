import { k12LeadershipOverrides } from "./k12-leadership-overrides";

export type ModuleKey = "k12-targets" | "ccd-targets" | "plans";

export type FieldValue = string | number;

export type ColumnDef = {
  key: string;
  label: string;
  width?: number;
  fullName?: string;
  isSystem?: boolean;
};

export type WorkspaceRecord = {
  id: string;
  module: ModuleKey;
  title: string;
  subtitle: string;
  updatedAt: string;
  kind?: "section" | "record";
  tone?: "dark";
  fields: Record<string, FieldValue>;
  isSystem?: boolean;
};

export const modules = [
  {
    key: "k12-targets",
    title: "K-12 Targets",
    href: "/k12-targets",
    kicker: "District pipeline"
  },
  {
    key: "ccd-targets",
    title: "CCD Targets",
    href: "/ccd-targets",
    kicker: "CCD tracker"
  },
  {
    key: "plans",
    title: "FY25&26",
    href: "/plans",
    kicker: "Revenue plan"
  }
] satisfies Array<{ key: ModuleKey; title: string; href: string; kicker: string }>;

export const moduleColumns: Record<ModuleKey, ColumnDef[]> = {
  "k12-targets": [
    { key: "District", label: "District", width: 300, isSystem: true },
    { key: "Area", label: "Area", width: 220, isSystem: true },
    { key: "MA", label: "MA", width: 190, fullName: "Municipal Advisor" },
    { key: "UW", label: "UW", width: 180, fullName: "Underwriter" },
    { key: "BC", label: "BC", width: 150, fullName: "Bond Counsel" },
    { key: "Auth", label: "Auth", width: 120, fullName: "Authorization" },
    { key: "Last Deal", label: "Last Deal", width: 130 },
    { key: "Notes", label: "Notes", width: 280 },
    { key: "Sup", label: "Sup", width: 190, fullName: "Superintendent" },
    { key: "CBO", label: "CBO", width: 210, fullName: "Chief Business Officer" },
    { key: "Board 1", label: "Board 1", width: 150 },
    { key: "Board 2", label: "Board 2", width: 150 },
    { key: "Board 3", label: "Board 3", width: 150 },
    { key: "Board 4", label: "Board 4", width: 150 },
    { key: "Board 5", label: "Board 5", width: 150 },
    { key: "Board 6", label: "Board 6", width: 150 },
    { key: "Board 7", label: "Board 7", width: 150 }
  ],
  "ccd-targets": [
    {
      key: "CCD Targets",
      label: "CCD Targets",
      width: 240,
      fullName: "Community College District Targets",
      isSystem: true
    },
    { key: "Authorizations", label: "Authorizations", width: 150 },
    { key: "Refundings", label: "Refundings", width: 150 },
    { key: "Last Deal", label: "Last Deal", width: 150 },
    { key: "Chancellor", label: "Chancellor", width: 170 },
    { key: "CFO", label: "CFO", width: 210, fullName: "Chief Financial Officer" },
    { key: "Underwriter", label: "Underwriter", width: 170 },
    { key: "MA", label: "MA", width: 190, fullName: "Municipal Advisor" },
    { key: "BC", label: "BC", width: 170, fullName: "Bond Counsel" },
    { key: "Notes", label: "Notes", width: 300 }
  ],
  plans: [
    { key: "Issuer", label: "Issuer", width: 230, isSystem: true },
    { key: "MA", label: "MA", width: 190, fullName: "Municipal Advisor" },
    { key: "Deal", label: "Deal", width: 210 },
    { key: "Role sale", label: "Role", width: 140, fullName: "Role / Sale" },
    { key: "Date", label: "Sale Date", width: 120 },
    { key: "Par ($M)", label: "Par ($M)", width: 190, fullName: "Par Amount in Millions" },
    { key: "Fee", label: "Fee", width: 110 },
    { key: "Liab.", label: "Liab.", width: 110, fullName: "Liability" },
    { key: "EST Rev", label: "Est Rev", width: 175, fullName: "Estimated Revenue" },
    { key: "Prob.", label: "Prob.", width: 100, fullName: "Probability" },
    { key: "ADJ Rev", label: "Adj. Rev", width: 175, fullName: "Adjusted Revenue" },
    { key: "Lead", label: "Lead", width: 130 },
    { key: "SRSupp.", label: "Sr. Supp.", width: 130, fullName: "Senior Support" },
    { key: "Supp.", label: "Supp.", width: 130, fullName: "Support" }
  ]
};

export const moduleFilterFields: Record<ModuleKey, string[]> = {
  "k12-targets": ["Area", "MA", "UW"],
  "ccd-targets": ["Authorizations", "Last Deal", "Underwriter", "MA"],
  plans: ["Role sale", "Lead", "MA"]
};

const updatedAt = "2026-06-30";

const k12Groups = [
  {
    name: "CALSA Board Members",
    districts: [
      "Riverside USD",
      "San Mateo-Foster City SD",
      "Berryessa Union SD",
      "Woodland USD",
      "Cutler-Orosi JUSD",
      "Salinas City ESD",
      "Salinas UHSD",
      "Adelanto ESD"
    ]
  },
  {
    name: "CLSBA Board Members",
    districts: [
      "Oak Grove SD",
      "Woodland JUSD",
      "San José USD",
      "Hacienda La Puente USD",
      "Monterey Peninsula USD",
      "Tustin USD",
      "Sunnyvale SD",
      "Morgan Hill USD",
      "Berkeley USD",
      "ABC Unified"
    ]
  },
  {
    name: "Los Angeles County",
    districts: [
      "Long Beach USD",
      "Pasadena USD",
      "Burbank USD",
      "Compton USD",
      "Pomona USD",
      "Antelope Valley JUSHD",
      "Santa Monica-Malibu USD",
      "Downey USD",
      "Arcadia USD",
      "PV Peninsula USD",
      "Redondo Beach USD",
      "Culver City USD",
      "Manhattan Beach USD",
      "San Marino USD",
      "Paramount USD",
      "Saugus Union SD",
      "San Gabriel USD",
      "Fullerton JUHSD",
      "El Monte City SD",
      "Lancaster Elementary SD",
      "Norwalk La Mirada USD",
      "Lynwood USD",
      "East Whittier CSD",
      "Los Nietos SD",
      "Alhambra USD"
    ]
  },
  {
    name: "Orange County (K-12 District w/ +$100M Auth. Since 2020)",
    districts: [
      "Anaheim UHSD",
      "Santa Ana USD",
      "Fullerton JUHSD",
      "Tustin USD",
      "Fullerton SD",
      "Brea Olinda USD"
    ]
  },
  {
    name: "Riverside County (K-12 District w/ +$100M Auth. Since 2020)",
    districts: [
      "Desert Sands USD",
      "Jurupa USD",
      "Lake Elsinore USD",
      "Moreno Valley USD",
      "Palm Springs USD",
      "Val Verde USD",
      "Alvord USD",
      "Menifee Union SD"
    ]
  },
  {
    name: "San Bernadino County (K-12 District w/ +$100M Auth. Since 2020)",
    districts: [
      "Redlands USD",
      "Fontana USD",
      "Colton Joint USD",
      "Victor Valley Union HSD",
      "Rialto USD"
    ]
  },
  {
    name: "San Diego County (K-12 District w/ +$100M Auth. Since 2020)",
    districts: [
      "San Diego USD",
      "San Marcos USD",
      "Oceanside USD",
      "Chula Vista ESD",
      "Encinitas Union SD",
      "La Mesa–Spring Valley SD",
      "Sweetwater Union HSD"
    ]
  },
  {
    name: "City of Ontario Overlapping K-12 Districts",
    districts: ["Chaffey JUHSD", "Chino Valley USD", "Ontario-Montclair School District"]
  }
];

const k12AreaOverrides: Record<string, string> = {
  "CALSA Board Members": "Statewide / Association",
  "Riverside USD": "Riverside",
  "San Mateo-Foster City SD": "San Mateo",
  "Berryessa Union SD": "N. San Jose",
  "Woodland USD": "Sacramento / Yolo",
  "Cutler-Orosi JUSD": "Tulare County",
  "Salinas City ESD": "Salinas",
  "Salinas UHSD": "Salinas",
  "Adelanto ESD": "High Desert",
  "CLSBA Board Members": "Statewide / Association",
  "Oak Grove SD": "S. San Jose",
  "Woodland JUSD": "Sacramento / Yolo",
  "San José USD": "San Jose",
  "Hacienda La Puente USD": "San Gabriel Valley",
  "Monterey Peninsula USD": "Monterey",
  "Tustin USD": "Orange County",
  "Sunnyvale SD": "Sunnyvale",
  "Morgan Hill USD": "S. San Jose",
  "Berkeley USD": "East Bay",
  "ABC Unified": "Cerritos / LA Gateway",
  "Los Angeles County": "Los Angeles County",
  "Long Beach USD": "Long Beach",
  "Pasadena USD": "Pasadena / SGV",
  "Burbank USD": "Burbank / SFV",
  "Compton USD": "South LA",
  "Pomona USD": "Pomona / SGV",
  "Antelope Valley JUSHD": "Antelope Valley",
  "Santa Monica-Malibu USD": "West LA",
  "Downey USD": "Southeast LA",
  "Arcadia USD": "San Gabriel Valley",
  "PV Peninsula USD": "South Bay",
  "Redondo Beach USD": "South Bay",
  "Culver City USD": "West LA",
  "Manhattan Beach USD": "South Bay",
  "San Marino USD": "San Gabriel Valley",
  "Paramount USD": "Southeast LA",
  "Saugus Union SD": "Santa Clarita",
  "San Gabriel USD": "San Gabriel Valley",
  "Fullerton JUHSD": "North Orange County",
  "El Monte City SD": "San Gabriel Valley",
  "Lancaster Elementary SD": "Antelope Valley",
  "Norwalk La Mirada USD": "Southeast LA",
  "Lynwood USD": "South LA",
  "East Whittier CSD": "Southeast LA / Whittier",
  "Los Nietos SD": "Southeast LA / Whittier",
  "Alhambra USD": "San Gabriel Valley",
  "Orange County (K-12 District w/ +$100M Auth. Since 2020)": "Orange County",
  "Anaheim UHSD": "North Orange County",
  "Santa Ana USD": "Central Orange County",
  "Fullerton SD": "North Orange County",
  "Brea Olinda USD": "North Orange County",
  "Riverside County (K-12 District w/ +$100M Auth. Since 2020)": "Riverside County",
  "Desert Sands USD": "Coachella Valley",
  "Jurupa USD": "Riverside",
  "Lake Elsinore USD": "Southwest Riverside",
  "Moreno Valley USD": "Riverside",
  "Palm Springs USD": "Coachella Valley",
  "Val Verde USD": "Perris / Moreno Valley",
  "Alvord USD": "Riverside",
  "Menifee Union SD": "Southwest Riverside",
  "San Bernadino County (K-12 District w/ +$100M Auth. Since 2020)": "San Bernardino County",
  "Redlands USD": "San Bernardino / Redlands",
  "Fontana USD": "Inland Empire",
  "Colton Joint USD": "San Bernardino / Colton",
  "Victor Valley Union HSD": "High Desert",
  "Rialto USD": "San Bernardino / Rialto",
  "San Diego County (K-12 District w/ +$100M Auth. Since 2020)": "San Diego County",
  "San Diego USD": "San Diego",
  "San Marcos USD": "North San Diego County",
  "Oceanside USD": "North San Diego County",
  "Chula Vista ESD": "South San Diego County",
  "Encinitas Union SD": "North Coastal San Diego",
  "La Mesa–Spring Valley SD": "East San Diego County",
  "Sweetwater Union HSD": "South San Diego County",
  "City of Ontario Overlapping K-12 Districts": "Ontario / Inland Empire",
  "Chaffey JUHSD": "Ontario / Inland Empire",
  "Chino Valley USD": "Chino / Inland Empire",
  "Ontario-Montclair School District": "Ontario / Inland Empire"
};

const ccdGroups = [
  {
    name: "Current Clients - No Immediate Transaction - Quaterly Coverage",
    targets: [
      "San Bernardino CCD",
      "Santa Monica CCD",
      "Long Beach CCD",
      "Southwestern CCD",
      "Los Rios CCD",
      "San Jose-Evergreen"
    ]
  },
  {
    name: "Relationship with Deal Likely in Next 12-18 Months",
    targets: [
      "Los Angeles CCD",
      "Desert CCD",
      "West Hills CCD",
      "San Diego CCD",
      "San Joaquin Delta",
      "Cerritos CCD"
    ]
  },
  {
    name: "New Targets",
    targets: ["San Francisco CCD", "Pasadena CCD", "San Mateo Cnty CCD"]
  },
  {
    name: "Large Authorization No Relationship - Waiting for Movement",
    targets: [
      "State Center CCD",
      "Riverside CCD",
      "Foothill De Anza CCD",
      "Peralta",
      "West Valley Mission"
    ]
  },
  {
    name: "Relationship Not Hired - Waiting for Big Change/Movement",
    targets: [
      "Mt. Sac CCD",
      "Glendale CCD",
      "Rio Hondo CCD",
      "Gavilan JCCD",
      "Contra Costa CCD"
    ]
  }
];

const planSections: Array<{ name: string; tone?: "dark"; issuers: string[] }> = [
  {
    name: "FY25 Business Plan",
    tone: "dark",
    issuers: [] as string[]
  },
  {
    name: "FY25 CA FIRM MANDATES (OFFICIALLY HIRED)",
    issuers: [
      "Los Angeles CCD",
      "Ontario City",
      "Cerritos CCD",
      "Inglewood USD",
      "Ontario City",
      "Monterey Park",
      "Hawthorne",
      "Watsonville",
      "Southwestern CCD",
      "SB CCD",
      "San Joaquin Delta",
      "Evergreen SD",
      "Long Beach CCD"
    ]
  },
  {
    name: "FY26 Business Plan",
    tone: "dark",
    issuers: [] as string[]
  },
  {
    name: "Cities",
    issuers: [
      "Ontario City",
      "Ontario City",
      "Ontario City",
      "Ontario City",
      "Inglewood",
      "Inglewood",
      "Monterey Park",
      "Azusa",
      "Pomona",
      "Carson",
      "Carson",
      "El Centro City"
    ]
  },
  {
    name: "CCDs and USD",
    issuers: [
      "Palmdale SD",
      "Los Angeles CCD",
      "Cerritos CCD",
      "San Joaquin Delta",
      "West Hills CCD",
      "Desert CCD",
      "Lynwood USD",
      "Santa Monica CCD",
      "San Diego CCD",
      "Contra Costa CCD"
    ]
  }
];

function fieldsFor(moduleKey: ModuleKey, values: Record<string, FieldValue> = {}) {
  return Object.fromEntries(
    moduleColumns[moduleKey].map((column) => [column.key, values[column.key] ?? ""])
  );
}

function sectionRecord(groupName: string, groupIndex: number): WorkspaceRecord {
  return {
    id: `k12-section-${String(groupIndex + 1).padStart(2, "0")}`,
    module: "k12-targets",
    title: groupName,
    subtitle: "Section",
    updatedAt,
    kind: "section",
    isSystem: true,
    fields: fieldsFor("k12-targets", {
      District: groupName,
      Area: k12AreaOverrides[groupName] ?? ""
    })
  };
}

function districtRecord(groupName: string, district: string, groupIndex: number, districtIndex: number): WorkspaceRecord {
  const leadershipFields = k12LeadershipOverrides[`${groupName}::${district}`] ?? {};

  return {
    id: `k12-${String(groupIndex + 1).padStart(2, "0")}-${String(districtIndex + 1).padStart(2, "0")}`,
    module: "k12-targets",
    title: district,
    subtitle: groupName,
    updatedAt,
    kind: "record",
    isSystem: true,
    fields: fieldsFor("k12-targets", {
      District: district,
      Area: k12AreaOverrides[district] ?? "-",
      ...leadershipFields
    })
  };
}

const k12TargetRecords = k12Groups.flatMap((group, groupIndex) => [
  sectionRecord(group.name, groupIndex),
  ...group.districts.map((district, districtIndex) =>
    districtRecord(group.name, district, groupIndex, districtIndex)
  )
]);

function ccdSectionRecord(groupName: string, groupIndex: number): WorkspaceRecord {
  return {
    id: `ccd-section-${String(groupIndex + 1).padStart(2, "0")}`,
    module: "ccd-targets",
    title: groupName,
    subtitle: "Section",
    updatedAt,
    kind: "section",
    tone: "dark",
    isSystem: true,
    fields: fieldsFor("ccd-targets", {
      "CCD Targets": groupName
    })
  };
}

function ccdTargetRecord(groupName: string, target: string, groupIndex: number, targetIndex: number): WorkspaceRecord {
  return {
    id: `ccd-${String(groupIndex + 1).padStart(2, "0")}-${String(targetIndex + 1).padStart(2, "0")}`,
    module: "ccd-targets",
    title: target,
    subtitle: groupName,
    updatedAt,
    kind: "record",
    isSystem: true,
    fields: fieldsFor("ccd-targets", {
      "CCD Targets": target,
      Authorizations: "-",
      "Last Deal": "-"
    })
  };
}

const ccdTargetRecords = ccdGroups.flatMap((group, groupIndex) => [
  ccdSectionRecord(group.name, groupIndex),
  ...group.targets.map((target, targetIndex) =>
    ccdTargetRecord(group.name, target, groupIndex, targetIndex)
  )
]);

function planSectionRecord(sectionName: string, sectionIndex: number, tone?: "dark"): WorkspaceRecord {
  return {
    id: `plan-section-${String(sectionIndex + 1).padStart(2, "0")}`,
    module: "plans",
    title: sectionName,
    subtitle: "Section",
    updatedAt,
    kind: "section",
    tone,
    isSystem: true,
    fields: fieldsFor("plans", {
      Issuer: sectionName
    })
  };
}

function planIssuerRecord(sectionName: string, issuer: string, sectionIndex: number, issuerIndex: number): WorkspaceRecord {
  return {
    id: `plan-${String(sectionIndex + 1).padStart(2, "0")}-${String(issuerIndex + 1).padStart(2, "0")}`,
    module: "plans",
    title: issuer,
    subtitle: sectionName,
    updatedAt,
    kind: "record",
    isSystem: true,
    fields: fieldsFor("plans", {
      Issuer: issuer
    })
  };
}

const planRecords = planSections.flatMap((section, sectionIndex) => [
  planSectionRecord(section.name, sectionIndex, section.tone),
  ...section.issuers.map((issuer, issuerIndex) =>
    planIssuerRecord(section.name, issuer, sectionIndex, issuerIndex)
  )
]);

export const records: WorkspaceRecord[] = [...k12TargetRecords, ...ccdTargetRecords, ...planRecords];

export function getModuleRows(moduleKey: ModuleKey) {
  return records.filter((record) => record.module === moduleKey);
}

export function getModuleTitle(moduleKey: ModuleKey) {
  return modules.find((module) => module.key === moduleKey)?.title ?? "K-12 Targets";
}

export function getLastUpdated(rows: WorkspaceRecord[]) {
  return rows
    .map((row) => row.updatedAt)
    .sort()
    .at(-1);
}
