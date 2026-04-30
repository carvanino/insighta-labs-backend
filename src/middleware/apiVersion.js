import { ApiError, sendError } from "../utils.js";


export default async function apiVersion(req, res, next) {
  const version = req.headers["x-api-version"];
  if (!version) {
    return sendError(res, new ApiError(400, "API version header required"));
  }
  next();
}