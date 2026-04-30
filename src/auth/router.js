import { Router } from "express";
import { sendError, ApiError } from "../utils.js";
import authenticate from "../middleware/authenticate.js";
import {
  getRedirectURL,
  exchangeCodeForToken,
  validateState,
  findOrCreateUser,
  generateAuthToken,
  generateAndSaveRefreshToken,
  refreshAuthToken,
  revokeRefreshToken,
} from "./service.js";

const router = Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
};

const setAuthCookies = (res, accessToken, refreshToken) => {
  res.cookie("access_token",  accessToken,  { ...COOKIE_OPTS, maxAge: Number(process.env.ACCESS_TOKEN_EXPIRY)  * 1000 });
  res.cookie("refresh_token", refreshToken, { ...COOKIE_OPTS, maxAge: Number(process.env.REFRESH_TOKEN_EXPIRY) * 1000 });
};

const clearAuthCookies = (res) => {
  res.clearCookie("access_token");
  res.clearCookie("refresh_token");
};

// ── GET /auth/github ────────────────────────────────────────────────────────
router.get("/github", (req, res) => {
  const cli_port    = req.query.cli_port ?? null;
  const redirectUrl = getRedirectURL(cli_port);
  res.redirect(redirectUrl);
});

// ── GET /auth/github/callback ───────────────────────────────────────────────
router.get("/github/callback", async (req, res) => {
  const { code, state } = req.query;
  const { valid, cli_port } = validateState(state);

  if (!state || !valid) {
    return sendError(res, new ApiError(400, "Invalid or missing state parameter"));
  }

  if (!code) {
    return sendError(res, new ApiError(400, "Authorization code not provided"));
  }

  try {
    const { githubUser } = await exchangeCodeForToken(code);
    const user           = await findOrCreateUser(githubUser);

    if (!user.is_active) {
      return sendError(res, new ApiError(403, "Account is deactivated"));
    }

    const appAccessToken = await generateAuthToken(user);
    const refreshToken   = await generateAndSaveRefreshToken(user.id);

    // CLI flow — redirect to local server with tokens in query params
    if (cli_port) {
      const params = new URLSearchParams({
        access_token:  appAccessToken,
        refresh_token: refreshToken,
        username:      user.username,
        email:         user.email ?? "",
        role:          user.role,
        id:            user.id,
      });
      const cliHost = process.env.HOST || "http://127.0.0.1";
      return res.redirect(`${cliHost}:${cli_port}/callback?${params.toString()}`);
    }

    // Web flow — set HTTP-only cookies, redirect to portal
    setAuthCookies(res, appAccessToken, refreshToken);
    
    return res.redirect(`${process.env.WEB_PORTAL_URL}/dashboard`);

  } catch (err) {
    console.error("GitHub OAuth error:", err);
    return sendError(res, new ApiError(500, "Failed to authenticate with GitHub"));
  }
});

// ── GET /auth/me ────────────────────────────────────────────────────────────
// Web portal uses this to hydrate user state on load
router.get("/me", authenticate, (req, res) => {
  return res.json({
    status: "success",
    data: {
      id:         req.user.id,
      username:   req.user.username,
      email:      req.user.email,
      avatar_url: req.user.avatar_url,
      role:       req.user.role,
    },
  });
});

// ── POST /auth/refresh ──────────────────────────────────────────────────────
router.post("/refresh", async (req, res) => {
  // Accept from body (CLI) or cookie (web)
  const token = req.body?.refresh_token ?? req.cookies?.refresh_token;

  if (!token) {
    return sendError(res, new ApiError(400, "Refresh token not provided"));
  }

  try {
    const { accessToken, newRefreshToken } = await refreshAuthToken(token);

    // If request came from web (cookie-based), update cookies
    if (req.cookies?.refresh_token) {
      setAuthCookies(res, accessToken, newRefreshToken);
      return res.json({ status: "success" });
    }

    return res.json({
      status:        "success",
      access_token:  accessToken,
      refresh_token: newRefreshToken,
    });
  } catch (err) {
    console.error("Token refresh error:", err);
    return sendError(res, new ApiError(401, "Invalid or expired refresh token"));
  }
});

// ── POST /auth/logout ───────────────────────────────────────────────────────
router.post("/logout", async (req, res) => {
  // Accept from body (CLI) or cookie (web)
  const token = req.body?.refresh_token ?? req.cookies?.refresh_token;

  if (!token) return sendError(res, new ApiError(400, "Refresh token required"));

  try {
    await revokeRefreshToken(token);
    clearAuthCookies(res);
    return res.json({ status: "success", message: "Logged out successfully" });
  } catch (err) {
    console.error("Logout error:", err);
    return sendError(res, new ApiError(500, "Failed to log out"));
  }
});

export default router;
