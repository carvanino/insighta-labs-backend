import { ApiError, sendError } from "../utils.js";

export default function authorize(requiredRole) {
  return (req, res, next) => {
    const rolesToCheck = Array.isArray(requiredRole) ? requiredRole : [requiredRole];

    if (requiredRole && !rolesToCheck.includes(req.user.role)) {
      return sendError(res, new ApiError(403, "Forbidden: Insufficient permissions"));
    }

    next();
  };
}   
