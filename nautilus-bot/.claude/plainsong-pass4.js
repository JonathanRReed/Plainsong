export const meta = {
  name: 'plainsong-build-pass4',
  description: 'Final pass — renderer correctness (permission re-verify, inactive-not-disabled) + neume harmonization + a read-only native HUD/menu-bar audit',
  phases: [{ title: 'Build & audit', detail: 'verifiable renderer wins built; native parts audited' }],
}

const BASE = [
  'Plainsong desktop app (Electron + React, Tailwind v4) in nautilus-bot/. Read nautilus-bot/STYLE.md. North-star: the most elegant, fully-LOCAL, MOST FUNCTIONAL way to dictate into any app and capture meetings — technology from an elegant advanced society.',
  'Research-validated UX rules to apply (cited): never DISABLE a control that is non-functional due to permission/offline/availability — remove/replace it, or use a focusable INACTIVE state that still takes focus and explains itself to assistive tech (GitHub Primer). Gate dictation behind sequential, PURPOSE-LABELED permission steps (microphone first, then accessibility with the reason: inserting spoken words into other apps) and RE-VERIFY grants are still in effect before continuing; on a revoked grant show a toast and focus/jump to the affected card (Wispr Flow).',
  'HARD CONSTRAINTS: keep ALL gates green (tsc -p tsconfig.json AND -p tsconfig.electron.json, vitest, knip, verify-dead-code-hygiene, vite build). Do NOT change test-asserted text/labels/roles (first-run-wizard.test.tsx, setup-view.test.tsx, settings-view-simple.test.tsx must keep passing). No new deps/unused imports. OFFLINE/local-first + HONEST. a11y-clean. RESTRAINT: gold earned, rust = rubric/not-yet, neutral chrome muted, neume state glyphs, no stoplight hues.',
  'CONSERVATIVE: only convert a disabled control to inactive when it is CLEARLY gated on permission/availability/offline — NOT when it is disabled for loading/validation/in-flight reasons (those disables are correct). If unsure, LEAVE it and note it. Keep recognizable check/cross ICONS in checklist/permission contexts (recolored gold/rust is fine) — convert only GENERIC colored status DOTS to neumes.',
  'VOCABULARY: .neume / .neume-lit / .neume-hollow / .neume-rust / .neume-live · .rubric / .rubric-muted · text-gold-text / bg-gold / border-gold · text-rust · .time-spec · .settle-in.',
].join('\n')

const BUILD_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['files'],
  properties: { files: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['path', 'changes'],
    properties: { path: { type: 'string' }, changes: { type: 'array', items: { type: 'string' } }, note: { type: 'string' } } } } },
}

const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['area', 'current', 'recommendation', 'location', 'needsOnDevice'],
    properties: {
      area: { type: 'string' },
      current: { type: 'string', description: 'what the code does today' },
      recommendation: { type: 'string', description: 'precise fix per the cited UX rule' },
      location: { type: 'string', description: 'file(s) + symbol/line' },
      needsOnDevice: { type: 'boolean' },
    } } }, summary: { type: 'string' } },
}

phase('Build & audit')
const [onboarding, dense, native] = await parallel([
  () => agent(
    BASE + '\n\nYOUR FILES (edit only these): src/components/first-run-wizard.tsx, src/components/views/setup-view.tsx\n\nBUILD: (1) Ensure the permission steps are sequential + purpose-labeled (microphone first, then accessibility with the why). (2) RE-VERIFY permission grants before the user advances past a permission step: re-check current grants; if one was granted then revoked, show a toast (existing toast system) and focus/scroll to the affected card. (3) Convert any "Continue/Next/Start" control that is DISABLED purely because a permission/availability is missing into a focusable INACTIVE control that still takes focus and, on activate, surfaces the reason (toast or inline) + points to the fix — do NOT convert loading/validation disables. (4) Neume harmonization: generic colored status dots -> neumes (keep recognizable check/cross icons, recolored gold/rust). Keep both test files passing.',
    { label: 'pass4:onboarding', phase: 'Build & audit', schema: BUILD_SCHEMA, effort: 'high' }
  ).then((r) => ({ kind: 'build', bucket: 'onboarding', ...r })),

  () => agent(
    BASE + '\n\nYOUR FILES (edit only these): src/components/asr-provider-manager.tsx, src/components/views/settings-view-simple.tsx\n\nBUILD: (1) Neume harmonization: convert generic colored status DOTS to neumes (neume-lit ready/on, neume-hollow optional/off, neume-rust attention) with text as the accessible truth; keep recognizable check/cross icons. (2) CONSERVATIVELY convert controls disabled purely for permission/offline/availability into focusable inactive states that explain themselves; leave loading/validation disables as-is and note them. Keep settings-view-simple.test.tsx passing; change no asserted text/labels/roles.',
    { label: 'pass4:dense', phase: 'Build & audit', schema: BUILD_SCHEMA, effort: 'high' }
  ).then((r) => ({ kind: 'build', bucket: 'dense', ...r })),

  () => agent(
    'You are auditing (READ-ONLY, do not edit) the Electron main-process + window code of the Plainsong desktop app for floating-HUD and menu-bar correctness against Apple HIG + competitor best practice. Read the electron/ directory (main, window creation, the dictation/recording overlay windows, any Tray/menu-bar, blur/focus/Esc handlers) and relevant renderer overlay code (src/overlay-root.tsx, src/components/popups/*). Report precise findings. The UX rules: a dictation/recording HUD should be a NON-MODAL macOS panel that floats and supports (not blocks) the active app; it should PERSIST until explicit dismissal (Escape) and NOT vanish on click-away/blur (that is a known regression); it should adapt to the real display (no fake notch on external monitors). A menu-bar extra (Tray) should show a MENU not a popover on click, be user-toggleable, and use a template monochrome icon. For each finding give: area, what the code does today (current), the precise recommendation, the file/symbol location, and whether verifying/applying it needs an on-device run. Return ONLY the structured object.',
    { label: 'pass4:native-audit', phase: 'Build & audit', schema: AUDIT_SCHEMA, agentType: 'Explore', effort: 'high' }
  ).then((r) => ({ kind: 'audit', bucket: 'native', ...r })),
])

return { onboarding, dense, native }
