/**
 * Reserved for UI primitives extracted from apps/web.
 *
 * The components currently live in `apps/web/components/ui.tsx`, where they are
 * the only consumer. Extracting them here before a second consumer exists would
 * be a package boundary with nothing on the other side of it, so this package
 * stays empty until `apps/demo-app` or an embeddable widget needs them.
 */
export const UI_PACKAGE_PLACEHOLDER = true;
