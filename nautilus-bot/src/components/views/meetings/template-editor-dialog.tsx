import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_MEETING_TEMPLATE_NAME_LENGTH,
  MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS,
  MAX_MEETING_TEMPLATE_PROMPT_LENGTH,
} from "@/lib/meeting-templates";

export type MeetingTemplateDraft = {
  name: string;
  summaryPrompt: string;
  notesOutline: string[];
};

/** The notes outline is edited as one heading per line -- the same shape
 * `buildMeetingTemplateOutline` in meeting-templates.ts writes into a fresh
 * meeting's notes, so what the user types here is exactly what they will
 * later see as section headings. */
function outlineToLines(outline: string[]): string {
  return outline.join("\n");
}

function nonEmptyOutlineLines(lines: string): string[] {
  return lines
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Capped to the same ceiling Rust enforces on save
 * (`MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS` in settings.rs), so what this
 * dialog saves is never silently trimmed later -- the count warning below
 * this textarea tells the user why a line beyond the twelfth was dropped. */
function linesToOutline(lines: string): string[] {
  return nonEmptyOutlineLines(lines).slice(0, MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS);
}

interface MeetingTemplateEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Save as new template" vs "Save changes" -- the same fields, two intents. */
  mode: "create" | "edit";
  /** The prompts to pre-fill the form with: either the meeting's current
   * effective structure -- the note's own section headings when it has any,
   * the active playbook's outline otherwise -- when creating from "Save
   * current structure as a template", or the existing custom template's own
   * fields when editing. See `buildTemplateSaveSeed` in recordings-view.tsx. */
  seed: MeetingTemplateDraft;
  /** Names of every other saved template (excluding the one being edited,
   * if any), for the duplicate-name warning below. Two templates sharing a
   * name is not invalid -- ids, not names, are how a template resolves --
   * but it makes the picker confusing, so this is a soft warning only. */
  existingNames?: string[];
  onSave: (draft: MeetingTemplateDraft) => Promise<void> | void;
}

/**
 * Create or edit one user-saved meeting template. Mirrors the dictation
 * custom-mode editor's shape (name, prompt, a structural field) but as a
 * small dialog rather than an embedded form -- Meetings has no dedicated
 * settings tab of its own to host an inline editor in.
 */
export function MeetingTemplateEditorDialog({
  open,
  onOpenChange,
  mode,
  seed,
  existingNames = [],
  onSave,
}: MeetingTemplateEditorDialogProps) {
  const [name, setName] = useState(seed.name);
  const [summaryPrompt, setSummaryPrompt] = useState(seed.summaryPrompt);
  const [outlineText, setOutlineText] = useState(outlineToLines(seed.notesOutline));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const outlineLineCount = nonEmptyOutlineLines(outlineText).length;
  const outlineOverflow = outlineLineCount - MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS;
  const isDuplicateName =
    name.trim().length > 0 &&
    existingNames.some((existing) => existing.trim().toLowerCase() === name.trim().toLowerCase());

  // Re-seed only on the open transition -- editing a second template right
  // after the first must not carry its draft over, but typing in the form
  // must not get stomped by a re-render that leaves `open` unchanged.
  useEffect(() => {
    if (open) {
      setName(seed.name);
      setSummaryPrompt(seed.summaryPrompt);
      setOutlineText(outlineToLines(seed.notesOutline));
      setError(null);
    }
    // `seed` is intentionally excluded: it is a fresh object on every parent
    // render, and the effect only needs to run when `open` flips to true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Give the template a name.");
      return;
    }
    const outline = linesToOutline(outlineText);
    setIsSaving(true);
    setError(null);
    try {
      await onSave({
        name: trimmedName,
        summaryPrompt: summaryPrompt.trim(),
        // A template with no outline at all would seed nothing into a fresh
        // meeting's notes -- a single general heading is a safer default
        // than an empty outline the user probably did not intend.
        notesOutline: outline.length > 0 ? outline : ["Notes"],
      });
      onOpenChange(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Couldn't save the template.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !isSaving && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "Save as a template" : "Edit template"}
          </DialogTitle>
          <DialogDescription>
            A template is a summary prompt plus a notes outline -- reused the
            next time you pick it for a meeting.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="meeting-template-name">
              Name
            </label>
            <Input
              id="meeting-template-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Board Update"
              disabled={isSaving}
              maxLength={MAX_MEETING_TEMPLATE_NAME_LENGTH}
              autoFocus
            />
            {isDuplicateName ? (
              <p className="text-xs text-muted-foreground">
                You already have a template named &ldquo;{name.trim()}&rdquo;. Both
                will still work, but they&apos;ll look the same in the picker.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="meeting-template-summary-prompt">
              Summary prompt
            </label>
            <Textarea
              id="meeting-template-summary-prompt"
              value={summaryPrompt}
              onChange={(event) => setSummaryPrompt(event.target.value)}
              placeholder="Summarize this meeting with..."
              rows={4}
              disabled={isSaving}
              maxLength={MAX_MEETING_TEMPLATE_PROMPT_LENGTH}
              className="resize-y"
            />
            <p className="text-xs text-muted-foreground">
              What Plainsong reads when it writes the summary for a meeting
              using this template.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="meeting-template-outline">
              Notes outline
            </label>
            <Textarea
              id="meeting-template-outline"
              value={outlineText}
              onChange={(event) => setOutlineText(event.target.value)}
              placeholder={"Sentiment\nAsks\nFollow-ups"}
              rows={4}
              disabled={isSaving}
              className="resize-y"
            />
            <p className="text-xs text-muted-foreground">
              One section heading per line, seeded into a meeting&apos;s notes
              when this template is picked. Up to {MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS}{" "}
              sections.
            </p>
            {outlineOverflow > 0 ? (
              <p role="alert" className="text-xs text-destructive">
                {outlineOverflow} line{outlineOverflow === 1 ? "" : "s"} past the{" "}
                {MAX_MEETING_TEMPLATE_OUTLINE_SECTIONS}-section limit won&apos;t be saved.
              </p>
            ) : null}
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={isSaving}>
            {mode === "create" ? "Save template" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
