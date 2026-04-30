import axios from "axios";
import { SignJWT } from "jose";
import { randomBytes } from "crypto";
import { TextEncoder } from "util";
import { v7 as uuid } from "uuid";
import { URLSearchParams } from "url";
import { query } from "../db/index.js";

// In-memory state store — { state: expiresAt }
const pendingStates = new Map();
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// State format: "<randomHex>" for web, "<randomHex>:<cli_port>" for CLI
export const generateState = (cli_port = null) => {
  const random = randomBytes(16).toString("hex");
  const state  = cli_port ? `${random}:${cli_port}` : random;
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
};

// Returns { valid: boolean, cli_port: string|null }
export const validateState = (state) => {
  const expiresAt = pendingStates.get(state);
  if (!expiresAt || Date.now() > expiresAt) return { valid: false, cli_port: null };
  pendingStates.delete(state);
  const parts    = state.split(":");
  const cli_port = parts.length === 2 ? parts[1] : null;
  return { valid: true, cli_port };
};


export const getRedirectURL = (cli_port = null) => {
  const state  = generateState(cli_port);
  const params = new URLSearchParams({
    client_id:    process.env.GITHUB_CLIENT_ID,
    redirect_uri: process.env.GITHUB_CALLBACK_URL,
    scope:        "read:user user:email",
    state,
  });
  return `${process.env.GITHUB_OAUTH_URL}?${params.toString()}`;
};

const getGitHubUser = async (token) => {
  const response = await axios.get("https://api.github.com/user", {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
    },
  });

  return response.data;
};

const getGitHubUserEmail = async (token) => {
  const response = await axios.get("https://api.github.com/user/emails", {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/json",
    },
  });

  const primaryEmail = response.data.find((email) => email.primary);
  return primaryEmail ? primaryEmail.email : null;
}

export const exchangeCodeForToken = async (code) => {
  const params = {
    client_id: process.env.GITHUB_CLIENT_ID,
    client_secret: process.env.GITHUB_CLIENT_SECRET,
    code,
    redirect_uri: process.env.GITHUB_CALLBACK_URL,
    // code_verifier: code, // For PKCE flow, if implemented
  };

  const headers = {
    Accept: "application/json",
  };

  const response = await axios.post("https://github.com/login/oauth/access_token", params, {
    headers
  });

  if (response.data.error) {
    throw new Error(response.data.error_description || "Failed to exchange code for token");
  }

  const accessToken = response.data.access_token;
  const githubUser = await getGitHubUser(accessToken);
  const email = await getGitHubUserEmail(accessToken);
  githubUser.email = email;

  return { accessToken, githubUser };
}

const getUserByGitHubId = async (githubId) => {
  const result = await query("SELECT * FROM users WHERE github_id = $1", [githubId]);
  return result.rows[0];
};

const createUserFromGitHub = async (githubUser) => {
  const { id: githubId, login: username, email, avatar_url } = githubUser;
  const userId = uuid();
  const result = await query(
    `INSERT INTO users (id, github_id, username, email, avatar_url)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *`,
    [userId, githubId, username, email, avatar_url]
  );
  return result.rows[0];
};

const updateLastLogin = async (userId, username, email, avatar_url) => {
  await query(
    `UPDATE users SET username=$2, email=$3, avatar_url=$4, last_login_at=NOW() WHERE id=$1`,
    [userId, username, email, avatar_url]
  );
};

export const findOrCreateUser = async (githubUser) => {
  let user = await getUserByGitHubId(githubUser.id);
  if (!user) {
    user = await createUserFromGitHub(githubUser);
  } else {
    await updateLastLogin(user.id, githubUser.login, githubUser.email, githubUser.avatar_url);
    // Re-fetch so the returned object reflects the updated fields
    user = await getUserByGitHubId(githubUser.id);
  }
  return user;
};

// JWT generation using jose library -----------------------------------------
const generateJWT = async (user) => {
  const payload = {
    sub: user.id,
    username: user.username,
    role: user.role,
  };

  const secretKey = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET);
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${process.env.ACCESS_TOKEN_EXPIRY}s`)
    .sign(secretKey);

  return token;
};

export const generateAuthToken = async (user) => {
  return await generateJWT(user);
};

export const generateAndSaveRefreshToken = async (userId) => {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + Number(process.env.REFRESH_TOKEN_EXPIRY) * 1000);

  await query(
    `INSERT INTO refresh_tokens (id, user_id, token, expires_at)
    VALUES ($1, $2, $3, $4)`,
    [uuid(), userId, token, expiresAt]
  );

  return token;
};

export const refreshAuthToken = async (refreshToken) => {
  const tokenRecord = await validateRefreshToken(refreshToken);
  if (!tokenRecord) {
    throw new Error("Invalid or expired refresh token");
  }

  const userResult = await query(`SELECT * FROM users WHERE id = $1`, [tokenRecord.user_id]);
  const user = userResult.rows[0];
  if (!user) {
    throw new Error("User not found for refresh token");
  }

  const accessToken = await generateAuthToken(user);
  const newRefreshToken = await generateAndSaveRefreshToken(user.id);
  await revokeRefreshToken(refreshToken);

  return { accessToken, newRefreshToken };
};

export const validateRefreshToken = async (token) => {
  const result = await query(
    `SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()`,
    [token]
  );
  return result.rows[0];
};

export const revokeRefreshToken = async (token) => {
  await query(`DELETE FROM refresh_tokens WHERE token = $1`, [token]);
};