type FieldProps = {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  errors?: string[];
};

export function Field({
  name,
  label,
  type = "text",
  autoComplete,
  placeholder,
  errors,
}: FieldProps) {
  const errorId = `${name}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={errors ? true : undefined}
        aria-describedby={errors ? errorId : undefined}
        className="rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none placeholder:text-black/35 focus:border-black/40 aria-invalid:border-red-500 dark:border-white/20 dark:bg-white/5 dark:placeholder:text-white/30 dark:focus:border-white/50"
      />
      {errors?.map((error) => (
        <p key={error} id={errorId} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ))}
    </div>
  );
}

export const submitButtonClass =
  "mt-2 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";
