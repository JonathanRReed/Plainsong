import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Pencil, Trash2 } from "lucide-react";
import type { CustomMeetingTemplate } from "@/lib/meeting-templates";

interface MeetingTemplateManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: CustomMeetingTemplate[];
  onEdit: (template: CustomMeetingTemplate) => void;
  onDelete: (template: CustomMeetingTemplate) => void;
}

/**
 * List, edit, and delete the user's saved meeting templates. The built-in 11
 * are not listed here -- they are fixed in meeting-templates.ts and have
 * nothing to manage. Deleting does not touch any past meeting: a meeting
 * keeps its stored template id regardless, and the picker/analysis fall back
 * to the default template for an id that no longer resolves (see
 * `getMeetingTemplateOption` and `resolve_meeting_template_summary_instruction`).
 */
export function MeetingTemplateManagerDialog({
  open,
  onOpenChange,
  templates,
  onEdit,
  onDelete,
}: MeetingTemplateManagerDialogProps) {
  // Delete is irreversible (there is no undo surface for a settings write),
  // so it is gated behind a confirmation step naming the template rather
  // than firing on the first click.
  const [pendingDelete, setPendingDelete] = useState<CustomMeetingTemplate | null>(null);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Your meeting templates</DialogTitle>
            <DialogDescription>
              Rename, edit, or remove a template you saved. Built-in playbooks
              aren&apos;t listed here.
            </DialogDescription>
          </DialogHeader>

          {templates.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No saved templates yet. From a meeting, use &quot;Save as a
              template&quot; to create one.
            </p>
          ) : (
            <ul className="max-h-80 space-y-2 overflow-y-auto py-2">
              {templates.map((template) => (
                <li
                  key={template.id}
                  className="flex items-start justify-between gap-3 rounded-lg border bg-muted/20 p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{template.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {template.notesOutline.join(" · ") || "No outline sections"}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Edit ${template.name}`}
                      onClick={() => onEdit(template)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${template.name}`}
                      onClick={() => setPendingDelete(template)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) {
            setPendingDelete(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this template?</DialogTitle>
            <DialogDescription>
              &ldquo;{pendingDelete?.name}&rdquo; will be removed. Meetings that
              already used it keep displaying -- they fall back to the default
              playbook.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDelete) {
                  onDelete(pendingDelete);
                }
                setPendingDelete(null);
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
