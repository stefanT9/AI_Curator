import type { NextConfig } from "next";

// Artwork images are served straight from the public Supabase Storage bucket,
// so next/image needs that host on the allow-list. Derived from the same env
// var the Supabase clients use, which keeps local (127.0.0.1:54321) and the
// hosted project working without a second entry.
const supabaseUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: supabaseUrl.protocol.replace(":", "") as "http" | "https",
        hostname: supabaseUrl.hostname,
        port: supabaseUrl.port,
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
};

export default nextConfig;
