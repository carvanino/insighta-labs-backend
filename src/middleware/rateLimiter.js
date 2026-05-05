import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { getRedisClient } from "../lib/cache.js";

const handler = (_req, res) => {
  res.status(429).json({
    status: "error",
    message: "Too many requests, please try again later.",
  });
};

// Shared Redis store — rate limit counters are consistent across all instances.
// Falls back gracefully if Redis is unavailable (express-rate-limit handles this).
const makeStore = (prefix) =>
  new RedisStore({
    sendCommand: (...args) => getRedisClient().call(...args),
    prefix,
  });

// Auth endpoints — 10 req / minute, keyed by IP
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore("rl:auth:"),
  handler,
});

// API endpoints — 60 req / minute, keyed by user id (falls back to IP)
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.user?.id ?? ipKeyGenerator(req, res),
  store: makeStore("rl:api:"),
  handler,
});
