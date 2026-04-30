/**
 * Rule-based Natural Language Query Parser
 * No AI / LLMs are used. All parsing is deterministic keyword matching.
 *
 * Unchanged from Stage 2.
 */

// ---------------------------------------------------------------------------
// Country lookup: name (lowercase) → ISO-3166-1 alpha-2 code
// Entries are sorted longest-first at build time so that multi-word names
// (e.g. "south africa", "ivory coast") match before single-word substrings.
// ---------------------------------------------------------------------------
const COUNTRY_NAME_TO_CODE = {
  // Africa – West
  nigeria: "NG",          ghana: "GH",         benin: "BJ",
  togo: "TG",             "ivory coast": "CI", "cote d'ivoire": "CI",
  "côte d'ivoire": "CI",  senegal: "SN",        mali: "ML",
  "guinea bissau": "GW",  "guinea-bissau": "GW","equatorial guinea": "GQ",
  guinea: "GN",           "sierra leone": "SL", liberia: "LR",
  gambia: "GM",           "the gambia": "GM",   "burkina faso": "BF",
  niger: "NE",            mauritania: "MR",      "cape verde": "CV",
  // Africa – East
  ethiopia: "ET",  kenya: "KE",     tanzania: "TZ",  uganda: "UG",
  rwanda: "RW",   burundi: "BI",   somalia: "SO",   djibouti: "DJ",
  eritrea: "ER",
  // Africa – Central
  cameroon: "CM",                    "central african republic": "CF",
  chad: "TD",                        gabon: "GA",
  "republic of congo": "CG",         "democratic republic of congo": "CD",
  "dr congo": "CD",                  drc: "CD",
  congo: "CG",                       "sao tome": "ST",
  "são tomé": "ST",
  // Africa – Southern
  "south africa": "ZA",  angola: "AO",      mozambique: "MZ",
  zimbabwe: "ZW",         zambia: "ZM",      malawi: "MW",
  namibia: "NA",          botswana: "BW",    lesotho: "LS",
  eswatini: "SZ",         swaziland: "SZ",   madagascar: "MG",
  comoros: "KM",          mauritius: "MU",   seychelles: "SC",
  // Africa – North
  egypt: "EG",   morocco: "MA",  algeria: "DZ",
  tunisia: "TN", libya: "LY",    sudan: "SD",    "south sudan": "SS",
  // Global
  "united states": "US",           "united states of america": "US",
  usa: "US",                        "united kingdom": "GB",
  "great britain": "GB",            england: "GB",
  uk: "GB",                         france: "FR",
  germany: "DE",                    italy: "IT",
  spain: "ES",                      portugal: "PT",
  netherlands: "NL",                belgium: "BE",
  switzerland: "CH",                austria: "AT",
  sweden: "SE",                     norway: "NO",
  denmark: "DK",                    finland: "FI",
  poland: "PL",                     russia: "RU",
  ukraine: "UA",                    turkey: "TR",
  greece: "GR",                     brazil: "BR",
  argentina: "AR",                  colombia: "CO",
  chile: "CL",                      peru: "PE",
  mexico: "MX",                     canada: "CA",
  australia: "AU",                  "new zealand": "NZ",
  india: "IN",                      china: "CN",
  japan: "JP",                      "south korea": "KR",
  korea: "KR",                      indonesia: "ID",
  malaysia: "MY",                   philippines: "PH",
  vietnam: "VN",                    thailand: "TH",
  pakistan: "PK",                   bangladesh: "BD",
  "saudi arabia": "SA",             "united arab emirates": "AE",
  uae: "AE",                        iran: "IR",
  iraq: "IQ",                       israel: "IL",
};

// Pre-sort entries longest-first so multi-word country names match before
// any single-word substring they contain (e.g. "south africa" before "africa").
const SORTED_COUNTRY_ENTRIES = Object.entries(COUNTRY_NAME_TO_CODE).sort(
  (a, b) => b[0].length - a[0].length
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MALE_RE   = /\b(males?|men|man)\b/;
const FEMALE_RE = /\b(females?|women|woman)\b/;

const AGE_GROUP_PATTERNS = [
  [/\b(children|child|kids?)\b/,         "child"],
  [/\b(teenagers?|teens?)\b/,            "teenager"],
  [/\b(adults?)\b/,                      "adult"],
  [/\b(seniors?|elderly|elders?)\b/,     "senior"],
];

const ABOVE_RE   = /\b(?:above|over|older than|at least)\s+(\d+)\b/;
const BELOW_RE   = /\b(?:below|under|younger than|at most)\s+(\d+)\b/;
const BETWEEN_RE = /\bbetween\s+(\d+)\s+and\s+(\d+)\b/;
const AGED_RE    = /\baged?\s+(\d+)\b/;

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

/**
 * Parse a plain-English query string into a filter object compatible with
 * the profiles query builder.
 *
 * Returns `null` when no recognisable intent can be extracted.
 *
 * @param {string} rawQuery
 * @returns {{ gender?, age_group?, country_id?, min_age?, max_age? } | null}
 */
export function parseNaturalLanguage(rawQuery) {
  if (!rawQuery || typeof rawQuery !== "string") return null;

  const q = rawQuery.toLowerCase().trim();
  if (!q) return null;

  const filters = {};

  // ── Gender ─────────────────────────────────────────────────────────────
  const hasMale   = MALE_RE.test(q);
  const hasFemale = FEMALE_RE.test(q);

  if (hasMale && !hasFemale)        filters.gender = "male";
  else if (hasFemale && !hasMale)   filters.gender = "female";

  // ── Age group ──────────────────────────────────────────────────────────
  const hasYoung = /\byoung\b/.test(q);

  if (!hasYoung) {
    for (const [re, group] of AGE_GROUP_PATTERNS) {
      if (re.test(q)) { filters.age_group = group; break; }
    }
  }

  // ── Numeric age bounds ─────────────────────────────────────────────────
  if (hasYoung) {
    filters.min_age = 16;
    filters.max_age = 24;
  }

  const betweenMatch = BETWEEN_RE.exec(q);
  if (betweenMatch) {
    filters.min_age = parseInt(betweenMatch[1], 10);
    filters.max_age = parseInt(betweenMatch[2], 10);
  } else {
    const aboveMatch = ABOVE_RE.exec(q);
    if (aboveMatch) filters.min_age = parseInt(aboveMatch[1], 10);

    const belowMatch = BELOW_RE.exec(q);
    if (belowMatch) filters.max_age = parseInt(belowMatch[1], 10);
  }

  if (!betweenMatch && !ABOVE_RE.test(q) && !BELOW_RE.test(q) && !hasYoung) {
    const agedMatch = AGED_RE.exec(q);
    if (agedMatch) {
      const n = parseInt(agedMatch[1], 10);
      filters.min_age = n;
      filters.max_age = n;
    }
  }

  // ── Country ─────────────────────────────────────────────────────────────
  for (const [name, code] of SORTED_COUNTRY_ENTRIES) {
    if (q.includes(name)) { filters.country_id = code; break; }
  }

  // ── Interpretability check ──────────────────────────────────────────────
  if (Object.keys(filters).length === 0) return null;

  return filters;
}
