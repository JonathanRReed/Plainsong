#!/usr/bin/env bash
set -euo pipefail

# Format: ID|owner|expiry(YYYY-MM-DD)|reason
POLICY_ENTRIES=(
  "RUSTSEC-2024-0413|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream tauri dependency updates"
  "RUSTSEC-2024-0416|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream tauri dependency updates"
  "RUSTSEC-2021-0153|security@nautilusbot.app|2026-12-31|Legacy transitive dependency retained for platform support"
  "RUSTSEC-2025-0057|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream patch release"
  "RUSTSEC-2024-0412|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream tauri dependency updates"
  "RUSTSEC-2024-0418|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream tauri dependency updates"
  "RUSTSEC-2024-0411|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream tauri dependency updates"
  "RUSTSEC-2024-0417|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream tauri dependency updates"
  "RUSTSEC-2024-0414|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream tauri dependency updates"
  "RUSTSEC-2024-0415|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream tauri dependency updates"
  "RUSTSEC-2024-0420|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream tauri dependency updates"
  "RUSTSEC-2024-0419|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream tauri dependency updates"
  "RUSTSEC-2020-0144|security@nautilusbot.app|2026-12-31|Legacy transitive crate required by current stack"
  "RUSTSEC-2025-0119|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream patch release"
  "RUSTSEC-2024-0436|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream patch release"
  "RUSTSEC-2024-0370|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream patch release"
  "RUSTSEC-2021-0140|security@nautilusbot.app|2026-12-31|Legacy transitive dependency retained for compatibility"
  "RUSTSEC-2020-0020|security@nautilusbot.app|2026-12-31|Legacy transitive dependency retained for compatibility"
  "RUSTSEC-2020-0056|security@nautilusbot.app|2026-12-31|Legacy transitive dependency retained for compatibility"
  "RUSTSEC-2025-0081|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream patch release"
  "RUSTSEC-2025-0075|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream patch release"
  "RUSTSEC-2025-0080|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream patch release"
  "RUSTSEC-2025-0100|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream patch release"
  "RUSTSEC-2025-0098|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream patch release"
  "RUSTSEC-2024-0429|security@nautilusbot.app|2026-12-31|Transitive advisory accepted pending upstream patch release"
)

validate_policy() {
  local today
  today="$(date -u +%Y-%m-%d)"

  if [ "${#POLICY_ENTRIES[@]}" -eq 0 ]; then
    echo "Policy error: no RustSec ignore entries configured." >&2
    return 1
  fi

  local failed=0
  local seen_ids=()
  for entry in "${POLICY_ENTRIES[@]}"; do
    IFS='|' read -r id owner expiry reason <<<"$entry"

    if [[ -z "${id:-}" || -z "${owner:-}" || -z "${expiry:-}" || -z "${reason:-}" ]]; then
      echo "Policy error: malformed entry '$entry'" >&2
      failed=1
      continue
    fi

    if [[ ! "$id" =~ ^RUSTSEC-[0-9]{4}-[0-9]{4}$ ]]; then
      echo "Policy error: invalid RustSec id '$id'" >&2
      failed=1
    fi

    if [[ ! "$expiry" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
      echo "Policy error: expiry must be YYYY-MM-DD for '$id'" >&2
      failed=1
    elif [[ "$expiry" < "$today" ]]; then
      echo "Policy error: ignore '$id' expired on $expiry" >&2
      failed=1
    fi

    if [[ ${#reason} -lt 12 ]]; then
      echo "Policy error: reason too short for '$id'" >&2
      failed=1
    fi

    for seen in "${seen_ids[@]}"; do
      if [[ "$seen" == "$id" ]]; then
        echo "Policy error: duplicate RustSec id '$id'" >&2
        failed=1
      fi
    done
    seen_ids+=("$id")
  done

  if [ "$failed" -ne 0 ]; then
    return 1
  fi

  echo "Cargo-audit policy metadata check passed (${#POLICY_ENTRIES[@]} entries)."
}

if [[ "${1:-}" == "--check-policy" ]]; then
  validate_policy
  exit 0
fi

validate_policy

AUDIT_ARGS=()
for entry in "${POLICY_ENTRIES[@]}"; do
  IFS='|' read -r id _ _ _ <<<"$entry"
  AUDIT_ARGS+=(--ignore "$id")
done

cargo audit -f Cargo.lock --deny warnings "${AUDIT_ARGS[@]}" "$@"
