const ENGINE = process.env.ENGINE_ORIGIN ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The dashboard talks to /api/* on its own origin; Next proxies straight through to
  // the engine, so SSE is same-origin and needs no CORS preflight in the browser.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${ENGINE}/api/:path*` }];
  },
};

export default nextConfig;
