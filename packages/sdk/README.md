# @retainos/sdk

Privacy-first product analytics SDK for [RetainOS](https://github.com/).
**Zero dependencies. 25 KiB of source.** Works in any browser and in Node.

```bash
pnpm add @retainos/sdk
```

```ts
import { RetainOS } from "@retainos/sdk";

const retain = RetainOS.init({
  projectKey: "rpk_YOUR_PUBLIC_KEY",
  endpoint: "https://your-retainos-instance.example",
  autoCapture: false,
});

retain.grantConsent();                 // nothing is sent before this
retain.track("signup_completed");
retain.identify("USER_123");
retain.track("core_action_completed", { feature: "first_project" });
retain.reset();                        // on logout
```

## It will not collect

Dropped before leaving the device, by key name **and** by value shape:

passwords · tokens · JWTs · API keys · session ids · cookies · card numbers ·
CVVs · bank and routing numbers · SSN · Aadhaar · PAN · passport numbers ·
private keys · seed phrases · PINs · OTPs · health fields · dates of birth ·
precise coordinates · **every non-scalar value**

There is **no session recording, keystroke capture, form-field capture or
fingerprinting**. Not disabled — absent, with no option that enables one.

`page()` sends the path only, never the query string.

## It will not break your app

Every public method swallows its own errors and records them in
`diagnostics()`. A broken analytics call must not break a customer's product.

`localStorage` access is wrapped everywhere: Safari private mode and blocked
site data make it *throw* rather than return null, and the SDK degrades to
memory instead of crashing the page.

## React

```tsx
import { RetainOSProvider, useRetainOS, useExperiment } from "@retainos/sdk/react";

<RetainOSProvider options={{ projectKey, endpoint }}>
  <App />
</RetainOSProvider>

function CreateButton() {
  const retain = useRetainOS();
  return <button onClick={() => retain?.track("project_created")}>Create</button>;
}

function Onboarding() {
  const { variant, loading } = useExperiment("optional-template-step");
  if (loading) return <Skeleton />;
  return variant === "treatment" ? <OptionalTemplate /> : <RequiredTemplate />;
}
```

`useExperiment` records exposure where the variant is **rendered**, not where it
is assigned — which is what makes the analysis mean anything.

## Full documentation

`docs/SDK.md` in the RetainOS repository.

Apache 2.0.
