/** @type {import('next').NextConfig} */
const nextConfig = {
  // The workspace packages are TypeScript sources, compiled by Next itself.
  transpilePackages: ["@retainos/shared", "@retainos/database", "@retainos/analytics"],
  // node:sqlite is a Node built-in; keep it external so it is required at
  // runtime rather than bundled.
  serverExternalPackages: ["node:sqlite"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "geolocation=(), microphone=(), camera=()" },
        ],
      },
    ];
  },
};
export default nextConfig;
