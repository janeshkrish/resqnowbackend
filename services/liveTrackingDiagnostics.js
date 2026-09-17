export function isLiveTrackingDiagnosticsEnabled(environment = process.env) {
  return String(environment?.LIVE_TRACKING_DIAGNOSTICS || '').trim().toLowerCase() === 'true';
}

export function logLiveTrackingDiagnostic(event, details = {}, { environment = process.env, logger = console.info } = {}) {
  if (!isLiveTrackingDiagnosticsEnabled(environment)) return;
  logger('[LiveTracking Diagnostics]', { event, ...details });
}
