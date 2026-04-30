// ---------------------------------------------------------------------------
// Express application — middleware stack + route mounting
// ---------------------------------------------------------------------------
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { randomBytes } from "crypto";
import "dotenv/config";

import { requestLogger } from "./middleware/logger.js";
import { authLimiter, apiLimiter } from "./middleware/rateLimiter.js";
import { csrfProtection } from "./middleware/csrf.js";
import authRouter from "./auth/router.js";
import profilesRouter from "./profiles/router.js";
import usersRouter from "./users/router.js";
import apiVersion from "./middleware/apiVersion.js";
import authenticate from "./middleware/authenticate.js";

const app = express();

// ── Core middleware ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser(process.env.COOKIE_SECRET));
app.use(cors({
  origin: process.env.WEB_PORTAL_URL,
  credentials: true,
}));
app.set("trust proxy", 1);

// ── CSRF token endpoint ─────────────────────────────────────────────────────
// Returns a short-lived CSRF token the portal reads and sends back as a header
// on every mutating request. Backend verifies header === cookie value.
app.get("/csrf-token", (req, res) => {
  const token = randomBytes(32).toString("hex");
  res.cookie("csrf_token", token, {
    httpOnly: false,   // JS must be able to read this one
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 1000, // 1 hour
  });
  res.json({ status: "success", csrf_token: token });
});

// ── Logging ─────────────────────────────────────────────────────────────────
app.use(requestLogger);


// ── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) =>
  res.json({ status: "success", message: "Insighta Labs+ API v3" })
);

app.use("/auth", authLimiter, authRouter);

app.use("/api", csrfProtection, apiLimiter, apiVersion, authenticate);


// ── Feature routers ─────────────────────────────────────────────────────────
app.use("/api/profiles", profilesRouter);
app.use("/api/users",    usersRouter);

// ── 404 fallback ────────────────────────────────────────────────────────────
app.use((_req, res) =>
  res.status(404).json({ status: "error", message: "Route not found" })
);

export default app;
