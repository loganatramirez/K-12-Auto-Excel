import { NextResponse } from "next/server";
import { getModuleRows, type ModuleKey, type WorkspaceRecord } from "@/lib/data";
import {
  equivalentFormattedValue,
  formatDealTeamValue,
  formatLastDealParts,
  formatWorkbookFieldValue
} from "@/lib/deal-formatting";
import {
  getK12ExtractionProvider,
  getOpenAIApiKey,
  getOpenAIModel,
  getPerplexityApiKey,
  getPerplexityModel,
  isDealTeamWebFallbackEnabled
} from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const minimumConfidence = 0.74;
const minimumDealTeamSuggestionConfidence = 0.7;
const minimumProviderConfidence = 0.65;
const minimumConsensusVotes = 2;
const maxSourcesPerQuery = 10;
const maxMergedSources = 14;
const maxMergedDealTeamSources = 48;
const maxMergedCcdLeadershipSources = 32;
const maxExpandedSources = 5;
const maxExpandedDealTeamSources = 14;
const maxExpandedCcdLeadershipSources = 12;
const maxExpandedSourceCharacters = 2200;
const maxExpandedDealTeamSourceCharacters = 12000;
const maxExpandedCcdLeadershipSourceCharacters = 4200;
const sourceFetchTimeoutMs = 10000;
const maxPdfBytes = 35 * 1024 * 1024;
const maxPdfPages = 130;
const maxPdfCharacters = 240000;
const maxPdfEvidencePages = 18;
const maxPdfPageCharacters = 6000;
const maxPdfPageEvidenceCharacters = 1400;
const maxLinkedPdfSources = 5;
const maxDealFollowUpQueries = 42;
const maxDealTeamQueries = 60;
const maxAssistantDealTeamSources = 24;
const maxSourceCandidateDiagnostics = 40;
const maxDealTeamSourceCandidateDiagnostics = 100;
const defaultBatchLimit = 100;
const minimumDealYear = 2023;
const preferredDealYear = 2025;
const debtWatchApiBaseUrl = "https://debtwatch.treasurer.ca.gov/api";
const debtWatchIssueDetailBaseUrl = "https://debtwatch.treasurer.ca.gov/issue-level-detail/issues";
const debtWatchIssueSearchPageSize = 8;

const blockedSourceHosts = [
  "ballotpedia.org",
  "facebook.com",
  "greatschools.org",
  "instagram.com",
  "linkedin.com",
  "niche.com",
  "publicschoolreview.com",
  "twitter.com",
  "wikipedia.org",
  "x.com",
  "youtube.com"
];

type SourceProfile =
  | "authorization"
  | "ccd-leadership"
  | "ccd-refundings"
  | "deal-team"
  | "k12-leadership"
  | "last-deal"
  | "plan-deal-facts";

type WorkflowConfig = {
  fields: readonly string[];
  includeBoardRosterDiff?: boolean;
  module: ModuleKey;
  prompt: string;
  queries: (institution: string) => string[];
  requiresConsensus?: boolean;
  sourceProfile: SourceProfile;
};

type WorkflowKey =
  | "authorization"
  | "ccd-deal-facts"
  | "ccd-deal-team"
  | "ccd-leadership"
  | "ccd-refundings"
  | "deal-team"
  | "last-deal"
  | "leadership"
  | "plan-deal-facts";

const workflows: Record<WorkflowKey, WorkflowConfig> = {
  "last-deal": {
    fields: ["Last Deal"],
    module: "k12-targets",
    prompt:
      "Use the local CDIAC/DebtWatch deal-facts dataset to propose only the latest supported bond/debt transaction for the exact school district or a CFD/SFID/special-tax financing explicitly named for or sponsored by that district. Do not extract MA, UW, BC, or other deal-team roles in this workflow.",
    queries: k12DealTeamQueries,
    sourceProfile: "last-deal"
  },
  "deal-team": {
    fields: ["MA", "UW", "BC"],
    module: "k12-targets",
    prompt:
      "Extract only the deal-team roles for the newest clearly supported bond/debt transaction from 2023 or later for the exact school district or a CFD/SFID/special-tax financing explicitly named for or sponsored by that district. MA means Municipal Advisor, UW means Underwriter, and BC means Bond Counsel. Do not propose Last Deal in this workflow. Do not use unrelated city, county, redevelopment, overlapping-agency, private-school, or similarly named CFD transactions. Underwriter must be an investment bank/dealer, not a law firm or counsel. Bond Counsel must be explicitly labeled bond counsel, not disclosure counsel. Follow this source path: first use EMMA/Official Statement/POS/bond PDFs when reachable; next use CDIAC/DebtWatch to discover or confirm deal records; next use official district board agenda packets, minutes, staff reports, and resolutions to confirm financing team, authorization, refunding, or sale approval; then use BondLink, MuniOS, and public-finance transaction pages as supporting sources. Do not treat EMMA as the only path because the public EMMA website may not be server-readable. Use stale rating/news/search snippets only as hints, not as final support. If no role is directly supported, omit it.",
    queries: k12DealTeamQueries,
    sourceProfile: "deal-team"
  },
  leadership: {
    fields: ["Sup", "CBO", "Board 1", "Board 2", "Board 3", "Board 4", "Board 5", "Board 6", "Board 7"],
    includeBoardRosterDiff: true,
    module: "k12-targets",
    prompt:
      "Extract only current district leadership for the exact requested public school district. Sup means Superintendent. CBO means Chief Business Officer, Assistant Superintendent Business Services, or the closest equivalent senior business/finance executive. Board 1 through Board 7 are current Board of Education or Trustee members. Do not use similarly named districts, private schools, charter schools, or acronym-only matches unless the source also clearly identifies the exact requested district.",
    queries: k12LeadershipQueries,
    requiresConsensus: true,
    sourceProfile: "k12-leadership"
  },
  authorization: {
    fields: ["Auth"],
    module: "k12-targets",
    prompt:
      "Extract only remaining unissued GO bond authorization outstanding, preferably by voter-approved election/measure. Prefer the latest Official Statement/POS/offering document tied to the saved Last Deal because those documents often include an authorization table. Report concise amounts still available with an as-of/source date, including $0 when the source states no remaining authorization. Do not report original bond measure authorization unless the same source also states the unissued remaining amount.",
    queries: k12AuthorizationQueries,
    sourceProfile: "authorization"
  },
  "ccd-deal-facts": {
    fields: ["Last Deal"],
    module: "ccd-targets",
    prompt:
      "Use the local CDIAC/DebtWatch deal-facts dataset to propose only the latest supported bond/debt transaction for the exact California community college district. Do not extract Underwriter, MA, BC, Chancellor, CFO, or other roles in this workflow.",
    queries: ccdDealTeamQueries,
    sourceProfile: "last-deal"
  },
  "ccd-refundings": {
    fields: ["Refundings"],
    module: "ccd-targets",
    prompt:
      "Use the local CDIAC/DebtWatch deal-facts dataset to propose only the latest supported refunding transaction for the exact California community college district. Prefer DebtWatch Refunding Amount when available; otherwise use par amount only when the issue name or refunding type directly identifies the deal as a refunding.",
    queries: ccdDealTeamQueries,
    sourceProfile: "ccd-refundings"
  },
  "ccd-deal-team": {
    fields: ["Underwriter", "MA", "BC"],
    module: "ccd-targets",
    prompt:
      "Extract only the deal-team roles for the newest clearly supported bond/debt transaction from 2023 or later for the exact California community college district. Underwriter means Lead Underwriter or senior manager, MA means Municipal Advisor or Financial/Municipal Advisor, and BC means Bond Counsel. Do not propose Last Deal in this workflow. Prefer CDIAC/DebtWatch Reports Section for a selected CDIAC number; if web/model fallback is explicitly enabled, use EMMA/Official Statement/POS/bond PDFs, official district board agenda packets, staff reports, resolutions, BondLink, and MuniOS only as supporting sources. If no role is directly supported, omit it.",
    queries: ccdDealTeamQueries,
    sourceProfile: "deal-team"
  },
  "ccd-leadership": {
    fields: ["Chancellor", "CFO"],
    module: "ccd-targets",
    prompt:
      "Extract only current California community college district leadership. Chancellor means the current district Chancellor, Chancellor/CEO, or Interim/Acting Chancellor. For single-college districts, use the current Superintendent/President, President/Superintendent, or President/CEO as Chancellor when that is the district's top executive title. CFO means Chief Financial Officer, Vice Chancellor of Business/Fiscal/Administrative Services, Vice Chancellor of Finance and Administration, Vice President of Business/Administrative Services, Executive Vice President of Administrative Services, Chief Business Officer, or the closest equivalent senior district finance executive. Preserve the official title when it clarifies that the person is the finance executive. Do not use a college-level president unless the source supports that the person is also the district chief executive.",
    queries: ccdLeadershipQueries,
    requiresConsensus: true,
    sourceProfile: "ccd-leadership"
  },
  "plan-deal-facts": {
    fields: ["MA", "Deal", "Date", "Par ($M)"],
    module: "plans",
    prompt:
      "Use the local CDIAC/DebtWatch deal-facts dataset to propose only objective FY25/FY26 plan deal facts: Municipal Advisor, deal name, sale date, and par amount. Do not estimate fees, liability, revenue, probability, adjusted revenue, lead, or support staffing.",
    queries: (issuer: string) => [
      `${issuer} CDIAC DebtWatch bond sale municipal advisor par amount`,
      `"${issuer}" "CDIAC" "DebtWatch"`,
      `"${issuer}" "municipal advisor" "bond"`
    ],
    sourceProfile: "plan-deal-facts"
  }
};

function valueFieldsForWorkflow(workflowKey: WorkflowKey, fields: readonly string[]) {
  const sourceProfile = workflows[workflowKey].sourceProfile;

  return sourceProfile === "deal-team" || sourceProfile === "authorization"
    ? uniqueStrings([...fields, "Last Deal"])
    : [...fields];
}

function k12DealTeamQueries(district: string) {
  const aliases = k12SearchAliases(district);
  const domains = k12SearchDomains(district);
  const primaryAlias = aliases[0] ?? district;
  const years = ["2026", "2025", "2024", "2023"];
  const officialStatementQueries = [
    `${primaryAlias} EMMA official statement school district bonds 2026 2025 2024 2023`,
    `${primaryAlias} OS POS PDF official statement bonds 2026 2025 municipal advisor underwriter bond counsel`,
    `${primaryAlias} filetype:pdf official statement bonds municipal advisor underwriter bond counsel`,
    `${primaryAlias} official statement PDF municipal advisor underwriter bond counsel 2025 2024 2023`,
    `${primaryAlias} preliminary official statement PDF bonds financing team`
  ];
  const cdiacQueries = [
    `${primaryAlias} CDIAC DebtWatch 2025 2024 2023 underwriter bond counsel municipal advisor`,
    `${primaryAlias} CDIAC debt issuance sale date principal amount refunding`,
    `${primaryAlias} California Debt and Investment Advisory Commission bonds 2025 2024 2023`
  ];
  const boardMaterialQueries = [
    `${primaryAlias} board agenda bonds 2025 2024 2023 municipal advisor underwriter bond counsel`,
    `${primaryAlias} board minutes bonds 2025 2024 2023 municipal advisor underwriter bond counsel`,
    `${primaryAlias} agenda packet bonds financing team 2025 2024 2023`,
    `${primaryAlias} staff report resolution bonds underwriter bond counsel`,
    `${primaryAlias} board approved bond purchase agreement municipal advisor`
  ];
  const roleQueries = [
    `${primaryAlias} municipal advisor bond counsel underwriter bonds`,
    `${primaryAlias} financing team bond counsel underwriter municipal advisor`,
    `${primaryAlias} financial advisor senior manager bond counsel school bonds`,
    `${primaryAlias} placement agent direct purchaser bond counsel school district`
  ];
  const authorizationRefundingQueries = [
    `${primaryAlias} authorization refunding bonds official statement 2026 2025 2024 2023`,
    `${primaryAlias} remaining authorization unissued authorization bond measure official statement`,
    `${primaryAlias} refunding refunded bonds escrow debt service savings official statement`,
    `${primaryAlias} voter approved bond measure maximum bonded indebtedness`
  ];
  const transactionPageQueries = [
    `${primaryAlias} BondLink MuniOS official statement bonds`,
    `${primaryAlias} public finance transactions bonds municipal advisor underwriter bond counsel`,
    `${primaryAlias} recent financings bonds municipal advisor underwriter bond counsel`,
    `${primaryAlias} Piper Sandler public finance transactions bonds`,
    `${primaryAlias} Dale Scott Company upcoming recent financings bonds`,
    `${primaryAlias} Keygent public finance transaction bonds`,
    `${primaryAlias} Fieldman Rolapp public finance transaction bonds`
  ];
  const yearQueries = years.flatMap((year) => [
    `${primaryAlias} Series ${year} bonds official statement municipal advisor`,
    `${primaryAlias} ${year} refunding bonds underwriter bond counsel`,
    `${primaryAlias} ${year} CFD special tax bonds underwriter bond counsel`,
    `${primaryAlias} ${year} community facilities district bonds municipal advisor`,
    `"${primaryAlias}" "${year}" "Preliminary Official Statement"`,
    `"${primaryAlias}" "${year}" "Financing Team" "Bond Counsel"`,
    `"${primaryAlias}" "${year}" "board minutes" "bond purchase agreement"`
  ]);
  const domainQueries = domains.flatMap((domain) => [
    `site:${domain} "official statement" bonds`,
    `site:${domain} "preliminary official statement" bonds`,
    `site:${domain} "community facilities district" bonds`,
    `site:${domain} "special tax bonds"`,
    `site:${domain} "municipal advisor" "bond counsel"`,
    `site:${domain} "underwriter" "refunding"`,
    `site:${domain} board agenda bonds financing`,
    `site:${domain} board minutes bonds financing`,
    `site:${domain} meeting minutes bonds underwriter`,
    `site:${domain} agenda packet bond purchase agreement`
  ]);
  const aliasQueries = aliases.flatMap((alias) => [
    `"${alias}" "Official Statement" "Municipal Advisor"`,
    `"${alias}" "Preliminary Official Statement"`,
    `"${alias}" "Community Facilities District" "Official Statement"`,
    `"${alias}" "CFD" "Special Tax Bonds"`,
    `"${alias}" "Bond Counsel" "Underwriter"`,
    `"${alias}" "CDIAC" "Underwriter"`,
    `"${alias}" "Public Finance Transactions" "Bonds"`,
    `"${alias}" "Recent Financings" "Bonds"`,
    `"${alias}" "Board Minutes" "Bonds"`,
    `"${alias}" "Meeting Minutes" "Municipal Advisor"`,
    `"${alias}" "Authorization" "Refunding"`
  ]);

  return uniqueStrings([
    ...officialStatementQueries,
    ...cdiacQueries,
    ...boardMaterialQueries,
    ...roleQueries,
    ...authorizationRefundingQueries,
    ...transactionPageQueries,
    ...yearQueries,
    ...domainQueries,
    ...aliasQueries
  ]).slice(0, maxDealTeamQueries);
}

function ccdDealTeamQueries(target: string) {
  const aliases = ccdSearchAliases(target);
  const domains = ccdSearchDomains(target);
  const primaryAlias = aliases[0] ?? target;
  const years = ["2026", "2025", "2024", "2023"];
  const officialStatementQueries = [
    `${primaryAlias} EMMA official statement community college district bonds 2026 2025 2024 2023`,
    `${primaryAlias} OS POS PDF official statement bonds municipal advisor underwriter bond counsel`,
    `${primaryAlias} CDIAC DebtWatch community college district bonds underwriter municipal advisor bond counsel`,
    `${primaryAlias} latest bond issue CDIAC number DebtWatch`
  ];
  const boardMaterialQueries = [
    `${primaryAlias} board agenda bonds 2025 2024 2023 municipal advisor underwriter bond counsel`,
    `${primaryAlias} board minutes bonds financing team municipal advisor underwriter bond counsel`,
    `${primaryAlias} bond purchase agreement municipal advisor underwriter bond counsel`
  ];
  const domainQueries = domains.flatMap((domain) => [
    `site:${domain} official statement bonds municipal advisor underwriter bond counsel`,
    `site:${domain} board agenda bonds financing team`,
    `site:${domain} bond purchase agreement underwriter municipal advisor`
  ]);
  const aliasQueries = aliases.flatMap((alias) => [
    `"${alias}" "Official Statement" "Community College District"`,
    `"${alias}" "CDIAC" "Underwriter"`,
    `"${alias}" "Bond Counsel" "Municipal Advisor"`,
    `"${alias}" "Financial Advisor" "Underwriter"`,
    ...years.flatMap((year) => [
      `"${alias}" "${year}" "Official Statement" "Underwriter"`,
      `"${alias}" "${year}" "Bond Counsel" "Municipal Advisor"`
    ])
  ]);

  return uniqueStrings([
    ...officialStatementQueries,
    ...boardMaterialQueries,
    ...domainQueries,
    ...aliasQueries
  ]).slice(0, maxDealTeamQueries);
}

function k12LeadershipQueries(district: string) {
  const aliases = k12SearchAliases(district);
  const domains = k12SearchDomains(district);
  const primaryAlias = aliases[0] ?? district;
  const queries = [
    `${primaryAlias} official superintendent chief business officer`,
    `${primaryAlias} official board of education trustees members`,
    ...domains.flatMap((domain) => [
      `site:${domain} superintendent chief business officer`,
      `site:${domain} board of education members`,
      `site:${domain} governing board trustees`,
      `site:${domain} cabinet business services`
    ]),
    ...aliases.flatMap((alias) => [
      `"${alias}" "Board of Trustees" members official`,
      `"${alias}" "Board of Education" members official`,
      `"${alias}" "Governing Board" members official`,
      `"${alias}" "Superintendent" "Business Services"`,
      `"${alias}" "Chief Business Officer"`
    ])
  ];

  return uniqueStrings(queries).slice(0, 22);
}

function k12SearchAliases(district: string) {
  const normalizedDistrict = district.trim().replace(/\s+/g, " ");
  const aliases: string[] = [];
  const addAlias = (alias: string) => {
    const normalizedAlias = alias.trim().replace(/\s+/g, " ");

    if (normalizedAlias && !aliases.includes(normalizedAlias)) {
      aliases.push(normalizedAlias);
    }
  };
  const knownAliases: Record<string, string[]> = {
    "Berkeley USD": ["Berkeley Unified School District", "Berkeley Unified", "Berkeley USD"],
    "Chaffey JUHSD": ["Chaffey Joint Union High School District", "Chaffey JUHSD"],
    "Lancaster Elementary SD": [
      "Lancaster School District",
      "Lancaster Elementary School District",
      "Lancaster ESD",
      "Lancaster SD"
    ],
    "La Mesa–Spring Valley SD": [
      "La Mesa-Spring Valley School District",
      "La Mesa Spring Valley School District",
      "La Mesa-Spring Valley SD",
      "La Mesa–Spring Valley SD",
      "LMSVSD"
    ],
    "Long Beach USD": ["Long Beach Unified School District", "Long Beach Unified", "Long Beach USD"],
    "PV Peninsula USD": [
      "Palos Verdes Peninsula Unified School District",
      "Palos Verdes Peninsula USD",
      "PV Peninsula USD",
      "PVPUSD"
    ],
    "San Mateo-Foster City SD": [
      "San Mateo-Foster City School District",
      "San Mateo Foster City School District",
      "San Mateo-Foster City Elementary School District",
      "San Mateo-Foster City SD",
      "SMFCSD"
    ],
    "Sweetwater Union HSD": [
      "Sweetwater Union High School District",
      "Sweetwater Union HSD",
      "Sweetwater UHSD",
      "Sweetwater Union",
      "SUHSD"
    ]
  };

  const suffixAliases: Array<[RegExp, string]> = [
    [/\s+USD$/i, " Unified School District"],
    [/\s+SD$/i, " School District"],
    [/\s+ESD$/i, " Elementary School District"],
    [/\s+HSD$/i, " High School District"],
    [/\s+Union HSD$/i, " Union High School District"],
    [/\s+UHSD$/i, " Union High School District"],
    [/\s+JUHSD$/i, " Joint Union High School District"],
    [/\s+JUSHD$/i, " Joint Union High School District"],
    [/\s+JUSD$/i, " Joint Unified School District"],
    [/\s+CSD$/i, " City School District"]
  ];

  (knownAliases[normalizedDistrict] ?? []).forEach(addAlias);
  suffixAliases.forEach(([pattern, replacement]) => {
    if (pattern.test(normalizedDistrict)) {
      addAlias(normalizedDistrict.replace(pattern, replacement));
    }
  });
  addAlias(normalizedDistrict);

  return aliases.slice(0, 8);
}

function k12SearchDomains(district: string) {
  const normalizedDistrict = district.trim().replace(/\s+/g, " ");
  const knownDomains: Record<string, string[]> = {
    "Berkeley USD": ["berkeleyschools.net"],
    "Chaffey JUHSD": ["cjuhsd.net"],
    "Lancaster Elementary SD": ["lancsd.org"],
    "La Mesa–Spring Valley SD": ["lmsvschools.org"],
    "Long Beach USD": ["lbschools.net"],
    "PV Peninsula USD": ["pvpusd.net"],
    "San Mateo-Foster City SD": ["smfcsd.net"],
    "Sweetwater Union HSD": ["sweetwaterschools.org"]
  };

  return knownDomains[normalizedDistrict] ?? [];
}

function ccdLeadershipQueries(target: string) {
  const aliases = ccdSearchAliases(target);
  const primaryAlias = aliases[0] ?? target;
  const domains = ccdSearchDomains(target);
  const queries = [
    `${primaryAlias} California community college district chancellor chief financial officer official leadership`,
    `${primaryAlias} superintendent president vice president business administrative services finance administration`,
    `${primaryAlias} chancellor cabinet vice chancellor finance administration`,
    `${primaryAlias} chief business officer ACBO CBO listing`,
    ...domains.flatMap((domain) => [
      `site:${domain} chancellor cabinet executive leadership`,
      `site:${domain} chief financial officer vice chancellor business services`,
      `site:${domain} vice president administrative services finance`,
      `site:${domain} president superintendent business services`
    ]),
    ...aliases.flatMap((alias) => [
      `"${alias}" "Chancellor" "Chief Financial Officer"`,
      `"${alias}" "Superintendent/President" "Business Services"`,
      `"${alias}" "Vice Chancellor" "Business" "Fiscal"`,
      `"${alias}" "Vice Chancellor" "Finance" "Administration"`,
      `"${alias}" "Executive Vice President" "Administrative Services"`,
      `"${alias}" "Vice President" "Business Services"`,
      `"${alias}" "Administrative Services" "Fiscal"`,
      `"${alias}" "Executive Cabinet" leadership`,
      `"${alias}" "ACBO" "CBO Listing"`
    ])
  ];

  return uniqueStrings(queries).slice(0, 28);
}

function ccdSearchAliases(target: string) {
  const normalizedTarget = target.trim().replace(/\s+/g, " ");
  const aliases = new Set<string>();
  const knownAliases: Record<string, string[]> = {
    "Berkeley CCD": ["Peralta Community College District", "Berkeley City College", "Berkeley CCD"],
    "San Bernardino CCD": ["San Bernardino Community College District", "SBCCD"],
    "Santa Monica CCD": ["Santa Monica Community College District", "Santa Monica College", "SMC"],
    "Long Beach CCD": ["Long Beach Community College District", "Long Beach City College", "LBCCD"],
    "Southwestern CCD": ["Southwestern Community College District", "Southwestern College"],
    "Los Rios CCD": ["Los Rios Community College District", "LRCCD"],
    "San Jose-Evergreen": [
      "San Jose Evergreen Community College District",
      "San José-Evergreen Community College District",
      "SJECCD"
    ],
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
    "Contra Costa CCD": ["Contra Costa Community College District", "4CD"]
  };

  (knownAliases[normalizedTarget] ?? knownAliases[ccdShortNameFromCanonical(normalizedTarget)] ?? []).forEach((alias) =>
    aliases.add(alias)
  );
  aliases.add(normalizedTarget);

  if (/\bCCD$/i.test(normalizedTarget)) {
    aliases.add(normalizedTarget.replace(/\s+CCD$/i, " Community College District"));
  }

  if (/\bJCCD$/i.test(normalizedTarget)) {
    aliases.add(normalizedTarget.replace(/\s+JCCD$/i, " Joint Community College District"));
  }

  return Array.from(aliases).filter(Boolean).slice(0, 8);
}

function ccdCanonicalSearchName(target: string) {
  const normalizedTarget = target.trim().replace(/\s+/g, " ");
  const canonicalNames: Record<string, string> = {
    "Cerritos CCD": "Cerritos Community College District",
    "Contra Costa CCD": "Contra Costa Community College District",
    "Desert CCD": "Desert Community College District",
    "Foothill De Anza CCD": "Foothill-De Anza Community College District",
    "Gavilan JCCD": "Gavilan Joint Community College District",
    "Glendale CCD": "Glendale Community College District",
    "Berkeley CCD": "Peralta Community College District",
    "Long Beach CCD": "Long Beach Community College District",
    "Los Angeles CCD": "Los Angeles Community College District",
    "Los Rios CCD": "Los Rios Community College District",
    "Mt. Sac CCD": "Mt. San Antonio Community College District",
    "Pasadena CCD": "Pasadena Area Community College District",
    Peralta: "Peralta Community College District",
    "Rio Hondo CCD": "Rio Hondo Community College District",
    "Riverside CCD": "Riverside Community College District",
    "San Bernardino CCD": "San Bernardino Community College District",
    "San Diego CCD": "San Diego Community College District",
    "San Francisco CCD": "San Francisco Community College District",
    "San Joaquin Delta": "San Joaquin Delta Community College District",
    "San Jose-Evergreen": "San Jose Evergreen Community College District",
    "San Mateo Cnty CCD": "San Mateo County Community College District",
    "Santa Monica CCD": "Santa Monica Community College District",
    "Southwestern CCD": "Southwestern Community College District",
    "State Center CCD": "State Center Community College District",
    "West Hills CCD": "West Hills Community College District",
    "West Valley Mission": "West Valley-Mission Community College District"
  };

  return canonicalNames[normalizedTarget] ?? normalizedTarget;
}

function ccdSearchRejectPhrases(target: string) {
  const normalizedTarget = target.trim().replace(/\s+/g, " ");
  const rejectPhrases: Record<string, string[]> = {
    "Long Beach CCD": ["laguna beach", "laguna beach unified", "laguna beach school", "laguna beach city"],
    "Long Beach Community College District": [
      "laguna beach",
      "laguna beach unified",
      "laguna beach school",
      "laguna beach city"
    ],
    "Berkeley CCD": ["berkeley unified school district", "berkeley usd", "berkeley public schools", "berkeleyschools"],
    "Berkeley Community College District": [
      "berkeley unified school district",
      "berkeley usd",
      "berkeley public schools",
      "berkeleyschools"
    ]
  };

  return rejectPhrases[normalizedTarget] ?? [];
}

function ccdSearchDomains(target: string) {
  const normalizedTarget = target.trim().replace(/\s+/g, " ");
  const knownDomains: Record<string, string[]> = {
    "Berkeley CCD": ["peralta.edu", "berkeleycitycollege.edu"],
    "San Bernardino CCD": ["sbccd.edu"],
    "Santa Monica CCD": ["smc.edu"],
    "Long Beach CCD": ["lbcc.edu"],
    "Southwestern CCD": ["swccd.edu"],
    "Los Rios CCD": ["losrios.edu"],
    "San Jose-Evergreen": ["sjeccd.edu"],
    "Los Angeles CCD": ["laccd.edu"],
    "Desert CCD": ["collegeofthedesert.edu"],
    "West Hills CCD": ["whccd.edu"],
    "San Diego CCD": ["sdccd.edu"],
    "San Joaquin Delta": ["deltacollege.edu"],
    "Cerritos CCD": ["cerritos.edu"],
    "San Francisco CCD": ["ccsf.edu"],
    "Pasadena CCD": ["pasadena.edu"],
    "San Mateo Cnty CCD": ["smccd.edu"],
    "State Center CCD": ["scccd.edu"],
    "Riverside CCD": ["rccd.edu"],
    "Foothill De Anza CCD": ["fhda.edu"],
    Peralta: ["peralta.edu"],
    "West Valley Mission": ["wvm.edu"],
    "Mt. Sac CCD": ["mtsac.edu"],
    "Glendale CCD": ["glendale.edu"],
    "Rio Hondo CCD": ["riohondo.edu"],
    "Gavilan JCCD": ["gavilan.edu"],
    "Contra Costa CCD": ["4cd.edu"]
  };

  return knownDomains[normalizedTarget] ?? knownDomains[ccdShortNameFromCanonical(normalizedTarget)] ?? [];
}

function ccdShortNameFromCanonical(target: string) {
  const canonicalToShortName: Record<string, string> = {
    "Cerritos Community College District": "Cerritos CCD",
    "Contra Costa Community College District": "Contra Costa CCD",
    "Desert Community College District": "Desert CCD",
    "Foothill-De Anza Community College District": "Foothill De Anza CCD",
    "Gavilan Joint Community College District": "Gavilan JCCD",
    "Glendale Community College District": "Glendale CCD",
    "Peralta Community College District": "Peralta",
    "Long Beach Community College District": "Long Beach CCD",
    "Los Angeles Community College District": "Los Angeles CCD",
    "Los Rios Community College District": "Los Rios CCD",
    "Mt. San Antonio Community College District": "Mt. Sac CCD",
    "Pasadena Area Community College District": "Pasadena CCD",
    "Rio Hondo Community College District": "Rio Hondo CCD",
    "Riverside Community College District": "Riverside CCD",
    "San Bernardino Community College District": "San Bernardino CCD",
    "San Diego Community College District": "San Diego CCD",
    "San Francisco Community College District": "San Francisco CCD",
    "San Joaquin Delta Community College District": "San Joaquin Delta",
    "San Jose Evergreen Community College District": "San Jose-Evergreen",
    "San José-Evergreen Community College District": "San Jose-Evergreen",
    "San Mateo County Community College District": "San Mateo Cnty CCD",
    "Santa Monica Community College District": "Santa Monica CCD",
    "Southwestern Community College District": "Southwestern CCD",
    "State Center Community College District": "State Center CCD",
    "West Hills Community College District": "West Hills CCD",
    "West Valley-Mission Community College District": "West Valley Mission"
  };

  return canonicalToShortName[target] ?? target;
}

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

type ExtractorProvider = "anthropic" | "openai" | "perplexity";

type ExtractorConfig = {
  apiKey: string;
  model: string;
  provider: ExtractorProvider;
};

type SourceSearchConfig = ExtractorConfig;
type SupabaseServerClient = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

type SearchSource = {
  index: number;
  title: string;
  url: string;
  snippet: string;
};

type PdfEvidencePage = {
  matchedKeywords: string[];
  pageNumber: number;
  score: number;
  text: string;
};

type RawSearchResult = {
  content?: unknown;
  description?: unknown;
  link?: unknown;
  name?: unknown;
  snippet?: unknown;
  source?: unknown;
  summary?: unknown;
  text?: unknown;
  title?: unknown;
  uri?: unknown;
  url?: unknown;
};

type AutomationFieldResult = {
  excerpt?: string;
  confidence?: number;
  field_key?: string;
  package_context?: string;
  providers?: ExtractorProvider[];
  source_context?: string;
  source_index?: number;
  source_title?: string;
  source_url?: string;
  value?: string;
};

type AutomationResearchResult = {
  candidate_diagnostics?: string[];
  deal_follow_up_seeds?: DealFollowUpSeed[];
  fields?: AutomationFieldResult[];
  provider_errors?: ProviderError[];
  source_candidates?: SourceCandidateDiagnostic[];
  source_count?: number;
};

type DealFollowUpSeed = {
  confidence?: number;
  excerpt?: string;
  source_title?: string;
  source_url?: string;
  value: string;
};

type SourceDiscoveryResult = {
  candidates: SourceCandidateDiagnostic[];
  providerErrors: ProviderError[];
  sources: SearchSource[];
};

type ProviderError = {
  error: string;
  provider: ExtractorProvider;
};

type ResearchDiagnostic = {
  institution: string;
  message: string;
};

type SourceCandidateCategory =
  | "board_materials"
  | "cdiac_debtwatch"
  | "emma_os_pos"
  | "issuer_site"
  | "supplemental"
  | "transaction_pages";

type SourceCandidateDiagnostic = {
  category: SourceCandidateCategory;
  reason: string;
  score: number;
  snippet: string;
  status: "excluded" | "kept" | "not_selected";
  title: string;
  url: string;
};

type InstitutionSourceCandidates = {
  institution: string;
  sources: SourceCandidateDiagnostic[];
};

type ConsensusCandidate = AutomationFieldResult & {
  normalizedValue: string;
};

type ConsensusWinner = ConsensusCandidate & {
  voteCount: number;
};

type WorkbookFieldValue = {
  record_id: string;
  field_key: string;
  value: string | null;
};

type PendingSuggestion = {
  record_id: string;
  field_key: string;
};

type UpdateSuggestionInsert = {
  module: ModuleKey;
  record_id: string;
  field_key: string;
  current_value: string;
  proposed_value: string;
  source_title: string;
  source_url: string;
  source_excerpt: string;
  confidence: number;
};

type MuniDealFactRow = {
  auth_detail?: string | null;
  auth_type?: string | null;
  bc?: string | null;
  bond_counsel?: string | null;
  confidence?: string | null;
  deal_name?: string | null;
  deal_par_amount?: number | string | null;
  deal_sale_date?: string | null;
  deal_state_id?: string | null;
  deal_type?: string | null;
  issuer_id?: string | null;
  issuer_name_reported?: string | null;
  ma?: string | null;
  municipal_advisor?: string | null;
  record_id?: string | null;
  related_entity_name?: string | null;
  refunding_amount?: number | string | null;
  refunding_type?: string | null;
  source_excerpt?: string | null;
  source_layer?: string | null;
  source_title_primary?: string | null;
  source_url_primary?: string | null;
  underwriters?: unknown;
  uw?: string | null;
};

type DebtWatchIssueRecord = Record<string, unknown> & {
  BondCounsel?: string | null;
  CDIACNumber?: string | null;
  DebtType?: string | null;
  FinancialOrMunicipalAdvisor?: string | null;
  IssueName?: string | null;
  Issuer?: string | null;
  LeadUnderwriter?: string | null;
  PrincipalAmount?: number | string | null;
  ProjectSeriesOrName?: string | null;
  RefundingAmount?: number | string | null;
  SaleDate?: string | null;
};

type DebtWatchAuthorizationRecord = Record<string, unknown> & {
  ADTRReportingYearEnd?: number | string | null;
  AuthAmountEndPeriod?: number | string | null;
  AuthAuthorizationAdded?: number | string | null;
  AuthDate?: string | null;
  AuthIssuance?: number | string | null;
  AuthName?: string | null;
  AuthOriginalAmount?: number | string | null;
};

type DebtWatchDocumentRecord = Record<string, unknown> & {
  DocumentFileName?: string | null;
  DocumentFileURL?: string | null;
  DocumentId?: number | string | null;
  DocumentType?: string | null;
  PrincipalAmount?: number | string | null;
  ProjectSeriesOrName?: string | null;
  SaleDate?: string | null;
};

type DebtWatchIssuanceDetailResponse = {
  datasetById?: {
    "adtr-auths"?: {
      recordSets?: Array<{
        records?: DebtWatchAuthorizationRecord[];
        reportingYearId?: number | string | null;
      }>;
    };
    documents?: {
      records?: DebtWatchDocumentRecord[];
    };
    issues?: {
      record?: DebtWatchIssueRecord;
    };
  };
};

type DebtWatchIssueSearchResponse = {
  records?: DebtWatchIssueRecord[];
  totalMatchingRecords?: number;
};

type BoardRosterMember = AutomationFieldResult & {
  normalizedValue: string;
  value: string;
};

export async function POST(request: Request) {
  const sourceSearchConfigs = getSourceSearchConfigs();
  let extractorConfigError = "";
  let extractors: ExtractorConfig[] = [];

  try {
    extractors = getExtractorConfigs();
  } catch (error) {
    extractorConfigError = error instanceof Error ? error.message : "Extraction provider is not configured.";
  }

  const supabase = await createSupabaseServerClient();

  if (!supabase) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Sign in before running automation." }, { status: 401 });
  }

  const body = await safeJson(request);
  const moduleKey = isModuleKey(body.module) ? body.module : "k12-targets";
  const workflowKey = isWorkflowKey(body.workflow) ? body.workflow : defaultWorkflowForModule(moduleKey);
  const workflow = workflows[workflowKey];

  if (workflow.module !== moduleKey) {
    return NextResponse.json(
      { error: `${workflowKey} is not available for ${moduleKey}.` },
      { status: 400 }
    );
  }

  if (
    workflow.sourceProfile !== "authorization" &&
    workflow.sourceProfile !== "ccd-refundings" &&
    workflow.sourceProfile !== "last-deal" &&
    workflow.sourceProfile !== "deal-team" &&
    workflow.sourceProfile !== "plan-deal-facts"
  ) {
    if (extractorConfigError) {
      return NextResponse.json({ error: extractorConfigError }, { status: 503 });
    }

    if (!sourceSearchConfigs.length) {
      return NextResponse.json(
        { error: "Add OPENAI_API_KEY or PERPLEXITY_API_KEY in Vercel to run source search." },
        { status: 503 }
      );
    }
  }

  if (workflow.requiresConsensus && extractors.length < minimumConsensusVotes) {
    return NextResponse.json(
      { error: `${workflowKey} research requires at least two extraction providers for consensus.` },
      { status: 503 }
    );
  }

  const selectedRecordIds = Array.isArray(body.recordIds)
    ? body.recordIds.filter((value): value is string => typeof value === "string")
    : [];
  const limit = clampLimit(body.limit);

  if (!selectedRecordIds.length) {
    return NextResponse.json({ error: `Select at least one ${entityLabel(moduleKey)}.` }, { status: 400 });
  }

  const rows = getModuleRows(moduleKey).filter(
    (row) => row.kind !== "section" && selectedRecordIds.includes(row.id)
  );
  const rowIds = rows.map((row) => row.id);

  if (!rowIds.length) {
    return NextResponse.json({ error: `No matching ${entityLabel(moduleKey)}s were found.` }, { status: 400 });
  }

  const valueFieldKeys = valueFieldsForWorkflow(workflowKey, workflow.fields);
  const [{ data: savedValues, error: valuesError }, { data: pendingSuggestions, error: pendingError }] =
    await Promise.all([
      supabase
        .from("workbook_field_values")
        .select("record_id, field_key, value")
        .eq("module", moduleKey)
        .in("record_id", rowIds)
        .in("field_key", valueFieldKeys),
      supabase
        .from("update_suggestions")
        .select("record_id, field_key")
        .eq("module", moduleKey)
        .eq("status", "pending")
        .in("record_id", rowIds)
        .in("field_key", workflow.fields)
    ]);

  if (valuesError || pendingError) {
    return NextResponse.json(
      { error: valuesError?.message ?? pendingError?.message ?? "Could not load workbook state." },
      { status: 500 }
    );
  }

  const valueMap = new Map(
    ((savedValues ?? []) as WorkbookFieldValue[]).map((field) => [
      `${field.record_id}::${field.field_key}`,
      field.value ?? ""
    ])
  );
  rows.forEach((row) => {
    valueFieldKeys.forEach((field) => {
      const key = `${row.id}::${field}`;

      if (!valueMap.has(key)) {
        valueMap.set(key, String(row.fields[field] ?? ""));
      }
    });
  });
  const pendingSet = new Set(
    ((pendingSuggestions ?? []) as PendingSuggestion[]).map((field) => `${field.record_id}::${field.field_key}`)
  );
  const eligibleRows = rows.filter((row) =>
    workflow.fields.some((field) => !pendingSet.has(`${row.id}::${field}`))
  );
  const skippedPendingRows = rows.length - eligibleRows.length;
  const candidates = eligibleRows.slice(0, limit);

  const suggestions = [];
  const errors = [];
  const diagnostics: ResearchDiagnostic[] = [];
  const providerErrors: Array<ProviderError & { institution: string }> = [];
  const sourceCandidates: InstitutionSourceCandidates[] = [];
  let sourceCount = 0;

  for (const row of candidates) {
    try {
      const result = await researchInstitution(
        recordSearchName(row, moduleKey),
        workflowKey,
        sourceSearchConfigs,
        extractors,
        supabase,
        moduleKey,
        row.id,
        valueMap.get(`${row.id}::Last Deal`) ?? ""
      );
      sourceCount += result.source_count ?? 0;
      if (result.source_candidates?.length) {
        sourceCandidates.push({
          institution: row.title,
          sources: result.source_candidates
        });
      }
      providerErrors.push(
        ...(result.provider_errors ?? []).map((providerError) => ({
          ...providerError,
          institution: row.title
        }))
      );
      const rowSuggestions = buildSuggestions(
        moduleKey,
        row.id,
        recordSearchName(row, moduleKey),
        workflowKey,
        workflow.fields,
        valueMap,
        pendingSet,
        result
      );

      if (!rowSuggestions.length) {
        diagnostics.push(
          buildNoSuggestionDiagnostic(
            row.title,
            workflowKey,
            workflow.fields,
            row.id,
            valueMap,
            pendingSet,
            result,
            recordSearchName(row, moduleKey)
          )
        );
      } else {
        const partialDiagnostic = buildDealTeamPartialDiagnostic(row.title, workflowKey, workflow.fields, result);

        if (partialDiagnostic) {
          diagnostics.push(partialDiagnostic);
        }
      }

      suggestions.push(...rowSuggestions);
    } catch (error) {
      errors.push({
        institution: row.title,
        error: error instanceof Error ? error.message : "Unknown automation error"
      });
    }
  }

  if (suggestions.length) {
    const { error } = await supabase.from("update_suggestions").insert(suggestions);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    dealTeamWebFallbackEnabled:
      workflow.sourceProfile === "deal-team" ? isDealTeamWebFallbackEnabled() : null,
    extractors: extractors.map((extractor) => extractor.provider),
    minimumDealYear: isDealWorkflow(workflowKey) ? minimumDealYear : null,
    preferredDealYear: isDealWorkflow(workflowKey) ? preferredDealYear : null,
    module: moduleKey,
    workflow: workflowKey,
    limit,
    eligible: eligibleRows.length,
    skippedPending: skippedPendingRows,
    scanned: candidates.length,
    selected: rows.length,
    sourceCount,
    sourceCandidates,
    created: suggestions.length,
    diagnostics,
    errors,
    providerErrors
  });
}

async function researchInstitution(
  institution: string,
  workflowKey: WorkflowKey,
  sourceSearchConfigs: SourceSearchConfig[],
  extractors: ExtractorConfig[],
  supabase: SupabaseServerClient,
  moduleKey: ModuleKey,
  recordId: string,
  savedLastDeal: string
): Promise<AutomationResearchResult> {
  const sourceProfile = workflows[workflowKey].sourceProfile;

  if (sourceProfile === "last-deal") {
    const l1DealResult = await researchDealTeamFromL1(supabase, moduleKey, recordId, institution);

    return (
      l1DealResult ?? {
        candidate_diagnostics: [`No CDIAC/DebtWatch deal fact is loaded for ${institution}.`],
        fields: [],
        source_count: 0
      }
    );
  }

  if (sourceProfile === "plan-deal-facts") {
    const planDealResult = await researchPlanDealFactsFromL1(supabase, moduleKey, recordId, institution);

    return (
      planDealResult ?? {
        candidate_diagnostics: [`No CDIAC/DebtWatch plan deal fact is loaded for ${institution}.`],
        fields: [],
        source_count: 0
      }
    );
  }

  if (sourceProfile === "ccd-refundings") {
    return {
      candidate_diagnostics: [
        "CCD Refundings automation is paused: the workbook column tracks future refunding opportunities, not historical CDIAC refunding transactions."
      ],
      fields: [],
      source_count: 0
    };
  }

  let l1DealResult =
    sourceProfile === "deal-team"
      ? await researchDealTeamFromL1(supabase, moduleKey, recordId, institution)
      : null;

  if (sourceProfile === "deal-team" && (!l1DealResult || !hasCompleteDealTeamPackage(workflowKey, l1DealResult))) {
    const debtWatchLastDealResult = await researchDealTeamFromDebtWatchLastDeal(
      moduleKey,
      institution,
      savedLastDeal
    );

    if (debtWatchLastDealResult) {
      l1DealResult = l1DealResult
        ? mergeL1AndSearchDealResults(l1DealResult, debtWatchLastDealResult, workflowKey)
        : debtWatchLastDealResult;
    }
  }

  if (l1DealResult && hasCompleteDealTeamPackage(workflowKey, l1DealResult)) {
    return l1DealResult;
  }

  if (sourceProfile === "deal-team" && !isDealTeamWebFallbackEnabled()) {
    return {
      ...(l1DealResult ?? { fields: [], source_count: 0 }),
      candidate_diagnostics: mergeCandidateDiagnostics([
        ...(l1DealResult?.candidate_diagnostics ?? []),
        l1DealResult
          ? `CDIAC-only mode: L1/DebtWatch did not contain a complete ${dealTeamFieldList(workflowKey)} package, and web/model fallback is disabled by default.`
          : `CDIAC-only mode: no complete CDIAC/DebtWatch deal fact was found for ${institution}; web/model fallback is disabled by default.`
      ])
    };
  }

  if (sourceProfile === "authorization") {
    const debtWatchAuthResult = await researchAuthorizationFromDebtWatch(
      institution,
      savedLastDeal,
      extractors
    );

    return (
      debtWatchAuthResult ?? {
        candidate_diagnostics: [
          savedLastDeal
            ? `No CDIAC/DebtWatch OS or ADTR remaining authorization evidence was found for saved Last Deal "${savedLastDeal}".`
            : "No saved Last Deal is available to locate a CDIAC OS/POS for remaining authorization."
        ],
        fields: [],
        source_count: 0
      }
    );
  }

  if (!sourceSearchConfigs.length || !extractors.length) {
    return {
      ...(l1DealResult ?? { fields: [], source_count: 0 }),
      candidate_diagnostics: mergeCandidateDiagnostics([
        ...(l1DealResult?.candidate_diagnostics ?? []),
        l1DealResult
          ? `L1 CDIAC/DebtWatch data did not contain a complete ${dealTeamFieldList(workflowKey)} package; source-search/extraction fallback is not fully configured.`
          : `No complete CDIAC/DebtWatch deal fact is loaded for ${institution}; source-search/extraction fallback is not fully configured.`
      ])
    };
  }

  const searchResult = await researchInstitutionFromSources(
    institution,
    workflowKey,
    sourceSearchConfigs,
    extractors
  );

  if (!l1DealResult) {
    return searchResult;
  }

  return mergeL1AndSearchDealResults(l1DealResult, searchResult, workflowKey);
}

async function researchInstitutionFromSources(
  institution: string,
  workflowKey: WorkflowKey,
  sourceSearchConfigs: SourceSearchConfig[],
  extractors: ExtractorConfig[],
  queries = workflows[workflowKey].queries(institution)
): Promise<AutomationResearchResult> {
  const workflow = workflows[workflowKey];
  const sourceDiscovery = await discoverSources(
    institution,
    queries,
    sourceSearchConfigs,
    workflowKey
  );
  const sources = sourceDiscovery.sources;

  if (!sources.length) {
    return {
      fields: [],
      provider_errors: sourceDiscovery.providerErrors,
      source_candidates: sourceDiscovery.candidates,
      source_count: 0
    };
  }

  const input = {
    institution,
    fields: workflow.fields,
    prompt: workflow.prompt,
    sourceList: buildSourceList(sources)
  };

  if (workflow.requiresConsensus && extractors.length >= minimumConsensusVotes) {
    const result = await runConsensusExtraction(input, extractors, sources);

    return {
      ...result,
      provider_errors: [...sourceDiscovery.providerErrors, ...(result.provider_errors ?? [])],
      source_candidates: sourceDiscovery.candidates,
      source_count: sources.length
    };
  }

  if (workflow.sourceProfile === "deal-team" && extractors.length > 1) {
    const initialResult = await runDealTeamExtraction(input, extractors, sources);
    const followUpQueries = dealFollowUpQueries(institution, initialResult, workflowKey);

    if (!followUpQueries.length) {
      return {
        ...initialResult,
        provider_errors: [...sourceDiscovery.providerErrors, ...(initialResult.provider_errors ?? [])],
        source_candidates: sourceDiscovery.candidates,
        source_count: sources.length
      };
    }

    const followUpDiscovery = await discoverSources(
      institution,
      followUpQueries,
      sourceSearchConfigs,
      workflowKey
    );
    const combinedSources = mergeAndReindexSources([...sources, ...followUpDiscovery.sources], workflowKey);
    const hasNewFollowUpSources = hasAdditionalSources(sources, combinedSources);

    if (!hasNewFollowUpSources) {
      return {
        ...initialResult,
        provider_errors: mergeProviderErrors([
          ...sourceDiscovery.providerErrors,
          ...(initialResult.provider_errors ?? []),
          ...followUpDiscovery.providerErrors
        ]),
        source_candidates: mergeSourceCandidateDiagnostics([
          ...sourceDiscovery.candidates,
          ...markFollowUpSourceCandidates(followUpDiscovery.candidates)
        ]),
        source_count: sources.length
      };
    }

    const combinedInput = {
      institution,
      fields: workflow.fields,
      prompt: workflow.prompt,
      sourceList: buildSourceList(combinedSources)
    };
    const followUpResult = await runDealTeamExtraction(combinedInput, extractors, combinedSources);
    const result = mergeDealTeamResearchResults(initialResult, followUpResult, workflow.fields);

    return {
      ...result,
      candidate_diagnostics: mergeCandidateDiagnostics([
        ...(result.candidate_diagnostics ?? []),
        ...dealTeamFollowUpDiagnostics(initialResult, followUpResult)
      ]),
      provider_errors: mergeProviderErrors([
        ...sourceDiscovery.providerErrors,
        ...(initialResult.provider_errors ?? []),
        ...followUpDiscovery.providerErrors,
        ...(followUpResult.provider_errors ?? [])
      ]),
      source_candidates: mergeSourceCandidateDiagnostics([
        ...sourceDiscovery.candidates,
        ...markFollowUpSourceCandidates(followUpDiscovery.candidates)
      ]),
      source_count: combinedSources.length
    };
  }

  const response = await extractFields(input, extractors[0]);
  const parsed = parseJsonObject(response) as AutomationResearchResult;
  const result = attachSourceMetadata(parsed, sources, extractors[0].provider);

  return {
    ...result,
    provider_errors: [...sourceDiscovery.providerErrors, ...(result.provider_errors ?? [])],
    source_candidates: sourceDiscovery.candidates,
    source_count: sources.length
  };
}

function muniDealFactSelectColumns() {
  return [
    "auth_detail",
    "auth_type",
    "bc",
    "bond_counsel",
    "confidence",
    "deal_name",
    "deal_par_amount",
    "deal_sale_date",
    "deal_state_id",
    "deal_type",
    "issuer_id",
    "issuer_name_reported",
    "ma",
    "municipal_advisor",
    "record_id",
    "related_entity_name",
    "refunding_type",
    "source_excerpt",
    "source_layer",
    "source_title_primary",
    "source_url_primary",
    "underwriters",
    "uw"
  ].join(", ");
}

async function researchDealTeamFromL1(
  supabase: SupabaseServerClient,
  moduleKey: ModuleKey,
  recordId: string,
  institution: string
): Promise<AutomationResearchResult | null> {
  const selectColumns = muniDealFactSelectColumns();

  const { data, error } = await supabase
    .from("muni_deal_facts")
    .select(selectColumns)
    .eq("module", moduleKey)
    .eq("record_id", recordId)
    .eq("scope_included", true)
    .gte("deal_sale_date", `${minimumDealYear}-01-01`)
    .order("deal_sale_date", { ascending: false })
    .limit(2);

  if (error) {
    if (isMissingMuniPipelineTableError(error)) {
      return null;
    }

    return {
      candidate_diagnostics: [`L1 state filing lookup failed: ${error.message}`],
      fields: [],
      source_count: 0
    };
  }

  const rows = (data ?? []) as MuniDealFactRow[];
  const candidateRows = rows.length
    ? rows
    : await researchDealTeamFromL1ByInstitution(supabase, moduleKey, institution, selectColumns);

  if (!candidateRows.length) {
    return null;
  }

  const latestRows = latestSameDayDeals(candidateRows);
  const latestDeal = latestRows[0];

  if (!latestDeal) {
    return null;
  }

  const selectedDeal = latestRows.length > 1 ? selectBestL1Deal(latestRows, institution) : latestDeal;
  const enrichedLatestDeal = await enrichL1DealFromDebtWatch(selectedDeal);
  const fields = buildL1DealFields(enrichedLatestDeal, moduleKey);

  if (!fields.length) {
    return null;
  }

  return {
    candidate_diagnostics: [
      latestRows.length > 1
        ? `L1 found ${latestRows.length} same-day state filing deals for ${institution}; selected the strongest match: ${formatL1DealSummary(enrichedLatestDeal)}.`
        : `L1 state filing deal found for ${institution}: ${formatL1DealSummary(enrichedLatestDeal)}.`
    ],
    deal_follow_up_seeds: [
      {
        confidence: l1Confidence(enrichedLatestDeal),
        excerpt: l1EvidenceExcerpt(enrichedLatestDeal),
        source_title: l1SourceTitle(enrichedLatestDeal),
        source_url: l1SourceUrl(enrichedLatestDeal),
        value: formatL1DealSummary(enrichedLatestDeal)
      }
    ],
    fields,
    source_candidates: [l1SourceCandidate(enrichedLatestDeal, institution)],
    source_count: 1
  };
}

async function researchPlanDealFactsFromL1(
  supabase: SupabaseServerClient,
  moduleKey: ModuleKey,
  recordId: string,
  institution: string
): Promise<AutomationResearchResult | null> {
  const selectColumns = muniDealFactSelectColumns();

  const { data, error } = await supabase
    .from("muni_deal_facts")
    .select(selectColumns)
    .eq("module", moduleKey)
    .eq("record_id", recordId)
    .eq("scope_included", true)
    .gte("deal_sale_date", `${minimumDealYear}-01-01`)
    .order("deal_sale_date", { ascending: false })
    .limit(2);

  if (error) {
    if (isMissingMuniPipelineTableError(error)) {
      return null;
    }

    return {
      candidate_diagnostics: [`Plan deal fact lookup failed: ${error.message}`],
      fields: [],
      source_count: 0
    };
  }

  const rows = (data ?? []) as MuniDealFactRow[];
  const candidateRows = rows.length
    ? rows
    : await researchDealTeamFromL1ByInstitution(supabase, moduleKey, institution, selectColumns);

  if (!candidateRows.length) {
    return null;
  }

  const latestRows = latestSameDayDeals(candidateRows);
  const latestDeal = latestRows[0];

  if (!latestDeal) {
    return null;
  }

  const selectedDeal = latestRows.length > 1 ? selectBestL1Deal(latestRows, institution) : latestDeal;
  const enrichedLatestDeal = await enrichL1DealFromDebtWatch(selectedDeal);
  const fields = buildPlanDealFields(enrichedLatestDeal);

  if (!fields.length) {
    return null;
  }

  return {
    candidate_diagnostics: [
      latestRows.length > 1
        ? `Plan facts found ${latestRows.length} same-day CDIAC/DebtWatch deals for ${institution}; selected the strongest match: ${formatL1DealSummary(enrichedLatestDeal)}.`
        : `Plan facts found a CDIAC/DebtWatch deal for ${institution}: ${formatL1DealSummary(enrichedLatestDeal)}.`
    ],
    fields,
    source_candidates: [l1SourceCandidate(enrichedLatestDeal, institution)],
    source_count: 1
  };
}

async function researchCcdRefundingsFromL1(
  supabase: SupabaseServerClient,
  moduleKey: ModuleKey,
  recordId: string,
  institution: string
): Promise<AutomationResearchResult | null> {
  const selectColumns = muniDealFactSelectColumns();

  const { data, error } = await supabase
    .from("muni_deal_facts")
    .select(selectColumns)
    .eq("module", moduleKey)
    .eq("record_id", recordId)
    .eq("scope_included", true)
    .gte("deal_sale_date", `${minimumDealYear}-01-01`)
    .order("deal_sale_date", { ascending: false })
    .limit(12);

  if (error) {
    if (isMissingMuniPipelineTableError(error)) {
      return null;
    }

    return {
      candidate_diagnostics: [`CCD refunding lookup failed: ${error.message}`],
      fields: [],
      source_count: 0
    };
  }

  const rows = (data ?? []) as MuniDealFactRow[];
  const candidateRows = rows.length
    ? rows
    : (await researchDealTeamFromL1ByInstitution(supabase, moduleKey, institution, selectColumns)).slice(0, 12);

  if (!candidateRows.length) {
    return null;
  }

  const enrichedRows = await Promise.all(candidateRows.map(enrichL1DealFromDebtWatch));
  const refundingRows = enrichedRows
    .filter(isRefundingDealRow)
    .sort((left, right) => String(right.deal_sale_date ?? "").localeCompare(String(left.deal_sale_date ?? "")));
  const latestRefunding = refundingRows[0];

  if (!latestRefunding) {
    return {
      candidate_diagnostics: [
        `Checked ${candidateRows.length} recent CDIAC/DebtWatch deal fact${candidateRows.length === 1 ? "" : "s"} for ${institution}, but none had a supported Refunding Amount or refunding label.`
      ],
      fields: [],
      source_candidates: enrichedRows.slice(0, 5).map((row) => l1SourceCandidate(row, institution)),
      source_count: candidateRows.length
    };
  }

  const field = buildCcdRefundingsField(latestRefunding);

  if (!field) {
    return {
      candidate_diagnostics: [
        `Found a refunding deal for ${institution}, but it did not include a usable refunding or par amount.`
      ],
      fields: [],
      source_candidates: [l1SourceCandidate(latestRefunding, institution)],
      source_count: candidateRows.length
    };
  }

  return {
    candidate_diagnostics: [
      `Latest CDIAC/DebtWatch refunding found for ${institution}: ${field.value}.`
    ],
    fields: [field],
    source_candidates: [l1SourceCandidate(latestRefunding, institution)],
    source_count: candidateRows.length
  };
}

async function enrichL1DealFromDebtWatch(row: MuniDealFactRow): Promise<MuniDealFactRow> {
  const cdiacNumber = cleanL1Value(row.deal_state_id);

  if (!cdiacNumber) {
    return row;
  }

  const issueRecord = await fetchDebtWatchIssueRecord(cdiacNumber);

  if (!issueRecord) {
    return row;
  }

  return mergeDebtWatchIssueRecord(row, issueRecord, cdiacNumber);
}

async function researchDealTeamFromDebtWatchLastDeal(
  moduleKey: ModuleKey,
  institution: string,
  savedLastDeal: string
): Promise<AutomationResearchResult | null> {
  const lastDeal = savedLastDeal.trim();

  if (!lastDeal) {
    return null;
  }

  const directCdiacNumber = extractCdiacNumbers(lastDeal)[0];
  const directIssueRecord = directCdiacNumber ? await fetchDebtWatchIssueRecord(directCdiacNumber) : null;
  const searchedIssueRecords = directIssueRecord
    ? [directIssueRecord]
    : await searchDebtWatchIssuesForLastDeal(institution, lastDeal);
  const bestIssueRecord = chooseDebtWatchIssueRecord(searchedIssueRecords, institution, lastDeal);
  const cdiacNumber = debtWatchText(bestIssueRecord?.CDIACNumber);

  if (!bestIssueRecord || !cdiacNumber) {
    return null;
  }

  const deal = mergeDebtWatchIssueRecord(debtWatchIssueRecordToMuniDealFact(bestIssueRecord), bestIssueRecord, cdiacNumber);
  const fields = buildL1DealFields(deal, moduleKey);

  if (!fields.length) {
    return null;
  }

  return {
    candidate_diagnostics: [
      `DebtWatch issue search matched saved Last Deal for ${institution} to CDIAC ${cdiacNumber}: ${formatL1DealSummary(deal)}.`
    ],
    deal_follow_up_seeds: [
      {
        confidence: l1Confidence(deal),
        excerpt: l1EvidenceExcerpt(deal),
        source_title: l1SourceTitle(deal),
        source_url: l1SourceUrl(deal),
        value: formatL1DealSummary(deal)
      }
    ],
    fields,
    source_candidates: [l1SourceCandidate(deal, institution)],
    source_count: searchedIssueRecords.length
  };
}

function debtWatchIssueRecordToMuniDealFact(issueRecord: DebtWatchIssueRecord): MuniDealFactRow {
  return {
    confidence: "high",
    deal_name: firstString(issueRecord.IssueName, issueRecord.ProjectSeriesOrName),
    deal_par_amount: debtWatchNumber(issueRecord.PrincipalAmount),
    deal_sale_date: debtWatchDate(issueRecord.SaleDate),
    deal_state_id: debtWatchText(issueRecord.CDIACNumber),
    deal_type: debtWatchText(issueRecord.DebtType),
    issuer_name_reported: debtWatchText(issueRecord.Issuer),
    source_layer: "L1"
  };
}

async function searchDebtWatchIssuesForLastDeal(institution: string, lastDeal: string) {
  const queries = debtWatchIssueSearchQueries(institution, lastDeal);
  const settledResults = await Promise.allSettled(queries.map(searchDebtWatchIssues));
  const issueByCdiacNumber = new Map<string, DebtWatchIssueRecord>();

  settledResults.forEach((result) => {
    if (result.status !== "fulfilled") {
      return;
    }

    result.value.forEach((record) => {
      const cdiacNumber = debtWatchText(record.CDIACNumber);

      if (cdiacNumber) {
        issueByCdiacNumber.set(cdiacNumber, record);
      }
    });
  });

  return Array.from(issueByCdiacNumber.values());
}

function debtWatchIssueSearchQueries(institution: string, lastDeal: string) {
  const cleanedLastDeal = lastDealSearchPhrase(lastDeal);

  return uniqueStrings([
    ...extractCdiacNumbers(lastDeal),
    ...extractDealSeriesLabels(lastDeal),
    ...extractCfdLabels(lastDeal),
    ...dealFollowUpDealTerms(lastDeal),
    cleanedLastDeal,
    `${institution} ${cleanedLastDeal}`.trim()
  ])
    .filter((query) => query.length >= 4)
    .slice(0, 8);
}

async function searchDebtWatchIssues(query: string) {
  try {
    const response = await fetch(`${debtWatchApiBaseUrl}/dataset/issues/search`, {
      body: JSON.stringify({
        filters: {},
        pagination: {
          pageNumber: 1,
          pageSize: debtWatchIssueSearchPageSize
        },
        searchTerm: query,
        sorting: {
          ascending: false,
          columnId: "CDIACNumber"
        }
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 (compatible; K12TargetsResearch/1.0)"
      },
      method: "PUT",
      signal: AbortSignal.timeout(sourceFetchTimeoutMs)
    });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as DebtWatchIssueSearchResponse;

    return Array.isArray(data.records) ? data.records : [];
  } catch {
    return [];
  }
}

function chooseDebtWatchIssueRecord(
  issueRecords: DebtWatchIssueRecord[],
  institution: string,
  lastDeal: string
) {
  return issueRecords
    .map((record) => ({
      record,
      score: scoreDebtWatchIssueRecord(record, institution, lastDeal)
    }))
    .filter((candidate) => candidate.score >= 35)
    .sort((left, right) => right.score - left.score)[0]?.record ?? null;
}

function scoreDebtWatchIssueRecord(
  issueRecord: DebtWatchIssueRecord,
  institution: string,
  lastDeal: string
) {
  const cdiacNumber = debtWatchText(issueRecord.CDIACNumber);
  const normalizedEvidence = normalizeIdentityText(
    [
      issueRecord.Issuer,
      issueRecord.IssueName,
      issueRecord.ProjectSeriesOrName,
      issueRecord.DebtType
    ]
      .filter(Boolean)
      .join(" ")
  );
  const institutionMatch = dealEvidenceMentionsInstitution(normalizedEvidence, institution);
  const directCdiacMatch = cdiacNumber ? extractCdiacNumbers(lastDeal).includes(cdiacNumber) : false;

  if (!institutionMatch && !directCdiacMatch) {
    return 0;
  }

  const saleYear = Number(debtWatchDate(issueRecord.SaleDate)?.slice(0, 4));
  const lastDealYears = extractYears(lastDeal);
  const issueAmount = debtWatchNumber(issueRecord.PrincipalAmount);
  const lastDealAmounts = extractDealAmountNumbers(lastDeal);
  const normalizedIssueText = normalizeIdentityText(
    [issueRecord.IssueName, issueRecord.ProjectSeriesOrName, issueRecord.DebtType].filter(Boolean).join(" ")
  );
  const matchingSeriesLabels = extractDealSeriesLabels(lastDeal).filter((label) =>
    normalizedIssueText.includes(normalizeIdentityText(label))
  ).length;
  const matchingCfdLabels = extractCfdLabels(lastDeal).filter((label) =>
    normalizedIssueText.includes(normalizeIdentityText(label))
  ).length;
  const matchingDealTerms = dealFollowUpDealTerms(lastDeal).filter((term) =>
    normalizedIssueText.includes(normalizeIdentityText(term))
  ).length;
  const amountMatch = issueAmount !== null && lastDealAmounts.some((amount) => amountsAreClose(issueAmount, amount));

  return (
    (directCdiacMatch ? 100 : 0) +
    (institutionMatch ? 35 : 0) +
    (Number.isFinite(saleYear) && lastDealYears.includes(saleYear) ? 20 : 0) +
    (amountMatch ? 25 : 0) +
    matchingSeriesLabels * 18 +
    matchingCfdLabels * 20 +
    matchingDealTerms * 8
  );
}

async function researchAuthorizationFromDebtWatch(
  institution: string,
  lastDeal: string,
  extractors: ExtractorConfig[]
): Promise<AutomationResearchResult | null> {
  if (!lastDeal.trim()) {
    return null;
  }

  const matchedIssue = await findDebtWatchIssueForLastDeal(institution, lastDeal);

  if (!matchedIssue) {
    return {
      candidate_diagnostics: [
        `Could not match saved Last Deal "${lastDeal}" to a CDIAC/DebtWatch issue, so no CDIAC OS/POS was opened.`
      ],
      fields: [],
      source_count: 0
    };
  }

  const detail = await fetchDebtWatchIssuanceDetail(matchedIssue.cdiacNumber);

  if (!detail) {
    return {
      candidate_diagnostics: [
        `Matched saved Last Deal to CDIAC ${matchedIssue.cdiacNumber}, but the DebtWatch detail report could not be loaded.`
      ],
      fields: [],
      source_candidates: [debtWatchIssueSourceCandidate(matchedIssue.cdiacNumber, institution)],
      source_count: matchedIssue.searchedCount
    };
  }

  const adtrField = buildDebtWatchAuthorizationField(detail, matchedIssue.cdiacNumber);

  if (adtrField) {
    return {
      candidate_diagnostics: [
        `CDIAC ${matchedIssue.cdiacNumber} ADTR authorization records supplied remaining authorization from the latest reporting year.`
      ],
      fields: [adtrField],
      source_candidates: [debtWatchIssueSourceCandidate(matchedIssue.cdiacNumber, institution)],
      source_count: matchedIssue.searchedCount
    };
  }

  const osSources = debtWatchOfficialStatementSources(detail, matchedIssue.cdiacNumber);

  if (!osSources.length) {
    return {
      candidate_diagnostics: [
        `CDIAC ${matchedIssue.cdiacNumber} was matched, but DebtWatch documents did not include an OS/POS file type.`
      ],
      fields: [],
      source_candidates: [debtWatchIssueSourceCandidate(matchedIssue.cdiacNumber, institution)],
      source_count: matchedIssue.searchedCount
    };
  }

  if (!extractors.length) {
    return {
      candidate_diagnostics: [
        `CDIAC ${matchedIssue.cdiacNumber} has OS/POS documents, but no extractor is configured to read them.`
      ],
      fields: [],
      source_candidates: osSources.map((source) => sourceCandidateFromSearchSource(source, "kept")),
      source_count: osSources.length
    };
  }

  const expandedSources = await expandSources(osSources, "authorization");
  const input = {
    institution,
    fields: workflows.authorization.fields,
    prompt: workflows.authorization.prompt,
    sourceList: buildSourceList(expandedSources)
  };
  const response = await extractFields(input, extractors[0]);
  const parsed = parseJsonObject(response) as AutomationResearchResult;
  const result = attachSourceMetadata(parsed, expandedSources, extractors[0].provider);

  return {
    ...result,
    candidate_diagnostics: mergeCandidateDiagnostics([
      ...(result.candidate_diagnostics ?? []),
      `Opened ${osSources.length} CDIAC OS/POS document${osSources.length === 1 ? "" : "s"} for CDIAC ${matchedIssue.cdiacNumber}.`
    ]),
    source_candidates: osSources.map((source) => sourceCandidateFromSearchSource(source, "kept")),
    source_count: osSources.length
  };
}

async function findDebtWatchIssueForLastDeal(institution: string, lastDeal: string) {
  const directCdiacNumber = extractCdiacNumbers(lastDeal)[0];
  const directIssueRecord = directCdiacNumber ? await fetchDebtWatchIssueRecord(directCdiacNumber) : null;
  const searchedIssueRecords = directIssueRecord
    ? [directIssueRecord]
    : await searchDebtWatchIssuesForLastDeal(institution, lastDeal);
  const bestIssueRecord = chooseDebtWatchIssueRecord(searchedIssueRecords, institution, lastDeal);
  const cdiacNumber = debtWatchText(bestIssueRecord?.CDIACNumber);

  if (!bestIssueRecord || !cdiacNumber) {
    return null;
  }

  return {
    cdiacNumber,
    issueRecord: bestIssueRecord,
    searchedCount: searchedIssueRecords.length
  };
}

function buildDebtWatchAuthorizationField(
  detail: DebtWatchIssuanceDetailResponse,
  cdiacNumber: string
): AutomationFieldResult | null {
  const recordSets = detail.datasetById?.["adtr-auths"]?.recordSets ?? [];
  const authRows = recordSets.flatMap((recordSet) =>
    (recordSet.records ?? []).map((record) => ({
      record,
      reportingYear: Number(record.ADTRReportingYearEnd ?? recordSet.reportingYearId)
    }))
  );
  const latestReportingYear = Math.max(0, ...authRows.map((row) => row.reportingYear).filter(Number.isFinite));
  const latestRows = authRows
    .filter((row) => row.reportingYear === latestReportingYear)
    .filter((row) => {
      const remainingAmount = debtWatchNumber(row.record.AuthAmountEndPeriod);

      return remainingAmount !== null && remainingAmount >= 0;
    });

  if (!latestRows.length) {
    return null;
  }

  const value = latestRows
    .map((row) => {
      const authName = debtWatchText(row.record.AuthName) ?? "Authorization";
      const remainingAmount = formatAuthorizationAmount(row.record.AuthAmountEndPeriod);

      return `${authName}: ${remainingAmount} remaining as of ${row.reportingYear} CDIAC ADTR`;
    })
    .join("; ");
  const excerpt = latestRows
    .map((row) => {
      const authName = debtWatchText(row.record.AuthName) ?? "Authorization";
      const originalAmount = formatAuthorizationAmount(row.record.AuthOriginalAmount);
      const issuedAmount = formatAuthorizationAmount(row.record.AuthIssuance);
      const remainingAmount = formatAuthorizationAmount(row.record.AuthAmountEndPeriod);

      return `${authName}: original authorization ${originalAmount || "n/a"}; issued ${issuedAmount || "n/a"}; remaining authorization/end-period amount ${remainingAmount}; reporting year ${row.reportingYear}.`;
    })
    .join(" ");

  return {
    confidence: 0.94,
    excerpt,
    field_key: "Auth",
    source_context: "CDIAC DebtWatch ADTR authorization records",
    source_title: `CDIAC DebtWatch ADTR authorization ${cdiacNumber}`,
    source_url: debtWatchIssueReportUrl(cdiacNumber),
    value
  };
}

function formatAuthorizationAmount(value: unknown) {
  const amount = debtWatchNumber(value);

  if (amount === null) {
    return "";
  }

  return amount === 0 ? "$0" : formatParAmount(amount);
}

function debtWatchOfficialStatementSources(detail: DebtWatchIssuanceDetailResponse, cdiacNumber: string): SearchSource[] {
  const documents = detail.datasetById?.documents?.records ?? [];

  return documents
    .filter(isOfficialStatementDocument)
    .slice(0, 4)
    .map((document, index) => {
      const documentType = debtWatchText(document.DocumentType) ?? "OS/POS";
      const fileName = debtWatchText(document.DocumentFileName) ?? `CDIAC document ${document.DocumentId ?? index + 1}`;
      const url = debtWatchText(document.DocumentFileURL) ?? "";
      const saleDate = formatPlanSaleDate(debtWatchDate(document.SaleDate));
      const principalAmount = formatParAmount(debtWatchNumber(document.PrincipalAmount));

      return {
        index: index + 1,
        snippet: [
          `CDIAC ${cdiacNumber}`,
          documentType,
          fileName,
          saleDate ? `Sale date ${saleDate}` : "",
          principalAmount ? `Principal amount ${principalAmount}` : "",
          "Read for remaining/unissued authorization table."
        ]
          .filter(Boolean)
          .join("; "),
        title: `CDIAC ${documentType}: ${fileName}`,
        url
      };
    })
    .filter((source) => Boolean(source.url));
}

function isOfficialStatementDocument(document: DebtWatchDocumentRecord) {
  const haystack = normalizeIdentityText(
    [document.DocumentType, document.DocumentFileName].filter(Boolean).join(" ")
  );

  return hasAnyPhrase(haystack, [
    "official statement",
    "preliminary official statement",
    "pos",
    "offering document"
  ]);
}

function debtWatchIssueSourceCandidate(cdiacNumber: string, institution: string): SourceCandidateDiagnostic {
  const url = debtWatchIssueReportUrl(cdiacNumber);

  return {
    category: "cdiac_debtwatch",
    reason: `Matched ${institution} saved Last Deal to CDIAC ${cdiacNumber}.`,
    score: 100,
    snippet: `CDIAC ${cdiacNumber} issue detail.`,
    status: "kept",
    title: `CDIAC DebtWatch issue ${cdiacNumber}`,
    url
  };
}

function sourceCandidateFromSearchSource(
  source: SearchSource,
  status: SourceCandidateDiagnostic["status"]
): SourceCandidateDiagnostic {
  return {
    category: dealSourceCategory(source),
    reason: "Kept because CDIAC document file type is OS/POS.",
    score: scoreSource(source, "authorization"),
    snippet: trimText(source.snippet, 280),
    status,
    title: trimText(source.title, 110),
    url: source.url
  };
}

function k12AuthorizationQueries(district: string) {
  const aliases = k12SearchAliases(district);
  const primaryAlias = aliases[0] ?? district;
  const years = ["2026", "2025", "2024", "2023"];
  const recentOfficialStatementQueries = years.flatMap((year) => [
    `${primaryAlias} ${year} official statement remaining authorization unissued authorization`,
    `${primaryAlias} ${year} preliminary official statement unissued GO bond authorization`
  ]);

  return uniqueStrings([
    `${primaryAlias} official statement remaining unissued GO bond authorization`,
    `${primaryAlias} preliminary official statement remaining authorization table`,
    `${primaryAlias} EMMA official statement remaining authorization unissued authorization`,
    `${primaryAlias} POS PDF unissued authorization remaining authorization`,
    `${primaryAlias} "authorization remaining" "official statement"`,
    `${primaryAlias} "authorized but unissued" "official statement"`,
    `${primaryAlias} "remaining authorization" "GO bonds"`,
    `${primaryAlias} "unissued authorization" "GO bonds"`,
    `${primaryAlias} bond program remaining unissued authorization`,
    `${primaryAlias} GO bond elections unissued authorization outstanding`,
    ...recentOfficialStatementQueries
  ]);
}

function authorizationQueriesForLastDeal(institution: string, savedLastDeal: string, baseQueries: string[]) {
  const lastDeal = savedLastDeal.trim();

  if (!lastDeal) {
    return baseQueries;
  }

  const latestYear = Math.max(0, ...extractYears(lastDeal));
  const amount = lastDeal.match(/\$\s?\d[\d,]*(?:\.\d+)?\s?(?:million|mm|m)?/i)?.[0] ?? "";
  const dealKind = hasAnyPhrase(normalizeIdentityText(lastDeal), ["ref", "refunding"]) ? "refunding" : "new money";
  const lastDealQueries = [
    `${institution} ${lastDeal} official statement remaining authorization`,
    latestYear ? `${institution} ${latestYear} official statement unissued authorization remaining authorization` : "",
    latestYear ? `${institution} ${latestYear} preliminary official statement authorized but unissued` : "",
    amount ? `${institution} ${amount} official statement remaining authorization` : "",
    `${institution} ${dealKind} bonds official statement remaining authorization`
  ].filter(Boolean);

  return uniqueStrings([...lastDealQueries, ...baseQueries]);
}

function extractCdiacNumbers(value: string) {
  return uniqueStrings(Array.from(value.matchAll(/\b20\d{2}-\d{4}\b/g)).map((match) => match[0]));
}

function lastDealSearchPhrase(value: string) {
  return value
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+20\d{2}\b/gi, " ")
    .replace(/\$\s?\d+(?:\.\d+)?\s?(?:m|mm|million)?/gi, " ")
    .replace(/\b\d+(?:\.\d+)?\s?(?:m|mm|million)\b/gi, " ")
    .replace(/[-–—|:,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDealAmountNumbers(value: string) {
  return Array.from(value.matchAll(/\$\s?(\d+(?:\.\d+)?)\s?(m|mm|million)?/gi))
    .map((match) => {
      const amount = Number(match[1]);

      if (!Number.isFinite(amount)) {
        return null;
      }

      return match[2] ? amount * 1_000_000 : amount;
    })
    .filter((amount): amount is number => amount !== null);
}

function amountsAreClose(left: number, right: number) {
  const denominator = Math.max(Math.abs(left), Math.abs(right), 1);

  return Math.abs(left - right) / denominator <= 0.02;
}

async function fetchDebtWatchIssueRecord(cdiacNumber: string) {
  const data = await fetchDebtWatchIssuanceDetail(cdiacNumber);

  return data?.datasetById?.issues?.record ?? null;
}

async function fetchDebtWatchIssuanceDetail(cdiacNumber: string) {
  try {
    const response = await fetch(
      `${debtWatchApiBaseUrl}/report/issuance-detail-with-history/${encodeURIComponent(cdiacNumber)}`,
      {
        headers: {
          accept: "application/json",
          "user-agent": "Mozilla/5.0 (compatible; K12TargetsResearch/1.0)"
        },
        signal: AbortSignal.timeout(sourceFetchTimeoutMs)
      }
    );

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as DebtWatchIssuanceDetailResponse;

    return data;
  } catch {
    return null;
  }
}

function mergeDebtWatchIssueRecord(
  row: MuniDealFactRow,
  issueRecord: DebtWatchIssueRecord,
  cdiacNumber: string
): MuniDealFactRow {
  const reportedCdiacNumber = debtWatchText(issueRecord.CDIACNumber) ?? cdiacNumber;
  const reportedMa = debtWatchText(issueRecord.FinancialOrMunicipalAdvisor);
  const reportedUw = debtWatchText(issueRecord.LeadUnderwriter);
  const reportedBc = debtWatchText(issueRecord.BondCounsel);
  const reportedSaleDate = debtWatchDate(issueRecord.SaleDate);
  const reportedParAmount = debtWatchNumber(issueRecord.PrincipalAmount);
  const reportedRefundingAmount = debtWatchNumber(issueRecord.RefundingAmount);
  const merged: MuniDealFactRow = {
    ...row,
    bc: reportedBc ?? row.bc,
    bond_counsel: reportedBc ?? row.bond_counsel,
    deal_name: firstString(issueRecord.IssueName, issueRecord.ProjectSeriesOrName, row.deal_name),
    deal_par_amount: row.deal_par_amount ?? reportedParAmount,
    deal_sale_date: row.deal_sale_date ?? reportedSaleDate,
    deal_state_id: row.deal_state_id ?? reportedCdiacNumber,
    deal_type: row.deal_type ?? debtWatchText(issueRecord.DebtType),
    issuer_name_reported: firstString(row.issuer_name_reported, issueRecord.Issuer),
    ma: reportedMa ?? row.ma,
    municipal_advisor: reportedMa ?? row.municipal_advisor,
    refunding_amount: reportedRefundingAmount ?? row.refunding_amount,
    source_layer: row.source_layer ?? "L1",
    source_title_primary: `CDIAC DebtWatch report ${reportedCdiacNumber}`,
    source_url_primary: debtWatchIssueReportUrl(reportedCdiacNumber),
    underwriters: reportedUw ? [{ name: reportedUw }] : row.underwriters,
    uw: reportedUw ?? row.uw
  };

  return {
    ...merged,
    source_excerpt: debtWatchIssueEvidenceExcerpt(merged)
  };
}

function debtWatchText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function debtWatchDate(value: unknown) {
  const text = debtWatchText(value);

  return text ? text.slice(0, 10) : null;
}

function debtWatchNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const numberValue = Number(value.replace(/[$,]/g, "").trim());

  return Number.isFinite(numberValue) ? numberValue : null;
}

function debtWatchIssueReportUrl(cdiacNumber: string) {
  return `${debtWatchIssueDetailBaseUrl}?cdiacNumber=${encodeURIComponent(cdiacNumber)}`;
}

function debtWatchIssueEvidenceExcerpt(row: MuniDealFactRow) {
  const ma = firstL1Value(row.ma, row.municipal_advisor);
  const uw = firstL1Value(row.uw) ?? formatUnderwriters(row.underwriters);
  const bc = firstL1Value(row.bc, row.bond_counsel);

  return [
    "CDIAC DebtWatch Reports Section",
    row.deal_state_id ? `CDIAC Number: ${row.deal_state_id}` : "",
    firstL1Value(row.issuer_name_reported) ? `Reported issuer: ${firstL1Value(row.issuer_name_reported)}` : "",
    firstL1Value(row.deal_name) ? `Issue name: ${firstL1Value(row.deal_name)}` : "",
    row.deal_sale_date ? `Sale date: ${row.deal_sale_date}` : "",
    row.deal_par_amount ? `Par: ${formatParAmount(row.deal_par_amount)}` : "",
    row.refunding_amount ? `Refunding Amount: ${formatParAmount(row.refunding_amount)}` : "",
    uw ? `Lead Underwriter: ${uw}` : "",
    ma ? `Financial/Municipal Advisor: ${ma}` : "",
    bc ? `Bond Counsel: ${bc}` : ""
  ]
    .filter(Boolean)
    .join("; ");
}

async function researchDealTeamFromL1ByInstitution(
  supabase: SupabaseServerClient,
  moduleKey: ModuleKey,
  institution: string,
  selectColumns: string
) {
  const { data, error } = await supabase
    .from("muni_deal_facts")
    .select(selectColumns)
    .eq("module", moduleKey)
    .eq("scope_included", true)
    .gte("deal_sale_date", `${minimumDealYear}-01-01`)
    .order("deal_sale_date", { ascending: false })
    .limit(5000);

  if (error) {
    if (isMissingMuniPipelineTableError(error)) {
      return [];
    }

    throw new Error(`L1 state filing issuer-name lookup failed: ${error.message}`);
  }

  return filterL1DealRowsForInstitution((data ?? []) as MuniDealFactRow[], institution);
}

function filterL1DealRowsForInstitution(rows: MuniDealFactRow[], institution: string) {
  return rows
    .map((row) => ({
      row,
      score: l1InstitutionMatchScore(row, institution)
    }))
    .filter(({ score }) => score >= 10)
    .sort((left, right) => {
      const dateCompare = String(right.row.deal_sale_date ?? "").localeCompare(String(left.row.deal_sale_date ?? ""));

      if (dateCompare) {
        return dateCompare;
      }

      const scoreCompare = right.score - left.score;

      if (scoreCompare) {
        return scoreCompare;
      }

      return l1ParAmount(right.row) - l1ParAmount(left.row);
    })
    .map(({ row }) => row);
}

function selectBestL1Deal(rows: MuniDealFactRow[], institution: string) {
  return [...rows].sort((left, right) => {
    const scoreCompare = l1InstitutionMatchScore(right, institution) - l1InstitutionMatchScore(left, institution);

    if (scoreCompare) {
      return scoreCompare;
    }

    const parCompare = l1ParAmount(right) - l1ParAmount(left);

    if (parCompare) {
      return parCompare;
    }

    return String(left.deal_state_id ?? "").localeCompare(String(right.deal_state_id ?? ""));
  })[0];
}

function l1InstitutionMatchScore(row: MuniDealFactRow, institution: string) {
  const normalizedEvidence = l1NormalizedEvidence(row);

  if (dealEvidenceMentionsInstitution(normalizedEvidence, institution)) {
    return 100 + l1SchoolFinanceScore(normalizedEvidence);
  }

  const coreAliases = l1InstitutionCoreAliases(institution);
  const matchedCoreAlias = coreAliases.find((alias) => normalizedEvidence.includes(alias));

  if (!matchedCoreAlias) {
    return 0;
  }

  const coreTokenCount = matchedCoreAlias.split(" ").length;
  const schoolFinanceScore = l1SchoolFinanceScore(normalizedEvidence);

  if (coreTokenCount === 1 && matchedCoreAlias.length < 7) {
    return 0;
  }

  if (schoolFinanceScore < 4) {
    return 0;
  }

  return 8 + Math.min(coreTokenCount, 4) * 2 + schoolFinanceScore;
}

function l1NormalizedEvidence(row: MuniDealFactRow) {
  return normalizeIdentityText(
    [
      row.record_id,
      row.issuer_id,
      row.issuer_name_reported,
      row.related_entity_name,
      row.deal_name,
      row.source_excerpt
    ]
      .filter(Boolean)
      .join(" ")
  );
}

function l1InstitutionCoreAliases(institution: string) {
  const aliases = uniqueStrings([
    institution,
    ...k12SearchAliases(institution),
    ...ccdSearchAliases(institution)
  ]);
  const suffixPhrases = [
    "joint union high school district",
    "joint unified school district",
    "union high school district",
    "unified school district",
    "elementary school district",
    "high school district",
    "city school district",
    "community college district",
    "school district",
    "public financing authority",
    "financing authority",
    "district",
    "usd",
    "juhsd",
    "jushd",
    "jusd",
    "uhsd",
    "hsd",
    "esd",
    "csd",
    "sd",
    "ccd"
  ];

  return uniqueStrings(
    aliases
      .map(normalizeIdentityText)
      .flatMap((alias) => {
        const stripped = suffixPhrases.reduce(
          (value, suffix) => value.replace(new RegExp(`\\b${suffix}\\b`, "g"), " "),
          alias
        );

        return [alias, normalizeIdentityText(stripped)];
      })
      .filter((alias) => alias.length >= 7)
  );
}

function l1SchoolFinanceScore(normalizedEvidence: string) {
  return keywordScore(normalizedEvidence, [
    ["school district", 8],
    ["unified school district", 8],
    ["elementary school district", 7],
    ["high school district", 7],
    ["union high school district", 7],
    ["joint unified school district", 7],
    ["joint union high school district", 7],
    ["school facilities", 6],
    ["general obligation", 5],
    ["public financing authority", 5],
    ["school financing", 5],
    ["school finance", 5],
    ["community facilities district", 4],
    ["special tax", 4],
    ["cfd", 3],
    ["sfid", 3],
    ["education", 2],
    ["bond", 2],
    ["bonds", 2],
    ["refunding", 2]
  ]);
}

function l1ParAmount(row: MuniDealFactRow) {
  const numericValue = Number(row.deal_par_amount);

  return Number.isFinite(numericValue) ? numericValue : 0;
}

function isMissingMuniPipelineTableError(error: { code?: string; message?: string }) {
  return error.code === "42P01" || /muni_deal_facts|relation .* does not exist/i.test(error.message ?? "");
}

function latestSameDayDeals(rows: MuniDealFactRow[]) {
  const sortedRows = [...rows].sort((left, right) =>
    String(right.deal_sale_date ?? "").localeCompare(String(left.deal_sale_date ?? ""))
  );
  const latestSaleDate = sortedRows[0]?.deal_sale_date;

  if (!latestSaleDate) {
    return sortedRows.slice(0, 1);
  }

  return sortedRows.filter((row) => row.deal_sale_date === latestSaleDate);
}

function buildL1DealFields(row: MuniDealFactRow, moduleKey: ModuleKey): AutomationFieldResult[] {
  const sourceTitle = l1SourceTitle(row);
  const sourceUrl = l1SourceUrl(row);
  const excerpt = l1EvidenceExcerpt(row);
  const confidence = l1Confidence(row);
  const common = {
    confidence,
    excerpt,
    package_context: excerpt,
    providers: [] as ExtractorProvider[],
    source_context: "L1 state filing database",
    source_title: sourceTitle,
    source_url: sourceUrl
  };
  const underwriterFieldKey = moduleKey === "ccd-targets" ? "Underwriter" : "UW";
  const fieldValues: Array<[string, string | null]> = [
    ["Last Deal", formatL1DealSummary(row)],
    ["MA", formatDealTeamValue("MA", firstL1Value(row.ma, row.municipal_advisor))],
    [underwriterFieldKey, formatDealTeamValue(underwriterFieldKey, firstL1Value(row.uw) ?? formatUnderwriters(row.underwriters))],
    ["BC", formatDealTeamValue("BC", firstL1Value(row.bc, row.bond_counsel))]
  ];

  return fieldValues.flatMap(([fieldKey, value]) => {
    if (!value) {
      return [];
    }

    return [
      {
        ...common,
        field_key: fieldKey,
        value
      }
    ];
  });
}

function buildPlanDealFields(row: MuniDealFactRow): AutomationFieldResult[] {
  const sourceTitle = l1SourceTitle(row);
  const sourceUrl = l1SourceUrl(row);
  const excerpt = l1EvidenceExcerpt(row);
  const common = {
    confidence: l1Confidence(row),
    excerpt,
    package_context: excerpt,
    providers: [] as ExtractorProvider[],
    source_context: "L1 state filing database",
    source_title: sourceTitle,
    source_url: sourceUrl
  };
  const dealName = cleanL1Value(row.deal_name) ?? formatL1DealSummary(row);
  const fieldValues: Array<[string, string | null]> = [
    ["MA", formatDealTeamValue("MA", firstL1Value(row.ma, row.municipal_advisor))],
    ["Deal", dealName],
    ["Date", formatPlanSaleDate(row.deal_sale_date)],
    ["Par ($M)", formatParAmount(row.deal_par_amount) || null]
  ];

  return fieldValues.flatMap(([fieldKey, value]) => {
    if (!value) {
      return [];
    }

    return [
      {
        ...common,
        field_key: fieldKey,
        value
      }
    ];
  });
}

function buildCcdRefundingsField(row: MuniDealFactRow): AutomationFieldResult | null {
  const value = formatCcdRefundingSummary(row);

  if (!value) {
    return null;
  }

  return {
    confidence: l1Confidence(row),
    excerpt: l1EvidenceExcerpt(row),
    field_key: "Refundings",
    package_context: l1EvidenceExcerpt(row),
    providers: [],
    source_context: "CDIAC/DebtWatch refunding deal facts",
    source_title: l1SourceTitle(row),
    source_url: l1SourceUrl(row),
    value
  };
}

function isRefundingDealRow(row: MuniDealFactRow) {
  const refundingAmount = l1RefundingAmount(row);

  if (refundingAmount !== null) {
    return refundingAmount > 0;
  }

  const normalizedEvidence = normalizeIdentityText(
    [row.refunding_type, row.deal_name, row.deal_type, row.source_excerpt].filter(Boolean).join(" ")
  );

  return hasAnyPhrase(normalizedEvidence, ["refunding", "refunded", "refund "]);
}

function l1RefundingAmount(row: MuniDealFactRow) {
  return debtWatchNumber(row.refunding_amount);
}

function formatCcdRefundingSummary(row: MuniDealFactRow) {
  const saleDate = formatSaleMonthYear(row.deal_sale_date);
  const refundingAmount = l1RefundingAmount(row);
  const amount = formatParAmount(refundingAmount !== null && refundingAmount > 0 ? refundingAmount : row.deal_par_amount);

  if (!saleDate && !amount) {
    return null;
  }

  return [saleDate, amount ? `${amount} Refunding` : "Refunding"].filter(Boolean).join(" / ");
}

function formatPlanSaleDate(value: string | null | undefined) {
  const cleaned = cleanL1Value(value);

  if (!cleaned) {
    return null;
  }

  const match = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (!match) {
    return cleaned;
  }

  return `${match[1]}/${match[2]}/${match[3]}`;
}

function formatL1DealSummary(row: MuniDealFactRow) {
  return formatLastDealParts({
    dealName: row.deal_name,
    dealType: row.deal_type,
    parAmount: row.deal_par_amount,
    refundingType: row.refunding_type,
    saleDate: row.deal_sale_date
  });
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

function formatUnderwriters(value: unknown) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return cleanL1Value(value);
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const names = value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }

      if (entry && typeof entry === "object" && "name" in entry) {
        return String(entry.name ?? "");
      }

      return "";
    })
    .map(cleanL1Value)
    .filter((name): name is string => Boolean(name));

  return names.length ? uniqueStrings(names).join("; ") : null;
}

function cleanL1Value(value: string | null | undefined) {
  const normalizedValue = value?.replace(/\s+/g, " ").trim();

  return normalizedValue && normalizedValue !== "-" ? normalizedValue : null;
}

function firstL1Value(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const cleanedValue = cleanL1Value(value);

    if (cleanedValue) {
      return cleanedValue;
    }
  }

  return null;
}

function l1SourceTitle(row: MuniDealFactRow) {
  const sourceLayer = row.source_layer?.trim() || "L1";
  const stateId = row.deal_state_id?.trim();

  return cleanL1Value(row.source_title_primary) ?? (stateId ? `${sourceLayer} state filing ${stateId}` : `${sourceLayer} state filing`);
}

function l1SourceUrl(row: MuniDealFactRow) {
  return cleanL1Value(row.source_url_primary) ?? "https://debtwatch.treasurer.ca.gov/";
}

function l1Confidence(row: MuniDealFactRow) {
  const confidence = row.confidence?.toLowerCase().trim();

  if (confidence === "high") {
    return 0.96;
  }

  if (confidence === "medium") {
    return 0.84;
  }

  if (confidence === "low") {
    return 0.72;
  }

  return 0.9;
}

function l1EvidenceExcerpt(row: MuniDealFactRow) {
  const sourceExcerpt = cleanL1Value(row.source_excerpt);

  if (sourceExcerpt) {
    return sourceExcerpt;
  }

  return [
    `Layer: ${row.source_layer ?? "L1"}`,
    cleanL1Value(row.issuer_name_reported) ? `Reported issuer: ${cleanL1Value(row.issuer_name_reported)}` : "",
    cleanL1Value(row.related_entity_name) ? `Related entity: ${cleanL1Value(row.related_entity_name)}` : "",
    row.deal_state_id ? `State ID: ${row.deal_state_id}` : "",
    row.deal_sale_date ? `Sale date: ${row.deal_sale_date}` : "",
    row.deal_par_amount ? `Par: ${formatParAmount(row.deal_par_amount)}` : "",
    firstL1Value(row.ma, row.municipal_advisor)
      ? `Municipal Advisor: ${firstL1Value(row.ma, row.municipal_advisor)}`
      : "",
    firstL1Value(row.uw) ?? formatUnderwriters(row.underwriters)
      ? `Underwriter: ${firstL1Value(row.uw) ?? formatUnderwriters(row.underwriters)}`
      : "",
    firstL1Value(row.bc, row.bond_counsel) ? `Bond Counsel: ${firstL1Value(row.bc, row.bond_counsel)}` : ""
  ]
    .filter(Boolean)
    .join("; ");
}

function l1SourceCandidate(row: MuniDealFactRow, institution: string): SourceCandidateDiagnostic {
  const title = l1SourceTitle(row);

  return {
    category: "cdiac_debtwatch",
    reason: `Kept because ${institution} has a ${row.source_layer ?? "L1"} state filing deal record.`,
    score: 100,
    snippet: l1EvidenceExcerpt(row),
    status: "kept",
    title,
    url: l1SourceUrl(row)
  };
}

function hasCompleteDealTeamPackage(workflowKey: WorkflowKey, result: AutomationResearchResult) {
  const fieldKeys = new Set((result.fields ?? []).map((field) => field.field_key));

  return dealTeamRoleFields(workflowKey).every((fieldKey) => fieldKeys.has(fieldKey));
}

function dealTeamRoleFields(workflowKey: WorkflowKey) {
  return workflows[workflowKey].fields.filter((fieldKey) => fieldKey !== "Last Deal" && isDealTeamField(fieldKey));
}

function allDealTeamRoleFields() {
  return ["MA", "UW", "Underwriter", "BC"];
}

function dealTeamFieldList(workflowKey: WorkflowKey) {
  return dealTeamRoleFields(workflowKey).join("/");
}

function mergeL1AndSearchDealResults(
  l1Result: AutomationResearchResult,
  searchResult: AutomationResearchResult,
  workflowKey: WorkflowKey
): AutomationResearchResult {
  const merged = mergeDealTeamResearchResults(l1Result, searchResult, dealTeamRoleFields(workflowKey));

  return {
    ...merged,
    candidate_diagnostics: mergeCandidateDiagnostics([
      ...(l1Result.candidate_diagnostics ?? []),
      ...(searchResult.candidate_diagnostics ?? [])
    ]),
    provider_errors: mergeProviderErrors([...(l1Result.provider_errors ?? []), ...(searchResult.provider_errors ?? [])]),
    source_candidates: mergeSourceCandidateDiagnostics([
      ...(l1Result.source_candidates ?? []),
      ...(searchResult.source_candidates ?? [])
    ]),
    source_count: (l1Result.source_count ?? 0) + (searchResult.source_count ?? 0)
  };
}

function buildSourceList(sources: SearchSource[]) {
  return sources
    .map((source) => `[${source.index}] ${source.title}\nURL: ${source.url}\nEvidence: ${source.snippet}`)
    .join("\n\n");
}

function dealFollowUpQueries(institution: string, result: AutomationResearchResult, workflowKey: WorkflowKey) {
  const seeds = result.deal_follow_up_seeds?.length
    ? result.deal_follow_up_seeds
    : (result.fields ?? [])
        .filter((field) => field.field_key === "Last Deal" && field.value?.trim())
        .map((field) => ({
          confidence: normalizeConfidence(field.confidence) ?? undefined,
          excerpt: field.excerpt,
          source_title: field.source_title,
          source_url: field.source_url,
          value: field.value?.trim() ?? ""
        }));

  if (!seeds.length) {
    return [];
  }

  const aliases = (workflows[workflowKey].module === "ccd-targets"
    ? ccdSearchAliases(institution)
    : k12SearchAliases(institution)).slice(0, 4);
  const queries = seeds.flatMap((seed) => {
    const value = seed.value.trim();
    const sourceTitle = seed.source_title?.trim() ?? "";
    const years = extractYears(value).filter((year) => year >= minimumDealYear);
    const searchYears = years.length ? years : [2026, 2025, 2024, 2023];
    const searchableDealText = `${value} ${sourceTitle} ${seed.excerpt ?? ""}`;
    const amounts = extractDealAmounts(searchableDealText);
    const seriesLabels = extractDealSeriesLabels(searchableDealText);
    const dateLabels = extractDealDateLabels(searchableDealText);
    const dealTerms = dealFollowUpDealTerms(searchableDealText);
    const cfdLabels = extractCfdLabels(searchableDealText);

    return aliases.flatMap((alias) => [
      `${alias} ${value} official statement municipal advisor underwriter bond counsel`,
      sourceTitle ? `${alias} ${sourceTitle} municipal advisor underwriter bond counsel` : "",
      `${alias} ${value} official statement PDF`,
      `${alias} ${value} financing team bond counsel underwriter municipal advisor`,
      `${alias} ${value} public finance transactions`,
      `${alias} ${value} recent financings`,
      `${alias} ${value} CDIAC DebtWatch`,
      `${alias} ${value} EMMA official statement`,
      `${alias} ${value} board agenda minutes financing team`,
      `${alias} ${value} authorization refunding official statement`,
      `${alias} ${value} bond purchase agreement preliminary official statement`,
      `${alias} ${value} sale date principal amount financing participants`,
      ...cfdLabels.flatMap((cfdLabel) => [
        `"${alias}" "${cfdLabel}" "Official Statement"`,
        `"${alias}" "${cfdLabel}" "Municipal Advisor"`,
        `"${alias}" "${cfdLabel}" "Underwriter"`,
        `"${alias}" "${cfdLabel}" "Bond Counsel"`,
        `"${alias}" "${cfdLabel}" "Financing Team"`,
        `"${alias}" "${cfdLabel}" "authorization"`,
        `"${alias}" "${cfdLabel}" "refunding"`
      ]),
      ...dateLabels.flatMap((dateLabel) => [
        `"${alias}" "${dateLabel}" "official statement"`,
        `"${alias}" "${dateLabel}" "municipal advisor"`,
        `"${alias}" "${dateLabel}" "underwriter"`,
        `"${alias}" "${dateLabel}" "bond counsel"`,
        `"${alias}" "${dateLabel}" "agenda" "bonds"`,
        `"${alias}" "${dateLabel}" "minutes" "financing"`
      ]),
      ...searchYears.flatMap((year) => [
        `"${alias}" "${year}" "Official Statement" "Municipal Advisor"`,
        `"${alias}" "${year}" "Preliminary Official Statement" "Underwriter"`,
        `"${alias}" "${year}" "Bond Counsel" "Underwriter"`,
        `"${alias}" "${year}" "Official Statement" "PDF"`,
        `"${alias}" "${year}" "Public Finance Transactions"`,
        `"${alias}" "${year}" "Recent Financings"`,
        `"${alias}" "${year}" "CDIAC" "Municipal Advisor"`,
        `"${alias}" "${year}" "EMMA" "Official Statement"`,
        `"${alias}" "${year}" "board minutes" "bond counsel"`,
        `"${alias}" "${year}" "agenda minutes" "financing team"`,
        `"${alias}" "${year}" "staff report" "underwriter"`,
        `"${alias}" "${year}" "authorization" "refunding"`
      ]),
      ...amounts.flatMap((amount) => [
        `"${alias}" "${amount}" "Official Statement"`,
        `"${alias}" "${amount}" "Bond Counsel"`,
        `"${alias}" "${amount}" "Underwriter"`,
        `"${alias}" "${amount}" "Municipal Advisor"`,
        `"${alias}" "${amount}" "CDIAC"`,
        `"${alias}" "${amount}" "bond purchase agreement"`
      ]),
      ...seriesLabels.flatMap((seriesLabel) => [
        `"${alias}" "${seriesLabel}" "Official Statement"`,
        `"${alias}" "${seriesLabel}" "Municipal Advisor"`,
        `"${alias}" "${seriesLabel}" "Underwriter"`,
        `"${alias}" "${seriesLabel}" "Bond Counsel"`,
        `"${alias}" "${seriesLabel}" "authorization"`,
        `"${alias}" "${seriesLabel}" "refunding"`
      ]),
      ...dealTerms.flatMap((term) => [
        `"${alias}" "${term}" "Official Statement"`,
        `"${alias}" "${term}" "board minutes"`,
        `"${alias}" "${term}" "financing team"`,
        `"${alias}" "${term}" "municipal advisor"`,
        `"${alias}" "${term}" "bond counsel"`
      ])
    ]);
  });

  return uniqueStrings(queries).slice(0, maxDealFollowUpQueries);
}

function extractCfdLabels(value: string) {
  const labels = Array.from(value.matchAll(/\b(?:CFD|Community Facilities District)\s*(?:No\.?|Number)?\s*[\w.-]+/gi))
    .map((match) => match[0].replace(/\s+/g, " ").trim())
    .filter((label) => /\d/.test(label));

  return uniqueStrings(
    labels.flatMap((label) => {
      const number = label.match(/\d[\w.-]*/)?.[0];

      if (!number) {
        return [label];
      }

      return [label, `CFD No. ${number}`, `Community Facilities District No. ${number}`];
    })
  ).slice(0, 6);
}

function extractDealAmounts(value: string) {
  return uniqueStrings(
    Array.from(value.matchAll(/\$\s?\d+(?:\.\d+)?\s?(?:m|mm|million)?/gi)).map((match) =>
      match[0].replace(/\s+/g, " ").trim()
    )
  ).slice(0, 3);
}

function extractDealSeriesLabels(value: string) {
  return uniqueStrings(
    [
      ...Array.from(value.matchAll(/\b(?:series\s*)?20\d{2}[- ]?[A-Z]?\b/gi)).map((match) =>
        match[0].replace(/\s+/g, " ").trim()
      ),
      ...Array.from(value.matchAll(/\bseries\s+[0-9A-Z][0-9A-Z.-]*(?:\s+[A-Z][0-9A-Z.-]*)?\b/gi)).map((match) =>
        match[0].replace(/\s+/g, " ").trim()
      )
    ]
  ).slice(0, 4);
}

function extractDealDateLabels(value: string) {
  const monthPattern =
    /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+20\d{2}\b/gi;
  const matches = Array.from(value.matchAll(monthPattern)).map((match) =>
    normalizeDealDateLabel(match[0])
  );

  return uniqueStrings(matches).slice(0, 4);
}

function normalizeDealDateLabel(value: string) {
  const normalizedValue = value.replace(".", "").replace(/\s+/g, " ").trim();
  const [month = "", year = ""] = normalizedValue.split(" ");
  const monthMap: Record<string, string> = {
    apr: "Apr",
    april: "Apr",
    aug: "Aug",
    august: "Aug",
    dec: "Dec",
    december: "Dec",
    feb: "Feb",
    february: "Feb",
    jan: "Jan",
    january: "Jan",
    jul: "Jul",
    july: "Jul",
    jun: "Jun",
    june: "Jun",
    mar: "Mar",
    march: "Mar",
    may: "May",
    nov: "Nov",
    november: "Nov",
    oct: "Oct",
    october: "Oct",
    sep: "Sep",
    sept: "Sep",
    september: "Sep"
  };

  return `${monthMap[month.toLowerCase()] ?? month} ${year}`.trim();
}

function dealFollowUpDealTerms(value: string) {
  const normalizedValue = normalizeIdentityText(value);
  const terms: string[] = [];

  if (hasAnyPhrase(normalizedValue, ["cfd", "community facilities district"])) {
    terms.push("Community Facilities District", "CFD", "Special Tax Bonds");
  }

  if (hasAnyPhrase(normalizedValue, ["sfid", "school facilities improvement district"])) {
    terms.push("School Facilities Improvement District", "SFID");
  }

  if (hasAnyPhrase(normalizedValue, ["ref", "refunding"])) {
    terms.push("Refunding Bonds");
  }

  if (hasAnyPhrase(normalizedValue, ["new money", "general obligation"]) || /\bGO\b/.test(value)) {
    terms.push("General Obligation Bonds", "New Money");
  }

  return uniqueStrings(terms).slice(0, 5);
}

function mergeAndReindexSources(sources: SearchSource[], workflowKey: WorkflowKey) {
  const sourceMap = new Map<string, SearchSource>();

  sources.forEach((source) => mergeSourcesIntoMap(sourceMap, [source], workflowKey));

  return Array.from(sourceMap.values())
    .sort((left, right) => scoreSource(right, workflowKey) - scoreSource(left, workflowKey))
    .slice(0, mergedSourceLimit(workflowKey))
    .map((source, index) => ({
      ...source,
      index: index + 1
    }));
}

function hasAdditionalSources(originalSources: SearchSource[], combinedSources: SearchSource[]) {
  const originalKeys = new Set(originalSources.map((source) => canonicalSourceKey(source.url)));

  return combinedSources.some((source) => !originalKeys.has(canonicalSourceKey(source.url)));
}

function chooseBetterDealTeamResearchResult(
  initialResult: AutomationResearchResult,
  followUpResult: AutomationResearchResult
) {
  return dealTeamResearchScore(followUpResult) > dealTeamResearchScore(initialResult)
    ? followUpResult
    : initialResult;
}

function mergeDealTeamResearchResults(
  initialResult: AutomationResearchResult,
  followUpResult: AutomationResearchResult,
  allowedFields: readonly string[] = allDealTeamRoleFields()
): AutomationResearchResult {
  const bestResult = chooseBetterDealTeamResearchResult(initialResult, followUpResult);
  const mergedFields = bestDealFields(
    [...(initialResult.fields ?? []), ...(followUpResult.fields ?? [])],
    allowedFields
  );
  const mergedSeeds = mergeDealFollowUpSeeds([
    ...(initialResult.deal_follow_up_seeds ?? []),
    ...(followUpResult.deal_follow_up_seeds ?? [])
  ]);

  return {
    ...bestResult,
    deal_follow_up_seeds: mergedSeeds,
    fields: mergedFields
  };
}

function mergeDealFollowUpSeeds(seeds: DealFollowUpSeed[]) {
  const seedMap = new Map<string, DealFollowUpSeed>();

  seeds.forEach((seed) => {
    const key = normalizeComparableValue(seed.value);
    const existingSeed = seedMap.get(key);

    if (!existingSeed || (seed.confidence ?? 0) > (existingSeed.confidence ?? 0)) {
      seedMap.set(key, seed);
    }
  });

  return Array.from(seedMap.values()).slice(0, 3);
}

function dealTeamResearchScore(result: AutomationResearchResult) {
  const fields = result.fields ?? [];
  const keys = new Set(fields.map((field) => field.field_key).filter(Boolean));
  const participantCount = allDealTeamRoleFields().filter((fieldKey) => keys.has(fieldKey)).length;
  const recencyScore = Math.max(0, ...fields.map(candidateDealYearScore));
  const averageConfidence =
    fields.reduce((sum, field) => sum + (normalizeConfidence(field.confidence) ?? 0), 0) /
    Math.max(fields.length, 1);

  return recencyScore + fields.length * 20 + participantCount * 8 + averageConfidence;
}

function dealTeamFollowUpDiagnostics(
  initialResult: AutomationResearchResult,
  followUpResult: AutomationResearchResult
) {
  const initialKeys = new Set((initialResult.fields ?? []).map((field) => field.field_key));
  const followUpKeys = new Set((followUpResult.fields ?? []).map((field) => field.field_key));
  const gainedFields = allDealTeamRoleFields().filter(
    (fieldKey) => followUpKeys.has(fieldKey) && !initialKeys.has(fieldKey)
  );

  if (!gainedFields.length) {
    return ["Follow-up search ran, but did not find additional supported deal-team role evidence."];
  }

  return [`Follow-up search added supported field evidence for ${gainedFields.join(", ")}.`];
}

function markFollowUpSourceCandidates(candidates: SourceCandidateDiagnostic[]) {
  return candidates.map((candidate) => ({
    ...candidate,
    reason: `Follow-up after Last Deal candidate: ${candidate.reason}`
  }));
}

function mergeSourceCandidateDiagnostics(candidates: SourceCandidateDiagnostic[]) {
  const statusRank = { kept: 3, not_selected: 2, excluded: 1 } satisfies Record<SourceCandidateDiagnostic["status"], number>;
  const candidateMap = new Map<string, SourceCandidateDiagnostic>();

  candidates.forEach((candidate) => {
    const key = canonicalSourceKey(candidate.url);
    const existingCandidate = candidateMap.get(key);

    if (
      !existingCandidate ||
      statusRank[candidate.status] > statusRank[existingCandidate.status] ||
      (statusRank[candidate.status] === statusRank[existingCandidate.status] && candidate.score > existingCandidate.score)
    ) {
      candidateMap.set(key, candidate);
    }
  });

  return Array.from(candidateMap.values())
    .sort((left, right) => {
      const statusOrder = { kept: 0, not_selected: 1, excluded: 2 } satisfies Record<SourceCandidateDiagnostic["status"], number>;
      const statusCompare = statusOrder[left.status] - statusOrder[right.status];

      if (statusCompare !== 0) {
        return statusCompare;
      }

      return right.score - left.score;
    })
    .slice(0, maxDealTeamSourceCandidateDiagnostics);
}

function mergeProviderErrors(providerErrors: ProviderError[]) {
  const errorMap = new Map<string, ProviderError>();

  providerErrors.forEach((providerError) => {
    errorMap.set(`${providerError.provider}::${providerError.error}`, providerError);
  });

  return Array.from(errorMap.values());
}

function mergeCandidateDiagnostics(candidateDiagnostics: string[]) {
  return uniqueStrings(candidateDiagnostics).slice(0, 10);
}

async function searchSources(query: string, apiKey: string): Promise<SearchSource[]> {
  const response = await fetch("https://api.perplexity.ai/search", {
    body: JSON.stringify({
      query,
      max_results: maxSourcesPerQuery,
      search_context_size: "high"
    }),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Perplexity source search failed with ${response.status}`);
  }

  const data = (await response.json()) as { data?: RawSearchResult[]; results?: RawSearchResult[] };
  const rawResults = Array.isArray(data.results) ? data.results : Array.isArray(data.data) ? data.data : [];

  return sourcesFromRawResults(rawResults);
}

async function discoverSources(
  institution: string,
  queries: string[],
  sourceSearchConfigs: SourceSearchConfig[],
  workflowKey: WorkflowKey
): Promise<SourceDiscoveryResult> {
  const providerErrors: ProviderError[] = [];
  const mergedSources = new Map<string, SearchSource>();
  const perplexityConfig = sourceSearchConfigs.find((config) => config.provider === "perplexity");

  if (perplexityConfig) {
    const settledResults = await Promise.allSettled(
      queries.map((query) => searchSources(query, perplexityConfig.apiKey))
    );

    settledResults.forEach((result) => {
      if (result.status === "fulfilled") {
        mergeSourcesIntoMap(mergedSources, result.value, workflowKey);
        return;
      }

      providerErrors.push({
        error: `Source search: ${normalizeErrorMessage(result.reason)}`,
        provider: "perplexity"
      });
    });
  }

  if (shouldRunAssistantSourceSearch(workflowKey, mergedSources)) {
    const assistantConfigs = sourceSearchConfigs.filter((config) => config.provider !== "perplexity");
    const assistantResults = await Promise.allSettled(
      assistantConfigs.map((config) => searchSourcesWithAssistant(institution, queries, workflowKey, config))
    );

    assistantResults.forEach((result, index) => {
      const provider = assistantConfigs[index]?.provider ?? "openai";

      if (result.status === "fulfilled") {
        mergeSourcesIntoMap(mergedSources, result.value, workflowKey);
        return;
      }

      providerErrors.push({
        error: `Source search: ${normalizeErrorMessage(result.reason)}`,
        provider
      });
    });
  }

  const allSources = Array.from(mergedSources.values());
  const matchedSources = filterSourcesForInstitution(allSources, institution, workflowKey);
  const matchedSourceKeys = new Set(matchedSources.map((source) => canonicalSourceKey(source.url)));
  const rankedSources = matchedSources.sort((left, right) => scoreSource(right, workflowKey) - scoreSource(left, workflowKey));
  const sourceLimit = mergedSourceLimit(workflowKey);
  const selectedSourceKeys = new Set(rankedSources.slice(0, sourceLimit).map((source) => canonicalSourceKey(source.url)));
  const candidates = buildSourceCandidateDiagnostics(
    allSources,
    matchedSourceKeys,
    selectedSourceKeys,
    institution,
    workflowKey
  );
  const sortedSources = rankedSources
    .slice(0, sourceLimit)
    .map((source, index) => ({
      ...source,
      index: index + 1,
      snippet: trimText(source.snippet, 900)
    }));

  return {
    candidates,
    providerErrors,
    sources: await expandSources(sortedSources, workflowKey)
  };
}

function buildSourceCandidateDiagnostics(
  sources: SearchSource[],
  matchedSourceKeys: Set<string>,
  selectedSourceKeys: Set<string>,
  institution: string,
  workflowKey: WorkflowKey
): SourceCandidateDiagnostic[] {
  return sources
    .map((source) => {
      const sourceKey = canonicalSourceKey(source.url);
      const score = scoreSource(source, workflowKey);
      const status: SourceCandidateDiagnostic["status"] = selectedSourceKeys.has(sourceKey)
        ? "kept"
        : matchedSourceKeys.has(sourceKey)
          ? "not_selected"
          : "excluded";

      return {
        category: sourceCandidateCategory(source, workflowKey),
        reason: sourceCandidateReason(source, status, institution, workflowKey),
        score,
        snippet: trimText(source.snippet, 280),
        status,
        title: trimText(source.title, 110),
        url: source.url
      };
    })
    .sort((left, right) => {
      const statusOrder = { kept: 0, not_selected: 1, excluded: 2 } satisfies Record<SourceCandidateDiagnostic["status"], number>;
      const statusCompare = statusOrder[left.status] - statusOrder[right.status];

      if (statusCompare !== 0) {
        return statusCompare;
      }

      return right.score - left.score;
    })
    .slice(0, sourceCandidateDiagnosticLimit(workflowKey));
}

function sourceCandidateDiagnosticLimit(workflowKey: WorkflowKey) {
  return workflows[workflowKey].sourceProfile === "deal-team"
    ? maxDealTeamSourceCandidateDiagnostics
    : maxSourceCandidateDiagnostics;
}

function sourceCandidateReason(
  source: SearchSource,
  status: SourceCandidateDiagnostic["status"],
  institution: string,
  workflowKey: WorkflowKey
) {
  if (status === "kept") {
    if (workflows[workflowKey].sourceProfile === "authorization") {
      return `Ranked as ${sourceCategoryLabel(sourceCandidateCategory(source, workflowKey))}; kept only if it can support remaining/unissued authorization.`;
    }

    if (workflows[workflowKey].sourceProfile === "deal-team") {
      return `Ranked as ${sourceCategoryLabel(sourceCandidateCategory(source, workflowKey))}; kept for PDF/page reading and extraction.`;
    }

    return "Kept for extraction.";
  }

  if (status === "not_selected") {
    if (workflows[workflowKey].sourceProfile === "authorization") {
      return `Matched the district, but ranked below stronger CDIAC/OS/POS remaining-authorization sources.`;
    }

    if (workflows[workflowKey].sourceProfile === "deal-team") {
      return `Matched the institution as ${sourceCategoryLabel(sourceCandidateCategory(source, workflowKey))}, but ranked below the top ${mergedSourceLimit(workflowKey)} sources for extraction.`;
    }

    return `Matched the institution, but ranked below the top ${mergedSourceLimit(workflowKey)} sources for extraction.`;
  }

  const sourceProfile = workflows[workflowKey].sourceProfile;

  if (sourceProfile === "k12-leadership" || sourceProfile === "deal-team" || sourceProfile === "authorization") {
    const sourceHost = sourceHostName(source.url);
    const entityName = workflows[workflowKey].module === "ccd-targets" ? "CCD" : "district";
    const domains = workflows[workflowKey].module === "ccd-targets"
      ? ccdSearchDomains(institution)
      : k12SearchDomains(institution);

    if (domains.length && !domains.some((domain) => sourceHost === domain || sourceHost.endsWith(`.${domain}`))) {
      return `Excluded because the URL is outside known ${entityName} domains and the text did not include an exact ${entityName} alias.`;
    }

    return `Excluded because the title/snippet/URL did not include an exact ${entityName} alias.`;
  }

  return "Excluded by source filtering.";
}

function sourceCandidateCategory(source: SearchSource, workflowKey: WorkflowKey): SourceCandidateCategory {
  const sourceProfile = workflows[workflowKey].sourceProfile;

  return sourceProfile === "deal-team" || sourceProfile === "authorization"
    ? dealSourceCategory(source)
    : "supplemental";
}

function dealSourceCategory(source: SearchSource): SourceCandidateCategory {
  const haystack = `${source.title} ${source.url} ${source.snippet}`.toLowerCase();
  const host = sourceHostName(source.url);
  const pathname = safeUrlPathname(source.url);
  const looksLikePdf = pathname.endsWith(".pdf") || haystack.includes(".pdf");
  const hasOfficialStatement =
    haystack.includes("official statement") ||
    haystack.includes("preliminary official statement") ||
    /\bpos\b/.test(haystack);

  if (host.includes("emma.msrb.org") || (looksLikePdf && hasOfficialStatement) || haystack.includes("offering document")) {
    return "emma_os_pos";
  }

  if (host.includes("cdiac") || host.includes("debtwatch") || haystack.includes("cdiac") || haystack.includes("debtwatch")) {
    return "cdiac_debtwatch";
  }

  if (
    haystack.includes("board agenda") ||
    haystack.includes("agenda packet") ||
    haystack.includes("agenda item") ||
    haystack.includes("board minutes") ||
    haystack.includes("meeting minutes") ||
    haystack.includes("agenda minutes") ||
    haystack.includes("staff report") ||
    haystack.includes("resolution")
  ) {
    return "board_materials";
  }

  if (
    host.includes("bondlink") ||
    host.includes("munios") ||
    haystack.includes("public finance transactions") ||
    haystack.includes("recent financings") ||
    haystack.includes("upcoming and recent financings") ||
    haystack.includes("piper sandler") ||
    haystack.includes("keygent") ||
    haystack.includes("fieldman") ||
    haystack.includes("dale scott")
  ) {
    return "transaction_pages";
  }

  if (host.includes(".k12.ca.us") || host.endsWith(".edu") || host.endsWith(".org")) {
    return "issuer_site";
  }

  return "supplemental";
}

function dealSourceCategoryScore(category: SourceCandidateCategory) {
  const scoreByCategory = {
    board_materials: 14,
    cdiac_debtwatch: 18,
    emma_os_pos: 24,
    issuer_site: 8,
    supplemental: 0,
    transaction_pages: 10
  } satisfies Record<SourceCandidateCategory, number>;

  return scoreByCategory[category];
}

function sourceCategoryLabel(category: SourceCandidateCategory) {
  const labelByCategory = {
    board_materials: "board materials",
    cdiac_debtwatch: "CDIAC/DebtWatch",
    emma_os_pos: "EMMA/OS/POS",
    issuer_site: "issuer site",
    supplemental: "supplemental",
    transaction_pages: "transaction pages"
  } satisfies Record<SourceCandidateCategory, string>;

  return labelByCategory[category];
}

function safeUrlPathname(rawUrl: string) {
  try {
    return new URL(rawUrl).pathname.toLowerCase();
  } catch {
    return rawUrl.toLowerCase();
  }
}

function mergeSourcesIntoMap(
  mergedSources: Map<string, SearchSource>,
  sources: SearchSource[],
  workflowKey: WorkflowKey
) {
  sources.forEach((source) => {
    const sourceKey = canonicalSourceKey(source.url);
    const existingSource = mergedSources.get(sourceKey);

    if (!existingSource) {
      mergedSources.set(sourceKey, source);
      return;
    }

    if (scoreSource(source, workflowKey) > scoreSource(existingSource, workflowKey)) {
      mergedSources.set(sourceKey, {
        ...source,
        snippet: mergeSourceSnippets(source.snippet, existingSource.snippet)
      });
      return;
    }

    mergedSources.set(sourceKey, {
      ...existingSource,
      snippet: mergeSourceSnippets(existingSource.snippet, source.snippet)
    });
  });
}

function shouldRunAssistantSourceSearch(workflowKey: WorkflowKey, mergedSources: Map<string, SearchSource>) {
  if (
    workflows[workflowKey].sourceProfile === "authorization" ||
    workflows[workflowKey].sourceProfile === "ccd-leadership" ||
    workflows[workflowKey].sourceProfile === "deal-team" ||
    workflows[workflowKey].sourceProfile === "k12-leadership"
  ) {
    return true;
  }

  return mergedSources.size < 4;
}

function sourceSearchDomains(institution: string, workflowKey: WorkflowKey) {
  const sourceProfile = workflows[workflowKey].sourceProfile;
  const moduleKey = workflows[workflowKey].module;

  if (sourceProfile === "ccd-leadership") {
    return ccdSearchDomains(institution);
  }

  if (sourceProfile === "deal-team" && moduleKey === "ccd-targets") {
    return ccdSearchDomains(institution);
  }

  if (sourceProfile === "k12-leadership") {
    return k12SearchDomains(institution);
  }

  if (sourceProfile === "deal-team") {
    return [];
  }

  return [];
}

function filterSourcesForInstitution(sources: SearchSource[], institution: string, workflowKey: WorkflowKey) {
  const sourceProfile = workflows[workflowKey].sourceProfile;
  const moduleKey = workflows[workflowKey].module;

  if (sourceProfile === "ccd-leadership") {
    return sources.filter((source) => sourceMatchesCcdInstitution(source, institution));
  }

  if (sourceProfile === "deal-team" && moduleKey === "ccd-targets") {
    return sources.filter((source) => sourceMatchesCcdInstitution(source, institution));
  }

  if (sourceProfile === "authorization") {
    return sources.filter((source) => sourceMatchesK12Institution(source, institution));
  }

  if (sourceProfile !== "k12-leadership" && sourceProfile !== "deal-team") {
    return sources;
  }

  return sources.filter((source) => sourceMatchesK12Institution(source, institution));
}

function sourceMatchesCcdInstitution(source: SearchSource, target: string) {
  const haystack = normalizeIdentityText(`${source.title} ${source.url} ${source.snippet}`);
  const rejectPhrases = ccdSearchRejectPhrases(target).map(normalizeIdentityText).filter(Boolean);

  if (rejectPhrases.some((phrase) => haystack.includes(phrase))) {
    return false;
  }

  const domains = ccdSearchDomains(target);
  const sourceHost = sourceHostName(source.url);

  if (domains.some((domain) => sourceHost === domain || sourceHost.endsWith(`.${domain}`))) {
    return true;
  }

  const aliases = ccdSearchAliases(target)
    .map(normalizeIdentityText)
    .filter((alias) => alias.length >= 4);

  return aliases.some((alias) => haystack.includes(alias));
}

function sourceMatchesK12Institution(source: SearchSource, district: string) {
  const domains = k12SearchDomains(district);
  const sourceHost = sourceHostName(source.url);

  if (domains.some((domain) => sourceHost === domain || sourceHost.endsWith(`.${domain}`))) {
    return true;
  }

  const haystack = normalizeIdentityText(`${source.title} ${source.url} ${source.snippet}`);
  const aliases = k12SearchAliases(district).map(normalizeIdentityText).filter(Boolean);

  return aliases.some((alias) => haystack.includes(alias));
}

async function searchSourcesWithAssistant(
  institution: string,
  queries: string[],
  workflowKey: WorkflowKey,
  config: SourceSearchConfig
): Promise<SearchSource[]> {
  if (config.provider === "openai") {
    return searchSourcesWithOpenAI(institution, queries, workflowKey, config);
  }

  if (config.provider === "anthropic") {
    return searchSourcesWithAnthropic(institution, queries, workflowKey, config);
  }

  return [];
}

async function searchSourcesWithOpenAI(
  institution: string,
  queries: string[],
  workflowKey: WorkflowKey,
  config: SourceSearchConfig
) {
  const domains = sourceSearchDomains(institution, workflowKey);
  const response = await fetch("https://api.openai.com/v1/responses", {
    body: JSON.stringify({
      include: ["web_search_call.action.sources"],
      input: buildAssistantSourceSearchPrompt(institution, queries, workflowKey),
      max_output_tokens: workflows[workflowKey].sourceProfile === "deal-team" ? 3000 : 1800,
      model: config.model,
      tool_choice: "required",
      tools: [
        {
          type: "web_search",
          ...(domains.length ? { filters: { allowed_domains: domains } } : {})
        }
      ]
    }),
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `OpenAI source search failed with ${response.status}`);
  }

  const data = await response.json();
  const text = extractOpenAIResponseText(data);

  return extractOpenAISourceSearchSources(data, text, workflowKey);
}

async function searchSourcesWithAnthropic(
  institution: string,
  queries: string[],
  workflowKey: WorkflowKey,
  config: SourceSearchConfig
) {
  const domains = sourceSearchDomains(institution, workflowKey);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    body: JSON.stringify({
      max_tokens: 1800,
      messages: [
        {
          role: "user",
          content: buildAssistantSourceSearchPrompt(institution, queries, workflowKey)
        }
      ],
      model: config.model,
      temperature: 0,
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: workflows[workflowKey].sourceProfile === "ccd-leadership" ? 8 : 4,
          ...(domains.length ? { allowed_domains: domains } : {})
        }
      ]
    }),
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": config.apiKey
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Anthropic source search failed with ${response.status}`);
  }

  const data = (await response.json()) as { content?: Array<{ text?: string; type?: string }> };
  const text = data.content?.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n") ?? "";

  return parseAssistantSourceSearchResult(text);
}

function buildAssistantSourceSearchPrompt(institution: string, queries: string[], workflowKey: WorkflowKey) {
  const profileInstruction = sourceSearchProfileInstruction(workflowKey);

  return `${profileInstruction}

Institution: ${institution}
Search queries to try:
${queries.map((query) => `- ${query}`).join("\n")}

Return JSON only in this exact shape:
{"sources":[{"title":"page title","url":"https://example.edu/page","snippet":"short evidence summary"}]}

Rules:
- Return at most 10 high-quality sources.
- Do not include LinkedIn, Wikipedia, Facebook, YouTube, or generic school ranking pages.
- Use official/current sources when possible.
- For deal-team research, use this path: find deal candidates, rank EMMA/OS/POS PDFs first, use CDIAC/DebtWatch for deal discovery, use official institution agenda/minutes/staff reports/resolutions for approval and role evidence, then use transaction pages/BondLink/MuniOS as support. Include sources likely to contain MA, underwriter, bond counsel, sale date, par amount, authorization, and new money/refunding details.
- If no source is found, return {"sources":[]}.`;
}

function sourceSearchProfileInstruction(workflowKey: WorkflowKey) {
  const workflow = workflows[workflowKey];
  const sourceProfile = workflow.sourceProfile;

  if (sourceProfile === "ccd-leadership") {
    return "Find official current California community college district leadership source pages for Chancellor/President/Superintendent and CFO/equivalent finance executive. Prefer official district or college .edu pages, cabinet pages, administration pages, staff directories, organizational charts, and ACBO/CBO listings.";
  }

  if (sourceProfile === "deal-team" && workflow.module === "ccd-targets") {
    return "Find high-quality public finance sources for recent California community college district bond/debt transactions, authorizations, refundings, and deal teams. Use an EMMA/OS/POS-first path when reachable: EMMA disclosure pages, Official Statement PDFs, POS PDFs, and bond PDFs are strongest. Use CDIAC/DebtWatch to discover or confirm deal records. Use official district board agenda packets, staff reports, resolutions, BondLink, and MuniOS as supporting sources. Sources must clearly relate to the exact requested community college district.";
  }

  if (sourceProfile === "deal-team") {
    return "Find high-quality public finance sources for recent California school district bond/debt transactions, including district-related CFD/SFID/special-tax bonds, authorizations, refundings, and deal teams. Use an EMMA/OS/POS-first path when reachable: EMMA disclosure pages, Official Statement PDFs, POS PDFs, and bond PDFs are strongest. Use CDIAC/DebtWatch to discover or confirm deal records. Use district board agenda packets, board minutes, agenda-minutes packets, staff reports, and resolutions to confirm financing team, authorization, refunding, or sale approval. Use public-finance transaction pages, BondLink, and MuniOS as supporting sources. Sources must clearly relate to the exact requested district or a CFD/SFID explicitly named for that district.";
  }

  if (sourceProfile === "authorization") {
    return "Find current remaining/unissued GO bond authorization evidence for a California school district. Prefer CDIAC/DebtWatch issue detail documents where DocumentType/FileType is Official Statement, Preliminary Official Statement, POS, or Offering Document, especially for the latest saved Last Deal. Also use recent official statements, POS PDFs, EMMA/offering documents, or current bond program pages that explicitly state remaining/unissued authorization. Do not use old election or ballot measure documents as final support unless they also state remaining/unissued authorization.";
  }

  return "Find official current source pages that can support the requested public finance workbook fields.";
}

function extractOpenAIResponseText(data: unknown) {
  if (typeof data === "object" && data !== null && "output_text" in data && typeof data.output_text === "string") {
    return data.output_text;
  }

  const output: unknown[] = typeof data === "object" && data !== null && "output" in data && Array.isArray(data.output)
    ? data.output
    : [];

  return output
    .flatMap((item) => {
      if (typeof item !== "object" || item === null || !("content" in item) || !Array.isArray(item.content)) {
        return [];
      }

      const content = item.content as unknown[];

      return content.flatMap((part) => {
        if (typeof part !== "object" || part === null) {
          return [];
        }

        if ("text" in part && typeof part.text === "string") {
          return [part.text];
        }

        return [];
      });
    })
    .join("\n");
}

function parseAssistantSourceSearchResult(content: string) {
  if (!content.trim()) {
    return [];
  }

  const parsed = parseJsonObject(content) as { sources?: RawSearchResult[] };
  const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];

  return sourcesFromRawResults(rawSources);
}

function extractOpenAISourceSearchSources(data: unknown, content: string, workflowKey: WorkflowKey) {
  return dedupeAndReindexSources([
    ...parseAssistantSourceSearchResultSafely(content),
    ...sourcesFromRawResults(collectRawSearchResults(data)),
    ...extractSourcesFromTextUrls(content)
  ]).slice(0, assistantSourceResultLimit(workflowKey));
}

function assistantSourceResultLimit(workflowKey: WorkflowKey) {
  return workflows[workflowKey].sourceProfile === "deal-team" ? maxAssistantDealTeamSources : maxSourcesPerQuery;
}

function parseAssistantSourceSearchResultSafely(content: string) {
  try {
    return parseAssistantSourceSearchResult(content);
  } catch {
    return [];
  }
}

function sourcesFromRawResults(rawResults: RawSearchResult[]) {
  return rawResults
    .map((result) => {
      const url = firstString(result.url, result.link, result.uri);

      return {
        title: firstString(result.title, result.name, result.source) || sourceTitleFromUrl(url),
        url,
        snippet: firstString(result.snippet, result.description, result.content, result.summary, result.text)
      };
    })
    .filter((result) => result.title && result.url && isUsableSource(result.url))
    .map((result) => ({
      ...result,
      snippet: result.snippet || result.title
    }))
    .slice(0, maxSourcesPerQuery)
    .map((result, index) => ({
      ...result,
      index: index + 1
    }));
}

function collectRawSearchResults(value: unknown, depth = 0): RawSearchResult[] {
  if (depth > 10) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectRawSearchResults(item, depth + 1));
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const url = firstString(record.url, record.link, record.uri);
  const self = url && isUsableSource(url) ? [record as RawSearchResult] : [];
  const childSources = Object.values(record).flatMap((childValue) =>
    collectRawSearchResults(childValue, depth + 1)
  );

  return [...self, ...childSources];
}

function extractSourcesFromTextUrls(content: string) {
  if (!content.trim()) {
    return [];
  }

  const matches = Array.from(content.matchAll(/https?:\/\/[^\s"'<>)}\]]+/g));

  return dedupeAndReindexSources(
    matches
      .map((match) => {
        const url = match[0].replace(/[.,;:]+$/, "");

        return {
          index: 1,
          title: sourceTitleFromUrl(url),
          url,
          snippet: sourceLineForUrl(content, match.index ?? 0)
        };
      })
      .filter((source) => isUsableSource(source.url))
  ).slice(0, maxSourcesPerQuery);
}

function dedupeAndReindexSources(sources: SearchSource[]) {
  const sourceMap = new Map<string, SearchSource>();

  sources.forEach((source) => {
    const key = canonicalSourceKey(source.url);
    const existingSource = sourceMap.get(key);

    if (!existingSource) {
      sourceMap.set(key, source);
      return;
    }

    sourceMap.set(key, {
      ...existingSource,
      snippet: mergeSourceSnippets(existingSource.snippet, source.snippet)
    });
  });

  return Array.from(sourceMap.values()).map((source, index) => ({
    ...source,
    index: index + 1
  }));
}

function sourceLineForUrl(content: string, index: number) {
  const lineStart = Math.max(content.lastIndexOf("\n", index) + 1, 0);
  const lineEnd = content.indexOf("\n", index);
  const line = content.slice(lineStart, lineEnd === -1 ? content.length : lineEnd).trim();

  return trimText(line || "Source returned by OpenAI web search.", 500);
}

function sourceTitleFromUrl(rawUrl: string) {
  if (!rawUrl) {
    return "";
  }

  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    const path = url.pathname
      .split("/")
      .filter(Boolean)
      .slice(-2)
      .join(" / ");

    return path ? `${host} / ${decodeURIComponent(path)}` : host;
  } catch {
    return "";
  }
}

async function expandSources(sources: SearchSource[], workflowKey: WorkflowKey): Promise<SearchSource[]> {
  const expandableSources = sources
    .filter((source) => isExpandableSource(source.url))
    .sort((left, right) => scoreSource(right, workflowKey) - scoreSource(left, workflowKey))
    .slice(0, expandedSourceLimit(workflowKey));
  const expandedResults = await Promise.allSettled(
    expandableSources.map(async (source) => ({
      text: await fetchSourceEvidenceText(source.url, workflowKey),
      url: source.url
    }))
  );
  const expandedTextByUrl = new Map(
    expandedResults.flatMap((result) =>
      result.status === "fulfilled" && result.value.text ? [[result.value.url, result.value.text] as const] : []
    )
  );

  return sources.map((source) => {
    const expandedText = expandedTextByUrl.get(source.url);

    if (!expandedText) {
      return source;
    }

    return {
      ...source,
      snippet: `${source.snippet}\n\nPage evidence:\n${expandedText}`
    };
  });
}

async function fetchSourceEvidenceText(url: string, workflowKey: WorkflowKey) {
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5",
        "user-agent": "Mozilla/5.0 (compatible; K12TargetsResearch/1.0)"
      },
      signal: AbortSignal.timeout(sourceFetchTimeoutMs)
    });

    if (!response.ok) {
      return "";
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const contentLength = Number(response.headers.get("content-length") ?? 0);

    if (isPdfResponse(url, contentType)) {
      if (contentLength && contentLength > maxPdfBytes) {
        return "";
      }

      const pdfBuffer = await response.arrayBuffer();

      if (pdfBuffer.byteLength > maxPdfBytes) {
        return "";
      }

      return extractPdfEvidenceText(pdfBuffer, workflowKey);
    }

    if (contentType.includes("image/") || contentType.includes("video/")) {
      return "";
    }

    const html = await response.text();
    const text = htmlToReadableText(html);
    const pageEvidence = extractRelevantEvidenceText(text, workflowKey);
    const linkedPdfEvidence = await fetchLinkedPdfEvidence(html, url, workflowKey);

    return [pageEvidence, linkedPdfEvidence].filter(Boolean).join("\n\nLinked PDF evidence:\n");
  } catch {
    return "";
  }
}

async function fetchLinkedPdfEvidence(html: string, baseUrl: string, workflowKey: WorkflowKey) {
  if (workflows[workflowKey].sourceProfile !== "deal-team") {
    return "";
  }

  const pdfLinks = extractPdfLinksFromHtml(html, baseUrl)
    .sort((left, right) => scoreLinkedPdf(right) - scoreLinkedPdf(left))
    .slice(0, maxLinkedPdfSources);

  if (!pdfLinks.length) {
    return "";
  }

  const settledResults = await Promise.allSettled(
    pdfLinks.map(async (link) => {
      const evidence = await fetchPdfUrlEvidence(link.url, workflowKey);

      return evidence ? `${link.title}\nURL: ${link.url}\n${evidence}` : "";
    })
  );

  return settledResults
    .flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []))
    .join("\n\n");
}

async function fetchPdfUrlEvidence(url: string, workflowKey: WorkflowKey) {
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/pdf,*/*;q=0.5",
        "user-agent": "Mozilla/5.0 (compatible; K12TargetsResearch/1.0)"
      },
      signal: AbortSignal.timeout(sourceFetchTimeoutMs)
    });

    if (!response.ok) {
      return "";
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const contentLength = Number(response.headers.get("content-length") ?? 0);

    if (!isPdfResponse(url, contentType)) {
      return "";
    }

    if (contentLength && contentLength > maxPdfBytes) {
      return "";
    }

    const pdfBuffer = await response.arrayBuffer();

    if (pdfBuffer.byteLength > maxPdfBytes) {
      return "";
    }

    return extractPdfEvidenceText(pdfBuffer, workflowKey);
  } catch {
    return "";
  }
}

async function extractPdfEvidenceText(pdfBuffer: ArrayBuffer, workflowKey: WorkflowKey) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      disableFontFace: true,
      stopAtErrors: false
    });
    const pdf = await loadingTask.promise;
    const pageLimit = Math.min(pdf.numPages, pdfPageLimit(workflowKey));
    const pages: PdfEvidencePage[] = [];

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item) => (typeof item === "object" && item !== null && "str" in item ? String(item.str) : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

      if (!pageText) {
        continue;
      }

      pages.push(buildPdfEvidencePage(pageNumber, pageText, workflowKey));
    }

    if (!pages.length) {
      return "";
    }

    return formatPdfEvidencePages(selectPdfEvidencePages(pages), workflowKey);
  } catch {
    return "";
  }
}

function buildPdfEvidencePage(pageNumber: number, rawText: string, workflowKey: WorkflowKey): PdfEvidencePage {
  const text = trimText(rawText, maxPdfPageCharacters);
  const matchedKeywords = matchedEvidenceKeywords(rawText, workflowKey);
  const score = scorePdfEvidencePage(rawText, workflowKey, matchedKeywords);

  return {
    matchedKeywords,
    pageNumber,
    score,
    text
  };
}

function selectPdfEvidencePages(pages: PdfEvidencePage[]) {
  const rankedPages = pages
    .filter((page) => page.score > 0)
    .sort((left, right) => right.score - left.score || left.pageNumber - right.pageNumber)
    .slice(0, maxPdfEvidencePages)
    .sort((left, right) => left.pageNumber - right.pageNumber);

  if (rankedPages.length) {
    return rankedPages;
  }

  return pages.slice(0, Math.min(maxPdfEvidencePages, 5));
}

function formatPdfEvidencePages(pages: PdfEvidencePage[], workflowKey: WorkflowKey) {
  const evidence = pages
    .map((page) => {
      const pageEvidence =
        extractKeywordWindowsText(page.text, workflowKey, maxPdfPageEvidenceCharacters) ||
        trimText(page.text, maxPdfPageEvidenceCharacters);
      const keywordNote = page.matchedKeywords.length
        ? `matched: ${page.matchedKeywords.slice(0, 8).join(", ")}`
        : "fallback";

      return `Page ${page.pageNumber} (${keywordNote})\n${pageEvidence}`;
    })
    .join("\n\n");

  return trimText(evidence, expandedSourceCharacterLimit(workflowKey));
}

function scorePdfEvidencePage(text: string, workflowKey: WorkflowKey, matchedKeywords: string[]) {
  const sourceProfile = workflows[workflowKey].sourceProfile;
  const normalizedText = normalizeIdentityText(text);
  let score = keywordScore(normalizedText, pdfEvidenceKeywordWeights(workflowKey));

  if (sourceProfile === "deal-team") {
    score += dealYearScore(latestDealYearFromText(text)) / 5;

    const hasDealTeamRole = hasAnyPhrase(normalizedText, [
      "municipal advisor",
      "municipal adviser",
      "financial advisor",
      "financial adviser",
      "underwriter",
      "underwriting",
      "senior manager",
      "initial purchaser",
      "placement agent",
      "bond counsel",
      "co bond counsel"
    ]);
    const hasDealDescriptor = hasAnyPhrase(normalizedText, [
      "official statement",
      "preliminary official statement",
      "principal amount",
      "par amount",
      "series 2026",
      "series 2025",
      "series 2024",
      "series 2023",
      "community facilities district",
      "special tax bonds",
      "general obligation bonds",
      "refunding",
      "authorization",
      "authorizations",
      "bond purchase agreement",
      "purchase contract",
      "notice of sale",
      "board approved",
      "authorizing the issuance"
    ]);

    if (hasDealTeamRole && hasDealDescriptor) {
      score += 24;
    }

    if (
      hasAnyPhrase(normalizedText, ["municipal advisor", "municipal adviser", "financial advisor", "financial adviser"]) &&
      hasAnyPhrase(normalizedText, ["underwriter", "underwriting", "senior manager", "initial purchaser", "placement agent"]) &&
      hasAnyPhrase(normalizedText, ["bond counsel", "co bond counsel"])
    ) {
      score += 28;
    }
  }

  return score + Math.min(matchedKeywords.length, 12);
}

function matchedEvidenceKeywords(text: string, workflowKey: WorkflowKey) {
  const normalizedText = normalizeIdentityText(text);

  return pdfEvidenceKeywordWeights(workflowKey)
    .map(([keyword]) => keyword)
    .filter((keyword) => normalizedText.includes(normalizeIdentityText(keyword)))
    .slice(0, 14);
}

function pdfEvidenceKeywordWeights(workflowKey: WorkflowKey): Array<[string, number]> {
  const sourceProfile = workflows[workflowKey].sourceProfile;

  if (sourceProfile === "deal-team") {
    return [
      ["preliminary official statement", 16],
      ["official statement", 15],
      ["municipal advisor", 14],
      ["municipal adviser", 14],
      ["financial advisor", 13],
      ["financial adviser", 13],
      ["bond counsel", 14],
      ["co-bond counsel", 12],
      ["underwriter", 14],
      ["underwriting", 12],
      ["senior manager", 11],
      ["initial purchaser", 11],
      ["placement agent", 10],
      ["direct purchaser", 10],
      ["financing team", 10],
      ["finance team", 9],
      ["transaction participants", 9],
      ["professionals", 6],
      ["participants", 6],
      ["bond purchase agreement", 12],
      ["purchase contract", 10],
      ["notice of sale", 8],
      ["continuing disclosure", 4],
      ["sale date", 8],
      ["dated date", 7],
      ["delivery date", 7],
      ["closing date", 7],
      ["principal amount", 9],
      ["aggregate principal amount", 10],
      ["par amount", 8],
      ["series 2026", 11],
      ["series 2025", 11],
      ["series 2024", 8],
      ["series 2023", 7],
      ["new money", 7],
      ["refunding", 8],
      ["refundings", 8],
      ["refunded bonds", 7],
      ["prior bonds", 6],
      ["debt service savings", 6],
      ["escrow", 4],
      ["defeasance", 4],
      ["general obligation bonds", 8],
      ["go bonds", 6],
      ["community facilities district", 10],
      ["school facilities improvement district", 10],
      ["special tax bonds", 10],
      ["cfd", 6],
      ["sfid", 6],
      ["authorization", 5],
      ["authorizations", 5],
      ["authorized", 5],
      ["remaining authorization", 7],
      ["unissued authorization", 7],
      ["bond measure", 6],
      ["voter approved", 5],
      ["board approved", 6],
      ["approved the issuance", 6],
      ["authorize the issuance", 7],
      ["authorizing the issuance", 7],
      ["maximum bonded indebtedness", 6],
      ["proposition 39", 5],
      ["financing documents", 5],
      ["bond documents", 5]
    ];
  }

  if (sourceProfile === "authorization") {
    return [
      ["authorization", 10],
      ["authorized", 9],
      ["remaining authorization", 12],
      ["unissued authorization", 12],
      ["bond measure", 10],
      ["voter approved", 8],
      ["election", 6],
      ["maximum bonded indebtedness", 9],
      ["proposition 39", 7],
      ["55%", 5]
    ];
  }

  return relevantSourceKeywords(workflowKey).map((keyword) => [keyword, 3]);
}

async function extractFields(
  input: { institution: string; fields: readonly string[]; prompt: string; sourceList: string },
  extractor: ExtractorConfig
) {
  if (extractor.provider === "openai") {
    return callOpenAIExtraction(input, extractor);
  }

  if (extractor.provider === "anthropic") {
    return callAnthropicExtraction(input, extractor);
  }

  return callPerplexityExtraction(input, extractor, true);
}

async function callPerplexityExtraction(
  input: { institution: string; fields: readonly string[]; prompt: string; sourceList: string },
  extractor: ExtractorConfig,
  useSchema: boolean
): Promise<string> {
  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    body: JSON.stringify({
      model: extractor.model,
      messages: buildChatMessages(input),
      ...(useSchema ? { response_format: { type: "json_object" } } : {}),
      temperature: 0
    }),
    headers: {
      authorization: `Bearer ${extractor.apiKey}`,
      "content-type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok && useSchema && response.status === 400) {
    return callPerplexityExtraction(input, extractor, false);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Perplexity extraction failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";

  if (!content) {
    throw new Error("Perplexity extraction returned no content.");
  }

  return content;
}

async function callOpenAIExtraction(
  input: { institution: string; fields: readonly string[]; prompt: string; sourceList: string },
  extractor: ExtractorConfig
) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    body: JSON.stringify({
      model: extractor.model,
      messages: buildChatMessages(input),
      response_format: { type: "json_object" },
      temperature: 0
    }),
    headers: {
      authorization: `Bearer ${extractor.apiKey}`,
      "content-type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `OpenAI extraction failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";

  if (!content) {
    throw new Error("OpenAI extraction returned no content.");
  }

  return content;
}

async function callAnthropicExtraction(
  input: { institution: string; fields: readonly string[]; prompt: string; sourceList: string },
  extractor: ExtractorConfig
) {
  const [systemMessage, userMessage] = buildChatMessages(input);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    body: JSON.stringify({
      max_tokens: 1800,
      messages: [
        {
          role: "user",
          content: userMessage.content
        }
      ],
      model: extractor.model,
      system: systemMessage.content,
      temperature: 0
    }),
    headers: {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": extractor.apiKey
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Anthropic extraction failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ text?: string; type?: string }>;
  };
  const content = data.content?.find((part) => part.type === "text" && part.text)?.text ?? "";

  if (!content) {
    throw new Error("Anthropic extraction returned no content.");
  }

  return content;
}

function buildChatMessages(input: { institution: string; fields: readonly string[]; prompt: string; sourceList: string }) {
  const dealPackageRules = input.fields.some((field) => isDealTeamField(field))
    ? `
Deal-team role rules:
- Return only the requested MA, Underwriter/UW, and BC fields. Do not return Last Deal from this workflow.
- Only return transaction packages from ${minimumDealYear} or later. If the only supported deal is older than ${minimumDealYear}, return no fields.
- The issuer/financing entity must be the exact requested school district, or a Community Facilities District (CFD), School Facilities Improvement District (SFID), special-tax bond, or similar financing explicitly named for/sponsored by the requested school district.
- Do not use unrelated city, county, redevelopment, overlapping-agency, private-school, or similarly named CFD deals.
- Prefer the newest clearly supported bond/debt transaction, not the newest webpage date.
- A ${preferredDealYear}/2026 transaction should beat a complete 2023/2024 package when the newer transaction has direct evidence. Use 2023/2024 only as fallback when no newer supported deal is found.
- Prefer sources that name the financing participants directly: Municipal Advisor, Underwriter, Bond Counsel, or Financing Team.
- If multiple sources disagree, prefer Official Statement/POS/EMMA/CDIAC over agenda snippets, rating reports, or news.
- Do not mix deal-team roles from different transactions unless the evidence clearly says they belong to the same latest deal.
- Underwriter/UW must be an underwriter, senior manager, purchaser, placement agent, direct purchaser, or dealer. Never put law firms, bond counsel, disclosure counsel, municipal advisors, or financial advisors in the underwriter field.
- BC must be explicitly bond counsel. Do not use disclosure counsel as BC unless the source also labels the firm as bond counsel.
- MA must be explicitly municipal advisor/adviser or financial advisor/adviser.
- If only one field is supported and the source is not an Official Statement, POS, EMMA, CDIAC, DebtWatch, board agenda, board minutes, agenda-minutes packet, staff report, or resolution, omit it.`
    : "";

  return [
    {
      role: "system",
      content:
        "You extract California public finance workbook fields from provided sources. Use only the sources in the user message. Do not guess. Return only valid JSON."
    },
    {
      role: "user",
      content: `${input.prompt}

Institution: ${input.institution}
Requested fields: ${input.fields.join(", ")}

Allowed sources:
${input.sourceList}
${dealPackageRules}

Rules:
- Use only the allowed sources above.
- Every returned field must cite one source_index from the allowed sources.
- If the source does not directly support the value, omit that field.
- Do not infer names, titles, deal teams, or authorization amounts from stale or secondary sources.
- When Board fields are requested, they should represent the current complete board roster when available, one current board member per field.
- For Board fields, do not include former board members unless the source clearly says they are current.
- When Last Deal is requested, return only date / par amount / NM or Ref. Use NM for new money and Ref for refunding. Example: "Apr 2026 / $397.505M / NM".
- When Auth is requested, return only remaining/unissued GO bond authorization outstanding, preferably by election/measure. Prefer CDIAC ADTR auth records or the latest OS/POS/offering document. Include an as-of/source date such as "Measure J: $120M remaining as of 2025 OS" or "$0 remaining as of 2025 CDIAC ADTR". If sources only show original authorization, bond measure amount, election result, or maximum bonded indebtedness without remaining/unissued authorization, omit the field.
- Set confidence below 0.74 unless the evidence directly supports the value.

Return JSON exactly in this shape:
{"fields":[{"field_key":"one of the requested fields","value":"concise value","source_index":1,"excerpt":"short direct evidence","confidence":0.0}]}`
    }
  ] as const;
}

async function runConsensusExtraction(
  input: { institution: string; fields: readonly string[]; prompt: string; sourceList: string },
  extractors: ExtractorConfig[],
  sources: SearchSource[]
): Promise<AutomationResearchResult> {
  const settledResults = await Promise.allSettled(
    extractors.map(async (extractor) => {
      const response = await extractFields(input, extractor);
      const parsed = parseJsonObject(response) as AutomationResearchResult;

      return attachSourceMetadata(parsed, sources, extractor.provider);
    })
  );
  const providerResults = settledResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
  const providerErrors = settledResults.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            error: normalizeErrorMessage(result.reason),
            provider: extractors[index]?.provider ?? "openai"
          }
        ]
      : []
  );

  if (providerResults.length < minimumConsensusVotes) {
    return { fields: [], provider_errors: providerErrors };
  }

  return {
    ...buildConsensusResult(providerResults, input.fields),
    provider_errors: providerErrors
  };
}

async function runDealTeamExtraction(
  input: { institution: string; fields: readonly string[]; prompt: string; sourceList: string },
  extractors: ExtractorConfig[],
  sources: SearchSource[]
): Promise<AutomationResearchResult> {
  const settledResults = await Promise.allSettled(
    extractors.map(async (extractor) => {
      const response = await extractFields(input, extractor);
      const parsed = parseJsonObject(response) as AutomationResearchResult;

      return attachSourceMetadata(parsed, sources, extractor.provider);
    })
  );
  const providerResults = settledResults.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
  const providerErrors = settledResults.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            error: normalizeErrorMessage(result.reason),
            provider: extractors[index]?.provider ?? "openai"
          }
        ]
      : []
  );
  const extractedCandidates = providerResults.flatMap((result) =>
    (result.fields ?? []).filter(
      (field) => isDealTeamField(field.field_key ?? "") && input.fields.includes(field.field_key ?? "")
    )
  );

  return {
    fields: chooseDealTeamPackage(providerResults, input.fields, input.institution, sources),
    candidate_diagnostics: buildDealTeamExtractionDiagnostics(extractedCandidates, input.institution),
    deal_follow_up_seeds: buildDealFollowUpSeeds(extractedCandidates, input.institution),
    provider_errors: providerErrors
  };
}

function chooseDealTeamPackage(
  results: AutomationResearchResult[],
  allowedFields: readonly string[],
  institution: string,
  sources: SearchSource[]
) {
  const sourceByUrl = new Map(sources.map((source) => [canonicalSourceKey(source.url), source]));
  const rawCandidates = results.flatMap((result) =>
    (result.fields ?? [])
      .filter((field) => isDealTeamField(field.field_key ?? "") && allowedFields.includes(field.field_key ?? ""))
      .filter(isUsableCandidate)
  );

  if (!rawCandidates.length) {
    return [];
  }

  const groupedBySource = groupDealTeamCandidatesBySource(rawCandidates);
  const validCandidates: AutomationFieldResult[] = [];

  const sourcePackages = Array.from(groupedBySource.entries())
    .flatMap(([sourceKey, sourceCandidates]) => {
      const source = sourceByUrl.get(sourceKey);
      const packageContext = buildDealPackageContext(sourceCandidates, source);
      const validSourceCandidates = sourceCandidates
        .filter((field) => isValidDealTeamCandidate(field, institution, packageContext))
        .map((field) => withDealPackageContext(field, packageContext));

      validCandidates.push(...validSourceCandidates);

      if (!validSourceCandidates.length) {
        return [];
      }

      const bestFields = bestDealFields(validSourceCandidates, allowedFields);
      const coverage = bestFields.length;
      const hasLastDeal = bestFields.some((field) => field.field_key === "Last Deal");
      const hasDealParticipant = bestFields.some((field) => isDealTeamRoleField(field.field_key ?? ""));
      const averageConfidence =
        bestFields.reduce((sum, field) => sum + (normalizeConfidence(field.confidence) ?? minimumProviderConfidence), 0) /
        Math.max(bestFields.length, 1);
      const sourceQuality = source ? scoreSource(source, "deal-team") / 100 : 0;
      const dealRecencyScore = dealYearPackageScore(bestFields, source);

      return [
        {
          fields: bestFields,
          score:
            dealRecencyScore +
            coverage * 10 +
            (hasLastDeal ? 4 : 0) +
            (hasDealParticipant ? 3 : 0) +
            averageConfidence +
            sourceQuality
        }
      ];
    })
    .filter((dealPackage) => dealPackage.fields.length >= 2 || dealPackage.fields.some((field) => field.field_key === "Last Deal"))
    .sort((left, right) => right.score - left.score);

  if (sourcePackages.length) {
    return enrichDealPackageFields(sourcePackages[0].fields, validCandidates, allowedFields, sourceByUrl);
  }

  return bestDealFields(validCandidates, allowedFields);
}

function enrichDealPackageFields(
  baseFields: AutomationFieldResult[],
  validCandidates: AutomationFieldResult[],
  allowedFields: readonly string[],
  sourceByUrl: Map<string, SearchSource>
) {
  const anchorField = baseFields.find((field) => field.field_key === "Last Deal");

  if (!anchorField) {
    return baseFields;
  }

  const enrichedFields = [...baseFields];
  const existingFieldKeys = new Set(enrichedFields.map((field) => field.field_key));
  const missingRoleFields = allowedFields.filter(
    (fieldKey) => isDealTeamRoleField(fieldKey) && !existingFieldKeys.has(fieldKey)
  );

  missingRoleFields.forEach((fieldKey) => {
    const candidate = validCandidates
      .filter((field) => field.field_key === fieldKey)
      .filter((field) => isDealSupplementCandidate(field, anchorField, sourceByUrl))
      .sort((left, right) => {
        const sourceCompare =
          dealSupplementSourceScore(right, sourceByUrl) - dealSupplementSourceScore(left, sourceByUrl);

        if (sourceCompare !== 0) {
          return sourceCompare;
        }

        const confidenceCompare = (normalizeConfidence(right.confidence) ?? 0) - (normalizeConfidence(left.confidence) ?? 0);

        if (confidenceCompare !== 0) {
          return confidenceCompare;
        }

        return candidateDealYearScore(right) - candidateDealYearScore(left);
      })[0];

    if (candidate) {
      enrichedFields.push(candidate);
    }
  });

  return bestDealFields(enrichedFields, allowedFields);
}

function isDealSupplementCandidate(
  candidate: AutomationFieldResult,
  anchorField: AutomationFieldResult,
  sourceByUrl: Map<string, SearchSource>
) {
  const anchorYear = candidateDealYear(anchorField);
  const candidateYear = candidateDealYear(candidate);

  if (!anchorYear || !candidateYear || anchorYear !== candidateYear) {
    return false;
  }

  const candidateText = dealCandidateText(candidate, sourceByUrl);
  const anchorText = dealCandidateText(anchorField, sourceByUrl);
  const anchorAmounts = extractDealAmounts(anchorText);
  const hasAnchorAmount = anchorAmounts.some((amount) =>
    normalizeIdentityText(candidateText).includes(normalizeIdentityText(amount))
  );
  const hasSpecificDealDocument = hasAnyPhrase(normalizeIdentityText(candidateText), [
    "official statement",
    "preliminary official statement",
    "emma",
    "cdiac",
    "debtwatch",
    "board agenda",
    "agenda packet",
    "board minutes",
    "meeting minutes",
    "agenda minutes",
    "staff report",
    "resolution",
    "financing team",
    "transaction participants"
  ]);
  const sharesSeriesOrDealTerm = sharedDealTerms(anchorText, candidateText).length > 0;

  return hasAnchorAmount || (hasSpecificDealDocument && sharesSeriesOrDealTerm);
}

function dealSupplementSourceScore(candidate: AutomationFieldResult, sourceByUrl: Map<string, SearchSource>) {
  const source = sourceByUrl.get(candidateDealSourceKey(candidate));
  const candidateText = dealCandidateText(candidate, sourceByUrl);
  const normalizedCandidateText = normalizeIdentityText(candidateText);

  return (
    (source ? scoreSource(source, "deal-team") : 0) +
    (hasAnyPhrase(normalizedCandidateText, ["official statement", "preliminary official statement", "emma"]) ? 20 : 0) +
    (hasAnyPhrase(normalizedCandidateText, ["financing team", "transaction participants"]) ? 8 : 0)
  );
}

function dealCandidateText(candidate: AutomationFieldResult, sourceByUrl: Map<string, SearchSource>) {
  const source = sourceByUrl.get(candidateDealSourceKey(candidate));

  return [
    candidate.value,
    candidate.excerpt,
    candidate.package_context,
    candidate.source_title,
    candidate.source_url,
    candidate.source_context,
    source?.title,
    source?.url,
    source?.snippet
  ]
    .filter(Boolean)
    .join(" ");
}

function sharedDealTerms(anchorText: string, candidateText: string) {
  const normalizedCandidateText = normalizeIdentityText(candidateText);
  const terms = uniqueStrings([
    ...extractDealSeriesLabels(anchorText),
    ...dealFollowUpDealTerms(anchorText),
    ...extractCfdLabels(anchorText)
  ]);

  return terms.filter((term) => normalizeIdentityText(term).length >= 3 && normalizedCandidateText.includes(normalizeIdentityText(term)));
}

function groupDealTeamCandidatesBySource(candidates: AutomationFieldResult[]) {
  const groupedBySource = new Map<string, AutomationFieldResult[]>();

  candidates.forEach((candidate) => {
    const sourceKey = candidateDealSourceKey(candidate);
    const sourceCandidates = groupedBySource.get(sourceKey) ?? [];
    sourceCandidates.push(candidate);
    groupedBySource.set(sourceKey, sourceCandidates);
  });

  return groupedBySource;
}

function candidateDealSourceKey(candidate: AutomationFieldResult) {
  const sourceUrl = candidate.source_url?.trim() ?? "";

  return sourceUrl ? canonicalSourceKey(sourceUrl) : "unknown";
}

function buildDealPackageContext(candidates: AutomationFieldResult[], source?: SearchSource) {
  const sourceText = source
    ? `${source.title}\n${source.url}\n${source.snippet}`
    : "";
  const fieldText = candidates
    .map((candidate) =>
      [
        candidate.field_key,
        candidate.value,
        candidate.excerpt,
        candidate.source_title,
        candidate.source_url,
        candidate.source_context
      ]
        .filter(Boolean)
        .join(" | ")
    )
    .join("\n");

  return trimText([sourceText, fieldText].filter(Boolean).join("\n"), 8000);
}

function withDealPackageContext(candidate: AutomationFieldResult, packageContext: string): AutomationFieldResult {
  return {
    ...candidate,
    package_context: packageContext
  };
}

function bestDealFields(candidates: AutomationFieldResult[], allowedFields: readonly string[]) {
  return allowedFields.flatMap((fieldKey) => {
    const bestCandidate = candidates
      .filter((candidate) => candidate.field_key === fieldKey)
      .sort((left, right) => {
        const yearCompare = candidateDealYearScore(right) - candidateDealYearScore(left);

        if (yearCompare !== 0) {
          return yearCompare;
        }

        return (normalizeConfidence(right.confidence) ?? 0) - (normalizeConfidence(left.confidence) ?? 0);
      })[0];

    return bestCandidate ? [bestCandidate] : [];
  });
}

function dealYearPackageScore(fields: AutomationFieldResult[], source?: SearchSource) {
  const fieldYear = Math.max(0, ...fields.map(candidateDealYear));
  const sourceYear = source ? latestDealYearFromText(`${source.title} ${source.url} ${source.snippet}`) : 0;

  return dealYearScore(Math.max(fieldYear, sourceYear));
}

function candidateDealYearScore(candidate: AutomationFieldResult) {
  return dealYearScore(candidateDealYear(candidate));
}

function candidateDealYear(candidate: AutomationFieldResult) {
  return latestDealYearFromText(
    [
      candidate.value,
      candidate.excerpt,
      candidate.package_context,
      candidate.source_title,
      candidate.source_url,
      candidate.source_context
    ].join(" ")
  );
}

function latestDealYearFromText(value: string) {
  const normalizedValue = value.toLowerCase();
  const years = extractYears(value).filter((year) => year >= minimumDealYear);
  const dealYears = years.filter((year) => {
    const yearIndex = normalizedValue.indexOf(String(year));
    const windowText = yearIndex === -1
      ? normalizedValue
      : normalizedValue.slice(Math.max(0, yearIndex - 80), yearIndex + 120);

    return /bond|bonds|certificate|certificates|cfd|community facilities|financing|refunding|sfid|school facilities|special tax|official statement|series|sale|par/i.test(windowText);
  });

  if (dealYears.length) {
    return Math.max(0, ...dealYears);
  }

  if (
    years.length &&
    (/(\$\s?\d|\b\d+(?:\.\d+)?\s?(?:m|mm|million)\b)/i.test(value) ||
      /cfd|community facilities|refunding|sfid|special tax|general obligation|new money/i.test(value))
  ) {
    return Math.max(0, ...years);
  }

  return 0;
}

function dealYearScore(year: number) {
  if (year >= 2026) {
    return 130;
  }

  if (year >= preferredDealYear) {
    return 110;
  }

  if (year === 2024) {
    return 35;
  }

  if (year === 2023) {
    return 10;
  }

  return 0;
}

function buildDealTeamExtractionDiagnostics(candidates: AutomationFieldResult[], institution: string) {
  const packageContextBySource = new Map(
    Array.from(groupDealTeamCandidatesBySource(candidates).entries()).map(([sourceKey, sourceCandidates]) => [
      sourceKey,
      buildDealPackageContext(sourceCandidates)
    ])
  );

  return candidates
    .slice(0, 8)
    .map((candidate) => {
      const fieldKey = candidate.field_key?.trim() || "Unknown field";
      const value = trimText(candidate.value?.trim() || "-", 90);
      const confidence = normalizeConfidence(candidate.confidence);
      const packageContext = packageContextBySource.get(candidateDealSourceKey(candidate)) ?? candidate.package_context;
      const reasons = [
        ...basicCandidateReasons(candidate),
        ...dealTeamValidationReasons(candidate, institution, packageContext)
      ];
      const reasonText = reasons.length ? reasons.join(", ") : "passed extraction validation";
      const sourceTitle = trimText(candidate.source_title?.trim() || "source", 70);

      return `${fieldKey} "${value}" (${formatConfidence(confidence)}) from ${sourceTitle}: ${reasonText}`;
    });
}

function buildDealFollowUpSeeds(candidates: AutomationFieldResult[], institution: string): DealFollowUpSeed[] {
  const seedMap = new Map<string, DealFollowUpSeed>();

  candidates
    .filter((candidate) => candidate.field_key === "Last Deal")
    .filter((candidate) => isPotentialDealFollowUpSeed(candidate, institution))
    .forEach((candidate) => {
      const value = candidate.value?.trim() ?? "";
      const key = normalizeComparableValue(value);
      const existingSeed = seedMap.get(key);
      const confidence = normalizeConfidence(candidate.confidence) ?? undefined;

      if (!existingSeed || (confidence ?? 0) > (existingSeed.confidence ?? 0)) {
        seedMap.set(key, {
          confidence,
          excerpt: candidate.excerpt,
          source_title: candidate.source_title,
          source_url: candidate.source_url,
          value
        });
      }
    });

  return Array.from(seedMap.values()).slice(0, 3);
}

function isPotentialDealFollowUpSeed(candidate: AutomationFieldResult, institution: string) {
  const value = candidate.value?.trim() ?? "";
  const confidence = normalizeConfidence(candidate.confidence);

  if (!value || confidence === null || confidence < minimumProviderConfidence || !isSpecificLastDealValue(value)) {
    return false;
  }

  const combinedEvidenceText = [
    value,
    candidate.excerpt,
    candidate.source_title,
    candidate.source_url,
    candidate.source_context
  ].join(" ");

  return hasRecentDealContext(combinedEvidenceText) &&
    dealEvidenceMentionsInstitution(normalizeIdentityText(combinedEvidenceText), institution);
}

function basicCandidateReasons(candidate: AutomationFieldResult) {
  const reasons: string[] = [];
  const confidence = normalizeConfidence(candidate.confidence);

  if (!candidate.value?.trim()) {
    reasons.push("missing value");
  }

  if (!candidate.excerpt?.trim()) {
    reasons.push("missing evidence excerpt");
  }

  if (!candidate.source_url?.trim()) {
    reasons.push("missing source URL");
  }

  if (!candidate.providers?.length) {
    reasons.push("missing provider");
  }

  if (confidence === null) {
    reasons.push("missing confidence");
  } else if (confidence < minimumProviderConfidence) {
    reasons.push(`provider confidence below ${minimumProviderConfidence}`);
  }

  return reasons;
}

function buildConsensusResult(results: AutomationResearchResult[], allowedFields: readonly string[]) {
  const fieldResults: AutomationFieldResult[] = [];

  for (const field of allowedFields.filter((field) => !field.startsWith("Board "))) {
    const candidates = results.flatMap((result) =>
      (result.fields ?? [])
        .filter((candidate) => candidate.field_key === field && isUsableCandidate(candidate))
        .map((candidate) => ({
          ...candidate,
          normalizedValue: normalizePersonValue(candidate.value ?? "")
        }))
    );
    const winner = chooseConsensusCandidate(candidates);

    if (winner) {
      fieldResults.push(winner);
    }
  }

  const boardCandidates = results.flatMap((result) => {
    const seenByProvider = new Set<string>();

    return (result.fields ?? [])
      .filter((candidate) => candidate.field_key?.startsWith("Board ") && isUsableCandidate(candidate))
      .flatMap((candidate) => {
        const normalizedValue = normalizePersonValue(candidate.value ?? "");
        const provider = candidate.providers?.[0];

        if (!normalizedValue || !provider || seenByProvider.has(`${provider}::${normalizedValue}`)) {
          return [];
        }

        seenByProvider.add(`${provider}::${normalizedValue}`);

        return [
          {
            ...candidate,
            normalizedValue
          }
        ];
      });
  });
  const boardWinners = chooseConsensusCandidates(boardCandidates).slice(0, 7);

  boardWinners.forEach((winner, index) => {
    fieldResults.push({
      ...winner,
      field_key: `Board ${index + 1}`
    });
  });

  return { fields: fieldResults };
}

function chooseConsensusCandidates(candidates: ConsensusCandidate[]) {
  const groupedCandidates = new Map<string, ConsensusCandidate[]>();

  candidates.forEach((candidate) => {
    if (!candidate.normalizedValue) {
      return;
    }

    const existingCandidates = groupedCandidates.get(candidate.normalizedValue) ?? [];
    existingCandidates.push(candidate);
    groupedCandidates.set(candidate.normalizedValue, existingCandidates);
  });

  return Array.from(groupedCandidates.values())
    .map((group) => mergeConsensusGroup(group))
    .filter((candidate): candidate is ConsensusWinner => Boolean(candidate))
    .sort((left, right) => {
      if (right.voteCount !== left.voteCount) {
        return right.voteCount - left.voteCount;
      }

      return (right.confidence ?? 0) - (left.confidence ?? 0);
    });
}

function chooseConsensusCandidate(candidates: ConsensusCandidate[]) {
  return chooseConsensusCandidates(candidates)[0] ?? null;
}

function mergeConsensusGroup(group: ConsensusCandidate[]): ConsensusWinner | null {
  const providerMap = new Map<ExtractorProvider, ConsensusCandidate>();

  group.forEach((candidate) => {
    const provider = candidate.providers?.[0];

    if (!provider) {
      return;
    }

    const existingCandidate = providerMap.get(provider);

    if (!existingCandidate || (candidate.confidence ?? 0) > (existingCandidate.confidence ?? 0)) {
      providerMap.set(provider, candidate);
    }
  });

  const providerCandidates = Array.from(providerMap.values());

  if (providerCandidates.length < minimumConsensusVotes) {
    return null;
  }

  const preferredCandidate = providerCandidates.sort(
    (left, right) => (right.confidence ?? 0) - (left.confidence ?? 0)
  )[0];
  const confidence =
    providerCandidates.reduce((sum, candidate) => sum + (candidate.confidence ?? minimumProviderConfidence), 0) /
    providerCandidates.length;

  return {
    ...preferredCandidate,
    confidence,
    providers: providerCandidates.flatMap((candidate) => candidate.providers ?? []),
    voteCount: providerCandidates.length
  };
}

function attachSourceMetadata(
  result: AutomationResearchResult,
  sources: SearchSource[],
  provider: ExtractorProvider
): AutomationResearchResult {
  const sourceByIndex = new Map(sources.map((source) => [source.index, source]));

  return {
    fields: (result.fields ?? []).flatMap((field) => {
      const sourceIndex = Number(field.source_index);
      const source = sourceByIndex.get(sourceIndex);

      if (!source) {
        return [];
      }

      return [
        {
          ...field,
          providers: [provider],
          source_context: source.snippet,
          source_title: source.title,
          source_url: source.url
        }
      ];
    })
  };
}

function buildNoSuggestionDiagnostic(
  institution: string,
  workflowKey: WorkflowKey,
  allowedFields: readonly string[],
  recordId: string,
  valueMap: Map<string, string>,
  pendingSet: Set<string>,
  result: AutomationResearchResult,
  searchInstitution: string
): ResearchDiagnostic {
  const sourceCount = result.source_count ?? 0;
  const extractedFieldCount = result.fields?.length ?? 0;
  const sourceProfile = workflows[workflowKey].sourceProfile;
  const buildRejectionDiagnostics = buildRejectedSuggestionDiagnostics(
    workflowKey,
    allowedFields,
    recordId,
    valueMap,
    pendingSet,
    result,
    searchInstitution
  );
  const candidateDiagnostics = [...buildRejectionDiagnostics, ...(result.candidate_diagnostics ?? [])].slice(0, 3);

  if (sourceProfile === "authorization" && candidateDiagnostics.length) {
    return {
      institution,
      message: candidateDiagnostics.join(" | ")
    };
  }

  if (!sourceCount) {
    return {
      institution,
      message: "No matching sources survived exact-institution filtering."
    };
  }

  if (sourceProfile === "deal-team") {
    if (!extractedFieldCount) {
      return {
        institution,
        message:
          `Checked ${sourceCount} matched sources, but no ${minimumDealYear}+ supported district or district-related CFD/SFID deal package passed validation.` +
          (candidateDiagnostics.length ? ` Candidates: ${candidateDiagnostics.join(" | ")}` : "")
      };
    }

    return {
      institution,
      message:
        `Found ${extractedFieldCount} candidate deal field${extractedFieldCount === 1 ? "" : "s"}, ` +
        `but they were unchanged, already pending, below confidence, or failed ${minimumDealYear}+/district-related issuer/role validation.` +
        (candidateDiagnostics.length ? ` Candidates: ${candidateDiagnostics.join(" | ")}` : "")
    };
  }

  if (sourceProfile === "ccd-refundings") {
    return {
      institution,
      message: extractedFieldCount
        ? `Found ${extractedFieldCount} refunding candidate field${extractedFieldCount === 1 ? "" : "s"}, but none required an update.`
        : `Checked ${sourceCount} recent CDIAC/DebtWatch deal fact${sourceCount === 1 ? "" : "s"}, but no supported refunding was found.` +
          (candidateDiagnostics.length ? ` Candidates: ${candidateDiagnostics.join(" | ")}` : "")
    };
  }

  return {
    institution,
    message: extractedFieldCount
      ? `Found ${extractedFieldCount} candidate field${extractedFieldCount === 1 ? "" : "s"}, but none required an update.`
      : `Checked ${sourceCount} matched sources, but no candidate fields passed validation.`
  };
}

function buildDealTeamPartialDiagnostic(
  institution: string,
  workflowKey: WorkflowKey,
  allowedFields: readonly string[],
  result: AutomationResearchResult
): ResearchDiagnostic | null {
  if (workflows[workflowKey].sourceProfile !== "deal-team") {
    return null;
  }

  const fieldKeys = new Set((result.fields ?? []).map((field) => field.field_key).filter(Boolean));

  if (!fieldKeys.has("Last Deal")) {
    return null;
  }

  const missingFields = dealTeamRoleFields(workflowKey).filter(
    (fieldKey) => allowedFields.includes(fieldKey) && !fieldKeys.has(fieldKey)
  );

  if (!missingFields.length) {
    return null;
  }

  return {
    institution,
    message:
      `Partial deal package found. Last Deal is supported, but ${missingFields.join(", ")} ` +
      `still needs direct role evidence from OS/POS/EMMA/CDIAC/agenda/minutes sources.`
  };
}

function buildRejectedSuggestionDiagnostics(
  workflowKey: WorkflowKey,
  allowedFields: readonly string[],
  recordId: string,
  valueMap: Map<string, string>,
  pendingSet: Set<string>,
  result: AutomationResearchResult,
  institution: string
) {
  const moduleKey = workflows[workflowKey].module;

  return (result.fields ?? [])
    .slice(0, 5)
    .map((fieldResult) => {
      const fieldKey = fieldResult.field_key?.trim() ?? "";
      const proposedValue = formatWorkbookFieldValue(moduleKey, fieldKey, fieldResult.value?.trim() ?? "");
      const currentValue = formatWorkbookFieldValue(moduleKey, fieldKey, valueMap.get(`${recordId}::${fieldKey}`) ?? "");
      const confidence = normalizeConfidence(fieldResult.confidence);
      const minimumRequiredConfidence = minimumSuggestionConfidence(workflowKey);
      const sourceUrl = fieldResult.source_url?.trim() ?? "";
      const excerpt = fieldResult.excerpt?.trim() ?? "";
      const reasons: string[] = [];

      if (workflows[workflowKey].includeBoardRosterDiff && isBoardField(fieldKey)) {
        reasons.push("handled by board roster diff");
      }

      if (!allowedFields.includes(fieldKey)) {
        reasons.push("field not in active workflow");
      }

      if (!proposedValue) {
        reasons.push("missing proposed value");
      }

      reasons.push(...candidateWorkflowValidationReasons(workflowKey, fieldResult, institution));

      if (valuesAreEquivalent(moduleKey, fieldKey, currentValue, proposedValue)) {
        reasons.push(`same as current value "${trimText(currentValue, 60)}"`);
      }

      if (pendingSet.has(`${recordId}::${fieldKey}`)) {
        reasons.push("pending suggestion already exists for this field");
      }

      if (!sourceUrl) {
        reasons.push("missing source URL");
      }

      if (!excerpt) {
        reasons.push("missing evidence excerpt");
      }

      if (confidence === null) {
        reasons.push("missing confidence");
      } else if (confidence < minimumRequiredConfidence) {
        reasons.push(`confidence ${formatConfidence(confidence)} below ${formatConfidence(minimumRequiredConfidence)}`);
      }

      const reasonText = reasons.length ? reasons.join(", ") : "unknown rejection";
      const sourceTitle = trimText(fieldResult.source_title?.trim() || "source", 70);

      return `${fieldKey || "Unknown field"} "${trimText(proposedValue || "-", 90)}" (${formatConfidence(
        confidence
      )}) from ${sourceTitle}: ${reasonText}`;
    });
}

function candidateWorkflowValidationReasons(
  workflowKey: WorkflowKey,
  candidate: AutomationFieldResult,
  institution: string
) {
  if (workflows[workflowKey].sourceProfile === "authorization") {
    return authorizationValidationReasons(candidate);
  }

  if (workflows[workflowKey].sourceProfile !== "deal-team") {
    return [];
  }

  return dealTeamValidationReasons(candidate, institution, candidate.package_context);
}

function buildSuggestions(
  moduleKey: ModuleKey,
  recordId: string,
  institution: string,
  workflowKey: WorkflowKey,
  allowedFields: readonly string[],
  valueMap: Map<string, string>,
  pendingSet: Set<string>,
  result: AutomationResearchResult
): UpdateSuggestionInsert[] {
  const directSuggestions: UpdateSuggestionInsert[] = (result.fields ?? []).flatMap((fieldResult) => {
    const fieldKey = fieldResult.field_key?.trim() ?? "";
    const proposedValue = formatWorkbookFieldValue(moduleKey, fieldKey, fieldResult.value?.trim() ?? "");
    const currentValue = formatWorkbookFieldValue(moduleKey, fieldKey, valueMap.get(`${recordId}::${fieldKey}`) ?? "");
    const confidence = normalizeConfidence(fieldResult.confidence);
    const minimumRequiredConfidence = minimumSuggestionConfidence(workflowKey);
    const sourceUrl = fieldResult.source_url?.trim() ?? "";
    const excerpt = fieldResult.excerpt?.trim() ?? "";

    if (
      (workflows[workflowKey].includeBoardRosterDiff && isBoardField(fieldKey)) ||
      !allowedFields.includes(fieldKey) ||
      !proposedValue ||
      !isValidCandidateForWorkflow(workflowKey, fieldResult, institution) ||
      valuesAreEquivalent(moduleKey, fieldKey, currentValue, proposedValue) ||
      pendingSet.has(`${recordId}::${fieldKey}`) ||
      !sourceUrl ||
      !excerpt ||
      confidence === null ||
      confidence < minimumRequiredConfidence
    ) {
      return [];
    }

    return [
      {
        module: moduleKey,
        record_id: recordId,
        field_key: fieldKey,
        current_value: currentValue,
        proposed_value: proposedValue,
        source_title: fieldResult.source_title ?? (workflows[workflowKey].sourceProfile === "deal-team" ? "Deal source" : "Perplexity source search"),
        source_url: sourceUrl,
        source_excerpt:
          workflows[workflowKey].sourceProfile === "deal-team"
            ? buildDealTeamSourceExcerpt(excerpt, fieldResult.providers)
            : buildSourceExcerpt(excerpt, fieldResult.providers),
        confidence
      }
    ];
  });

  if (!workflows[workflowKey].includeBoardRosterDiff) {
    return directSuggestions;
  }

  return [
    ...directSuggestions,
    ...buildBoardRosterDiffSuggestions(moduleKey, recordId, allowedFields, valueMap, pendingSet, result)
  ];
}

function buildBoardRosterDiffSuggestions(
  moduleKey: ModuleKey,
  recordId: string,
  allowedFields: readonly string[],
  valueMap: Map<string, string>,
  pendingSet: Set<string>,
  result: AutomationResearchResult
): UpdateSuggestionInsert[] {
  const boardFields = allowedFields.filter(isBoardField);
  const officialRoster = getConsensusBoardRoster(result);

  if (!boardFields.length || officialRoster.length < 3) {
    return [];
  }

  const currentSlots = boardFields.map((fieldKey) => {
    const value = (valueMap.get(`${recordId}::${fieldKey}`) ?? "").trim();

    return {
      fieldKey,
      normalizedValue: normalizePersonValue(value),
      value
    };
  });
  const currentMembers = currentSlots.filter((slot) => slot.normalizedValue);
  const hasCompleteRosterEvidence = officialRoster.length >= 5 || officialRoster.length >= currentMembers.length;
  const newMembers = officialRoster.filter(
    (member) => !currentMembers.some((slot) => samePersonValue(slot.value, member.value))
  );
  const removedSlots = hasCompleteRosterEvidence
    ? currentMembers.filter((slot) => !officialRoster.some((member) => samePersonValue(slot.value, member.value)))
    : [];
  const emptySlots = currentSlots.filter((slot) => !slot.normalizedValue);
  const suggestions: UpdateSuggestionInsert[] = [];
  const pendingKey = (fieldKey: string) => `${recordId}::${fieldKey}`;
  const newMemberQueue = [...newMembers];

  removedSlots.forEach((slot) => {
    if (pendingSet.has(pendingKey(slot.fieldKey))) {
      return;
    }

    const replacement = newMemberQueue.shift();

    if (replacement) {
      const suggestion = buildBoardRosterSuggestion(moduleKey, recordId, slot.fieldKey, slot.value, replacement, "replacement");

      if (suggestion) {
        suggestions.push(suggestion);
      }

      return;
    }

    const suggestion = buildBoardRemovalSuggestion(moduleKey, recordId, slot.fieldKey, slot.value, officialRoster);

    if (suggestion) {
      suggestions.push(suggestion);
    }
  });

  emptySlots.forEach((slot) => {
    if (!newMemberQueue.length || pendingSet.has(pendingKey(slot.fieldKey))) {
      return;
    }

    const newMember = newMemberQueue.shift();

    if (!newMember) {
      return;
    }

    const suggestion = buildBoardRosterSuggestion(moduleKey, recordId, slot.fieldKey, "", newMember, "new");

    if (suggestion) {
      suggestions.push(suggestion);
    }
  });

  return suggestions;
}

function getConsensusBoardRoster(result: AutomationResearchResult) {
  const memberByName = new Map<string, BoardRosterMember>();

  (result.fields ?? []).forEach((field) => {
    const fieldKey = field.field_key?.trim() ?? "";
    const value = field.value?.trim() ?? "";
    const normalizedValue = normalizePersonValue(value);
    const confidence = normalizeConfidence(field.confidence);

    if (
      !isBoardField(fieldKey) ||
      !value ||
      !normalizedValue ||
      !field.source_url?.trim() ||
      !field.excerpt?.trim() ||
      confidence === null ||
      confidence < minimumConfidence
    ) {
      return;
    }

    const existingMember = memberByName.get(normalizedValue);

    if (!existingMember || confidence > (existingMember.confidence ?? 0)) {
      memberByName.set(normalizedValue, {
        ...field,
        confidence,
        normalizedValue,
        value
      });
    }
  });

  return Array.from(memberByName.values()).slice(0, 7);
}

function buildBoardRosterSuggestion(
  moduleKey: ModuleKey,
  recordId: string,
  fieldKey: string,
  currentValue: string,
  member: BoardRosterMember,
  kind: "new" | "replacement"
): UpdateSuggestionInsert | null {
  const sourceUrl = member.source_url?.trim() ?? "";
  const excerpt = member.excerpt?.trim() ?? "";
  const confidence = normalizeConfidence(member.confidence);

  if (!sourceUrl || !excerpt || confidence === null || confidence < minimumConfidence) {
    return null;
  }

  return {
    module: moduleKey,
    record_id: recordId,
    field_key: fieldKey,
    current_value: currentValue,
    proposed_value: member.value,
    source_title: member.source_title ?? "Roster source",
    source_url: sourceUrl,
    source_excerpt: buildBoardRosterSourceExcerpt(kind, excerpt, member.providers, currentValue, member.value),
    confidence
  };
}

function buildBoardRemovalSuggestion(
  moduleKey: ModuleKey,
  recordId: string,
  fieldKey: string,
  currentValue: string,
  officialRoster: BoardRosterMember[]
): UpdateSuggestionInsert | null {
  const evidence = officialRoster
    .filter((member) => member.source_url?.trim() && member.excerpt?.trim())
    .sort((left, right) => (right.confidence ?? 0) - (left.confidence ?? 0))[0];

  if (!evidence) {
    return null;
  }

  const confidence = Math.max(
    minimumConfidence,
    Math.min(0.82, normalizeConfidence(evidence.confidence) ?? minimumConfidence)
  );

  return {
    module: moduleKey,
    record_id: recordId,
    field_key: fieldKey,
    current_value: currentValue,
    proposed_value: "",
    source_title: evidence.source_title ?? "Roster source",
    source_url: evidence.source_url ?? "",
    source_excerpt: buildBoardRosterSourceExcerpt("removed", evidence.excerpt ?? "", evidence.providers, currentValue),
    confidence
  };
}

function buildBoardRosterSourceExcerpt(
  kind: "new" | "replacement" | "removed",
  excerpt: string,
  providers?: ExtractorProvider[],
  currentValue?: string,
  proposedValue?: string
) {
  const evidence = buildSourceExcerpt(excerpt, providers);

  if (kind === "new") {
    return `Roster diff: New board member found in the current consensus roster. ${evidence}`;
  }

  if (kind === "replacement") {
    return `Roster diff: Possible board roster change; replace "${currentValue}" with "${proposedValue}". ${evidence}`;
  }

  return `Roster diff: Possibly removed; "${currentValue}" was not found in the current consensus roster. ${evidence}`;
}

function isBoardField(fieldKey: string) {
  return /^Board [1-7]$/.test(fieldKey);
}

function isDealTeamField(fieldKey: string) {
  return fieldKey === "Last Deal" || isDealTeamRoleField(fieldKey);
}

function isDealTeamRoleField(fieldKey: string) {
  return fieldKey === "MA" || isUnderwriterField(fieldKey) || fieldKey === "BC";
}

function isUnderwriterField(fieldKey: string) {
  return fieldKey === "UW" || fieldKey === "Underwriter";
}

function isValidCandidateForWorkflow(workflowKey: WorkflowKey, candidate: AutomationFieldResult, institution: string) {
  if (workflows[workflowKey].sourceProfile === "authorization") {
    return authorizationValidationReasons(candidate).length === 0;
  }

  if (workflows[workflowKey].sourceProfile !== "deal-team") {
    return true;
  }

  return isValidDealTeamCandidate(candidate, institution, candidate.package_context);
}

function isValidDealTeamCandidate(candidate: AutomationFieldResult, institution: string, packageContext?: string) {
  return dealTeamValidationReasons(candidate, institution, packageContext).length === 0;
}

function authorizationValidationReasons(candidate: AutomationFieldResult) {
  const fieldKey = candidate.field_key?.trim() ?? "";
  const value = candidate.value?.trim() ?? "";
  const evidenceText = [
    value,
    candidate.excerpt,
    candidate.source_title,
    candidate.source_url,
    candidate.source_context,
    candidate.package_context
  ]
    .filter(Boolean)
    .join(" ");
  const normalizedEvidence = normalizeIdentityText(evidenceText);
  const reasons: string[] = [];

  if (fieldKey !== "Auth" || !value) {
    return ["missing authorization field or value"];
  }

  if (!hasRemainingAuthorizationEvidence(normalizedEvidence)) {
    if (hasAnyPhrase(normalizedEvidence, ["bond measure", "election", "voter approved", "maximum bonded indebtedness"])) {
      reasons.push("Only original authorization found; no remaining unissued amount supported.");
    } else {
      reasons.push("no remaining/unissued authorization evidence");
    }
  }

  if (!/(\$\s?\d|\b\d+(?:\.\d+)?\s?(?:m|mm|million)\b)/i.test(value)) {
    reasons.push("authorization value lacks an amount");
  }

  return reasons;
}

function dealTeamValidationReasons(candidate: AutomationFieldResult, institution: string, packageContext?: string) {
  const fieldKey = candidate.field_key?.trim() ?? "";
  const value = candidate.value?.trim() ?? "";
  const reasons: string[] = [];

  if (!isDealTeamField(fieldKey) || !value) {
    return ["missing deal field or value"];
  }

  const sourceText = `${candidate.source_title ?? ""} ${candidate.source_url ?? ""} ${candidate.source_context ?? ""}`;
  const fieldEvidenceText = `${candidate.excerpt ?? ""}`;
  const packageEvidenceText = packageContext ?? candidate.package_context ?? "";
  const combinedEvidenceText = `${sourceText} ${fieldEvidenceText} ${packageEvidenceText}`;
  const normalizedSource = normalizeIdentityText(`${sourceText} ${packageEvidenceText}`);
  const normalizedFieldEvidence = normalizeIdentityText(fieldEvidenceText);
  const normalizedEvidence = normalizeIdentityText(combinedEvidenceText);
  const normalizedValue = normalizeIdentityText(value);

  if (!isL1StateFilingCandidate(candidate) && !dealEvidenceMentionsInstitution(normalizedSource, institution)) {
    reasons.push("source/evidence does not mention exact institution alias");
  }

  if (!hasRecentDealContext(combinedEvidenceText)) {
    reasons.push(`no ${minimumDealYear}+ deal context`);
  }

  if (fieldKey === "Last Deal") {
    if (!isSpecificLastDealValue(value)) {
      reasons.push("Last Deal lacks recent year or amount");
    }

    return reasons;
  }

  if (fieldKey === "MA") {
    if (
      !hasRoleEvidence(normalizedFieldEvidence, normalizedEvidence, [
        "municipal advisor",
        "municipal adviser",
        "financial advisor",
        "financial adviser"
      ])
    ) {
      reasons.push("no municipal/financial advisor role evidence");
    }

    if (hasDealLegalRole(normalizedValue)) {
      reasons.push("value looks like legal counsel, not MA");
    }

    return reasons;
  }

  if (isUnderwriterField(fieldKey)) {
    if (
      !hasRoleEvidence(normalizedFieldEvidence, normalizedEvidence, [
      "underwriter",
      "underwriting",
      "placement agent",
      "direct purchaser",
      "purchaser",
      "senior manager"
      ])
    ) {
      reasons.push("no underwriter role evidence");
    }

    if (hasDealLegalRole(normalizedValue)) {
      reasons.push("value looks like legal counsel, not underwriter");
    }

    if (hasAnyPhrase(normalizedValue, ["financial advisor", "financial adviser", "municipal advisor", "municipal adviser"])) {
      reasons.push("value looks like advisor, not underwriter");
    }

    return reasons;
  }

  if (fieldKey === "BC") {
    if (!hasRoleEvidence(normalizedFieldEvidence, normalizedEvidence, ["bond counsel"])) {
      reasons.push("no bond counsel role evidence");
    }

    if (hasAnyPhrase(normalizedValue, ["underwriter", "municipal advisor", "financial advisor"])) {
      reasons.push("value looks like non-counsel role");
    }

    return reasons;
  }

  return reasons;
}

function isL1StateFilingCandidate(candidate: AutomationFieldResult) {
  return normalizeIdentityText(`${candidate.source_context ?? ""} ${candidate.source_title ?? ""}`).includes("l1 state filing");
}

function dealEvidenceMentionsInstitution(normalizedEvidence: string, institution: string) {
  const aliases = uniqueStrings([...k12SearchAliases(institution), ...ccdSearchAliases(institution)])
    .map(normalizeIdentityText)
    .filter(Boolean);
  const genericInstitution = normalizeIdentityText(institution);

  if (genericInstitution && normalizedEvidence.includes(genericInstitution)) {
    return true;
  }

  return aliases.some((alias) => alias.length >= 6 && normalizedEvidence.includes(alias));
}

function isSpecificLastDealValue(value: string) {
  return hasRecentDealYear(value) && /(\$\s?\d|\b\d+(?:\.\d+)?\s?(?:m|mm|million)\b)/i.test(value);
}

function hasRecentDealContext(value: string) {
  return hasRecentDealYear(value) &&
    /bond|bonds|certificate|certificates|cfd|community facilities|financing|refunding|sfid|school facilities|special tax|official statement|series/i.test(value);
}

function hasRecentDealYear(value: string) {
  return extractYears(value).some((year) => year >= minimumDealYear);
}

function extractYears(value: string) {
  return Array.from(value.matchAll(/\b20\d{2}\b/g))
    .map((match) => Number(match[0]))
    .filter((year) => Number.isFinite(year));
}

function hasDealLegalRole(normalizedValue: string) {
  return hasAnyPhrase(normalizedValue, [
    "bond counsel",
    "disclosure counsel",
    "llp",
    "law",
    "lawyer",
    "attorney",
    "stradling",
    "orrick",
    "norton rose",
    "kutak",
    "jones hall",
    "hawkins",
    "mcguire",
    "nixon peabody"
  ]);
}

function hasRoleEvidence(normalizedFieldEvidence: string, normalizedEvidence: string, phrases: string[]) {
  return hasAnyPhrase(normalizedFieldEvidence, phrases) || hasAnyPhrase(normalizedEvidence, phrases);
}

function hasAnyPhrase(value: string, phrases: string[]) {
  return phrases.some((phrase) => value.includes(phrase));
}

function hasRemainingAuthorizationEvidence(value: string) {
  const normalizedValue = normalizeIdentityText(value);

  return hasAnyPhrase(normalizedValue, [
    "authorization remaining",
    "remaining authorization",
    "unissued authorization",
    "authorized but unissued",
    "amounts authorized but unissued",
    "authorization end period",
    "authamountendperiod",
    "remaining authorization end period"
  ]);
}

function valuesAreEquivalent(moduleKey: ModuleKey, fieldKey: string, currentValue: string, proposedValue: string) {
  if (equivalentFormattedValue(moduleKey, fieldKey, currentValue, proposedValue)) {
    return true;
  }

  const normalizedCurrent = normalizeComparableValue(currentValue);
  const normalizedProposed = normalizeComparableValue(proposedValue);

  if (!normalizedCurrent || !normalizedProposed) {
    return false;
  }

  if (normalizedCurrent === normalizedProposed) {
    return true;
  }

  if (!isPersonField(fieldKey)) {
    return false;
  }

  return samePersonValue(currentValue, proposedValue);
}

function isPersonField(fieldKey: string) {
  return fieldKey === "Sup" || fieldKey === "CBO" || fieldKey === "Chancellor" || fieldKey === "CFO" || isBoardField(fieldKey);
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

function samePersonValue(left: string, right: string) {
  const leftParts = normalizePersonParts(left);
  const rightParts = normalizePersonParts(right);

  if (!leftParts.canonical || !rightParts.canonical) {
    return false;
  }

  if (leftParts.canonical === rightParts.canonical) {
    return true;
  }

  if (personTokenSubset(leftParts.tokens, rightParts.tokens) || personTokenSubset(rightParts.tokens, leftParts.tokens)) {
    return true;
  }

  const leftLast = leftParts.tokens[leftParts.tokens.length - 1];
  const rightLast = rightParts.tokens[rightParts.tokens.length - 1];

  if (!leftLast || !rightLast || leftLast !== rightLast) {
    return false;
  }

  const leftGivenTokens = new Set(leftParts.tokens.slice(0, -1));
  const rightGivenTokens = new Set(rightParts.tokens.slice(0, -1));

  return Array.from(leftGivenTokens).some((token) => rightGivenTokens.has(token));
}

function personTokenSubset(shorterCandidate: string[], longerCandidate: string[]) {
  if (shorterCandidate.length < 2 || shorterCandidate.length > longerCandidate.length) {
    return false;
  }

  const longerTokens = new Set(longerCandidate);

  return shorterCandidate.every((token) => longerTokens.has(token));
}

function parseJsonObject(content: string) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error("Provider did not return JSON.");
    }

    return JSON.parse(match[0]);
  }
}

function normalizeErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return trimText(error.message, 260);
  }

  if (typeof error === "string") {
    return trimText(error, 260);
  }

  return "Provider request failed.";
}

async function safeJson(request: Request) {
  try {
    return (await request.json()) as { limit?: unknown; module?: unknown; recordIds?: unknown; workflow?: unknown };
  } catch {
    return {};
  }
}

function clampLimit(value: unknown) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return defaultBatchLimit;
  }

  return Math.min(Math.max(Math.floor(numericValue), 1), defaultBatchLimit);
}

function normalizeConfidence(value: unknown) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.min(Math.max(numericValue, 0), 1);
}

function minimumSuggestionConfidence(workflowKey: WorkflowKey) {
  return workflows[workflowKey].sourceProfile === "deal-team"
    ? minimumDealTeamSuggestionConfidence
    : minimumConfidence;
}

function isDealWorkflow(workflowKey: WorkflowKey) {
  const sourceProfile = workflows[workflowKey].sourceProfile;

  return sourceProfile === "ccd-refundings" ||
    sourceProfile === "deal-team" ||
    sourceProfile === "last-deal" ||
    sourceProfile === "plan-deal-facts";
}

function formatConfidence(value: number | null) {
  if (value === null) {
    return "no confidence";
  }

  return `${Math.round(value * 100)}%`;
}

function isWorkflowKey(value: unknown): value is WorkflowKey {
  return typeof value === "string" && value in workflows;
}

function isModuleKey(value: unknown): value is ModuleKey {
  return value === "k12-targets" || value === "ccd-targets" || value === "plans";
}

function defaultWorkflowForModule(moduleKey: ModuleKey): WorkflowKey {
  if (moduleKey === "ccd-targets") {
    return "ccd-deal-facts";
  }

  if (moduleKey === "plans") {
    return "plan-deal-facts";
  }

  return moduleKey === "k12-targets" ? "last-deal" : "leadership";
}

function entityLabel(moduleKey: ModuleKey) {
  if (moduleKey === "ccd-targets") {
    return "CCD";
  }

  if (moduleKey === "plans") {
    return "issuer";
  }

  return "institution";
}

function recordSearchName(row: WorkspaceRecord, moduleKey: ModuleKey) {
  if (moduleKey === "ccd-targets") {
    return ccdCanonicalSearchName(String(row.fields["CCD Targets"] ?? row.title));
  }

  if (moduleKey === "plans") {
    return String(row.fields.Issuer ?? row.title);
  }

  return String(row.fields.District ?? row.title);
}

function getSourceSearchConfigs(): SourceSearchConfig[] {
  const sourceSearchConfigs: SourceSearchConfig[] = [];
  const perplexityKey = getPerplexityApiKey();
  const openAIKey = getOpenAIApiKey();

  if (perplexityKey) {
    sourceSearchConfigs.push({
      apiKey: perplexityKey,
      model: getPerplexityModel(),
      provider: "perplexity"
    });
  }

  if (openAIKey) {
    sourceSearchConfigs.push({
      apiKey: openAIKey,
      model: getOpenAIModel(),
      provider: "openai"
    });
  }

  return sourceSearchConfigs;
}

function getExtractorConfigs(): ExtractorConfig[] {
  const requestedProvider = getK12ExtractionProvider().toLowerCase();
  const openAIKey = getOpenAIApiKey();
  const perplexityKey = getPerplexityApiKey();

  if (requestedProvider === "openai") {
    if (!openAIKey) {
      throw new Error("Add OPENAI_API_KEY in Vercel or change K12_EXTRACTION_PROVIDER.");
    }

    return [
      {
        apiKey: openAIKey,
        model: getOpenAIModel(),
        provider: "openai"
      }
    ];
  }

  if (requestedProvider === "anthropic") {
    throw new Error("Claude/Anthropic is disabled for this workbook. Use OPENAI_API_KEY and PERPLEXITY_API_KEY.");
  }

  if (requestedProvider === "perplexity") {
    return [
      {
        apiKey: perplexityKey,
        model: getPerplexityModel(),
        provider: "perplexity"
      }
    ];
  }

  const extractors: ExtractorConfig[] = [];

  if (openAIKey) {
    extractors.push({
      apiKey: openAIKey,
      model: getOpenAIModel(),
      provider: "openai"
    });
  }

  if (perplexityKey) {
    extractors.push({
      apiKey: perplexityKey,
      model: getPerplexityModel(),
      provider: "perplexity"
    });
  }

  if (!extractors.length) {
    throw new Error("Add OPENAI_API_KEY or PERPLEXITY_API_KEY in Vercel.");
  }

  return extractors;
}

function isUsableCandidate(candidate: AutomationFieldResult) {
  const confidence = normalizeConfidence(candidate.confidence);

  return Boolean(
    candidate.value?.trim() &&
      candidate.excerpt?.trim() &&
      candidate.source_url?.trim() &&
      candidate.providers?.length &&
      confidence !== null &&
      confidence >= minimumProviderConfidence
  );
}

function buildSourceExcerpt(excerpt: string, providers?: ExtractorProvider[]) {
  const uniqueProviders = Array.from(new Set(providers ?? []));

  if (uniqueProviders.length < minimumConsensusVotes) {
    return excerpt;
  }

  return `Consensus: ${uniqueProviders.join(", ")}. ${excerpt}`;
}

function buildDealTeamSourceExcerpt(excerpt: string, providers?: ExtractorProvider[]) {
  const uniqueProviders = Array.from(new Set(providers ?? []));
  const providerText = uniqueProviders.length ? ` Providers: ${uniqueProviders.join(", ")}.` : "";

  return `Deal package extraction.${providerText} ${excerpt}`;
}

function canonicalSourceKey(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    ["fbclid", "gclid", "mc_cid", "mc_eid", "utm_campaign", "utm_medium", "utm_source", "utm_term"].forEach((key) =>
      url.searchParams.delete(key)
    );
    url.pathname = url.pathname.replace(/\/+$/, "");

    return url.toString().toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

function sourceHostName(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function normalizeIdentityText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function mergeSourceSnippets(primarySnippet: string, secondarySnippet: string) {
  const primary = primarySnippet.trim();
  const secondary = secondarySnippet.trim();

  if (!primary) {
    return secondary;
  }

  if (!secondary || primary.includes(secondary)) {
    return primary;
  }

  if (secondary.includes(primary)) {
    return secondary;
  }

  return `${primary}\n${secondary}`;
}

function scoreSource(source: SearchSource, workflowKey: WorkflowKey) {
  const haystack = `${source.title} ${source.url} ${source.snippet}`.toLowerCase();
  const sourceProfile = workflows[workflowKey].sourceProfile;
  let score = 0;

  try {
    const host = new URL(source.url).hostname.replace(/^www\./, "").toLowerCase();

    if (host.includes(".k12.ca.us") || host.endsWith(".org") || host.endsWith(".edu")) {
      score += 3;
    }

    if (host.includes("cdiac") || host.includes("debtwatch")) {
      score += 5;
    }

    if (host.includes("emma.msrb.org")) {
      score += 5;
    }

    if (sourceProfile === "deal-team" && (host.includes("bondlink") || host.includes("munios"))) {
      score += 4;
    }
  } catch {
    score += 0;
  }

  if (sourceProfile === "k12-leadership") {
    score += keywordScore(haystack, [
      ["our board", 6],
      ["board members", 6],
      ["board of trustees", 6],
      ["governing board", 6],
      ["board of education", 5],
      ["trustee", 4],
      ["superintendent", 3],
      ["chief business", 3],
      ["business services", 3],
      ["cabinet", 2]
    ]);
  }

  if (sourceProfile === "ccd-leadership") {
    score += keywordScore(haystack, [
      ["chancellor", 7],
      ["chancellor/ceo", 7],
      ["chief financial officer", 7],
      ["superintendent/president", 7],
      ["president/superintendent", 7],
      ["president/ceo", 6],
      ["vice chancellor", 6],
      ["finance and administration", 6],
      ["vice president", 5],
      ["business services", 5],
      ["business administration", 5],
      ["fiscal services", 5],
      ["financial services", 5],
      ["administration and finance", 5],
      ["administration services", 5],
      ["administrative services", 4],
      ["executive cabinet", 4],
      ["executive vice president", 4],
      ["college leadership", 3],
      ["senior staff", 3],
      ["leadership", 3],
      ["staff directory", 3],
      ["directory", 2]
    ]);
  }

  if (sourceProfile === "deal-team") {
    score += dealSourceCategoryScore(dealSourceCategory(source));
    score += dealYearScore(latestDealYearFromText(haystack)) / 4;
    score += keywordScore(haystack, [
      ["official statement", 10],
      ["preliminary official statement", 10],
      ["emma", 8],
      ["cdiac", 8],
      ["debtwatch", 8],
      ["municipal advisor", 7],
      ["municipal adviser", 7],
      ["financial advisor", 6],
      ["financial adviser", 6],
      ["bond counsel", 7],
      ["co-bond counsel", 6],
      ["underwriter", 7],
      ["underwriting", 6],
      ["senior manager", 6],
      ["initial purchaser", 6],
      ["placement agent", 5],
      ["direct purchaser", 5],
      ["community facilities district", 7],
      ["special tax bonds", 7],
      ["school facilities improvement district", 7],
      ["financing team", 6],
      ["finance team", 5],
      ["transaction participants", 5],
      ["participants", 3],
      ["professionals", 3],
      ["board agenda", 5],
      ["agenda packet", 5],
      ["board minutes", 6],
      ["meeting minutes", 6],
      ["agenda minutes", 6],
      ["minutes", 3],
      ["staff report", 5],
      ["resolution", 4],
      ["bond purchase agreement", 7],
      ["purchase contract", 6],
      ["notice of sale", 5],
      ["financing documents", 5],
      ["bond documents", 5],
      ["bondlink", 4],
      ["munios", 4],
      ["sale date", 4],
      ["series 2026", 4],
      ["series 2025", 4],
      ["series 2024", 3],
      ["series 2023", 3],
      ["cfd", 3],
      ["sfid", 3],
      ["new money", 3],
      ["refunding", 3],
      ["refundings", 3],
      ["refunded bonds", 3],
      ["prior bonds", 2],
      ["debt service savings", 2],
      ["principal amount", 3],
      ["aggregate principal amount", 3],
      ["par amount", 3],
      ["authorization", 2],
      ["authorizations", 2],
      ["authorized", 2],
      ["remaining authorization", 3],
      ["unissued authorization", 3],
      ["board approved", 4],
      ["approved the issuance", 4],
      ["authorize the issuance", 4],
      ["authorizing the issuance", 4],
      ["bond measure", 2],
      ["maximum bonded indebtedness", 2],
      [".pdf", 2]
    ]);
  }

  if (sourceProfile === "authorization") {
    score += dealSourceCategoryScore(dealSourceCategory(source));
    score += dealYearScore(latestDealYearFromText(haystack)) / 5;
    score += keywordScore(haystack, [
      ["official statement", 14],
      ["preliminary official statement", 14],
      ["offering document", 12],
      ["emma", 10],
      ["cdiac", 10],
      ["debtwatch", 10],
      ["authorization remaining", 14],
      ["remaining authorization", 14],
      ["unissued authorization", 14],
      ["authorized but unissued", 13],
      ["amounts authorized but unissued", 13],
      ["authorization table", 10],
      ["authorization", 4],
      ["authorized", 3],
      ["bond measure", 3],
      ["measure", 1],
      ["facilities bond", 3],
      ["voter-approved", 2],
      ["voter approved", 2],
      ["election", 1],
      ["maximum bonded indebtedness", 4],
      ["proposition 39", 2],
      ["55%", 2]
    ]);

    if (
      hasAnyPhrase(haystack, ["election", "bond measure", "voter approved", "voter-approved"]) &&
      !hasRemainingAuthorizationEvidence(haystack) &&
      !hasAnyPhrase(haystack, ["official statement", "preliminary official statement", "offering document"])
    ) {
      score -= 12;
    }
  }

  return score;
}

function keywordScore(value: string, weightedKeywords: Array<[string, number]>) {
  return weightedKeywords.reduce((sum, [keyword, weight]) => sum + (value.includes(keyword) ? weight : 0), 0);
}

function mergedSourceLimit(workflowKey: WorkflowKey) {
  const sourceProfile = workflows[workflowKey].sourceProfile;

  if (sourceProfile === "ccd-leadership") {
    return maxMergedCcdLeadershipSources;
  }

  if (sourceProfile === "deal-team") {
    return maxMergedDealTeamSources;
  }

  return maxMergedSources;
}

function expandedSourceLimit(workflowKey: WorkflowKey) {
  const sourceProfile = workflows[workflowKey].sourceProfile;

  if (sourceProfile === "ccd-leadership") {
    return maxExpandedCcdLeadershipSources;
  }

  if (sourceProfile === "deal-team") {
    return maxExpandedDealTeamSources;
  }

  return maxExpandedSources;
}

function pdfPageLimit(workflowKey: WorkflowKey) {
  return workflows[workflowKey].sourceProfile === "deal-team" ? maxPdfPages : 35;
}

function isExpandableSource(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const pathname = url.pathname.toLowerCase();

    if (pathname.endsWith(".pdf")) {
      return true;
    }

    return !/\.(csv|doc|docx|gif|jpg|jpeg|png|ppt|pptx|xls|xlsx|zip)$/.test(pathname);
  } catch {
    return false;
  }
}

function isPdfResponse(rawUrl: string, contentType: string) {
  if (contentType.includes("pdf")) {
    return true;
  }

  try {
    return new URL(rawUrl).pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

function extractPdfLinksFromHtml(html: string, baseUrl: string) {
  const links = Array.from(
    html.matchAll(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)
  ).flatMap((match) => {
    const href = decodeHtmlAttribute(match[2] ?? "");
    const label = htmlToReadableText(match[3] ?? "");

    if (!href || href.startsWith("#") || href.toLowerCase().startsWith("mailto:")) {
      return [];
    }

    try {
      const url = new URL(href, baseUrl).toString();
      const haystack = normalizeIdentityText(`${label} ${url}`);
      const looksLikePdf = /\.pdf(?:$|[?#])/i.test(url) || haystack.includes("pdf");
      const looksLikeDealDocument = hasAnyPhrase(haystack, [
        "official statement",
        "preliminary official statement",
        "pos",
        "bonds",
        "bond",
        "community facilities district",
        "special tax",
        "municipal advisor",
        "bond counsel",
        "underwriter",
        "board minutes",
        "meeting minutes",
        "agenda minutes",
        "minutes",
        "emma",
        "os"
      ]);

      if (!looksLikePdf && !looksLikeDealDocument) {
        return [];
      }

      if (!isUsableSource(url)) {
        return [];
      }

      return [
        {
          title: label || sourceTitleFromUrl(url),
          url
        }
      ];
    } catch {
      return [];
    }
  });
  const linkMap = new Map<string, { title: string; url: string }>();

  links.forEach((link) => {
    const key = canonicalSourceKey(link.url);

    if (!linkMap.has(key)) {
      linkMap.set(key, link);
    }
  });

  return Array.from(linkMap.values());
}

function scoreLinkedPdf(link: { title: string; url: string }) {
  const haystack = normalizeIdentityText(`${link.title} ${link.url}`);

  return keywordScore(haystack, [
    ["preliminary official statement", 12],
    ["official statement", 11],
    ["pos", 8],
    ["emma", 8],
    ["series 2026", 6],
    ["series 2025", 6],
    ["series 2024", 5],
    ["series 2023", 5],
    ["community facilities district", 5],
    ["special tax", 5],
    ["municipal advisor", 4],
    ["municipal adviser", 4],
    ["financial advisor", 4],
    ["financial adviser", 4],
    ["bond counsel", 4],
    ["co-bond counsel", 3],
    ["underwriter", 4],
    ["underwriting", 3],
    ["senior manager", 3],
    ["initial purchaser", 3],
    ["placement agent", 3],
    ["board minutes", 4],
    ["meeting minutes", 4],
    ["agenda minutes", 4],
    ["minutes", 2],
    ["transaction participants", 3],
    ["financing team", 3],
    ["principal amount", 3],
    ["authorization", 2],
    ["refunding", 2],
    ["bonds", 3],
    ["pdf", 2]
  ]);
}

function decodeHtmlAttribute(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function htmlToReadableText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|div|h[1-6]|li|p|section|td|th|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&ndash;|&#8211;/g, "-")
    .replace(/&mdash;|&#8212;/g, "-")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractRelevantEvidenceText(text: string, workflowKey: WorkflowKey) {
  const keywords = relevantSourceKeywords(workflowKey);
  const lineLengthLimit = evidenceLineLengthLimit(workflowKey);
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 2 && line.length <= lineLengthLimit);
  const selectedIndexes = new Set<number>();

  lines.forEach((line, index) => {
    const normalizedLine = line.toLowerCase();

    if (!keywords.some((keyword) => normalizedLine.includes(keyword))) {
      return;
    }

    for (let windowIndex = Math.max(0, index - 2); windowIndex <= Math.min(lines.length - 1, index + 12); windowIndex += 1) {
      selectedIndexes.add(windowIndex);
    }
  });

  const selectedLines = Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => lines[index])
    .filter(Boolean);
  const windowEvidence = extractKeywordWindowsText(text, workflowKey, expandedSourceCharacterLimit(workflowKey));
  const evidenceText = selectedLines.length ? selectedLines.join("\n") : windowEvidence || lines.slice(0, 40).join("\n");

  return trimText(evidenceText, expandedSourceCharacterLimit(workflowKey));
}

function extractKeywordWindowsText(text: string, workflowKey: WorkflowKey, maxLength: number) {
  const keywords = relevantSourceKeywords(workflowKey);
  const normalizedText = text.toLowerCase();
  const windows: Array<[number, number]> = [];

  keywords.forEach((keyword) => {
    let index = normalizedText.indexOf(keyword.toLowerCase());

    while (index !== -1 && windows.length < 80) {
      windows.push([Math.max(0, index - 450), Math.min(text.length, index + 1200)]);
      index = normalizedText.indexOf(keyword.toLowerCase(), index + keyword.length);
    }
  });

  if (!windows.length) {
    return "";
  }

  const mergedWindows = windows
    .sort((left, right) => left[0] - right[0])
    .reduce<Array<[number, number]>>((merged, window) => {
      const previous = merged[merged.length - 1];

      if (!previous || window[0] > previous[1] + 160) {
        merged.push([...window]);
        return merged;
      }

      previous[1] = Math.max(previous[1], window[1]);
      return merged;
    }, []);

  return trimText(
    mergedWindows
      .map(([start, end]) => text.slice(start, end).replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n...\n"),
    maxLength
  );
}

function evidenceLineLengthLimit(workflowKey: WorkflowKey) {
  const sourceProfile = workflows[workflowKey].sourceProfile;

  if (sourceProfile === "ccd-leadership" || sourceProfile === "deal-team") {
    return 420;
  }

  return 260;
}

function expandedSourceCharacterLimit(workflowKey: WorkflowKey) {
  const sourceProfile = workflows[workflowKey].sourceProfile;

  if (sourceProfile === "ccd-leadership") {
    return maxExpandedCcdLeadershipSourceCharacters;
  }

  if (sourceProfile === "deal-team") {
    return maxExpandedDealTeamSourceCharacters;
  }

  return maxExpandedSourceCharacters;
}

function relevantSourceKeywords(workflowKey: WorkflowKey) {
  const sourceProfile = workflows[workflowKey].sourceProfile;

  if (sourceProfile === "k12-leadership") {
    return [
      "assistant superintendent",
      "board",
      "business",
      "chief business",
      "governing",
      "member",
      "president",
      "superintendent",
      "trustee"
    ];
  }

  if (sourceProfile === "ccd-leadership") {
    return [
      "administrative services",
      "business administration",
      "business services",
      "cabinet",
      "chancellor",
      "chancellor/ceo",
      "chief financial officer",
      "college leadership",
      "executive vice president",
      "executive leadership",
      "finance and administration",
      "financial services",
      "fiscal services",
      "leadership",
      "president/ceo",
      "president/superintendent",
      "senior staff",
      "superintendent/president",
      "vice president",
      "vice chancellor"
    ];
  }

  if (sourceProfile === "deal-team") {
    return [
      "agenda",
      "aggregate principal amount",
      "authorization",
      "authorizations",
      "authorized",
      "authorize the issuance",
      "authorizing the issuance",
      "bond counsel",
      "bond documents",
      "bond measure",
      "bond purchase agreement",
      "bonds",
      "board approved",
      "cdiac",
      "cfd",
      "closing date",
      "co-bond counsel",
      "community facilities district",
      "dated date",
      "debt service",
      "debt service savings",
      "debtwatch",
      "defeasance",
      "delivery date",
      "dealer",
      "direct purchaser",
      "emma",
      "escrow",
      "financial adviser",
      "financial advisor",
      "financing",
      "financing team",
      "finance team",
      "fiscal agent",
      "general obligation bonds",
      "go bonds",
      "initial purchaser",
      "maximum bonded indebtedness",
      "board minutes",
      "meeting minutes",
      "minutes",
      "municipal adviser",
      "new money",
      "official statement",
      "par amount",
      "participants",
      "placement agent",
      "preliminary official statement",
      "principal amount",
      "prior bonds",
      "professionals",
      "proposition 39",
      "purchase contract",
      "refundings",
      "refunded bonds",
      "municipal advisor",
      "refunding",
      "remaining authorization",
      "resolution",
      "notice of sale",
      "sale date",
      "school facilities improvement district",
      "senior manager",
      "series 2024",
      "series 2025",
      "series 2026",
      "series 2023",
      "sfid",
      "special tax",
      "special tax bonds",
      "staff report",
      "transaction participants",
      "underwriting",
      "unissued authorization",
      "underwriter"
    ];
  }

  return [
    "authorization",
    "authorized",
    "bond measure",
    "bond program",
    "election",
    "maximum bonded indebtedness",
    "measure",
    "proposition 39",
    "remaining authorization",
    "unissued authorization",
    "voter",
    "voter approved",
    "voter-approved"
  ];
}

function trimText(value: string, maxLength: number) {
  const normalized = value.replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trim()}...`;
}

function normalizePersonValue(value: string) {
  return normalizePersonParts(value).canonical;
}

function normalizePersonParts(value: string) {
  const withoutParentheticals = value.replace(/\([^)]*\)/g, " ");
  const beforeComma = withoutParentheticals.split(",")[0] ?? withoutParentheticals;
  const normalized = beforeComma
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\b([a-z])\./g, " ")
    .replace(
      /\b(acting|assistant|board|business|cbo|cfo|chair|chancellor|chief|clerk|cpa|d|director|dr|ed|executive|finance|financial|fiscal|interim|jd|jr|mba|member|mr|mrs|ms|officer|ph|president|prof|secretary|services|sr|superintendent|trustee|vice|ii|iii|iv)\b/g,
      " "
    )
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = normalized
    .split(" ")
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter((word) => word.length > 1);

  if (words.length >= 2) {
    return {
      canonical: `${words[0]} ${words[words.length - 1]}`,
      tokens: words
    };
  }

  return {
    canonical: words.join(" "),
    tokens: words
  };
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function isUsableSource(rawUrl: string) {
  try {
    const host = new URL(rawUrl).hostname.replace(/^www\./, "").toLowerCase();
    return !blockedSourceHosts.some((blockedHost) => host === blockedHost || host.endsWith(`.${blockedHost}`));
  } catch {
    return false;
  }
}
