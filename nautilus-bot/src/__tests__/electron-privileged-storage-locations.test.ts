import { describe, expect, it } from "bun:test";
import {
  parseCloudLocationRequest,
  cloudLocationConfirmationDetail,
} from "../../electron/privileged-storage-locations";

describe("parseCloudLocationRequest security validation", () => {
  it("accepts valid relative cloud folder paths and valid remote names", () => {
    const request = parseCloudLocationRequest({
      provider: "google_drive",
      remoteName: "my-gdrive",
      folder: "PlainsongBackups/2026",
    });
    expect(request).toEqual({
      provider: "google_drive",
      remoteName: "my-gdrive",
      folder: "PlainsongBackups/2026",
    });
  });

  it("accepts iCloud requests with safe relative folder path", () => {
    const request = parseCloudLocationRequest({
      provider: "i_cloud",
      folder: "Backups/Daily",
    });
    expect(request).toEqual({
      provider: "i_cloud",
      remoteName: null,
      folder: "Backups/Daily",
    });
  });

  it("rejects path traversal attempts with '..' or '.'", () => {
    expect(() =>
      parseCloudLocationRequest({
        provider: "google_drive",
        remoteName: "gdrive",
        folder: "../outside",
      }),
    ).toThrow("safe relative path");

    expect(() =>
      parseCloudLocationRequest({
        provider: "google_drive",
        remoteName: "gdrive",
        folder: "sub/./folder",
      }),
    ).toThrow("safe relative path");
  });

  it("rejects leading absolute path slashes", () => {
    expect(() =>
      parseCloudLocationRequest({
        provider: "one_drive",
        remoteName: "onedrive",
        folder: "/absolute/path",
      }),
    ).toThrow("safe relative path");

    expect(() =>
      parseCloudLocationRequest({
        provider: "one_drive",
        remoteName: "onedrive",
        folder: "\\unc\\path",
      }),
    ).toThrow("safe relative path");
  });

  it("rejects null byte injection in folder path", () => {
    expect(() =>
      parseCloudLocationRequest({
        provider: "proton_drive",
        remoteName: "proton",
        folder: "Plainsong\0Backups",
      }),
    ).toThrow("safe relative path");
  });

  it("rejects Windows drive specifiers in folder path", () => {
    expect(() =>
      parseCloudLocationRequest({
        provider: "google_drive",
        remoteName: "gdrive",
        folder: "C:PlainsongBackups",
      }),
    ).toThrow("safe relative path");

    expect(() =>
      parseCloudLocationRequest({
        provider: "google_drive",
        remoteName: "gdrive",
        folder: "D:\\Backups",
      }),
    ).toThrow("safe relative path");
  });

  it("generates correct confirmation detail formatting", () => {
    const rcloneDetail = cloudLocationConfirmationDetail({
      provider: "google_drive",
      remoteName: "my-gdrive",
      folder: "PlainsongBackups",
    });
    expect(rcloneDetail).toContain("my-gdrive:PlainsongBackups");

    const icloudDetail = cloudLocationConfirmationDetail({
      provider: "i_cloud",
      remoteName: null,
      folder: "PlainsongBackups",
    });
    expect(icloudDetail).toContain("under PlainsongBackups");
  });
});
