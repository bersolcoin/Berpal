/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  // Standalone output makes Railway/Docker deploys lean.
  output: 'standalone',

  // Pin the workspace root explicitly so Next.js doesn't get confused by
  // any stray lockfiles in parent directories.
  turbopack: {
    root: path.join(__dirname),
  },

  // Allow dev requests (HMR WebSocket, asset loads) when the app is
  // served through ngrok or local network IPs. Next 15+ blocks
  // cross-origin dev requests by default as a security measure.
  allowedDevOrigins: [
    '*.ngrok-free.dev',
    '*.ngrok-free.app',
    '*.ngrok.io',
    'localhost',
    '127.0.0.1',
    '192.168.*.*',
  ],

  // We're plain JS; skip type checks at build time.
  typescript: {
    ignoreBuildErrors: true,
  },

  // Node-only packages — keep them as runtime requires, never bundle.
  // Webpack would otherwise try to resolve `fs`, `net`, `tls` etc. and fail.
  serverExternalPackages: [
    'pg',
    'pg-connection-string',
    'twilio',
    'bcryptjs',
    'iron-session',
  ],
};

module.exports = nextConfig;
