// Minimal OTLP/HTTP JSON log exporter, mirroring the lab's established
// pattern (plex/src/organize/otelLog.js): ship this app's own log lines to
// the LOCAL OpenTelemetry Collector on this LXC, which forwards them (with
// the shared push credential baked into ITS config, never this app's) to
// the central Loki stack on 192.168.0.34 -- see the C:\git\logging repo.
// The Collector stamps the `host: agy-gateway` label; this app only names
// its service.
//
// Deliberately NOT the official @opentelemetry/* SDK: OTLP/HTTP with JSON
// encoding is a small, stable wire format (POST one resourceLogs
// envelope), and the SDK would break this repo's zero-npm-dependency
// constraint for what amounts to "POST this JSON somewhere."

const SEVERITY = {
  info: { number: 9, text: "INFO" },
  error: { number: 17, text: "ERROR" },
};
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Builds one OTLP/HTTP JSON `ExportLogsServiceRequest` body for a single
 * log line. Pure -- no I/O.
 * @param {string} message
 * @param {{serviceName: string, level?: "info"|"error", now?: () => Date}} params
 * @returns {object}
 */
export function buildOtlpLogPayload(message, { serviceName, level = "info", now = () => new Date() }) {
  const severity = SEVERITY[level] ?? SEVERITY.info;
  // OTLP wants nanosecond-precision Unix time as a string (BigInt avoids
  // float-precision loss).
  const timeUnixNano = String(BigInt(now().getTime()) * 1_000_000n);
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [{ key: "service.name", value: { stringValue: serviceName } }],
        },
        scopeLogs: [
          {
            scope: {},
            logRecords: [
              {
                timeUnixNano,
                severityNumber: severity.number,
                severityText: severity.text,
                body: { stringValue: message },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * Creates a fire-and-forget OTLP log shipper. `send()` never throws and
 * never blocks its caller -- a slow or unreachable Collector must never
 * slow down or crash the gateway (visibility, not a hard dependency). A
 * failure calls `onError` once, then stays quiet until a send succeeds
 * again, so a downed Collector doesn't generate one failure line per
 * shipped line.
 * @param {object} params
 * @param {string} params.endpoint
 * @param {string} [params.serviceName]
 * @param {number} [params.timeoutMs]
 * @param {typeof fetch} [params.fetchImpl]
 * @param {(error: Error) => void} [params.onError]
 * @returns {{send: (message: string, level?: "info"|"error") => void}}
 */
export function createOtelLogShipper({
  endpoint,
  serviceName = "agy-gateway",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  onError = () => {},
}) {
  let warned = false;

  function send(message, level = "info") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const payload = buildOtlpLogPayload(message, { serviceName, level });

    fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then((response) => {
        if (response.ok) {
          warned = false;
          return;
        }
        if (!warned) {
          warned = true;
          onError(new Error(`OTel Collector returned HTTP ${response.status}`));
        }
      })
      .catch((error) => {
        if (!warned) {
          warned = true;
          onError(error);
        }
      })
      .finally(() => clearTimeout(timer));
  }

  return { send };
}
