import { Router } from "express";
import { query } from "../db/index.js";
import { sendError, ApiError } from "../utils.js";

const router = Router();

// GET /api/users/me — returns the currently authenticated user
router.get("/me", async (req, res) => {
  try {
    const result = await query("SELECT * FROM users WHERE id = $1", [req.user.id]);
    if (!result.rows.length) {
      return sendError(res, new ApiError(404, "User not found"));
    }
    const u = result.rows[0];
    return res.json({
      status: "success",
      data: {
        id:            u.id,
        username:      u.username,
        email:         u.email,
        avatar_url:    u.avatar_url,
        role:          u.role,
        is_active:     u.is_active,
        last_login_at: u.last_login_at,
        created_at:    u.created_at,
      },
    });
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
