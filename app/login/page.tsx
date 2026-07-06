import { LoginForm } from "@/components/login-form";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const nextPath = params.next || "/k12-targets";

  return (
    <main className="login-page">
      {isSupabaseConfigured() ? (
        <LoginForm initialError={params.error} nextPath={nextPath} />
      ) : (
        <section className="login-card setup-card">
          <p className="eyebrow">Setup required</p>
          <h1>Connect Supabase</h1>
          <p>
            Add <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in Vercel, then redeploy this project.
          </p>
          <p>
            To enable signup, also add <code>SUPABASE_SERVICE_ROLE_KEY</code> and{" "}
            <code>SIGNUP_ACCESS_CODE</code>, then run the SQL in <code>lib/schema.sql</code>.
          </p>
        </section>
      )}
    </main>
  );
}
