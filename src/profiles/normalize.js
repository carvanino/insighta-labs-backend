// ---------------------------------------------------------------------------
// Query normalization
//
// Problem: "Nigerian females between 20 and 45" and "Women aged 20–45 in Nigeria"
// both parse to { gender: 'female', country_id: 'NG', min_age: 20, max_age: 45 }
// but could arrive with different key ordering, string casing, or numeric types,
// producing different cache keys for the same query.
//
// Solution: before caching or cache-key generation, normalize the filter object
// into a canonical form:
//   1. Extract only known filter keys
//   2. Coerce types (strings → lowercase, numerics → Number)
//   3. Apply missing pagination defaults
//   4. Serialize keys in a fixed alphabetical order
//
// Two filter objects with the same semantic meaning always produce the same key.
// ---------------------------------------------------------------------------

// Keys in the order they will appear in the cache key string.
// Alphabetical so the order is deterministic and independent of insertion order.
const ORDERED_KEYS = [
  'age_group',
  'country_id',
  'gender',
  'limit',
  'max_age',
  'min_age',
  'min_country_probability',
  'min_gender_probability',
  'order',
  'page',
  'sort_by',
];

const NUMERIC_KEYS = new Set([
  'limit', 'max_age', 'min_age',
  'min_country_probability', 'min_gender_probability', 'page',
]);

const STRING_KEYS = new Set([
  'age_group', 'country_id', 'gender', 'order', 'sort_by',
]);

// Defaults must match buildQuery() defaults so that an explicit default value
// and an omitted value produce the same cache key.
const DEFAULTS = {
  sort_by: 'created_at',
  order:   'asc',
  page:    1,
  limit:   10,
};

/**
 * Convert a raw query object (req.query, NLP output, or merged object) into
 * a canonical, type-safe filter object. The result is deterministic regardless
 * of how the query was expressed.
 *
 * @param {object} raw
 * @returns {object} canonical filter object
 */
export function normalizeFilters(raw) {
  const out = {};

  for (const key of ORDERED_KEYS) {
    const val = raw[key];
    if (val === undefined || val === null || val === '') continue;

    if (NUMERIC_KEYS.has(key)) {
      const n = Number(val);
      if (Number.isFinite(n)) out[key] = n;
    } else if (STRING_KEYS.has(key)) {
      out[key] = String(val).toLowerCase().trim();
    }
  }

  // Apply defaults so that omitting a default and stating it explicitly are equivalent
  out.sort_by = out.sort_by ?? DEFAULTS.sort_by;
  out.order   = out.order   ?? DEFAULTS.order;
  out.page    = out.page    ?? DEFAULTS.page;
  out.limit   = out.limit   ?? DEFAULTS.limit;

  return out;
}

/**
 * Produce a deterministic cache key from a normalized filter object.
 * Example: "profiles:age_group=adult&country_id=NG&gender=female&limit=10&order=asc&page=1&sort_by=created_at"
 *
 * @param {object} normalized — output of normalizeFilters()
 * @returns {string}
 */
export function makeCacheKey(normalized) {
  const parts = ORDERED_KEYS
    .filter((k) => normalized[k] !== undefined)
    .map((k) => `${k}=${normalized[k]}`);
  return `profiles:${parts.join('&')}`;
}
