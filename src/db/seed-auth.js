// ---------------------------------------------------------------------------
// seed-auth.js — generates test tokens for grading
//
// Usage:  node src/db/seed-auth.js
//
// Upserts a seeded admin + analyst user into the DB, issues valid tokens
// for each, and prints them to stdout. Safe to run multiple times.
// ---------------------------------------------------------------------------
import "dotenv/config";
import { SignJWT } from "jose";
import { randomBytes } from "crypto";
import { TextEncoder } from "util";
import { v7 as uuid } from "uuid";
import pool, { initDB } from "./index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const query = (text, params) => pool.query(text, params);

const generateAccessToken = async (user) => {
  const secret = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET);
  return new SignJWT({
    sub:      user.id,
    id:       user.id,
    username: user.username,
    email:    user.email,
    role:     user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    // Long expiry for testing so the grader doesn't hit expiry mid-run
    .setExpirationTime("24h")
    .sign(secret);
};

const generateRefreshToken = async (userId) => {
  const token     = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h for testing
  await query(
    `INSERT INTO refresh_tokens (id, user_id, token, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO NOTHING`,
    [uuid(), userId, token, expiresAt]
  );
  return token;
};

// Upsert a seeded user — if github_id exists update role, otherwise insert
const upsertSeedUser = async ({ github_id, username, email, role }) => {
  const existing = await query(
    "SELECT * FROM users WHERE github_id = $1",
    [github_id]
  );

  if (existing.rows.length) {
    // Ensure role is correct even if it was changed
    await query(
      "UPDATE users SET role = $1, username = $2, email = $3 WHERE github_id = $4",
      [role, username, email, github_id]
    );
    const updated = await query(
      "SELECT * FROM users WHERE github_id = $1",
      [github_id]
    );
    return updated.rows[0];
  }

  const id     = uuid();
  const result = await query(
    `INSERT INTO users (id, github_id, username, email, role, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING *`,
    [id, github_id, username, email, role]
  );
  return result.rows[0];
};

// ── Main ──────────────────────────────────────────────────────────────────────

const seed = async () => {
  await initDB();

  // Seeded users — fake github_ids prefixed with "seed_" to avoid conflicts
  const adminUser = await upsertSeedUser({
    github_id: "seed_admin_001",
    username:  "insighta_admin",
    email:     "admin@insighta.dev",
    role:      "admin",
  });

  const analystUser = await upsertSeedUser({
    github_id: "seed_analyst_001",
    username:  "insighta_analyst",
    email:     "analyst@insighta.dev",
    role:      "analyst",
  });

  // Clean up any old seed refresh tokens to avoid clutter
  await query(
    "DELETE FROM refresh_tokens WHERE user_id = ANY($1)",
    [[adminUser.id, analystUser.id]]
  );

  // Generate tokens
  const adminAccessToken    = await generateAccessToken(adminUser);
  const adminRefreshToken   = await generateRefreshToken(adminUser.id);
  const analystAccessToken  = await generateAccessToken(analystUser);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("  Insighta Labs+ — Test Tokens");
  console.log("═══════════════════════════════════════════════════════════\n");

  console.log("Admin User:");
  console.log(`  ID:       ${adminUser.id}`);
  console.log(`  Username: ${adminUser.username}`);
  console.log(`  Role:     ${adminUser.role}\n`);

  console.log("Admin Test Token (access):");
  console.log(`  ${adminAccessToken}\n`);

  console.log("Analyst Test Token (access):");
  console.log(`  ${analystAccessToken}\n`);

  console.log("Refresh Test Token (paired with admin):");
  console.log(`  ${adminRefreshToken}\n`);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Paste these into the grader token form.");
  console.log("  Tokens expire in 24h.\n");

  await pool.end();
};

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
