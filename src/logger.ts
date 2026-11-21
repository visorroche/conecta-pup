import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Nunca logar senha nem credenciais do proxy.
  redact: {
    paths: ["password", "*.password", "proxyPassword", "proxyUsername"],
    censor: "[redacted]",
  },
});
