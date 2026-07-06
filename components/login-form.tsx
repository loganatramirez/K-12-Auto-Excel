"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { isValidEmail, normalizeEmail } from "@/lib/auth";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type AuthMode = "sign-in" | "sign-up";

export function LoginForm({
  initialError,
  nextPath
}: {
  initialError?: string;
  nextPath: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [message, setMessage] = useState(
    initialError === "auth" ? "Please sign in to access this workbook." : ""
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setIsSubmitting(true);

    const normalizedEmail = normalizeEmail(email);

    if (!isValidEmail(normalizedEmail)) {
      setMessage("Please enter a valid email address.");
      setIsSubmitting(false);
      return;
    }

    const supabase = createSupabaseBrowserClient();

    if (!supabase) {
      setMessage("Supabase is not configured yet.");
      setIsSubmitting(false);
      return;
    }

    if (mode === "sign-up") {
      const response = await fetch("/api/signup", {
        body: JSON.stringify({
          code: registrationCode,
          email: normalizedEmail,
          password
        }),
        headers: {
          "content-type": "application/json"
        },
        method: "POST"
      });

      const result = (await response.json()) as { error?: string };

      if (!response.ok) {
        setMessage(result.error ?? "Could not create account.");
        setIsSubmitting(false);
        return;
      }
    }

    const authResult = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password
    });

    if (authResult.error) {
      setMessage(authResult.error.message);
      setIsSubmitting(false);
      return;
    }

    router.push(nextPath || "/k12-targets");
    router.refresh();
  }

  return (
    <form className="login-card" onSubmit={handleSubmit}>
      <div className="login-mark">
        <LockKeyhole size={18} aria-hidden="true" />
      </div>
      <p className="eyebrow">Private workbook</p>
      <h1>{mode === "sign-in" ? "Sign in" : "Create account"}</h1>
      <div className="auth-mode" aria-label="Authentication mode">
        <button
          className={mode === "sign-in" ? "active" : ""}
          onClick={() => {
            setMode("sign-in");
            setMessage("");
          }}
          type="button"
        >
          Sign in
        </button>
        <button
          className={mode === "sign-up" ? "active" : ""}
          onClick={() => {
            setMode("sign-up");
            setMessage("");
          }}
          type="button"
        >
          Sign up
        </button>
      </div>
      <label className="login-field">
        <span>Email</span>
        <input
          type="email"
          autoComplete="email"
          placeholder="name@example.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>
      <label className="login-field">
        <span>Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>
      {mode === "sign-up" ? (
        <>
          <label className="login-field">
            <span>Registration code</span>
            <input
              autoComplete="off"
              value={registrationCode}
              onChange={(event) => setRegistrationCode(event.target.value)}
              required
            />
          </label>
          <p className="login-help">Any email can register with the registration code.</p>
        </>
      ) : null}
      {message ? <p className="login-message">{message}</p> : null}
      <button className="login-submit" type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Working..." : mode === "sign-in" ? "Sign in" : "Create account"}
      </button>
    </form>
  );
}
