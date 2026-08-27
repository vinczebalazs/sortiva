/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source (DECISIONS 2026-08-27, T0.1).
  transpilePackages: ['@sortiva/core', '@sortiva/db', '@sortiva/jobs', '@sortiva/rules', '@sortiva/ui'],
  // packages/rules reads signals.config.yaml + its JSON schema from disk at
  // worker start (main §7.10, tech §2), so tracing must carry them into the
  // deployed bundle.
  outputFileTracingIncludes: {
    '/**': ['../../packages/rules/signals.config.yaml', '../../packages/rules/schema/*.json'],
  },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
}

export default nextConfig
