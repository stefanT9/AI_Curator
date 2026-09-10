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
  /**
   * Renders the field controlled, so a parent can fill it programmatically.
   * When supplied, `defaultValue` is ignored and `onValueChange` is required to
   * keep the field editable. Omit both and the field behaves exactly as before.
   *
   * Decide once per call site and hold it: a `value` that starts `undefined`
   * and later becomes a string flips the field from uncontrolled to
   * controlled, which React warns about and which discards the value on the
   * switch. Seed the parent's state with `""` rather than `undefined`.
   */
  value?: string;
  onValueChange?: (value: string) => void;
  /** Rendered next to the label — progress or status for this field alone. */
  action?: React.ReactNode;
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
  value,
  onValueChange,
  action,
}: FieldProps) {
  const errorId = `${name}-error`;
  const hintId = `${name}-hint`;

  // A field can be described by its hint, its errors, or both. `errors?.length`
  // rather than `errors` — an empty array is truthy, which would point
  // aria-describedby at an element that never renders.
  const hasErrors = Boolean(errors?.length);

  const describedBy =
    [hint ? hintId : null, hasErrors ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;

  // Controlled and uncontrolled are mutually exclusive in React: passing both
  // `value` and `defaultValue` warns and the field stops accepting input.
  const controlled = value !== undefined;

  const shared = {
    id: name,
    name,
    placeholder,
    ...(controlled
      ? {
          value,
          onChange: (
            event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
          ) => onValueChange?.(event.target.value),
        }
      : { defaultValue }),
    "aria-invalid": hasErrors ? (true as const) : undefined,
    "aria-describedby": describedBy,
    className: fieldClass,
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={name} className="text-sm font-medium">
          {label}
        </label>
        {action}
      </div>
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
          // Spreading `onChange` here unconditionally would clobber the
          // controlled handler in `shared` and freeze the field.
          {...(controlled ? {} : { onChange })}
        />
      )}
      {/*
        One wrapper carries the id, not each message. Repeating the id per
        message produced duplicate DOM ids, and aria-describedby resolves to
        the first match only — so a second error was never announced.
      */}
      {hasErrors ? (
        <div id={errorId} className="flex flex-col gap-1.5">
          {errors?.map((error) => (
            <p key={error} className="text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const fieldClass =
  "rounded-lg border border-black/15 bg-white px-3 py-2 text-sm outline-none placeholder:text-black/35 focus:border-black/40 aria-invalid:border-red-500 dark:border-white/20 dark:bg-white/5 dark:placeholder:text-white/30 dark:focus:border-white/50";

export const submitButtonClass =
  "mt-2 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
  "rounded-lg border border-black/15 px-3 py-2 text-sm font-medium transition-colors hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/20 dark:hover:bg-white/10";
