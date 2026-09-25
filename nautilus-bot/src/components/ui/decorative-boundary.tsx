import { Component, type ErrorInfo, type ReactNode } from "react";

interface DecorativeBoundaryProps {
  /** The surface with its effect. */
  children: ReactNode;
  /** The same surface without the effect, shown if the effect throws. */
  fallback: ReactNode;
}

/**
 * Keeps a purely decorative effect (a glow, an orb) from taking a screen
 * down with it. The app's only other boundary is the whole window, so an
 * effect that failed on some GPU or audio device would otherwise replace
 * onboarding or dictation with the crash screen. Falls back to the plain
 * surface and stays there.
 */
export class DecorativeBoundary extends Component<
  DecorativeBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[effects] a decorative effect failed; showing the plain surface", error, info.componentStack);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
