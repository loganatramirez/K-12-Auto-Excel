import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isValidEmail, normalizeEmail } from "@/lib/auth";
import {
  getSignupAccessCode,
  getSupabaseServiceRoleKey,
  getSupabaseUrl
} from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const { code, email, password } = (await request.json()) as {
    code?: string;
    email?: string;
    password?: string;
  };

  const normalizedEmail = normalizeEmail(email);
  const signupAccessCode = getSignupAccessCode();
  const supabaseUrl = getSupabaseUrl();
  const serviceRoleKey = getSupabaseServiceRoleKey();

  if (!signupAccessCode || !serviceRoleKey || !supabaseUrl) {
    return NextResponse.json(
      { error: "Signup is not configured yet." },
      { status: 503 }
    );
  }

  if (code !== signupAccessCode) {
    return NextResponse.json(
      { error: "Invalid registration code." },
      { status: 403 }
    );
  }

  if (!isValidEmail(normalizedEmail)) {
    return NextResponse.json(
      { error: "Please enter a valid email address." },
      { status: 400 }
    );
  }

  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  const { error } = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true
  });

  if (error) {
    const alreadyRegistered =
      error.message.toLowerCase().includes("already") ||
      error.message.toLowerCase().includes("registered");

    return NextResponse.json(
      {
        error: alreadyRegistered
          ? "This email already has an account. Try signing in."
          : error.message
      },
      { status: alreadyRegistered ? 409 : 400 }
    );
  }

  return NextResponse.json({ ok: true });
}
