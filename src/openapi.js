// OpenAPI 3.1 spec for the gateway, built from the LIVE config so the
// published caps and defaults can never drift from what is actually
// enforced. Served unauthenticated at GET /openapi.json (like /health):
// on a trusted LAN, discoverability is the point -- the spec reveals the
// API's shape, never its token.

/**
 * @param {{ config: object, version: string }} params
 * @returns {object} an OpenAPI 3.1 document
 */
export function buildOpenApiSpec({ config, version }) {
  const errorKinds = ["bad-request", "timeout", "not-found", "exit", "bad-output", "agy-status"];

  const runFailure = {
    type: "object",
    description:
      "Typed failure shape returned by /run failures and stored on failed jobs. HTTP mapping: bad-request 400, timeout 504, not-found 503, exit/bad-output/agy-status 502.",
    properties: {
      ok: { const: false },
      errorKind: { type: "string", enum: errorKinds },
      message: { type: "string" },
      stderrTail: {
        type: "string",
        description: "Last ~2000 chars of agy's stderr, present when non-empty (failure detail lives here).",
      },
      durationMs: { type: "number" },
    },
    required: ["ok", "errorKind", "message"],
  };

  const runSuccess = {
    type: "object",
    properties: {
      ok: { const: true },
      agy: {
        type: "object",
        description:
          'agy\'s own response body (json mode). When a jsonSchema was supplied, trust structured_output -- response can carry extra prose.',
        properties: {
          conversation_id: { type: "string" },
          status: { const: "SUCCESS" },
          response: { type: "string" },
          structured_output: { description: "Present when a jsonSchema was supplied." },
          usage: { type: "object" },
        },
      },
      text: { type: "string", description: "Raw stdout (outputFormat text only; replaces agy)." },
      durationMs: { type: "number" },
    },
    required: ["ok", "durationMs"],
  };

  const runRequest = {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        maxLength: 100_000,
        description: "The prompt. Max 100,000 chars (agy receives it as a single CLI argument).",
      },
      effort: {
        type: "string",
        enum: ["low", "medium", "high"],
        default: config.agyEffort,
        description: "agy reasoning effort.",
      },
      outputFormat: {
        type: "string",
        enum: ["json", "text"],
        default: "json",
      },
      jsonSchema: {
        type: "string",
        maxLength: 100_000,
        description: "Inline JSON schema; agy enforces structured output into structured_output.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1,
        maximum: config.agyTimeoutMaxMs,
        default: config.agyTimeoutMs,
        description:
          "Total budget spanning queue wait plus execution; a request that expires while queued returns a timeout without ever starting agy.",
      },
    },
  };

  const job = {
    type: "object",
    properties: {
      jobId: { type: "string", format: "uuid" },
      state: { type: "string", enum: ["queued", "running", "succeeded", "failed"] },
      createdAt: { type: "integer", description: "Epoch ms." },
      startedAt: { type: "integer" },
      finishedAt: { type: "integer" },
      result: { $ref: "#/components/schemas/RunSuccess" },
      error: { $ref: "#/components/schemas/RunFailure" },
    },
    required: ["jobId", "state", "createdAt"],
  };

  const errorBody = {
    type: "object",
    properties: { ok: { const: false }, error: { type: "string" } },
    required: ["ok", "error"],
  };

  const security = [{ bearerAuth: [] }];
  const jsonBody = (schemaRef) => ({
    required: true,
    content: { "application/json": { schema: schemaRef } },
  });
  const jsonResponse = (description, schemaRef) => ({
    description,
    content: { "application/json": { schema: schemaRef } },
  });
  const failureResponses = {
    400: jsonResponse("Invalid request (bad-request errorKind or malformed body/fields)", { $ref: "#/components/schemas/RunFailure" }),
    401: jsonResponse("Missing or wrong bearer token", { $ref: "#/components/schemas/ErrorBody" }),
    502: jsonResponse("agy failed (exit, bad-output, or agy-status errorKind)", { $ref: "#/components/schemas/RunFailure" }),
    503: jsonResponse("agy binary missing (not-found errorKind)", { $ref: "#/components/schemas/RunFailure" }),
    504: jsonResponse("Timeout budget expired, queued or executing", { $ref: "#/components/schemas/RunFailure" }),
  };

  const paths = {
    "/run": {
      post: {
        summary: "Run a prompt synchronously",
        description: `Blocks until agy finishes or the budget expires. At most ${config.agyMaxConcurrent} agy processes run at once; excess requests queue (FIFO). Request bodies capped at ${config.agyMaxBodyBytes} bytes (413). Note: Node fetch clients hit a ~300s default response timeout -- use /jobs beyond that.`,
        security,
        requestBody: jsonBody({ $ref: "#/components/schemas/RunRequest" }),
        responses: {
          200: jsonResponse("agy succeeded", { $ref: "#/components/schemas/RunSuccess" }),
          ...failureResponses,
          413: jsonResponse("Request body over the cap", { $ref: "#/components/schemas/ErrorBody" }),
        },
      },
    },
    "/jobs": {
      post: {
        summary: "Submit an async job",
        description: `Returns immediately; poll GET /jobs/{jobId}. Jobs are in-memory: finished jobs evicted after ${config.jobTtlMs} ms, and every job is lost on a service restart.`,
        security,
        requestBody: jsonBody({ $ref: "#/components/schemas/RunRequest" }),
        responses: {
          202: jsonResponse("Job accepted", {
            type: "object",
            properties: { jobId: { type: "string" }, state: { const: "queued" } },
          }),
          400: failureResponses[400],
          401: failureResponses[401],
          413: jsonResponse("Request body over the cap", { $ref: "#/components/schemas/ErrorBody" }),
        },
      },
      get: {
        summary: "List recent jobs",
        description: "Ids, states, and timestamps only -- never prompt or result content.",
        security,
        responses: {
          200: jsonResponse("Recent jobs, newest first", {
            type: "object",
            properties: { jobs: { type: "array", items: { $ref: "#/components/schemas/Job" } } },
          }),
          401: failureResponses[401],
        },
      },
    },
    "/jobs/{jobId}": {
      get: {
        summary: "Poll a job",
        security,
        parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          200: jsonResponse("The job, with result or error once finished", { $ref: "#/components/schemas/Job" }),
          401: failureResponses[401],
          404: jsonResponse("Unknown, expired, or evicted job id", { $ref: "#/components/schemas/ErrorBody" }),
        },
      },
    },
    "/health": {
      get: {
        summary: "Health (unauthenticated)",
        responses: {
          200: jsonResponse("Healthy", { $ref: "#/components/schemas/Health" }),
          503: jsonResponse("Degraded: agy binary missing", { $ref: "#/components/schemas/Health" }),
        },
      },
    },
    "/openapi.json": {
      get: {
        summary: "This document (unauthenticated)",
        responses: { 200: { description: "OpenAPI 3.1 spec built from the live configuration" } },
      },
    },
  };

  if (config.agyUploadDir) {
    paths["/files"] = {
      post: {
        summary: "Upload a file for analysis",
        description: `Raw request body in (max ${config.agyMaxUploadBytes} bytes), server-minted UUID filename out. Only the extension of the optional ?name= hint survives. Reference the returned containerPath in a /run or /jobs prompt (agy has scoped read trust over the upload share only). Files are never auto-deleted.`,
        security,
        parameters: [
          {
            name: "name",
            in: "query",
            required: false,
            schema: { type: "string" },
            description: "Filename hint; only its extension is used.",
          },
        ],
        requestBody: {
          required: true,
          content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
        },
        responses: {
          201: jsonResponse("Stored", {
            type: "object",
            properties: {
              ok: { const: true },
              file: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  containerPath: { type: "string", description: "Use this path in prompts." },
                  bytes: { type: "integer" },
                },
              },
            },
          }),
          400: jsonResponse("Empty upload body", { $ref: "#/components/schemas/ErrorBody" }),
          401: failureResponses[401],
          413: jsonResponse(`File over the ${config.agyMaxUploadBytes}-byte cap`, { $ref: "#/components/schemas/ErrorBody" }),
        },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "agy-gateway",
      version,
      description:
        "LAN HTTP gateway to the headless agy (Antigravity) CLI: synchronous prompt runs, async jobs, and file/image analysis via a shared upload directory. All endpoints except GET /health, GET /, and GET /openapi.json require the bearer token.",
    },
    servers: [{ url: "/" }],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        RunRequest: runRequest,
        RunSuccess: runSuccess,
        RunFailure: runFailure,
        Job: job,
        ErrorBody: errorBody,
        Health: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["ok", "degraded"] },
            pid: { type: "integer" },
            startedAt: { type: "string", format: "date-time" },
            uptimeSeconds: { type: "integer" },
            agy: {
              type: "object",
              properties: {
                path: { type: "string" },
                present: { type: "boolean" },
                version: { type: ["string", "null"] },
              },
            },
            jobs: {
              type: "object",
              properties: {
                running: { type: "integer" },
                queued: { type: "integer" },
                stored: { type: "integer" },
              },
            },
            maxConcurrent: { type: "integer" },
          },
        },
      },
    },
    paths,
  };
}
