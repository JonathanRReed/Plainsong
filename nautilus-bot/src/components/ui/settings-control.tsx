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
import { ChevronRight } from "lucide-react";

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

/** The DOM id a settings row is reachable by, for search and deep links. */
export function settingAnchorId(settingId: string): string {
  return `setting-${settingId}`;
}

const ROW_CLASS = "py-3.5";
const LABEL_CLASS = "text-sm font-medium leading-5";
const DESCRIPTION_CLASS = "text-sm leading-5 text-muted-foreground";

interface SettingsSwitchProps {
  label: string;
  /** What happens when the toggle is flipped. Required: see the note above. */
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  /** Anchor for settings search and deep links (`setting-<id>`). */
  settingId?: string;
}

/**
 * A flat settings row: label and one plain sentence on the left, the switch
 * on the right. It carries no border or fill of its own; a group separates
 * its rows with a hairline.
 */
export function SettingsSwitch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  className,
  settingId,
}: SettingsSwitchProps) {
  const labelId = useId();
  const descriptionId = `${labelId}-description`;

  return (
    <div
      id={settingId ? settingAnchorId(settingId) : undefined}
      className={cn("flex items-start justify-between gap-6", ROW_CLASS, className)}
    >
      <div className="min-w-0 space-y-1">
        <Label id={labelId} className={LABEL_CLASS}>
          {label}
        </Label>
        <p id={descriptionId} className={DESCRIPTION_CLASS}>
          {description}
        </p>
      </div>
      <Switch
        className="mt-0.5"
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
  max?: number;
  disabled?: boolean;
  className?: string;
  /** Width of the field on the right; a wide value can ask for more. */
  inputClassName?: string;
  onBlur?: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  settingId?: string;
}

export function SettingsInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = "text",
  min,
  max,
  disabled = false,
  className,
  inputClassName,
  onBlur,
  onKeyDown,
  settingId,
}: SettingsInputProps) {
  const inputId = useId();
  const descriptionId = `${inputId}-description`;

  return (
    <div
      id={settingId ? settingAnchorId(settingId) : undefined}
      className={cn(
        "flex flex-col gap-2 @md:flex-row @md:items-start @md:justify-between @md:gap-6",
        ROW_CLASS,
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <Label htmlFor={inputId} className={LABEL_CLASS}>
          {label}
        </Label>
        <p id={descriptionId} className={DESCRIPTION_CLASS}>
          {description}
        </p>
      </div>
      <Input
        id={inputId}
        aria-describedby={descriptionId}
        className={cn("h-9 shrink-0 @md:w-56", inputClassName)}
        type={type}
        min={min}
        max={max}
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

interface SettingsRowProps {
  label: ReactNode;
  /** One plain sentence: what this row does for you. */
  description?: ReactNode;
  /** The control, on the right. */
  control?: ReactNode;
  /** Anything that belongs under the row (a status, a note, a list). */
  children?: ReactNode;
  settingId?: string;
  /** Ids the label and description get, for a control rendered elsewhere. */
  labelId?: string;
  descriptionId?: string;
  className?: string;
}

/** The generic row for controls that are not a single switch or field. */
export function SettingsRow({
  label,
  description,
  control,
  children,
  settingId,
  labelId,
  descriptionId,
  className,
}: SettingsRowProps) {
  return (
    <div
      id={settingId ? settingAnchorId(settingId) : undefined}
      className={cn(ROW_CLASS, className)}
    >
      <div className="flex flex-col gap-3 @md:flex-row @md:items-start @md:justify-between @md:gap-6">
        <div className="min-w-0 space-y-1">
          <p id={labelId} className={LABEL_CLASS}>
            {label}
          </p>
          {description ? (
            <div id={descriptionId} className={DESCRIPTION_CLASS}>
              {description}
            </div>
          ) : null}
        </div>
        {control ? (
          <div className="flex shrink-0 items-center gap-2">{control}</div>
        ) : null}
      </div>
      {children ? <div className="mt-3 space-y-3">{children}</div> : null}
    </div>
  );
}

interface SettingsGroupProps {
  title: string;
  description?: ReactNode;
  /** Id for the description, when controls inside point at it. */
  descriptionId?: string;
  children: ReactNode;
  settingId?: string;
  className?: string;
}

/**
 * A titled run of rows. Groups sit flat on the page, one hairline apart; the
 * rows inside are separated by a fainter one.
 */
export function SettingsGroup({
  title,
  description,
  descriptionId,
  children,
  settingId,
  className,
}: SettingsGroupProps) {
  const headingId = useId();
  return (
    <section
      id={settingId ? settingAnchorId(settingId) : undefined}
      aria-labelledby={headingId}
      className={cn("settings-group", className)}
    >
      <h3 id={headingId} className="section-heading">
        {title}
      </h3>
      {description ? (
        <p id={descriptionId} className="mt-1 text-sm leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
      <div className="settings-rows mt-2">{children}</div>
    </section>
  );
}

interface SettingsMoreProps {
  /** What is behind it, e.g. "More dictation options". */
  label: string;
  /** A few words naming what is inside, so nobody has to open it to find out. */
  hint?: string;
  children: ReactNode;
  settingId?: string;
  defaultOpen?: boolean;
  /** Told each time the reader opens or closes it, e.g. to load on first open. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Progressive disclosure for the rows most people never change. A native
 * `<details>`, so it is keyboard-operable and announced as expandable with
 * no extra wiring, and settings search can open it to reveal a match.
 */
export function SettingsMore({
  label,
  hint,
  children,
  settingId,
  defaultOpen = false,
  onOpenChange,
}: SettingsMoreProps) {
  return (
    <details
      id={settingId ? settingAnchorId(settingId) : undefined}
      className="settings-more group/more"
      open={defaultOpen || undefined}
      onToggle={
        onOpenChange
          ? (event) => onOpenChange((event.currentTarget as HTMLDetailsElement).open)
          : undefined
      }
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md py-3 text-sm font-medium text-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open/more:rotate-90 motion-reduce:transition-none"
        />
        <span>{label}</span>
        {hint ? (
          <span className="min-w-0 truncate font-normal text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </summary>
      <div className="settings-rows pb-2 pl-6">{children}</div>
    </details>
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
