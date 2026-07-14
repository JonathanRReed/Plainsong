import { useEffect, useMemo, useState } from "react";
import {
  AudioWaveform,
  FileOutput,
  FileText,
  Folder,
  Mic,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/components/toast";
import { requestMainView, type MainViewId } from "@/lib/navigation";
import { formatNavShortcut } from "@/lib/nav-shortcuts";
import { transformSelectedText } from "@/lib/backend";
import {
  formatSelectedTextActionStatusMessage,
  selectedTextActionSearchAliases,
  selectedTextActionTransformCommand,
  SELECTED_TEXT_ACTIONS,
  type SelectedTextQuickActionKey,
} from "@/lib/selected-text-actions";
import { SELECTED_TEXT_ACTION_ICONS } from "@/lib/selected-text-action-icons";

interface NavigationPaletteEntry {
  view: MainViewId;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
}

// Mirrors the nav items/labels/icons in src/components/sidebar.tsx so the
// palette stays a thin trigger over the same navigation surface rather than
// a parallel source of truth. Shortcut labels come from the shared
// nav-shortcuts module so all surfaces advertise the same keys.
const NAVIGATION_BASE: Omit<NavigationPaletteEntry, "shortcut">[] = [
  { view: "dashboard", label: "Home", icon: FileText },
  { view: "dictation", label: "Dictation", icon: Mic },
  { view: "recordings", label: "Meetings", icon: AudioWaveform },
  { view: "projects", label: "Projects", icon: Folder },
  { view: "settings", label: "Settings", icon: Settings },
  { view: "setup", label: "Setup", icon: Sparkles },
  { view: "exports", label: "Exports", icon: FileOutput },
];

const NAVIGATION_ENTRIES: NavigationPaletteEntry[] = NAVIGATION_BASE.map((entry) => ({
  ...entry,
  shortcut: formatNavShortcut(entry.view) ?? undefined,
}));

interface AppCommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AppCommandPalette({ open, onOpenChange }: AppCommandPaletteProps) {
  const { toast } = useToast();
  const [pendingAction, setPendingAction] = useState<SelectedTextQuickActionKey | null>(
    null,
  );

  useEffect(() => {
    if (!open) {
      setPendingAction(null);
    }
  }, [open]);

  const close = () => onOpenChange(false);

  const handleNavigate = (view: MainViewId) => {
    requestMainView(view);
    close();
  };

  const handleSelectedTextAction = async (action: SelectedTextQuickActionKey) => {
    if (pendingAction) {
      return;
    }
    setPendingAction(action);
    close();
    try {
      const command = selectedTextActionTransformCommand(action);
      const result = await transformSelectedText(command);
      toast(
        formatSelectedTextActionStatusMessage(action, result),
        result.error && !result.pasted && !result.copied ? "error" : "success",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(`Could not run action: ${message}`, "error");
    } finally {
      setPendingAction(null);
    }
  };

  const selectedTextEntries = useMemo(
    () =>
      SELECTED_TEXT_ACTIONS.map((metadata) => ({
        metadata,
        keywords: selectedTextActionSearchAliases(metadata),
        Icon: SELECTED_TEXT_ACTION_ICONS[metadata.iconKey],
      })),
    [],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <Command shouldFilter loop className="[&_[cmdk-group-heading]]:px-2">
          <CommandInput placeholder="Jump to a view or run a text action..." />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup heading="Go to">
              {NAVIGATION_ENTRIES.map(({ view, label, icon: Icon, shortcut }) => (
                <CommandItem
                  key={view}
                  value={`nav-${view}`}
                  keywords={[label]}
                  onSelect={() => handleNavigate(view)}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  <span>{label}</span>
                  {shortcut ? (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {shortcut}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="Text actions">
              {selectedTextEntries.map(({ metadata, keywords, Icon }) => (
                <CommandItem
                  key={metadata.action}
                  value={`action-${metadata.action}`}
                  keywords={keywords}
                  disabled={pendingAction !== null}
                  onSelect={() => {
                    void handleSelectedTextAction(metadata.action);
                  }}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  <span>{metadata.paletteLabel}</span>
                  {metadata.shortcut ? (
                    <span className="ml-auto text-xs text-muted-foreground">
                      {metadata.shortcut}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
