import { useEffect, useRef, useCallback } from "react";
import { validateLicense } from "@/lib/backend/license";
import type { LicenseInfo } from "@/lib/backend/license";

const VALIDATION_INTERVAL_MS = 4 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "nautilus_license_last_check";

interface UsePeriodicLicenseCheckOptions {
  license: LicenseInfo | null;
  onLicenseChange: (info: LicenseInfo) => void;
  onLicenseRevoked?: () => void;
}

export function usePeriodicLicenseCheck({
  license,
  onLicenseChange,
  onLicenseRevoked,
}: UsePeriodicLicenseCheckOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isCheckingRef = useRef(false);

  const performCheck = useCallback(async () => {
    if (isCheckingRef.current) return;
    isCheckingRef.current = true;

    try {
      const info = await validateLicense();
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));

      const hadValidLicense = license?.valid === true;
      const nowValid = info.valid === true;

      if (hadValidLicense && !nowValid && onLicenseRevoked) {
        onLicenseRevoked();
      } else if (JSON.stringify(info) !== JSON.stringify(license)) {
        onLicenseChange(info);
      }
    } catch {
      // Grace period in Rust handles network errors
    } finally {
      isCheckingRef.current = false;
    }
  }, [license, onLicenseChange, onLicenseRevoked]);

  useEffect(() => {
    if (!license) return;

    const lastCheckRaw = localStorage.getItem(LAST_CHECK_KEY);
    const lastCheck = lastCheckRaw ? Number(lastCheckRaw) : 0;
    const timeSinceLastCheck = Date.now() - lastCheck;

    if (timeSinceLastCheck >= VALIDATION_INTERVAL_MS) {
      void performCheck();
    }

    timerRef.current = setInterval(performCheck, VALIDATION_INTERVAL_MS);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [performCheck, license]);
}
