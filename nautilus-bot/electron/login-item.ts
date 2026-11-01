/**
 * "Open at Login" in the menu bar menu.
 *
 * Dictation is a global shortcut: until Plainsong is running, pressing it does
 * nothing, so after every restart the reader had to remember to open the app
 * first. macOS keeps the real answer (System Settings > General > Login
 * Items), and the reader can change it there, so the menu shows what macOS
 * reports rather than a remembered preference.
 */
export interface LoginItemReading {
  openAtLogin: boolean;
  /** macOS 13+: `not-registered`, `enabled`, `requires-approval`, `not-found`. */
  status?: string;
}

export interface LoginItemMenuState {
  checked: boolean;
  label: string;
}

export function describeLoginItem(reading: LoginItemReading | null): LoginItemMenuState {
  if (!reading) {
    return { checked: false, label: "Open at Login" };
  }
  if (reading.status === "requires-approval") {
    // Registered, but macOS will not launch it until the reader allows it.
    return { checked: true, label: "Open at Login (allow in System Settings)" };
  }
  return {
    checked: reading.openAtLogin || reading.status === "enabled",
    label: "Open at Login",
  };
}
