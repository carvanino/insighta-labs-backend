import { jwtVerify } from "jose";
import { TextEncoder } from "util";
import { sendError, ApiError } from "../utils.js";
import { query } from "../db/index.js";


const getUserById = async (id) => {
  const result = await query("SELECT id, username, email, avatar_url, role, is_active FROM users WHERE id = $1", [id]);
  return result.rows[0];
};

export default async function authenticate(req, res, next) {
  // Support both Bearer token (CLI) and HTTP-only cookie (web portal)
  let token = null;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.cookies?.access_token) {
    token = req.cookies.access_token;
  }

  if (!token) {
    return sendError(res, new ApiError(401, "Authentication required"));
  }

  const secretKey = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET);

  try {
    const { payload } = await jwtVerify(token, secretKey);

    const user = await getUserById(payload.sub);

    if (!user || !user.is_active) {
      return sendError(res, new ApiError(403, "User account is inactive"));
    }

    req.user = user;

    next();
  } catch (err) {
    console.error("JWT verification failed:", err);
    return sendError(res, new ApiError(401, "Invalid or expired token"));
  }
};