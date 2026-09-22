"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestOtpCode, verifyOtpCode } from "@/lib/auth/actions";

const GENERIC_MESSAGE = "If that email is authorized, a sign-in code has been sent.";

export function LoginForm() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleRequestCode(e: FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      try {
        const result = await requestOtpCode(email);
        setMessage(result.message);
      } catch {
        setMessage(GENERIC_MESSAGE);
      }
      setStep("code");
    });
  }

  function handleVerifyCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await verifyOtpCode(email, code);
      if (result?.error) {
        setError(result.error);
      }
    });
  }

  if (step === "code") {
    return (
      <form onSubmit={handleVerifyCode} className="flex flex-col gap-4">
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="code">6-digit code</Label>
          <Input
            id="code"
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            required
            autoFocus
          />
        </div>
        <Button type="submit" disabled={isPending || code.length !== 6}>
          {isPending ? "Verifying…" : "Sign in"}
        </Button>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <button
          type="button"
          className="text-sm text-muted-foreground underline"
          onClick={() => {
            setStep("email");
            setCode("");
            setError(null);
            setMessage(null);
          }}
        >
          Use a different email
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={handleRequestCode} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <Button type="submit" disabled={isPending || !email}>
        {isPending ? "Sending…" : "Send sign-in code"}
      </Button>
    </form>
  );
}
