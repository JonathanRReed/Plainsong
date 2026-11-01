import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { EmbeddingStatus } from "@/lib/backend";

type SearchModel = EmbeddingStatus["builtInModels"][number];

/** The only use policy a built-in search model names today is Google's for Gemma. */
const USE_POLICY_NAME = "Gemma Prohibited Use Policy";

function TermsLink({ href, children }: { href: string; children: string }) {
  return (
    <a className="underline" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/**
 * The terms a built-in search model comes under, and the use policy its
 * publisher asks deployments to follow when it names one. Ends with a period.
 */
export function SearchModelTermsNote({ model }: { model: SearchModel }) {
  const policy = model.usePolicyUrl ? <TermsLink href={model.usePolicyUrl}>{`the ${USE_POLICY_NAME}`}</TermsLink> : null;
  if (model.requiresTermsAcceptance) {
    return (
      <>
        Use of {model.displayName} is subject to <TermsLink href={model.termsUrl}>{`the ${model.license}`}</TermsLink>
        {policy && <> and {policy}</>}.
      </>
    );
  }
  return (
    <>
      Use of {model.displayName} is subject to its{" "}
      <TermsLink href={model.termsUrl}>{`${model.license} license`}</TermsLink>
      {policy && <>, and Google asks that it be used in line with {policy}</>}.
    </>
  );
}

/**
 * The click-through a model with its own terms needs before Plainsong
 * downloads or runs it. The sidecar refuses the download until the
 * acceptance this records is in settings.
 */
export function SearchModelTermsPrompt({
  model,
  recommended,
  disabled,
  onAccept,
}: {
  model: SearchModel;
  /** The default model, offered as the way around these terms. */
  recommended?: SearchModel;
  disabled: boolean;
  onAccept: () => void;
}) {
  const [checked, setChecked] = useState(false);
  const titleId = `search-model-terms-${model.id}`;
  return (
    <div role="group" aria-labelledby={titleId} className="space-y-2 rounded-md border border-border p-3 text-sm">
      <p id={titleId} className="font-medium">
        Accept the {model.license} to use {model.displayName}
      </p>
      <p className="text-muted-foreground">
        {model.displayName} comes under Google&apos;s <TermsLink href={model.termsUrl}>{model.license}</TermsLink>,
        not an open-source license. Plainsong downloads and runs it only after you agree to those terms
        {model.usePolicyUrl && (
          <>
            , including the <TermsLink href={model.usePolicyUrl}>{USE_POLICY_NAME}</TermsLink>
          </>
        )}
        . Your acceptance and its date are saved in Plainsong&apos;s settings on this Mac. Until you accept,
        search matches words.
        {recommended && recommended.id !== model.id && !recommended.requiresTermsAcceptance && (
          <> {recommended.displayName}, the recommended model, needs no extra terms.</>
        )}
      </p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 accent-gold"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
        />
        <span>
          I accept the {model.license}
          {model.usePolicyUrl ? ` and the ${USE_POLICY_NAME}` : ""}.
        </span>
      </label>
      <Button type="button" variant="secondary" size="sm" disabled={!checked || disabled} onClick={onAccept}>
        {model.downloaded
          ? "Accept and use"
          : `Accept and download (${Math.round(model.downloadBytes / 1_000_000)} MB)`}
      </Button>
    </div>
  );
}
