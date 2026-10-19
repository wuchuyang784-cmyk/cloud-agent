const statuses = Object.freeze({
  invalid_model_input: 422, model_access_configuration_invalid: 503, model_credential_crypto_invalid: 503,
  model_credential_not_found: 404, model_access_conflict: 409, model_access_denied: 403,
  model_grant_invalid: 401, model_gateway_busy: 429, model_access_unavailable: 503,
  model_upstream_unavailable: 502, model_gateway_timeout: 504, model_gateway_limit: 413,
});
export class ModelAccessError extends Error {
  constructor(code = 'model_access_unavailable') {
    const safe = Object.hasOwn(statuses, code) ? code : 'model_access_unavailable';
    super(safe); this.name = 'ModelAccessError'; this.code = safe; this.status = statuses[safe];
  }
}
