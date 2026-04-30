// ---------------------------------------------------------------------------
// Profile Service
// Handles:
//  - External API calls (Genderize / Agify / Nationalize)
//  - Query building (filters, sorting, pagination)
//  - DB operations
// ---------------------------------------------------------------------------
import axios from "axios";
import { v7 as uuid } from "uuid";
import { URLSearchParams } from "url";

import { query } from "../db/index.js";
import { ApiError, classifyAgeGroup, formatProfile } from "../utils.js";

// ── ISO-3166-1 alpha-2 → full country name ──────────────────────────────────
export const ISO_TO_NAME = {
  NG: "Nigeria", GH: "Ghana", BJ: "Benin",
  TG: "Togo", CI: "Côte d'Ivoire", SN: "Senegal",
  ML: "Mali", GW: "Guinea-Bissau", GQ: "Equatorial Guinea",
  GN: "Guinea", SL: "Sierra Leone", LR: "Liberia",
  GM: "Gambia", BF: "Burkina Faso", NE: "Niger",
  MR: "Mauritania", CV: "Cape Verde", ET: "Ethiopia",
  KE: "Kenya", TZ: "Tanzania", UG: "Uganda",
  RW: "Rwanda", BI: "Burundi", SO: "Somalia",
  DJ: "Djibouti", ER: "Eritrea", CM: "Cameroon",
  CF: "Central African Republic", TD: "Chad", GA: "Gabon",
  CG: "Republic of Congo", CD: "Democratic Republic of Congo",
  ST: "São Tomé and Príncipe",
  ZA: "South Africa", AO: "Angola", MZ: "Mozambique",
  ZW: "Zimbabwe", ZM: "Zambia", MW: "Malawi",
  NA: "Namibia", BW: "Botswana", LS: "Lesotho",
  SZ: "Eswatini", MG: "Madagascar", KM: "Comoros",
  MU: "Mauritius", SC: "Seychelles", EG: "Egypt",
  MA: "Morocco", DZ: "Algeria", TN: "Tunisia",
  LY: "Libya", SD: "Sudan", SS: "South Sudan",
  US: "United States", GB: "United Kingdom", FR: "France",
  DE: "Germany", IT: "Italy", ES: "Spain",
  PT: "Portugal", NL: "Netherlands", BE: "Belgium",
  CH: "Switzerland", AT: "Austria", SE: "Sweden",
  NO: "Norway", DK: "Denmark", FI: "Finland",
  PL: "Poland", RU: "Russia", UA: "Ukraine",
  TR: "Turkey", GR: "Greece", BR: "Brazil",
  AR: "Argentina", CO: "Colombia", CL: "Chile",
  PE: "Peru", MX: "Mexico", CA: "Canada",
  AU: "Australia", NZ: "New Zealand", IN: "India",
  CN: "China", JP: "Japan", KR: "South Korea",
  ID: "Indonesia", MY: "Malaysia", PH: "Philippines",
  VN: "Vietnam", TH: "Thailand", PK: "Pakistan",
  BD: "Bangladesh", SA: "Saudi Arabia", AE: "United Arab Emirates",
  IR: "Iran", IQ: "Iraq", IL: "Israel",
};

// ── External API helpers ────────────────────────────────────────────────────

const makeAPIRequest = async (url, name, apiName) => {
  if (!url) throw new ApiError(500, "Internal server error");
  try {
    const { status, data } = await axios.get(url, {
      timeout: 15_000,
      params: { name },
    });
    if (status !== 200 || !data || typeof data !== "object") {
      throw new ApiError(502, `${apiName} returned an invalid response`);
    }
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, `${apiName} returned an invalid response`);
  }
};

export const getGenderPrediction = async (name) => {
  const data = await makeAPIRequest(
    process.env.GENDERIZE_URL, name, "Genderize"
  );
  if (!data.gender || Number(data.count) === 0) {
    throw new ApiError(502, "Genderize returned an invalid response");
  }
  return { gender: data.gender, gender_probability: data.probability };
};

export const getAgePrediction = async (name) => {
  const data = await makeAPIRequest(process.env.AGIFY_URL, name, "Agify");
  if (data.age === null) {
    throw new ApiError(502, "Agify returned an invalid response");
  }
  return { age: data.age, age_group: classifyAgeGroup(data.age) };
};

export const getCountryPrediction = async (name) => {
  const data = await makeAPIRequest(
    process.env.NATIONALIZE_URL, name, "Nationalize"
  );
  const countries = Array.isArray(data.country) ? data.country : [];
  if (countries.length === 0) {
    throw new ApiError(502, "Nationalize returned an invalid response");
  }
  const top = countries.reduce((best, c) =>
    !best || c.probability > best.probability ? c : best, null
  );
  return {
    country_id: top.country_id,
    country_name: ISO_TO_NAME[top.country_id] ?? top.country_id,
    country_probability: top.probability,
  };
};

// ── Query builder ────────────────────────────────────────────────────────────

const VALID_SORT_BY = new Set(["age", "created_at", "gender_probability"]);
const VALID_ORDER = new Set(["asc", "desc"]);
const VALID_GENDER = new Set(["male", "female"]);
const VALID_GROUP = new Set(["child", "teenager", "adult", "senior"]);

/**
 * Validate + compile query params (or pre-parsed NLP filters) into SQL
 * strings and parameter arrays ready for pg.
 *
 * @param {object} rawQuery – req.query or NLP-parsed filters merged with pagination
 * @returns {{ countSql, dataSql, countParams, dataParams, page, limit }}
 */
export function buildQuery(rawQuery) {
  const {
    gender,
    age_group,
    country_id,
    min_age,
    max_age,
    min_gender_probability,
    min_country_probability,
    sort_by = "created_at",
    order = "asc",
    page = "1",
    limit = "10",
  } = rawQuery;

  if (!VALID_SORT_BY.has(sort_by)) throw new ApiError(400, "Invalid query parameters");
  if (!VALID_ORDER.has(order)) throw new ApiError(400, "Invalid query parameters");

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);

  if (!Number.isFinite(pageNum) || pageNum < 1) throw new ApiError(422, "Invalid query parameters");
  if (!Number.isFinite(limitNum) || limitNum < 1 || limitNum > 50) throw new ApiError(422, "Invalid query parameters");

  const conditions = [];
  const baseParams = [];
  let idx = 1;

  const push = (condition, value) => {
    conditions.push(condition.replace("?", `$${idx++}`));
    baseParams.push(value);
  };

  if (gender !== undefined) {
    const g = String(gender).toLowerCase();
    if (!VALID_GENDER.has(g)) throw new ApiError(422, "Invalid query parameters");
    push("gender = ?", g);
  }

  if (age_group !== undefined) {
    const ag = String(age_group).toLowerCase();
    if (!VALID_GROUP.has(ag)) throw new ApiError(422, "Invalid query parameters");
    push("age_group = ?", ag);
  }

  if (country_id !== undefined) {
    push("country_id = ?", String(country_id).toUpperCase());
  }

  if (min_age !== undefined) {
    const v = Number(min_age);
    if (!Number.isFinite(v)) throw new ApiError(422, "Invalid query parameters");
    push("age >= ?", v);
  }

  if (max_age !== undefined) {
    const v = Number(max_age);
    if (!Number.isFinite(v)) throw new ApiError(422, "Invalid query parameters");
    push("age <= ?", v);
  }

  if (min_gender_probability !== undefined) {
    const v = Number(min_gender_probability);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new ApiError(422, "Invalid query parameters");
    push("gender_probability >= ?", v);
  }

  if (min_country_probability !== undefined) {
    const v = Number(min_country_probability);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new ApiError(422, "Invalid query parameters");
    push("country_probability >= ?", v);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countSql = `SELECT COUNT(*) FROM profiles ${where}`;
  const dataSql = `
    SELECT * FROM profiles
    ${where}
    ORDER BY ${sort_by} ${order.toUpperCase()}
    LIMIT $${idx} OFFSET $${idx + 1}
  `;

  const offset = (pageNum - 1) * limitNum;

  return {
    countSql,
    dataSql,
    countParams: baseParams,
    dataParams: [...baseParams, limitNum, offset],
    page: pageNum,
    limit: limitNum,
  };
}

class Links {
  constructor(baseUrl, query, current, limit, totalPages) {
    this.baseUrl = baseUrl.split('?')[0]; // Strip existing query string
    this.query = query;
    this.current = current;
    this.limit = limit;
    this.totalPages = totalPages;
  }

  getLinks() {
    const buildUrl = (p) => {
      const params = new URLSearchParams(this.query);
      params.set('page', p);
      params.set('limit', this.limit);
      return `${this.baseUrl}?${params.toString()}`;
    };

    return {
      self: buildUrl(this.current),
      next: this.current < this.totalPages ? buildUrl(this.current + 1) : null,
      prev: this.current > 1 ? buildUrl(this.current - 1) : null,
    };
  }
}

// ── DB operations ────────────────────────────────────────────────────────────

/**
 * Fetch a paginated + filtered list of profiles.
 */
export async function listProfiles(rawQuery, baseUrl = '/api/profiles', linkQuery = null) {
  const { countSql, dataSql, countParams, dataParams, page, limit } =
    buildQuery(rawQuery);

  const [countResult, dataResult] = await Promise.all([
    query(countSql, countParams),
    query(dataSql, dataParams),
  ]);

  const total = parseInt(countResult.rows[0].count, 10);
  const total_pages = Math.ceil(total / limit);

  // Use linkQuery for URL building if provided (e.g. search passes req.query to preserve `q`)
  const linksObj = new Links(baseUrl, linkQuery ?? rawQuery, page, limit, total_pages);
  const links = linksObj.getLinks();

  return { rows: dataResult.rows.map(formatProfile), total, page, limit, total_pages, links };
}

/**
 * Fetch a single profile by id.
 */
export async function getProfileById(id) {
  const result = await query("SELECT * FROM profiles WHERE id = $1", [id]);
  if (!result.rows.length) throw new ApiError(404, "Profile not found");
  return formatProfile(result.rows[0]);
}

/**
 * Create a profile by calling all three external APIs and inserting into DB.
 * Returns the existing profile (without calling APIs) if the name already exists.
 */
export async function createProfile(rawName) {
  if (rawName === undefined || rawName === null)
    throw new ApiError(400, "Missing or empty name");
  if (typeof rawName !== "string")
    throw new ApiError(422, "Invalid type");

  const name = rawName.trim().toLowerCase();
  if (!name) throw new ApiError(400, "Missing or empty name");

  const existing = await query("SELECT * FROM profiles WHERE name = $1", [name]);
  if (existing.rows.length) {
    return { profile: formatProfile(existing.rows[0]), created: false };
  }

  const [genderData, ageData, countryData] = await Promise.all([
    getGenderPrediction(name),
    getAgePrediction(name),
    getCountryPrediction(name),
  ]);

  const id = uuid();
  const result = await query(
    `INSERT INTO profiles
       (id, name, gender, gender_probability, age, age_group,
        country_id, country_name, country_probability)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      id, name,
      genderData.gender, genderData.gender_probability,
      ageData.age, ageData.age_group,
      countryData.country_id, countryData.country_name, countryData.country_probability,
    ]
  );

  return { profile: formatProfile(result.rows[0]), created: true };
}

/**
 * Fetch all matching profiles for CSV export — no pagination.
 * Reuses buildQuery for WHERE clause then runs an unbounded query.
 */
export async function exportProfiles(rawQuery) {
  const { sort_by = "created_at", order = "asc" } = rawQuery;

  // buildQuery requires valid page/limit — we only need the WHERE clause + params
  const { countSql, countParams } = buildQuery({ ...rawQuery, page: "1", limit: "50" });

  const where = countSql.replace("SELECT COUNT(*) FROM profiles", "").trim();
  const sql = `SELECT * FROM profiles ${where} ORDER BY ${sort_by} ${order.toUpperCase()}`;

  const result = await query(sql, countParams);
  return result.rows.map(formatProfile);
}

/**
 * Delete a profile by id.
 */
export async function deleteProfile(id) {
  const result = await query("DELETE FROM profiles WHERE id = $1", [id]);
  if (result.rowCount === 0) throw new ApiError(404, "Profile not found");
}
