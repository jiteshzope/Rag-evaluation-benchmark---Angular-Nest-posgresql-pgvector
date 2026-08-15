/**
 * Quota preflight for the UI check scripts.
 *
 * Uploading a corpus spends from a small daily budget. Without this check an
 * exhausted budget surfaces as a scatter of unrelated assertion failures — the
 * paste silently 429s, so every later expectation about the uploaded corpus is
 * wrong — instead of the one fact that explains all of them.
 */
export async function preflight(apiOrigin, uploadsNeeded, cleanup) {
  const quotasUrl = apiOrigin.replace(/\/+$/, '') + '/api/quotas';

  const stop = (...lines) => {
    for (const line of lines) console.error(line);
    cleanup?.();
    process.exit(2);
  };

  let quotas;
  try {
    quotas = (await (await fetch(quotasUrl)).json()).quotas;
  } catch {
    stop(`Cannot reach ${quotasUrl}.`, 'Check the API is reachable, then re-run.');
  }

  const upload = quotas?.find((q) => q.action === 'upload');
  if (!upload) stop(`Unexpected response from ${quotasUrl}.`);

  if (upload.remaining < uploadsNeeded) {
    stop(
      `Not enough upload quota: ${upload.remaining} left, this suite needs ${uploadsNeeded}.`,
      'Restart the backend to clear the in-memory quota, then re-run.',
    );
  }
}
