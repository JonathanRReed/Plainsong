import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ProductReadinessProvider,
  useProductReadinessStatus,
} from "@/features/readiness/product-readiness-context";

const readinessStatus = vi.hoisted(() => ({
  loading: false,
  error: null,
  refresh: vi.fn(),
  productReadiness: {
    evidenceObservedAt: 42,
    dictation: { domain: "dictation", state: "ready", cause: null },
    meetings: { domain: "meetings", state: "ready", cause: null },
    fullCapture: { domain: "full_capture", state: "degraded", cause: null },
    overall: { domain: "overall", state: "degraded", cause: null },
  },
}));

vi.mock("@/hooks/use-setup-status", () => ({
  useSetupStatus: () => readinessStatus,
}));

function ReadinessProbe() {
  const status = useProductReadinessStatus();
  return (
    <p>
      {status.productReadiness.evidenceObservedAt}:
      {status.productReadiness.dictation.state}
    </p>
  );
}

describe("ProductReadinessProvider", () => {
  it("shares one exact readiness observation with every product surface", () => {
    render(
      <ProductReadinessProvider>
        <ReadinessProbe />
        <ReadinessProbe />
      </ProductReadinessProvider>,
    );

    expect(screen.getAllByText("42:ready")).toHaveLength(2);
  });
});
