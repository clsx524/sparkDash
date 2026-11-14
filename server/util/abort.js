/** Race non-cancellable observations without allowing their late result to advance an apply. */
export async function abortable(operation, signal) {
  signal?.throwIfAborted();
  if (!signal) return await operation();
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Do not release a workflow's lock while any parallel sibling can still mutate a host. */
export async function settleAll(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
}
