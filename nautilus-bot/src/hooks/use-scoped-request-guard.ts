import { useCallback, useMemo, useRef } from "react";

export type ScopedRequestToken<TScope extends string | null = string | null> = {
  requestId: number;
  scope: TScope;
};

export function useScopedRequestGuard<TScope extends string | null = string | null>() {
  const latestRequestIdRef = useRef(0);
  const activeScopeRef = useRef<TScope>(null as TScope);

  const beginRequest = useCallback((scope: TScope): ScopedRequestToken<TScope> => {
    latestRequestIdRef.current += 1;
    activeScopeRef.current = scope;
    return {
      requestId: latestRequestIdRef.current,
      scope,
    };
  }, []);

  const setScope = useCallback((scope: TScope) => {
    latestRequestIdRef.current += 1;
    activeScopeRef.current = scope;
  }, []);

  const isCurrent = useCallback((token: ScopedRequestToken<TScope>) => {
    return (
      latestRequestIdRef.current === token.requestId &&
      Object.is(activeScopeRef.current, token.scope)
    );
  }, []);

  return useMemo(
    () => ({
      activeScopeRef,
      beginRequest,
      isCurrent,
      setScope,
    }),
    [beginRequest, isCurrent, setScope]
  );
}
