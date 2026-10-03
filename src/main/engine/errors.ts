// Error types that steer what a task does next. They contain no Electron imports so
// they can be unit tested.

/**
 * Why a task paused. Every one of these needs a human: the app never tries to get
 * around a CAPTCHA, bot challenge, block or verification step.
 */
export type PauseKind =
  | 'captcha'
  | 'bot_challenge'
  | 'blocked'
  | 'two_factor'
  | 'sign_in_required'
  | 'cvv_required'
  | 'needs_review'
  | 'kill_switch';

/** Pause the task and tell the user. `handoff` means a session window is open for them. */
export class PauseError extends Error {
  constructor(
    readonly kind: PauseKind,
    message: string,
    readonly handoff = false,
  ) {
    super(message);
    this.name = 'PauseError';
  }
}

/** The item sold out during checkout: go back to monitoring. */
export class OutOfStockError extends Error {
  constructor(message = 'Item went out of stock during checkout') {
    super(message);
    this.name = 'OutOfStockError';
  }
}

/** The price is above the task's max: do not buy, keep monitoring. */
export class PriceLimitError extends Error {
  constructor(
    readonly price: number,
    readonly maxPrice: number,
    message?: string,
  ) {
    super(message ?? `Price $${price.toFixed(2)} is above the max of $${maxPrice.toFixed(2)}`);
    this.name = 'PriceLimitError';
  }
}

/** Unexpected or failed retailer response. Counts toward the auto-stop limit. */
export class RetailerError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RetailerError';
  }
}

/** The direct HTTP path cannot do this step (API changed or needs the site's own scripts): use the browser. */
export class NeedsBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NeedsBrowserError';
  }
}

/** Payment declined: stop, do not retry the order. */
export class DeclinedError extends Error {
  constructor(message = 'The retailer declined the payment method') {
    super(message);
    this.name = 'DeclinedError';
  }
}

/** The task was stopped by the user, the kill switch or shutdown. */
export class AbortedError extends Error {
  constructor(message = 'Stopped') {
    super(message);
    this.name = 'AbortedError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Unknown error';
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortedError();
}

/** setTimeout as a promise that rejects with AbortedError when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A waiting room is in front of the page. The task waits in it (never skips it). */
export class QueueError extends Error {
  constructor(
    readonly detail: string,
    readonly url?: string,
  ) {
    super(`Waiting room: ${detail}`);
    this.name = 'QueueError';
  }
}

/** Stop the task as failed without retrying: a setup problem, or the auto-stop limit was hit. */
export class FatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}

/** The task's group already placed the number of orders the user asked for. */
export class GoalReachedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoalReachedError';
  }
}

/** The retailer sent us to its sign-in page mid-flow: sign in again, then retry. */
export class NeedsSignInError extends Error {
  constructor(message = 'The retailer asked to sign in again') {
    super(message);
    this.name = 'NeedsSignInError';
  }
}
