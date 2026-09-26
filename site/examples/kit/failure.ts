import { overlay } from './overlay.ts';
import { kitWord } from './words.ts';

/**
 * What the reader sees when the example stops on an error — a model that did not load, a device
 * the engine refused: a card naming the error, and its message in `failures`, a verdict's reasons.
 */
let shown: HTMLElement | undefined;
export const failures = new Set<string>();

/** The card, once (the first error stopped the page); every error joins `failures`. */
function showFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (failures.add(message) && shown) return;
  shown = document.createElement('div');
  shown.role = 'alert';
  shown.className =
    'pointer-events-auto absolute inset-x-3 top-3 mx-auto max-w-lg alert alert-soft alert-error';
  const title = document.createElement('strong');
  title.textContent = kitWord('failure', 'title', 'This example stopped on an error');
  const detail = document.createElement('p');
  detail.className = 'text-xs break-words';
  detail.textContent = message;
  const text = document.createElement('div');
  text.append(title, detail);
  shown.append(text);
  overlay().append(shown);
}

/** A refusal the browser gives in passing, which stops nothing: a video's `play()` cut short by a
 *  pause (`AbortError`) or refused before the reader has touched the page (`NotAllowedError`). */
export const isPassing = (reason: unknown) =>
  reason instanceof DOMException && ['AbortError', 'NotAllowedError'].includes(reason.name);

/** Shows any error the example's own code leaves uncaught: an `await` that rejects at the top
 *  of its module is one. An error event without an error (a resize notice) is not one, nor a
 *  refusal in passing. */
export function watchFailures() {
  globalThis.addEventListener?.('error', (event) => {
    if (event.error) showFailure(event.error);
  });
  globalThis.addEventListener?.('unhandledrejection', (event) => {
    if (!isPassing(event.reason)) showFailure(event.reason);
  });
}
