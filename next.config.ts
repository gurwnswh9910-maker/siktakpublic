import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  output: "standalone",
  serverExternalPackages: ["highs"],
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/highs/package.json",
      "./node_modules/highs/build/**/*",
    ],
  },
  distDir: process.env.SIKTAK_BUILD_DIR ?? ".next",
};
export default config;
