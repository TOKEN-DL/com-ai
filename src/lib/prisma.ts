/**
 * Prisma 客户端单例。
 *
 * 开发模式下 Next.js 会热重载模块，不做单例化会不断新建连接池。
 * 连接串来自环境变量 DATABASE_URL（运行时注入，不写进镜像）。
 */
import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
