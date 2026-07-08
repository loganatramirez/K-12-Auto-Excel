import { NextResponse } from "next/server";
import {
  getK12ExtractionProvider,
  getOpenAIApiKey,
  getPerplexityApiKey,
  getPubfinApiKey,
  getSignupAccessCode,
  getSupabaseAnonKey,
  getSupabaseServiceRoleKey,
  getSupabaseUrl,
  isSupabaseConfigured
} from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

export function GET() {
  const supabaseUrl = getSupabaseUrl();
  const supabaseAnonKey = getSupabaseAnonKey();
  const supabaseServiceRoleKey = getSupabaseServiceRoleKey();
  const signupAccessCode = getSignupAccessCode();
  const perplexityApiKey = getPerplexityApiKey();
  const pubfinApiKey = getPubfinApiKey();
  const openAIApiKey = getOpenAIApiKey();
  const supabaseHost = safeHost(supabaseUrl);

  return NextResponse.json({
    supabaseConfigured: isSupabaseConfigured(),
    supabaseUrlPresent: Boolean(supabaseUrl),
    supabaseUrlLength: supabaseUrl.length,
    supabaseHost,
    supabaseProjectRef: supabaseHost.endsWith(".supabase.co") ? supabaseHost.replace(".supabase.co", "") : "",
    supabaseAnonKeyPresent: Boolean(supabaseAnonKey),
    supabaseAnonKeyLength: supabaseAnonKey.length,
    signupConfigured: Boolean(supabaseServiceRoleKey && signupAccessCode),
    supabaseServiceRoleKeyPresent: Boolean(supabaseServiceRoleKey),
    supabaseServiceRoleKeyLength: supabaseServiceRoleKey.length,
    signupAccessCodePresent: Boolean(signupAccessCode),
    signupAccessCodeLength: signupAccessCode.length,
    k12ResearchConfigured: Boolean(perplexityApiKey || openAIApiKey),
    peopleAutomationConfigured: Boolean(perplexityApiKey),
    perplexityApiKeyPresent: Boolean(perplexityApiKey),
    perplexityApiKeyLength: perplexityApiKey.length,
    pubfinApiKeyPresent: Boolean(pubfinApiKey),
    pubfinApiKeyLength: pubfinApiKey.length,
    k12ExtractionProvider: getK12ExtractionProvider(),
    openAIApiKeyPresent: Boolean(openAIApiKey),
    openAIApiKeyLength: openAIApiKey.length,
    claudeDisabled: true
  });
}

function safeHost(value: string) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}
