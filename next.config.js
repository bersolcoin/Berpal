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
