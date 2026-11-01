import { RetainOSClient, SDK_NAME, SDK_VERSION } from "./client.ts";
import type { RetainOSOptions } from "./types.ts";

export { RetainOSClient, SDK_NAME, SDK_VERSION };
export * from "./types.ts";
export { sanitiseProperties, isSensitiveKey, isSensitiveValue } from "./privacy.ts";
export { memoryStorage, browserStorage } from "./storage.ts";
export { fetchTransport, recordingTransport } from "./transport.ts";

/**
 * Entry point.
 *
 *   import { RetainOS } from "@retainos/sdk";
 *
 *   const retain = RetainOS.init({
 *     projectKey: "PUBLIC_PROJECT_KEY",
 *     endpoint: "https://your-retainos-instance.example",
 *     autoCapture: false,
 *   });
 *
 *   retain.grantConsent();
 *   retain.track("signup_completed");
 *   retain.identify("USER_123");
 *   retain.track("core_action_completed", { feature: "first_project" });
 */
export const RetainOS = {
  init(options: RetainOSOptions): RetainOSClient {
    return new RetainOSClient(options);
  },
  version: SDK_VERSION,
};

export default RetainOS;
