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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Trash2 } from "lucide-react";
import {
  MAX_SAVED_PROMPTS,
  MAX_SAVED_PROMPT_NAME_LENGTH,
  MAX_SAVED_PROMPT_TEXT_LENGTH,
  moveSavedPrompt,
  newSavedPromptId,
  removeOrHideSavedPrompt,
  setSavedPromptHidden,
  upsertSavedPrompt,
  type SavedPrompt,
  type SavedPromptScope,
} from "@/lib/saved-prompts";

interface SavedPromptManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The resolved library: stored prompts first, untouched starters after. */
  prompts: readonly SavedPrompt[];
  /** Persists a whole library. Returns false when the save failed. */
  onPersist: (next: readonly SavedPrompt[]) => Promise<boolean> | boolean;
  /** A prompt to open the editor on immediately (from "Save as prompt"). */
  seedPrompt?: SavedPrompt | null;
  onSeedConsumed?: () => void;
  saveError?: string | null;
}

const SCOPE_LABELS: Record<SavedPromptScope, string> = {
  meeting: "This meeting's chat",
  memory: "Ask your meetings",
  both: "Both",
};

/**
 * List, edit, add, hide and reorder saved prompts.
 *
 * The six starters are listed alongside the reader's own. They can be edited
 * and hidden but not deleted, because deleting one would only mean it came
 * back on the next launch -- this dialog says so on the row rather than
 * offering a button that lies.
 *
 * Reordering writes the whole list back, starters included. Once order is a
 * decision the reader made, it has to be stored rather than re-derived.
 */
export function SavedPromptManagerDialog({
  open,
  onOpenChange,
  prompts,
  onPersist,
  seedPrompt = null,
  onSeedConsumed,
  saveError = null,
}: SavedPromptManagerDialogProps) {
  const [editing, setEditing] = useState<SavedPrompt | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SavedPrompt | null>(null);

  useEffect(() => {
    if (open && seedPrompt) {
      setEditing(seedPrompt);
      onSeedConsumed?.();
    }
  }, [open, seedPrompt, onSeedConsumed]);

  const atCapacity = prompts.length >= MAX_SAVED_PROMPTS;

  const commit = async (next: readonly SavedPrompt[]) => {
    await onPersist(next);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Saved prompts</DialogTitle>
            <DialogDescription>
              Questions you reuse. Type &ldquo;/&rdquo; in a meeting&apos;s chat
              or in &ldquo;Ask your meetings&rdquo; to pick one. They are stored
              in your settings file on this Mac.
            </DialogDescription>
          </DialogHeader>

          {saveError ? (
            <p className="rounded-md border border-rust/30 bg-rust/10 p-3 text-sm text-rust">
              {saveError}
            </p>
          ) : null}

          <ul className="max-h-96 space-y-2 overflow-y-auto py-1">
            {prompts.map((prompt, index) => (
              <li
                key={prompt.id}
                className="flex items-start justify-between gap-3 rounded-md border bg-muted/20 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {prompt.name}
                    {prompt.hidden ? (
                      <span className="ml-2 font-normal text-muted-foreground">
                        hidden
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                    {prompt.prompt}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {SCOPE_LABELS[prompt.scope]}
                    {prompt.builtIn ? " · built in" : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Move ${prompt.name} up`}
                    disabled={index === 0}
                    onClick={() => void commit(moveSavedPrompt(prompts, prompt.id, -1))}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Move ${prompt.name} down`}
                    disabled={index === prompts.length - 1}
                    onClick={() => void commit(moveSavedPrompt(prompts, prompt.id, 1))}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={
                      prompt.hidden ? `Show ${prompt.name}` : `Hide ${prompt.name}`
                    }
                    onClick={() =>
                      void commit(
                        setSavedPromptHidden(prompts, prompt.id, !prompt.hidden),
                      )
                    }
                  >
                    {prompt.hidden ? (
                      <Eye className="h-4 w-4" />
                    ) : (
                      <EyeOff className="h-4 w-4" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={`Edit ${prompt.name}`}
                    onClick={() => setEditing({ ...prompt })}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {prompt.builtIn ? null : (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Delete ${prompt.name}`}
                      onClick={() => setPendingDelete(prompt)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>

          <DialogFooter className="sm:justify-start">
            <Button
              type="button"
              variant="outline"
              disabled={atCapacity}
              onClick={() =>
                setEditing({
                  id: newSavedPromptId(),
                  name: "",
                  prompt: "",
                  scope: "both",
                  builtIn: false,
                  hidden: false,
                })
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              New prompt
            </Button>
            {atCapacity ? (
              <p className="self-center text-sm text-muted-foreground">
                {MAX_SAVED_PROMPTS} saved prompts is the limit. Delete one to add
                another.
              </p>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SavedPromptEditorDialog
        prompt={editing}
        onCancel={() => setEditing(null)}
        onSave={async (next) => {
          setEditing(null);
          await commit(upsertSavedPrompt(prompts, next));
        }}
      />

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this prompt?</DialogTitle>
            <DialogDescription>
              &ldquo;{pendingDelete?.name}&rdquo; will be removed from your
              settings. Answers you already got from it are untouched.
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
                  void commit(removeOrHideSavedPrompt(prompts, pendingDelete.id));
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

interface SavedPromptEditorDialogProps {
  prompt: SavedPrompt | null;
  onCancel: () => void;
  onSave: (prompt: SavedPrompt) => void;
}

/**
 * The add/edit form. Length ceilings match the sidecar's, enforced here with
 * `maxLength` so the reader is stopped at the limit rather than having text
 * silently truncated on save.
 */
function SavedPromptEditorDialog({
  prompt,
  onCancel,
  onSave,
}: SavedPromptEditorDialogProps) {
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<SavedPromptScope>("both");

  useEffect(() => {
    if (prompt) {
      setName(prompt.name);
      setBody(prompt.prompt);
      setScope(prompt.scope);
    }
  }, [prompt]);

  const canSave = name.trim().length > 0 && body.trim().length > 0;

  return (
    <Dialog
      open={prompt !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {prompt?.builtIn ? "Edit a built-in prompt" : "Saved prompt"}
          </DialogTitle>
          <DialogDescription>
            {prompt?.builtIn
              ? "Your wording replaces the one Plainsong ships. Built-in prompts can be hidden but not deleted."
              : "A question you want to ask again, in your own words."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="saved-prompt-name">Name</Label>
            <Input
              id="saved-prompt-name"
              value={name}
              maxLength={MAX_SAVED_PROMPT_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)}
              placeholder="Decisions made"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="saved-prompt-body">Prompt</Label>
            <Textarea
              id="saved-prompt-body"
              value={body}
              rows={5}
              maxLength={MAX_SAVED_PROMPT_TEXT_LENGTH}
              onChange={(event) => setBody(event.target.value)}
              placeholder="List the decisions that were actually made…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="saved-prompt-scope">Offered in</Label>
            <Select
              value={scope}
              onValueChange={(next) => setScope(next as SavedPromptScope)}
            >
              <SelectTrigger id="saved-prompt-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="both">{SCOPE_LABELS.both}</SelectItem>
                <SelectItem value="meeting">{SCOPE_LABELS.meeting}</SelectItem>
                <SelectItem value="memory">{SCOPE_LABELS.memory}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              if (!prompt || !canSave) return;
              onSave({ ...prompt, name, prompt: body, scope });
            }}
          >
            Save prompt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
