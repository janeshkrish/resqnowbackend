import { createServer } from "node:http";

// Used for both the API and workers during the schema cutover. This process
// deliberately imports no application modules, database driver or queue client.
const server = createServer((request, response) => {
  const probe = ["/", "/health", "/ready"].includes(new URL(request.url, "http://localhost").pathname);
  response.writeHead(probe ? 200 : 503, { "Content-Type": "application/json", "Retry-After": "30", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ maintenance: true, revision: process.env.RAILWAY_GIT_COMMIT_SHA || process.env.RENDER_GIT_COMMIT || "", message: "Database migration is in progress. Please retry shortly." }));
});
server.listen(Number(process.env.PORT || 5000), "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
