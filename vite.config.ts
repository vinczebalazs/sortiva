import { reactRouter } from '@react-router/dev/vite'
import { defineConfig, type UserConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

// The Shopify CLI passes the tunnel URL as HOST, which Vite would otherwise read as its own bind address.
if (process.env.HOST && (!process.env.SHOPIFY_APP_URL || process.env.SHOPIFY_APP_URL === process.env.HOST)) {
  process.env.SHOPIFY_APP_URL = process.env.HOST
  delete process.env.HOST
}

const host = new URL(process.env.SHOPIFY_APP_URL || 'http://localhost').hostname
const hmr =
  host === 'localhost'
    ? { protocol: 'ws', host: 'localhost', port: 64999, clientPort: 64999 }
    : { protocol: 'wss', host, port: Number(process.env.FRONTEND_PORT) || 8002, clientPort: 443 }

export default defineConfig({
  server: {
    allowedHosts: [host],
    port: Number(process.env.PORT || 3000),
    hmr,
    fs: { allow: ['app', 'core', 'connectors', 'vendors', 'db', 'jobs', 'config', 'node_modules'] },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: { assetsInlineLimit: 0 },
}) satisfies UserConfig
