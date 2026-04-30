// ---------------------------------------------------------------------------
// Profiles router — /api/profiles/*
// All Stage 2 endpoints preserved exactly.
// ---------------------------------------------------------------------------
import { Router } from "express";

import { parseNaturalLanguage } from "../nlp.js";
import { sendError } from "../utils.js";
import {
  listProfiles,
  getProfileById,
  createProfile,
  deleteProfile,
  exportProfiles,
} from "./service.js";
import authorize from "../middleware/authorize.js";

const router = Router();

// ── GET /api/profiles ────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { rows, total, page, limit, total_pages, links } = await listProfiles(req.query, req.path);

    return res.status(200).json({
      status: "success",
      page,
      limit,
      total,
      total_pages,
      data: rows,
      links,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// ── GET /api/profiles/export ─────────────────────────────────────────────────
router.get("/export", async (req, res) => {
  try {
    const { format = "csv" } = req.query;

    if (format !== "csv") {
      return res.status(400).json({ status: "error", message: "Only format=csv is supported" });
    }

    const rows = await exportProfiles(req.query);

    const columns = [
      "id", "name", "gender", "gender_probability",
      "age", "age_group", "country_id", "country_name",
      "country_probability", "created_at",
    ];

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="profiles_${timestamp}.csv"`);

    // Header row
    res.write(columns.join(",") + "\n");

    // Data rows
    for (const row of rows) {
      const line = columns.map((col) => {
        const val = row[col] ?? "";
        // Wrap in quotes if value contains comma, quote, or newline
        const str = String(val);
        return str.includes(",") || str.includes('"') || str.includes("\n")
          ? `"${str.replace(/"/g, '""')}`
          : str;
      });
      res.write(line.join(",") + "\n");
    }

    res.end();
  } catch (err) {
    return sendError(res, err);
  }
});

// ── GET /api/profiles/search ──────────────────────────────────────────────────
router.get("/search", async (req, res) => {
  try {
    const { q, page, limit } = req.query;

    if (!q || !String(q).trim()) {
      return res
        .status(400)
        .json({ status: "error", message: "Missing or empty parameter" });
    }

    const nlpFilters = parseNaturalLanguage(q);

    if (!nlpFilters) {
      return res
        .status(200)
        .json({ status: "error", message: "Unable to interpret query" });
    }

    const merged = { ...nlpFilters };
    if (page !== undefined) merged.page = page;
    if (limit !== undefined) merged.limit = limit;

    const { rows, total, page: pageNum, limit: limitNum, total_pages, links } =
      await listProfiles(merged, req.path, req.query);

    return res.status(200).json({
      status: "success",
      page: pageNum,
      limit: limitNum,
      total,
      total_pages,
      data: rows,
      links,
    });
  } catch (err) {
    return sendError(res, err);
  }
});

// ── POST /api/profiles ────────────────────────────────────────────────────────
router.post("/", authorize('admin'), async (req, res) => {
  try {
    const { profile, created } = await createProfile(req.body?.name);

    if (!created) {
      return res.status(200).json({
        status: "success",
        message: "Profile already exists",
        data: profile,
      });
    }

    return res.status(201).json({ status: "success", data: profile });
  } catch (err) {
    return sendError(res, err);
  }
});

// ── GET /api/profiles/:id ─────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const profile = await getProfileById(req.params.id);
    return res.status(200).json({ status: "success", data: profile });
  } catch (err) {
    return sendError(res, err);
  }
});

// ── DELETE /api/profiles/:id ──────────────────────────────────────────────────
router.delete("/:id", authorize('admin'), async (req, res) => {
  try {
    await deleteProfile(req.params.id);
    return res.status(204).send();
  } catch (err) {
    return sendError(res, err);
  }
});

export default router;
