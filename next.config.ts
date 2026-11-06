import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone 输出：Docker 镜像只拷 .next/standalone，不带源码与 devDependencies
  output: "standalone",
};

export default nextConfig;
