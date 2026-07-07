import {
  Brain,
  Bug,
  CheckCircle2,
  FileText,
  Languages,
  ListChecks,
  Search,
  Sparkles,
  Terminal,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { SelectedTextActionIconKey } from "@/lib/selected-text-actions";

export const SELECTED_TEXT_ACTION_ICONS: Record<
  SelectedTextActionIconKey,
  LucideIcon
> = {
  brain: Brain,
  bug: Bug,
  check: CheckCircle2,
  file_text: FileText,
  list: ListChecks,
  languages: Languages,
  search: Search,
  sparkles: Sparkles,
  terminal: Terminal,
  zap: Zap,
};
