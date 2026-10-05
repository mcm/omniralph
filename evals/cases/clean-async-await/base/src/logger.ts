export const logger = {
  info: (message: string, data?: Record<string, unknown>) => console.info(message, data ?? {}),
  error: (message: string, data?: Record<string, unknown>) => console.error(message, data ?? {}),
};
