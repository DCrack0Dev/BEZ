// Prisma 7 config — datasource URL comes from env (Render Environment / .env locally)
import "dotenv/config";
import { defineConfig } from "prisma/config";

const url = (process.env.DATABASE_URL || "").trim();

if (!url) {
  // prisma migrate deploy fails with a vague message if url is undefined —
  // throw early so Render logs show the real fix.
  throw new Error(
    "DATABASE_URL is required for Prisma. Set it in Render → liquibot-back → Environment " +
      "(Internal Database URL from your Render Postgres)."
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url,
  },
});
