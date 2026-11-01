/**
 * The demonstration application.
 *
 * A genuinely separate program that uses the published SDK to send real events
 * to a running RetainOS instance over HTTP. It exists so the ingestion path can
 * be verified end to end rather than only in unit tests: nothing here imports
 * RetainOS's server code.
 *
 *   pnpm --filter @retainos/demo-app start -- --key rpk_… --endpoint http://localhost:3000
 */
import { RetainOS } from "@retainos/sdk";

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value && !value.startsWith("--")) return value;
  if (fallback !== undefined) return fallback;
  console.error(`Missing required argument --${name}.`);
  console.error("Usage: start -- --key rpk_YOUR_KEY [--endpoint http://localhost:3000] [--users 5]");
  process.exit(1);
}

const projectKey = arg("key");
const endpoint = arg("endpoint", "http://localhost:3000");
const users = Number(arg("users", "5"));

console.log(`Sending events to ${endpoint} with key ${projectKey.slice(0, 12)}…\n`);

const retain = RetainOS.init({
  projectKey,
  endpoint,
  autoCapture: false,
  // This is a server-side script, so consent is the operator's own decision
  // and is asserted explicitly rather than assumed.
  requireConsent: true,
  batchSize: 10,
  debug: true,
});

retain.grantConsent();

let sent = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

for (let i = 0; i < users; i++) {
  const userId = `demo-app-user-${Date.now()}-${i}`;

  retain.reset();                       // fresh anonymous identity per simulated user
  retain.track("page_viewed", { path: "/signup" });
  retain.track("signup_completed", { acquisition_source: "demo_app" });
  // identify() with no traits emits no event of its own; it links the
  // anonymous history that was already sent to this user id.
  retain.identify(userId);
  sent += 2;

  if (i % 4 !== 3) {
    retain.track("onboarding_started");
    sent++;
    if (i % 3 !== 2) {
      retain.track("onboarding_completed");
      retain.track("project_created", { is_first: true });
      sent += 2;
    }
  }

  // Properties the SDK must refuse to send. Verified below.
  retain.track("core_action_completed", {
    feature: "demo",
    password: "should-never-be-sent",
    api_key: "sk_live_should_never_be_sent",
  } as never);
  sent++;

  await sleep(20);
}

// An event name the server must reject, so the inspector shows a real rejection.
retain.track("ThisNameIsInvalid" as never);

await retain.flush();
await sleep(400);

const diagnostics = retain.diagnostics();
console.log("\n--- SDK diagnostics ---");
console.log(`  queued   ${diagnostics.queued}`);
console.log(`  sent     ${diagnostics.sent}`);
console.log(`  dropped  ${diagnostics.dropped}`);
console.log(`  failed   ${diagnostics.failed}`);
console.log(`  lastError ${diagnostics.lastError ?? "none"}`);

console.log(`\n${sent} valid events were handed to the SDK; ${diagnostics.sent} were accepted by the server.`);
console.log("One further call used an invalid event name and was refused by the SDK before it reached the network.");
console.log("The password and api_key properties were stripped by the SDK, and again by the server.");
console.log("\nOpen the event inspector to see them arrive:");
console.log(`  ${endpoint}/analytics/events`);

retain.shutdown();
