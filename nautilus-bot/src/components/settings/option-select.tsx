import {
  Children,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * The app's custom Select, written the way a native `<select>` is: the
 * options are `<option>` children. Settings grew up on native selects, and
 * keeping the option markup means each call site swaps one element for
 * another instead of being rewritten, while the reader gets the same menu
 * everywhere instead of a system popup next to a styled one.
 *
 * Radix reserves the empty string for "no selection", so an `<option
 * value="">` (e.g. "System default microphone") is carried under a sentinel
 * and handed back to `onValueChange` as `""`.
 */

const EMPTY_VALUE = "__plainsong-empty__";

type OptionElement = ReactElement<{
  value?: string | number;
  disabled?: boolean;
  children?: ReactNode;
}>;

function toItemValue(value: string): string {
  return value === "" ? EMPTY_VALUE : value;
}

function fromItemValue(value: string): string {
  return value === EMPTY_VALUE ? "" : value;
}

interface OptionSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  /** `<option>` elements; `false`/`null` entries from conditionals are skipped. */
  children: ReactNode;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

export function OptionSelect({
  value,
  onValueChange,
  children,
  id,
  disabled = false,
  className,
  ...aria
}: OptionSelectProps) {
  const options = Children.toArray(children).filter(
    (child): child is OptionElement =>
      isValidElement(child) && child.type === "option",
  );

  return (
    <Select
      value={toItemValue(value)}
      onValueChange={(next) => onValueChange(fromItemValue(next))}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        className={cn("bg-background text-left", className)}
        {...aria}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => {
          const optionValue = String(option.props.value ?? "");
          return (
            <SelectItem
              key={optionValue}
              value={toItemValue(optionValue)}
              disabled={option.props.disabled}
            >
              {option.props.children}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

interface SettingsOptionSelectProps {
  label: string;
  /** What choosing differently changes. Required, as on `SettingsSelect`. */
  description: string;
  value: string;
  onChange: (value: string) => void;
  /** The `<option>` elements. */
  children: ReactNode;
  disabled?: boolean;
  className?: string;
  /** Width of the menu on the right; long option names can ask for more. */
  selectClassName?: string;
  /** Rendered under the row: a consequence that depends on the value. */
  footnote?: ReactNode;
  /** Anchor for settings search and deep links (`setting-<id>`). */
  settingId?: string;
}

/**
 * `SettingsSelect`'s labelled row with the custom menu in place of the native
 * `<select>`: label and sentence on the left, the menu on the right. The
 * label and helper sentence stay wired to the trigger, so a screen reader
 * still hears the consequence of a change.
 */
export function SettingsOptionSelect({
  label,
  description,
  value,
  onChange,
  children,
  disabled = false,
  className,
  selectClassName,
  footnote,
  settingId,
}: SettingsOptionSelectProps) {
  const selectId = useId();
  const descriptionId = `${selectId}-description`;

  return (
    <div
      id={settingId ? `setting-${settingId}` : undefined}
      className={cn("py-3.5", className)}
    >
      <div className="flex flex-col gap-2 @md:flex-row @md:items-start @md:justify-between @md:gap-6">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={selectId} className="text-sm font-medium leading-5">
            {label}
          </Label>
          <p id={descriptionId} className="text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        </div>
        <OptionSelect
          id={selectId}
          aria-describedby={descriptionId}
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          className={cn("h-9 w-full shrink-0 @md:w-56", selectClassName)}
        >
          {children}
        </OptionSelect>
      </div>
      {footnote ? <div className="mt-2">{footnote}</div> : null}
    </div>
  );
}
