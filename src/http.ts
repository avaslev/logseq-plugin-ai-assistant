export class TimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  opts: RequestOptions = {}
): Promise<Response> {
  if (opts.signal?.aborted) throw abortReason(opts.signal);

  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onAbort = (): void => {
    controller.abort(abortReason(opts.signal!));
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) throw new TimeoutError();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  message = "Request timed out"
): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readResponseText(
  res: Response,
  timeoutMs?: number
): Promise<string> {
  try {
    return await withTimeout(res.text(), timeoutMs);
  } catch (err) {
    void res.body?.cancel().catch(() => {});
    throw err;
  }
}

export async function readResponseJson<T>(
  res: Response,
  timeoutMs?: number
): Promise<T> {
  const text = await readResponseText(res, timeoutMs);
  return JSON.parse(text) as T;
}
