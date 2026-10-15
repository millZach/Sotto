// What Devin CLI 3000.11.3 fills an `otel` block in with when it reads one back (#1045), observed on October 14, 2026.
// Kept apart from the adapter's own copy so the fake and the tests do not just agree with the code they check.
export const devinOtelDefaults = Object.freeze({
  endpoint: null, logs_endpoint: null, metrics_endpoint: null, headers: {}, logs_headers: {}, metrics_headers: {},
  resource_attributes: {}, timeout_ms: null, log_export_interval_ms: null, metric_export_interval_ms: null,
  disable_user_prompt_logging: false, disable_tool_logging: false,
})
