// ---------------------------------------------------------------------------
// Shared utilities — used across profile service and other modules
// ---------------------------------------------------------------------------

/**
 * Structured API error — carries an HTTP status code.
 */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Send a normalised error response.
 * Logs unexpected (non-ApiError) failures to stderr.
 */
export const sendError = (res, error) => {
  if (error instanceof ApiError) {
    return res
      .status(error.status)
      .json({ status: "error", message: error.message });
  }
  console.error(error);
  return res
    .status(500)
    .json({ status: "error", message: "Internal server error" });
};

/**
 * Normalise a JS Date (or ISO string) to a UTC ISO-8601 string
 * without milliseconds: "2025-01-01T00:00:00Z"
 */
export const toUtcIso8601 = (date) =>
  (date instanceof Date ? date : new Date(date))
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

/**
 * Map an age number to a human-readable group label.
 */
export const classifyAgeGroup = (age) => {
  if (age <= 12) return "child";
  if (age <= 19) return "teenager";
  if (age <= 59) return "adult";
  return "senior";
};

/**
 * Serialise a DB row to the public profile shape.
 */
export const formatProfile = (row) => ({
  id:                  row.id,
  name:                row.name,
  gender:              row.gender,
  gender_probability:  row.gender_probability,
  age:                 row.age,
  age_group:           row.age_group,
  country_id:          row.country_id,
  country_name:        row.country_name,
  country_probability: row.country_probability,
  created_at:          toUtcIso8601(row.created_at),
});
