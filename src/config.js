// Env-driven config for agy-gateway, mirroring plex/src/config.js's
// fail-fast style: a malformed value throws a clear Error naming the
// variable at startup instead of becoming NaN/undefined and misbehaving
// silently at request time. Unlike the plex module (which validates at
// import time into a singleton), this exports a loadConfig() function so
// tests can inject their own env object and .env loader.

const VALID_EFFORTS = new Set(["low", "medium", "high"]);

/**
 * Loads and validates the gateway's configuration.
 *
 * @param {{
 *   env?: Record<string, string|undefined>,
 *   envFilePath?: string,
 *   loadEnvFileImpl?: (path: string) => void,
 * }} [options]
 * @returns {{
 *   agyGatewayToken: string,
 *   port: number,
 *   agyPath: string,
 *   agyTimeoutMs: number,
 *   agyTimeoutMaxMs: number,
 *   agyMaxConcurrent: number,
 *   agyEffort: string,
 *   agySandbox: boolean,
 *   agyMaxBodyBytes: number,
 *   jobTtlMs: number,
 * }}
 */
export function loadConfig({
  env = process.env,
  envFilePath = ".env",
  loadEnvFileImpl = process.loadEnvFile,
} = {}) {
  // A missing .env is fine (systemd may inject the real env instead);
  // anything it did load lands in process.env, which is the default `env`.
  try {
    loadEnvFileImpl(envFilePath);
  } catch {
    // Tolerated: no .env file present.
  }

  function requiredString(name) {
    const value = env[name];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`Missing required environment variable: ${name}. Add it to .env before running.`);
    }
    return value;
  }

  function optionalString(name, fallback) {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    return value;
  }

  function optionalInt(name, fallback, { min = 1 } = {}) {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(value) || value < min) {
      throw new Error(`Invalid environment variable ${name}: ${JSON.stringify(raw)} is not an integer >= ${min}.`);
    }
    return value;
  }

  function optionalBool(name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`Invalid environment variable ${name}: ${JSON.stringify(raw)} (expected "true" or "false").`);
  }

  function optionalEnum(name, fallback, valid) {
    const value = optionalString(name, fallback);
    if (!valid.has(value)) {
      throw new Error(
        `Invalid environment variable ${name}: ${JSON.stringify(value)} (expected one of ${[...valid].join("|")}).`
      );
    }
    return value;
  }

  return {
    // The static bearer token every route except GET /health requires (KTD8).
    agyGatewayToken: requiredString("AGY_GATEWAY_TOKEN"),
    port: optionalInt("PORT", 8100),
    agyPath: (() => {
      const value = optionalString("AGY_PATH", "/root/.local/bin/agy");
      if (value.trim() === "") {
        throw new Error("Invalid environment variable AGY_PATH: must be a non-empty string.");
      }
      return value;
    })(),
    agyTimeoutMs: optionalInt("AGY_TIMEOUT_MS", 300_000),
    agyTimeoutMaxMs: optionalInt("AGY_TIMEOUT_MAX_MS", 900_000),
    agyMaxConcurrent: optionalInt("AGY_MAX_CONCURRENT", 3),
    agyEffort: optionalEnum("AGY_EFFORT", "high", VALID_EFFORTS),
    agySandbox: optionalBool("AGY_SANDBOX", false),
    agyMaxBodyBytes: optionalInt("AGY_MAX_BODY_BYTES", 1_048_576),
    jobTtlMs: optionalInt("JOB_TTL_MS", 86_400_000),
  };
}
