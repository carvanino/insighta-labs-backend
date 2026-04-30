import morgan from "morgan";

/**
 * HTTP request logger.
 * Logs: method  endpoint  status  response-time
 *
 * Format: :method :url :status :response-time ms
 *
 * Stage 3 will extend this to write to a structured log store
 * and add user identity once auth is in place.
 */
export const requestLogger = morgan(
  ":method :url :status :response-time ms",
  {
    stream: {
      write: (message) => process.stdout.write(message),
    },
  }
);
