export function databaseReadiness(state) {
  return (req, res, next) => {
    if (state.ready || ["/health", "/ready"].includes(req.path)) return next();
    res.setHeader("Retry-After", "30");
    return res.status(503).json({ error: "Database initialization is in progress. Please retry shortly." });
  };
}
