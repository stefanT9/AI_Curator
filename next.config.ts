import type { NextConfig } from "next";

// Artwork images are served straight from the public Supabase Storage bucket,
// so next/image needs that host on the allow-list. Derived from the same env
// var the Supabase clients use, which keeps local (127.0.0.1:54321) and the
// hosted project working without a second entry.
const supabaseUrl = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!);

// Next 16 blocks the image optimizer from fetching upstream images whose
// hostname resolves to a private IP (SSRF guard), returning 400. The local
// Supabase Storage host is exactly that (http://127.0.0.1:54321), so the seed
// corpus renders as broken images without this opt-in. Gate it to a loopback
// http host only — a hosted project is https on a public host and never trips
// this, so production is untouched.
const isLocalSupabase =
  supabaseUrl.protocol === "http:" &&
  ["127.0.0.1", "localhost", "[::1]", "::1"].includes(supabaseUrl.hostname);

const nextConfig: NextConfig = {
  images: {
    dangerouslyAllowLocalIP: isLocalSupabase,
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
