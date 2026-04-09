import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SettingsSwitchProps {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}

export function SettingsSwitch({
  label,
  description,
  checked,
  onCheckedChange,
  disabled = false,
  className,
}: SettingsSwitchProps) {
  return (
    <div className={cn("flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-background/75 p-4", className)}>
      <div className="space-y-0.5">
        <Label>{label}</Label>
        {description && (
          <p className="text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </div>
  );
}

interface SettingsInputProps {
  label: string;
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
  return (
    <div className={cn("space-y-2", className)}>
      <Label>{label}</Label>
      {description && (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
      <Input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  );
}
