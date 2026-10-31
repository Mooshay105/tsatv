/** Local exceptions used by library. */

export class PyatvError extends Error {
  constructor(message?: string, options?: { cause?: unknown }) {
    super(message ?? "", options);
    this.name = new.target.name;
  }

  override toString(): string {
    return this.message;
  }
}

/** Equivalent of Python's NotImplementedError. */
export class NotImplementedError extends PyatvError {}

/** Equivalent of Python's OSError (wraps socket errors). */
export class OSError extends PyatvError {
  errno?: number | string;
  constructor(message?: string, errno?: number | string, options?: { cause?: unknown }) {
    super(message, options);
    this.errno = errno;
  }
}

/** Thrown when connecting to a device with no usable service. */
export class NoServiceError extends PyatvError {}

/** Thrown when an unsupported protocol was requested. (deprecated) */
export class UnsupportedProtocolError extends PyatvError {}

/** Thrown when connection fails, e.g. refused or timed out. */
export class ConnectionFailedError extends PyatvError {}

/** Thrown when a connection is lost. */
export class ConnectionLostError extends PyatvError {}

/** Thrown when pairing fails. */
export class PairingError extends PyatvError {}

/** Thrown when authentication fails. */
export class AuthenticationError extends PyatvError {}

/** Thrown when trying to perform an action that is not supported. */
export class NotSupportedError extends NotImplementedError {}

/** Thrown when invalid DMAP data is parsed. */
export class InvalidDmapDataError extends PyatvError {}

/** Thrown when an unknown media kind is found. */
export class UnknownMediaKindError extends PyatvError {}

/** Thrown when an unknown play state is found. */
export class UnknownPlayStateError extends PyatvError {}

/** Thrown when starting AsyncUpdater with no listener. */
export class NoAsyncListenerError extends PyatvError {}

/** Thrown if credentials are missing. */
export class NoCredentialsError extends PyatvError {}

/** Thrown if credentials are invalid. */
export class InvalidCredentialsError extends PyatvError {}

/** Thrown when device id is missing. */
export class DeviceIdMissingError extends PyatvError {}

/** Thrown when device mandates a backoff period. */
export class BackOffError extends PyatvError {}

/** Thrown when media playback failed. */
export class PlaybackError extends PyatvError {}

/** Thrown when a command (e.g. play or pause) failed. */
export class CommandError extends PyatvError {}

/** Thrown when address it not in any local subnet. (deprecated) */
export class NonLocalSubnetError extends PyatvError {}

/** Thrown when trying to perform an action not possible in the current state. */
export class InvalidStateError extends PyatvError {}

/**
 * Thrown when a generic protocol error occurs.
 *
 * Generic protocol errors includes for instance missing fields, incorrect or
 * unexpected types, etc. Any error that can happen when communicating with a device
 * that is not covered by another exception is covered by this exception.
 */
export class ProtocolError extends PyatvError {}

/** Thrown when a HTTP error occurs. */
export class HttpError extends ProtocolError {
  private readonly _statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this._statusCode = statusCode;
  }

  /** Return status code that triggered the error. */
  get statusCode(): number {
    return this._statusCode;
  }
}

/** Thrown when something is wrong or missing in the config. */
export class InvalidConfigError extends PyatvError {}

/**
 * Thrown when calling a blocked method.
 *
 * Typically, public interface methods (e.g. any method available via the object
 * returned by `connect`) becomes blocked after either calling close or because
 * the connection was closed for some other reason.
 */
export class BlockedStateError extends PyatvError {}

/** Thrown when a remote sends an invalid response. */
export class InvalidResponseError extends PyatvError {}

/** Raised when a timeout happens. */
export class OperationTimeoutError extends PyatvError {}

/** Raised when an error related to settings happens. */
export class SettingsError extends PyatvError {}

/** Return true if error looks like a socket/OS level error. */
export function isOSError(error: unknown): boolean {
  if (error instanceof OSError) return true;
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    const syscall = (error as { syscall?: unknown }).syscall;
    if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return true;
    if (typeof syscall === "string") return true;
  }
  return false;
}
