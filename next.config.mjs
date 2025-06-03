/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: ["ws"] // allow ws to be bundled for server
  }
};

export default nextConfig; 