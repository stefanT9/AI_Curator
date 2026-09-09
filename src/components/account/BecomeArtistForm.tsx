"use client";

import { useActionState } from "react";
import { becomeArtist } from "@/app/actions/profile";
import { Field, submitButtonClass } from "@/components/ui/Field";

export function BecomeArtistForm() {
  const [state, action, pending] = useActionState(becomeArtist, undefined);

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        name="displayName"
        label="Artist name"
        placeholder="How you want to be credited"
        hint="Shown publicly on every piece you upload."
        errors={state?.errors?.displayName}
      />

      {state?.message ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={submitButtonClass}>
        {pending ? "Setting up…" : "Become an artist"}
      </button>
    </form>
  );
}
