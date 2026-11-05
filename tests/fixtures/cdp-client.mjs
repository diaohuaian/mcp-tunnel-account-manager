/**
 * CDP client bridge backed by isolated browser runtime.
 * Exports standard browser detection and launching APIs.
 */
export {
  findBrowserExecutable,
  buildSafeBrowserEnv,
  launchHeadlessBrowser,
  createBrowserRuntime
} from './browser-runtime.mjs';
