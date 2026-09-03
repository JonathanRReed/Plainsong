import {
  useId,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The settings row primitives, and the one rule they enforce in the type
 * system: **`description` is required.**
 *
 * It used to be optional, with a doc comment saying to omit it when it "only
 * restates the label". In practice that licensed a label with nothing under it
 * — "While dictating", "Mode", "Method" — which is exactly the thing a first
 * run gets stuck on. A label names the control; the description says what
 * happens to the reader if they change it. If a description can only restate
 * the label, the label is the thing that needs rewriting.
 */

interface SettingsSwitchProps {
  label: string;
  /** What happens when the toggle is flipped. Required: see the note above. */
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * A flat settings row. It deliberately carries no border or fill of its own:
 * settings pages group rows with whitespace and a hairline, not a box per row.
 */
export function SettingsSwitch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  className,
}: SettingsSwitchProps) {
  const labelId = useId();
  const descriptionId = `${labelId}-description`;

  return (
    <div className={cn("flex items-center justify-between gap-4 py-3", className)}>
      <div className="space-y-1">
        <Label id={labelId}>{label}</Label>
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
      />
    </div>
  );
}

interface SettingsInputProps {
  label: string;
  /** What the value affects. Required: see the note above. */
  description: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  min?: number;
  disabled?: boolean;
  className?: string;
  onBlur?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}

export function SettingsInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = "text",
  min,
  disabled = false,
  className,
  onBlur,
  onKeyDown,
}: SettingsInputProps) {
  const inputId = useId();
  const descriptionId = `${inputId}-description`;

  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={inputId}>{label}</Label>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {description}
      </p>
      <Input
        id={inputId}
        aria-describedby={descriptionId}
        type={type}
        min={min}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />
    </div>
  );
}

interface SettingsSelectProps {
  label: string;
  /** What choosing differently changes. Required: see the note above. */
  description: string;
  value: string;
  onChange: (value: string) => void;
  /** The `<option>` elements. */
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  /** Rendered under the select — a consequence that depends on the value. */
  footnote?: ReactNode;
}

/**
 * A labelled `<select>` whose helper sentence is wired to it with
 * `aria-describedby`, so a screen reader hears the consequence and
 * `settings-copy-clarity.test.tsx` can prove the sentence exists.
 */
export function SettingsSelect({
  label,
  description,
  value,
  onChange,
  children,
  disabled = false,
  className,
  footnote,
}: SettingsSelectProps) {
  const selectId = useId();
  const descriptionId = `${selectId}-description`;

  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={selectId}>{label}</Label>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        {description}
      </p>
      <select
        id={selectId}
        aria-describedby={descriptionId}
        className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLSelectElement>) =>
          onChange(event.target.value)
        }
      >
        {children}
      </select>
      {footnote}
    </div>
  );
}
