import { Check, Moon, Sun, Monitor } from "lucide-react";
import * as React from "react";
import { useTheme } from "@/components/theme-provider";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Theme = "light" | "dark" | "system";

const THEME_OPTIONS: Array<{
  value: Theme;
  label: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function ThemeToggleComponent() {
  const { theme, setTheme, isDark } = useTheme();

  const getIcon = () => {
    if (theme === "system") {
      return <Monitor className="h-[1.2rem] w-[1.2rem]" />;
    }
    return isDark ? (
      <Moon className="h-[1.2rem] w-[1.2rem]" />
    ) : (
      <Sun className="h-[1.2rem] w-[1.2rem]" />
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          {getIcon()}
          <span className="sr-only">Toggle theme</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_OPTIONS.map((option) => {
          const Icon = option.icon;
          const selected = theme === option.value;
          return (
            <DropdownMenuItem
              key={option.value}
              role="menuitemradio"
              aria-checked={selected}
              className="gap-2"
              onClick={() => setTheme(option.value)}
            >
              <Icon className="h-4 w-4" />
              <span className="min-w-0 flex-1">{option.label}</span>
              <Check
                className={selected ? "h-4 w-4 text-gold-text opacity-100" : "h-4 w-4 opacity-0"}
                aria-hidden="true"
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const ThemeToggle = React.memo(ThemeToggleComponent);
