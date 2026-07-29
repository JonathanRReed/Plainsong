import { useId } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SettingsSwitchProps {
  label: string;
  /** What changes when the toggle is flipped — omit it if it only restates the label. */
  description?: string;
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
        {description && (
          <p id={descriptionId} className="text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
      />
    </div>
  );
}

interface SettingsInputProps {
  label: string;
  /** What the value affects — omit it if it only restates the label. */
  description?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
  className?: string;
}

export function SettingsInput({
  label,
  description,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled = false,
  className,
}: SettingsInputProps) {
  const inputId = useId();
  const descriptionId = `${inputId}-description`;

  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={inputId}>{label}</Label>
      {description && (
        <p id={descriptionId} className="text-sm text-muted-foreground">
          {description}
        </p>
      )}
      <Input
        id={inputId}
        aria-describedby={description ? descriptionId : undefined}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  );
}
