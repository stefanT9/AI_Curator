type FieldProps = {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  errors?: string[];
  /** Renders a textarea instead of an input, with the same label/error wiring. */
  multiline?: boolean;
  rows?: number;
  defaultValue?: string;
  /** For `type="file"` — e.g. "image/png,image/jpeg,image/webp". */
  accept?: string;
  /** Quiet guidance under the label, for anything the placeholder can't carry. */
  hint?: string;
  /** Input-only; the file field uses it to drive a local preview. */
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

export function Field({
  name,
  label,
  type = "text",
  autoComplete,
  placeholder,
  errors,
  multiline,
  rows = 4,
  defaultValue,
  accept,
  hint,
  onChange,
}: FieldProps) {
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;

  // A field can be described by its hint, its errors, or both.
  const describedBy =
    [hint ? hintId : null, errors ? errorId : null].filter(Boolean).join(" ") ||
    undefined;

  const shared = {
    id: name,
    name,
    placeholder,
    defaultValue,
    "aria-invalid": errors ? (true as const) : undefined,
    "aria-describedby": describedBy,
    className: fieldClass,
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-sm font-medium">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="text-xs opacity-60">
          {hint}
        </p>
      ) : null}
      {multiline ? (
        <textarea {...shared} rows={rows} />
      ) : (
        <input
          {...shared}
          type={type}
          autoComplete={autoComplete}
          accept={accept}
          onChange={onChange}
        />
      )}
      {errors?.map((error) => (
        <p
          key={error}
          id={errorId}
          className="text-xs text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      ))}
    </div>
  );
}

const fieldClass =
  "rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none placeholder:text-black/35 focus:border-black/40 aria-invalid:border-red-500 dark:border-white/20 dark:bg-white/5 dark:placeholder:text-white/30 dark:focus:border-white/50";

export const submitButtonClass =
  "mt-2 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
  "rounded-lg border border-black/15 px-3 py-2 text-sm font-medium transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10";
