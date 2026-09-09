"use client";

import { useActionState } from "react";
import { updateDisplayName } from "@/app/actions/profile";
import { Field, submitButtonClass } from "@/components/ui/Field";

export function DisplayNameForm({
  displayName,
}: {
  displayName: string | null;
}) {
  const [state, action, pending] = useActionState(updateDisplayName, undefined);

  return (
    <form action={action} className="flex flex-col gap-4">
      <Field
        name="displayName"
        label="Artist name"
        defaultValue={displayName ?? undefined}
        hint="Shown publicly on every piece you upload."
        errors={state?.errors?.displayName}
      />

      {state?.message ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.message}
        </p>
      ) : null}

      {state?.success ? (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          Saved.
        </p>
      ) : null}

      <button type="submit" disabled={pending} className={submitButtonClass}>
        {pending ? "Saving…" : "Save name"}
      </button>
    </form>
  );
}
