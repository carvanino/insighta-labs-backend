// ---------------------------------------------------------------------------
// CSV ingestion — streaming, chunked, non-blocking
//
// Design decisions:
//
// 1. Streaming: busboy (in the router) hands us a raw Node.js Readable stream.
//    We pipe it through csv-parse in streaming mode. The file is never fully
//    buffered in memory — rows are processed as they arrive.
//
// 2. Batch inserts: rows are accumulated in a buffer (BATCH_SIZE = 1000).
//    When full, a single parameterised INSERT with multiple value tuples is
//    executed. This is ~50–100x faster than individual INSERTs at scale.
//
// 3. ON CONFLICT (name) DO NOTHING: duplicate detection is delegated to the
//    DB unique constraint. No pre-check query per row, no locking.
//    rowCount from the INSERT tells us how many were actually written.
//
// 4. Non-blocking: after each batch INSERT we yield the event loop via
//    setImmediate. This allows pending read queries to run between batches
//    and prevents upload throughput from starving concurrent readers.
//
// 5. Failure isolation: a single bad row is skipped with a tracked reason.
//    A batch INSERT error is logged and skipped — rows already inserted remain.
//    The promise always resolves (never rejects) with the partial stats.
// ---------------------------------------------------------------------------

import { parse } from "csv-parse";
import { v7 as uuid } from "uuid";
import { query } from "../db/index.js";

const BATCH_SIZE = 1000;

const VALID_GENDERS    = new Set(["male", "female"]);
const VALID_AGE_GROUPS = new Set(["child", "teenager", "adult", "senior"]);

const REQUIRED_COLUMNS = [
  "name", "gender", "gender_probability", "age",
  "age_group", "country_id", "country_name", "country_probability",
];

// ── Row validation ────────────────────────────────────────────────────────────

function validateRow(raw) {
  // Wrong column count — relax_column_count means extra/fewer columns don't throw,
  // but we still check required fields are present and non-empty.
  for (const col of REQUIRED_COLUMNS) {
    if (!raw[col] || String(raw[col]).trim() === "") {
      return { valid: false, reason: "missing_fields" };
    }
  }

  const name = String(raw.name).trim().toLowerCase();
  if (!name) return { valid: false, reason: "missing_fields" };

  const gender = String(raw.gender).trim().toLowerCase();
  if (!VALID_GENDERS.has(gender)) return { valid: false, reason: "invalid_gender" };

  const gender_probability = parseFloat(raw.gender_probability);
  if (!Number.isFinite(gender_probability) || gender_probability < 0 || gender_probability > 1) {
    return { valid: false, reason: "invalid_probability" };
  }

  const age = parseInt(raw.age, 10);
  if (!Number.isFinite(age) || age < 0 || age > 150) {
    return { valid: false, reason: "invalid_age" };
  }

  const age_group = String(raw.age_group).trim().toLowerCase();
  if (!VALID_AGE_GROUPS.has(age_group)) return { valid: false, reason: "invalid_age_group" };

  const country_id = String(raw.country_id).trim().toUpperCase();
  if (!country_id || country_id.length !== 2) return { valid: false, reason: "invalid_country" };

  const country_name = String(raw.country_name).trim();
  if (!country_name) return { valid: false, reason: "missing_fields" };

  const country_probability = parseFloat(raw.country_probability);
  if (!Number.isFinite(country_probability) || country_probability < 0 || country_probability > 1) {
    return { valid: false, reason: "invalid_probability" };
  }

  return {
    valid: true,
    row: {
      id: uuid(),
      name,
      gender,
      gender_probability,
      age,
      age_group,
      country_id,
      country_name,
      country_probability,
    },
  };
}

// ── Batch insert ──────────────────────────────────────────────────────────────

async function insertBatch(rows) {
  if (rows.length === 0) return { inserted: 0, duplicates: 0 };

  const valueClauses = [];
  const params       = [];
  let   idx          = 1;

  for (const row of rows) {
    valueClauses.push(
      `($${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++},$${idx++})`
    );
    params.push(
      row.id, row.name, row.gender, row.gender_probability,
      row.age, row.age_group, row.country_id, row.country_name, row.country_probability
    );
  }

  const sql = `
    INSERT INTO profiles
      (id, name, gender, gender_probability, age, age_group,
       country_id, country_name, country_probability)
    VALUES ${valueClauses.join(", ")}
    ON CONFLICT (name) DO NOTHING
  `;

  const result = await query(sql, params);
  const inserted   = result.rowCount ?? 0;
  const duplicates = rows.length - inserted;
  return { inserted, duplicates };
}

// Yield to the event loop so pending read queries can run between batches
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Process a CSV file stream from a multipart upload.
 *
 * @param {import('stream').Readable} fileStream
 * @returns {Promise<{ total_rows, inserted, skipped, reasons }>}
 */
export function processCSVStream(fileStream) {
  return new Promise((resolve) => {
    const stats = {
      total_rows: 0,
      inserted:   0,
      skipped:    0,
      reasons:    {},
    };

    const trackSkip = (reason) => {
      stats.skipped++;
      stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
    };

    const parser = parse({
      columns:              true,  // treat first row as header
      skip_empty_lines:     true,
      trim:                 true,
      relax_column_count:   true,  // malformed column counts → skip, not throw
      encoding:             "utf8",
    });

    let batch         = [];
    let flushing      = false;
    let parserEnded   = false;

    const finalize = async () => {
      if (batch.length > 0) {
        try {
          const { inserted, duplicates } = await insertBatch(batch);
          stats.inserted += inserted;
          if (duplicates > 0) {
            stats.reasons.duplicate_name = (stats.reasons.duplicate_name ?? 0) + duplicates;
            stats.skipped += duplicates;
          }
        } catch (err) {
          console.error("[ingest] final batch error:", err.message);
        }
      }
      resolve(stats);
    };

    const flushBatch = async () => {
      if (flushing || batch.length === 0) return;
      flushing = true;

      const toInsert = batch.splice(0, BATCH_SIZE);
      parser.pause();

      try {
        const { inserted, duplicates } = await insertBatch(toInsert);
        stats.inserted += inserted;
        if (duplicates > 0) {
          stats.reasons.duplicate_name = (stats.reasons.duplicate_name ?? 0) + duplicates;
          stats.skipped += duplicates;
        }
      } catch (err) {
        // Batch error — log and continue. Already-inserted rows stay.
        console.error("[ingest] batch error:", err.message);
        stats.skipped    += toInsert.length;
        stats.reasons.batch_error = (stats.reasons.batch_error ?? 0) + toInsert.length;
      }

      await yieldToEventLoop(); // let reads through
      flushing = false;

      if (parserEnded && batch.length === 0) {
        resolve(stats);
      } else {
        parser.resume();
      }
    };

    parser.on("readable", () => {
      let record;
      while ((record = parser.read()) !== null) {
        stats.total_rows++;

        const { valid, row, reason } = validateRow(record);
        if (!valid) {
          trackSkip(reason);
          continue;
        }

        batch.push(row);

        if (batch.length >= BATCH_SIZE) {
          flushBatch(); // async — parser will be paused inside
        }
      }
    });

    parser.on("end", async () => {
      parserEnded = true;
      if (!flushing) {
        await finalize();
      }
      // If flushing is in progress, finalize will be called when it completes
    });

    parser.on("error", async (err) => {
      console.error("[ingest] parser error:", err.message);
      parserEnded = true;
      // Flush whatever we have
      await finalize();
    });

    fileStream.on("error", async (err) => {
      console.error("[ingest] stream error:", err.message);
      parserEnded = true;
      await finalize();
    });

    fileStream.pipe(parser);
  });
}
