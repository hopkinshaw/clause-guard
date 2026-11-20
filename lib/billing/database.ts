import type { PoolConfig } from "pg";

const isNeon = (host: string) => host.toLowerCase().endsWith(".neon.tech");

const pooled = ["DATABASE_URL", "POSTGRES_URL"] as const;
const direct = ["DATABASE_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING"] as const;

export function postgresSource(env: Record<string, string | undefined> = process.env, preferDirect = false) {
  const keys = preferDirect ? [...direct, ...pooled] : [...pooled, ...direct];
  return keys.find(key => env[key]?.trim()) ?? (env.PGHOST?.trim() ? "PGHOST" : null);
}

export function postgresOptions(env: Record<string, string | undefined> = process.env, preferDirect = false): PoolConfig {
  const source = postgresSource(env, preferDirect);
  const connectionString = source && source !== "PGHOST" ? env[source]?.trim() : undefined;

  if (connectionString) {
    let url: URL;
    try {
      url = new URL(connectionString);
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error();
    } catch {
      throw new Error("Invalid Postgres connection URL");
    }
    if (isNeon(url.searchParams.get("host") ?? url.hostname)) {
      // Preserve credentials and connection parameters, and require verified TLS for Neon.
      url.searchParams.set("sslmode", "verify-full");
      return { connectionString: url.href, enableChannelBinding: url.searchParams.get("channel_binding") !== "disable" };
    }
    return { connectionString };
  }

  const host = env.PGHOST?.trim();
  if (!host) throw new Error("Postgres is not configured");
  const port = env.PGPORT ? Number(env.PGPORT) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("Invalid Postgres port");
  }
  return {
    host,
    user: env.PGUSER,
    database: env.PGDATABASE,
    password: env.PGPASSWORD,
    port,
    ...(isNeon(host) ? { ssl: true, enableChannelBinding: true } : {}),
  };
}
