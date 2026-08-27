export class RouteServiceError extends Error {
  constructor(message, statusCode = 502, code = "route_provider_error") {
    super(message);
    this.name = "RouteServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
