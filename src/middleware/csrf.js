// Validates CSRF token on mutating requests from the web portal.
// The portal reads the csrf_token cookie and sends it back as X-CSRF-Token header.
// Skip for CLI requests (Authorization header present = CLI, not cookie-based).

export const csrfProtection = (req, res, next) => {
  // CLI uses Bearer token — skip CSRF for those requests
  if (req.headers.authorization?.startsWith("Bearer ")) return next();

  // Only enforce on mutating methods
  const mutating = ["POST", "PUT", "PATCH", "DELETE"];
  if (!mutating.includes(req.method)) return next();

  const cookieToken  = req.cookies?.csrf_token;
  const headerToken  = req.headers["x-csrf-token"];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ status: "error", message: "Invalid CSRF token" });
  }

  next();
};
