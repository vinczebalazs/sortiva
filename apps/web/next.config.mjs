/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source (DECISIONS 2026-08-27, T0.1).
  transpilePackages: ['@sortiva/core', '@sortiva/db', '@sortiva/jobs', '@sortiva/rules', '@sortiva/ui'],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
}

export default nextConfig
