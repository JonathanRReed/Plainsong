const RENDERER_ALLOWED_PERMISSIONS = new Set([
  "media",
  "clipboard-sanitized-write",
]);

type RendererPermissionRequest = {
  requestingOrigin: string | undefined | null;
  isMainFrame: boolean;
};

export function rendererPermissionAllowed(
  permission: string,
  request: RendererPermissionRequest,
  isTrustedOrigin: (origin: string) => boolean,
): boolean {
  const origin = request.requestingOrigin?.trim();
  return Boolean(
    request.isMainFrame &&
      origin &&
      RENDERER_ALLOWED_PERMISSIONS.has(permission) &&
      isTrustedOrigin(origin),
  );
}
