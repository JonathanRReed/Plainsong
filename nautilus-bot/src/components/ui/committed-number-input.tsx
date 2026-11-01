import { useEffect, useState, type InputHTMLAttributes } from "react";

type CommittedNumberInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type" | "min"
> & {
  value: number;
  min: number;
  /** Called once the reader leaves the field or presses Enter. */
  onCommit(value: number): void;
};

/**
 * A number field that saves when the reader is done typing, not per key.
 *
 * Saving every keystroke clamped an emptied field straight back to the
 * minimum ("1"), so clearing it to type "72" produced "172", and every
 * intermediate value was written to settings in between.
 */
export function CommittedNumberInput({
  value,
  min,
  onCommit,
  onBlur,
  onKeyDown,
  ...props
}: CommittedNumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Math.floor(Number(draft));
    const next = Number.isFinite(parsed) && draft.trim() !== "" ? Math.max(min, parsed) : value;
    setDraft(String(next));
    if (next !== value) {
      onCommit(next);
    }
  };

  return (
    <input
      {...props}
      type="number"
      min={min}
      inputMode="numeric"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        commit();
        onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          commit();
        }
        onKeyDown?.(event);
      }}
    />
  );
}
