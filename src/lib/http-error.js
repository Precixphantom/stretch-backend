/** An error with a status code and a message that is safe to show the user. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {Record<string, string>} [details] Field name → problem, for form errors.
   */
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
