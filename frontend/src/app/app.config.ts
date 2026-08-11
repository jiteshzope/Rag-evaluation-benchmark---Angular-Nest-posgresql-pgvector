import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';

/**
 * Zoneless: there is no zone.js polyfill in the build, and every piece of state
 * the UI reads is a signal, so change detection is scheduled by the writes that
 * cause it rather than by patched browser APIs.
 */
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideZonelessChangeDetection()],
};
