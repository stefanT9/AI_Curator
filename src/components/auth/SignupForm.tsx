"use client";

import { useActionState } from "react";
import { signup } from "@/app/actions/auth";
import { Field, submitButtonClass } from "./Field";

export function SignupForm() {
  const [state, action, pending] = useActionState(signup, undefined);

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="email"
        placeholder="you@example.com"
        errors={state?.errors?.email}
      />
      <Field
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        placeholder="At least 8 characters"
        errors={state?.errors?.password}
      />

      {state?.message ? (
        <p className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={submitButtonClass}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
