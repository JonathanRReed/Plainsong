export type CloudLocationRequest = {
  provider: "one_drive" | "google_drive" | "proton_drive" | "i_cloud";
  remoteName: string | null;
  folder: string;
};

const RCLONE_REMOTE_PATTERN = /^[A-Za-z0-9_-]{1,64}:?$/;

export function parseCloudLocationRequest(args: unknown): CloudLocationRequest {
  const payload = (args ?? {}) as Record<string, unknown>;
  const provider = payload.provider;
  if (
    provider !== "one_drive" &&
    provider !== "google_drive" &&
    provider !== "proton_drive" &&
    provider !== "i_cloud"
  ) {
    throw new Error("Choose a supported cloud provider");
  }

  const folder = typeof payload.folder === "string" ? payload.folder.trim() : "";
  if (
    !folder ||
    folder.length > 160 ||
    folder.startsWith("/") ||
    folder.startsWith("\\") ||
    folder.split(/[\\/]/).some((part) => part === ".." || part === ".")
  ) {
    throw new Error("Cloud folder must be a safe relative path");
  }

  if (provider === "i_cloud") {
    return { provider, remoteName: null, folder };
  }

  const remoteName =
    typeof payload.remoteName === "string" ? payload.remoteName.trim() : "";
  if (!RCLONE_REMOTE_PATTERN.test(remoteName)) {
    throw new Error("Enter a valid rclone remote name");
  }
  return {
    provider,
    remoteName: remoteName.replace(/:$/, ""),
    folder,
  };
}

export function cloudLocationConfirmationDetail(request: CloudLocationRequest): string {
  if (request.provider === "i_cloud") {
    return `Plainsong will write beta backups inside the folder you select, under ${request.folder}.`;
  }
  return `Plainsong will upload beta backups to ${request.remoteName}:${request.folder}.`;
}
