import path from "path";

export const RENDERER_SCHEME = "plainsong";
export const RENDERER_HOST = "bundle";

export function rendererUrl(query?: Record<string, string>): string {
  const url = new URL(`${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export function isRendererUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${RENDERER_SCHEME}:` && url.host === RENDERER_HOST;
  } catch {
    return false;
  }
}

export function resolveRendererAssetPath(rendererRoot: string, rawUrl: string): string {
  const url = new URL(rawUrl);
  if (!isRendererUrl(rawUrl)) {
    throw new Error("Renderer URL must use the packaged renderer origin");
  }

  const relativeAssetPath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (!relativeAssetPath || relativeAssetPath.includes("\0")) {
    throw new Error("Renderer asset path is invalid");
  }

  const resolvedRoot = path.resolve(rendererRoot);
  const resolvedAsset = path.resolve(resolvedRoot, relativeAssetPath);
  const relativeToRoot = path.relative(resolvedRoot, resolvedAsset);
  if (
    !relativeToRoot ||
    relativeToRoot.startsWith("..") ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error("Renderer asset path escapes the packaged renderer root");
  }

  return resolvedAsset;
}
