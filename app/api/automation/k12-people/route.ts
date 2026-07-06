import { NextResponse } from "next/server";
import { getModuleRows } from "@/lib/data";
import { getPerplexityApiKey, getPerplexityModel } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const peopleFields = ["Sup", "CBO", "Board 1", "Board 2", "Board 3", "Board 4", "Board 5", "Board 6", "Board 7"];

type PeopleFieldResult = {
  value?: string;
  source_title?: string;
  source_url?: string;
  excerpt?: string;
  confidence?: number;
};

type PeopleResearchResult = {
  superintendent?: PeopleFieldResult;
  cbo?: PeopleFieldResult;
  board_members?: PeopleFieldResult[];
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

export async function POST(request: Request) {
  const apiKey = getPerplexityApiKey();

  if (!apiKey) {
    return NextResponse.json(
      { error: "Add PERPLEXITY_API_KEY in Vercel to run this automation." },
      { status: 503 }
    );
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
  const limit = clampLimit(body?.limit);
  const rows = getModuleRows("k12-targets").filter((row) => row.kind !== "section").slice(0, 80);
  const rowIds = rows.map((row) => row.id);

  const [{ data: savedValues, error: valuesError }, { data: pendingSuggestions, error: pendingError }] =
    await Promise.all([
      supabase
        .from("workbook_field_values")
        .select("record_id, field_key, value")
        .eq("module", "k12-targets")
        .in("record_id", rowIds)
        .in("field_key", peopleFields),
      supabase
        .from("update_suggestions")
        .select("record_id, field_key")
        .eq("module", "k12-targets")
        .eq("status", "pending")
        .in("record_id", rowIds)
        .in("field_key", peopleFields)
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
  const pendingSet = new Set(
    ((pendingSuggestions ?? []) as PendingSuggestion[]).map((field) => `${field.record_id}::${field.field_key}`)
  );

  const candidates = rows
    .filter((row) => peopleFields.some((field) => !pendingSet.has(`${row.id}::${field}`)))
    .slice(0, limit);

  const suggestions = [];
  const errors = [];

  for (const row of candidates) {
    try {
      const result = await researchDistrictPeople(String(row.fields.District ?? row.title), apiKey);
      const nextSuggestions = buildSuggestions(row.id, valueMap, pendingSet, result);
      suggestions.push(...nextSuggestions);
    } catch (error) {
      errors.push({
        district: row.title,
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
    scanned: candidates.length,
    created: suggestions.length,
    errors
  });
}

async function researchDistrictPeople(district: string, apiKey: string): Promise<PeopleResearchResult> {
  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    body: JSON.stringify({
      model: getPerplexityModel(),
      messages: [
        {
          role: "system",
          content:
            "You research California K-12 school district leadership. Prefer official district websites. Return only valid JSON, with no markdown."
        },
        {
          role: "user",
          content: `Find the current Superintendent, Chief Business Officer or equivalent business services executive, and Board of Education/Trustee members for ${district}. Use official district sources whenever possible. Return JSON exactly in this shape: {"superintendent":{"value":"","source_title":"","source_url":"","excerpt":"","confidence":0},"cbo":{"value":"","source_title":"","source_url":"","excerpt":"","confidence":0},"board_members":[{"value":"","source_title":"","source_url":"","excerpt":"","confidence":0}]}`
        }
      ],
      temperature: 0.1
    }),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Perplexity request failed with ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    citations?: string[];
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonObject(content) as PeopleResearchResult;
  const fallbackSourceUrl = data.citations?.[0];

  return fillFallbackSources(parsed, fallbackSourceUrl);
}

function buildSuggestions(
  recordId: string,
  valueMap: Map<string, string>,
  pendingSet: Set<string>,
  result: PeopleResearchResult
) {
  const fieldResults = [
    ["Sup", result.superintendent],
    ["CBO", result.cbo],
    ...((result.board_members ?? []).slice(0, 7).map((member, index) => [`Board ${index + 1}`, member]) as Array<
      [string, PeopleFieldResult | undefined]
    >)
  ] as Array<[string, PeopleFieldResult | undefined]>;

  return fieldResults.flatMap(([fieldKey, fieldResult]) => {
    const proposedValue = fieldResult?.value?.trim();
    const currentValue = valueMap.get(`${recordId}::${fieldKey}`) ?? "";

    if (!proposedValue || proposedValue === currentValue || pendingSet.has(`${recordId}::${fieldKey}`)) {
      return [];
    }

    return [
      {
        module: "k12-targets",
        record_id: recordId,
        field_key: fieldKey,
        current_value: currentValue,
        proposed_value: proposedValue,
        source_title: fieldResult?.source_title ?? "Perplexity research",
        source_url: fieldResult?.source_url ?? null,
        source_excerpt: fieldResult?.excerpt ?? null,
        confidence: normalizeConfidence(fieldResult?.confidence)
      }
    ];
  });
}

function fillFallbackSources(result: PeopleResearchResult, fallbackSourceUrl?: string): PeopleResearchResult {
  const applyFallback = (field?: PeopleFieldResult) => {
    if (field && !field.source_url && fallbackSourceUrl) {
      field.source_url = fallbackSourceUrl;
    }
  };

  applyFallback(result.superintendent);
  applyFallback(result.cbo);
  result.board_members?.forEach(applyFallback);

  return result;
}

function parseJsonObject(content: string) {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error("Perplexity did not return JSON.");
    }

    return JSON.parse(match[0]);
  }
}

async function safeJson(request: Request) {
  try {
    return (await request.json()) as { limit?: unknown };
  } catch {
    return {};
  }
}

function clampLimit(value: unknown) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return 5;
  }

  return Math.min(Math.max(Math.floor(numericValue), 1), 10);
}

function normalizeConfidence(value: unknown) {
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.min(Math.max(numericValue, 0), 1);
}
