// ---------------------------------------------------------------------------
// Entry point — starts the HTTP server
// ---------------------------------------------------------------------------
import { createServer } from "http";
import "dotenv/config";

import app from "./src/app.js";
import { initDB } from "./src/db/index.js";

const PORT = process.env.PORT ?? 3004;

const server = createServer(app);

initDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Insighta Labs+ backend listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialise database:", err.message);
    process.exit(1);
  });
