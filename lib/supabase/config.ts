export function getSupabaseUrl() {
  return process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
}

export function getSupabaseAnonKey() {
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
}

export function getSupabaseServiceRoleKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
}

export function getSignupAccessCode() {
  return process.env.SIGNUP_ACCESS_CODE ?? "";
}

export function getOpenAIApiKey() {
  return process.env.OPENAI_API_KEY ?? "";
}

export function getOpenAIModel() {
  return process.env.OPENAI_MODEL ?? "gpt-4.1-mini";
}

export function getAnthropicApiKey() {
  return process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY ?? process.env.Claude_API_KEY ?? "";
}

export function getClaudeApiKey() {
  return process.env.CLAUDE_API_KEY ?? process.env.Claude_API_KEY ?? "";
}

export function getAnthropicModel() {
  return process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514";
}

export function getK12ExtractionProvider() {
  return process.env.K12_EXTRACTION_PROVIDER ?? process.env.AI_EXTRACTION_PROVIDER ?? "auto";
}

export function isDealTeamWebFallbackEnabled() {
  return ["1", "true", "yes", "on"].includes(
    (process.env.DEAL_TEAM_WEB_FALLBACK ?? process.env.K12_DEAL_TEAM_WEB_FALLBACK ?? "").trim().toLowerCase()
  );
}

export function getPerplexityApiKey() {
  return process.env.PERPLEXITY_API_KEY ?? process.env.PUBFIN_API_KEY ?? "";
}

export function getPubfinApiKey() {
  return process.env.PUBFIN_API_KEY ?? "";
}

export function getPerplexityModel() {
  return process.env.PERPLEXITY_MODEL ?? "sonar-pro";
}

export function isSupabaseConfigured() {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();

  return Boolean(supabaseUrl && supabaseAnonKey);
}
