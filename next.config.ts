import type {NextConfig} from 'next';

// When deploying to GitHub Pages the site is served from /<repo>, so a base path
// is injected via NEXT_PUBLIC_BASE_PATH at build time. Local dev leaves it empty.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  // Static export so it can be hosted for free on GitHub Pages.
  output: 'export',
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  transpilePackages: ['motion'],
};

export default nextConfig;
