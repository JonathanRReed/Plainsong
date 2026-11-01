import { Button } from "@/components/ui/button";
import type { DictationCommandPreset } from "@/lib/backend/dictation";
import {
  DICTATION_TEXT_ACTIONS,
  SELECTED_TEXT_COMMAND_PRESET_ACTIONS,
  SELECTED_TEXT_TARGET_POLICY_DETAILS,
  type SelectedTextActionCommandPresetKey,
} from "@/lib/selected-text-actions";

interface DictationTextActionsEditorProps {
  presets: DictationCommandPreset[];
  commandPrefix: string;
  saveStates?: Record<string, { pending?: boolean; failure?: "save" | "reset"; unsaved?: boolean }>;
  onDraftChange: (
    commandKey: SelectedTextActionCommandPresetKey,
    updates: Partial<Pick<DictationCommandPreset, "systemPrompt" | "enabled">>,
  ) => void;
  onCommit: (
    commandKey: SelectedTextActionCommandPresetKey,
    systemPrompt: string,
    enabled: boolean,
  ) => void;
  onReset: (commandKey: SelectedTextActionCommandPresetKey) => void;
}

/**
 * The prompt editor for every spoken command action.
 *
 * Driven straight off `SELECTED_TEXT_COMMAND_PRESET_ACTIONS` so the editor, the
 * command palette, and the spoken-command parser all read the same catalog.
 * This page used to hard-code three of them, which quietly hid the rest.
 */
export function DictationTextActionsEditor({
  presets,
  commandPrefix,
  saveStates = {},
  onDraftChange,
  onCommit,
  onReset,
}: DictationTextActionsEditorProps) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="section-heading">{DICTATION_TEXT_ACTIONS.familyLabel}</h3>
        <p className="text-sm text-muted-foreground">
          {DICTATION_TEXT_ACTIONS.presetEditorDescription}
        </p>
      </div>
      <div className="space-y-3">
        {SELECTED_TEXT_COMMAND_PRESET_ACTIONS.map((action) => {
          const preset = presets.find(
            (candidate) => candidate.commandKey === action.commandPresetKey,
          );
          const promptValue =
            preset?.systemPrompt ?? action.commandDefaultPrompt;
          const enabledValue = preset?.enabled ?? true;
          const saveState = saveStates[action.commandPresetKey];
          const spokenExample = action.spokenCommandExamples?.[0];
          return (
            <div
              key={action.commandPresetKey}
              className="rounded-md border p-3 space-y-2"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <label
                    className="text-sm font-medium"
                    htmlFor={`text-action-${action.commandPresetKey}`}
                  >
                    {action.commandPresetLabel}
                  </label>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {action.detail}.{" "}
                    {SELECTED_TEXT_TARGET_POLICY_DETAILS[action.targetPolicy]}
                  </p>
                  {spokenExample ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      Say{" "}
                      <span className="font-mono">
                        &quot;{commandPrefix} {spokenExample}&quot;
                      </span>
                      .
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={enabledValue}
                      onChange={(event) => {
                        const next = event.target.checked;
                        onDraftChange(action.commandPresetKey, {
                          enabled: next,
                        });
                        onCommit(action.commandPresetKey, promptValue, next);
                      }}
                    />
                    Enabled
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={saveState?.pending}
                    onClick={() => onReset(action.commandPresetKey)}
                  >
                    Reset
                  </Button>
                </div>
              </div>
              <textarea
                id={`text-action-${action.commandPresetKey}`}
                className="w-full min-h-[84px] p-2 border rounded-md bg-background text-sm"
                value={promptValue}
                onChange={(event) =>
                  onDraftChange(action.commandPresetKey, {
                    systemPrompt: event.target.value,
                  })
                }
                onBlur={(event) => {
                  const nextPrompt =
                    event.target.value.trim() || action.commandDefaultPrompt;
                  onDraftChange(action.commandPresetKey, {
                    systemPrompt: nextPrompt,
                  });
                  onCommit(action.commandPresetKey, nextPrompt, enabledValue);
                }}
              />
              {saveState?.pending ? (
                <p role="status" className="text-sm text-muted-foreground">Saving changes…</p>
              ) : saveState?.failure ? (
                <div role="alert" className="flex items-center gap-2 text-sm">
                  <p>{saveState.failure === "reset" ? "Reset wasn't confirmed." : "Save wasn't confirmed."} Your local changes are still here.</p>
                  <Button variant="outline" size="sm" onClick={() => {
                    if (saveState.failure === "reset") onReset(action.commandPresetKey);
                    else onCommit(action.commandPresetKey, promptValue.trim() || action.commandDefaultPrompt, enabledValue);
                  }}>{saveState.failure === "reset" ? "Retry reset" : "Retry save"}</Button>
                </div>
              ) : saveState?.unsaved ? (
                <p role="status" className="text-sm text-muted-foreground">Unsaved changes</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
