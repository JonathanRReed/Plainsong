import { createContext, useContext, type ReactNode } from "react";
import { useSetupStatus } from "@/hooks/use-setup-status";

export type ProductReadinessStatus = ReturnType<typeof useSetupStatus>;

const ProductReadinessContext =
  createContext<ProductReadinessStatus | null>(null);

export function ProductReadinessProvider({
  children,
}: {
  children: ReactNode;
}) {
  const status = useSetupStatus();

  return (
    <ProductReadinessContext.Provider value={status}>
      {children}
    </ProductReadinessContext.Provider>
  );
}

export function useProductReadinessStatus(): ProductReadinessStatus {
  const status = useContext(ProductReadinessContext);
  if (!status) {
    throw new Error(
      "useProductReadinessStatus must be used inside ProductReadinessProvider.",
    );
  }
  return status;
}
