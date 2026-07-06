import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Radix UI primitives (Select, Dialog, etc.) require these browser APIs that
// jsdom does not provide.
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

// jsdom does not implement matchMedia; components like the toast progress
// bar (src/components/toast.tsx) query prefers-reduced-motion.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

const canvas2DContextStub = {
  beginPath: vi.fn(),
  clearRect: vi.fn(),
  drawImage: vi.fn(),
  fill: vi.fn(),
  fillRect: vi.fn(),
  getImageData: vi.fn(),
  putImageData: vi.fn(),
  resetTransform: vi.fn(),
  restore: vi.fn(),
  roundRect: vi.fn(),
  save: vi.fn(),
  scale: vi.fn(),
  setTransform: vi.fn(),
  fillStyle: "",
  globalAlpha: 1,
  shadowBlur: 0,
  shadowColor: "",
} satisfies Partial<CanvasRenderingContext2D>;

HTMLCanvasElement.prototype.getContext = vi.fn(
  () => canvas2DContextStub as unknown as CanvasRenderingContext2D
) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// Mock Electron IPC adapter
vi.mock("@/lib/electron", () => ({
  invoke: vi.fn(),
  listen: vi.fn(() => Promise.resolve(() => {})),
  once: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(),
  getCurrentWindow: () => ({
    label: "main",
    setSize: vi.fn(),
    setPosition: vi.fn(),
    hide: vi.fn(),
    startDragging: vi.fn(),
  }),
  LogicalSize: class LogicalSize {
    constructor(public width: number, public height: number) {}
  },
}));
