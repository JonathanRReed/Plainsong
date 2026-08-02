export const RENDERER_READY_LOG_MESSAGE = "[main] App rendered";

export function shouldForwardRendererConsoleMessage(
  message: string,
  isDevelopment: boolean
): boolean {
  return isDevelopment || message === RENDERER_READY_LOG_MESSAGE;
}
