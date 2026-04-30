import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const limitResponse = (message) => ({ status: "error", message });

// Auth endpoints — 10 req / minute (unauthenticated, keyed by IP)
export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: limitResponse("Too many requests, please try again later."),
});

// API endpoints — 60 req / minute per authenticated user (falls back to IP)
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Key by user id once authenticated, otherwise by IP
  keyGenerator: (req, res) => req.user?.id ?? ipKeyGenerator(req, res),
  message: limitResponse("Too many requests, please try again later."),
});
