import { NextResponse } from "next/server";
import type { AssetKind } from "@prisma/client";

import { requireVerifiedPublisher } from "@/lib/publish-gate";
import { PublishError, publishAsset } from "@/lib/publish-service";

// 发布要实时写库，不许被静态化。
export const dynamic = "force-dynamic";

/** 请求体里允许出现的字符串字段。 */
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * POST /api/publish —— 发布自己的资产。
 *
 * 门槛：登录 **且** 邮箱已验证（`emailVerifiedAt` 非空），见
 * {@link requireVerifiedPublisher}。
 *
 * 流程（细节见 `publish-service.ts`）：
 *   1. 校验入参、解析仓库地址；
 *   2. 按声明的许可证分档（FULL / METADATA_ONLY）；
 *   3. 生成中文简介初稿（LLM 失败 → 模板降级，不阻断发布）；
 *   4. 自动关键词过滤（命中 → 状态 PENDING，已下架待抽查）；
 *   5. 写资产（唯一写入路径 `writeAsset`）+ 写发布记录；
 *   6. 解析依赖清单（票 #17）：清单格式非法或依赖目标不存在时**整条拒绝**，
 *      错误消息里带字段路径与行列位置 —— 不静默忽略，也不半截入库。
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await requireVerifiedPublisher(request);
  if (!gate.ok) {
    return gate.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "请求体不是合法的 JSON。" },
      { status: 400 },
    );
  }

  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const kind = (readString(record, "kind") ?? "").toUpperCase();

  try {
    const result = await publishAsset({
      userId: gate.userId,
      kind: kind as AssetKind,
      displayName: readString(record, "displayName") ?? "",
      repoUrl: readString(record, "repoUrl") ?? "",
      license: readString(record, "license"),
      description: readString(record, "description") ?? "",
      contentBody: readString(record, "contentBody"),
      skillPath: readString(record, "skillPath"),
      // #16 起版本号真的会被消费；#17 起依赖清单会被解析入库。
      version: readString(record, "version"),
      manifestPath: readString(record, "manifestPath"),
      manifest: readString(record, "manifest"),
    });

    return NextResponse.json(
      {
        ok: true,
        slug: result.asset.slug,
        displayName: result.asset.displayName,
        kind: result.asset.kind,
        license: result.asset.license,
        contentTier: result.contentTier,
        repoUrl: result.asset.repoUrl,
        // 简介初稿与它的来源标记（回显**落库**的值）。
        summaryZh: result.summaryZh,
        summarySource: result.summarySource,
        whenToUse: result.whenToUse,
        howToUse: result.howToUse,
        /** 简介是不是 AI 生成的（页面据此标注「AI 生成，版权归原作者」）。 */
        aiGenerated: result.summarySource === "LLM",
        // 审核状态。
        status: result.status,
        filtered: result.filtered,
        // 落库的依赖关系（票 #17）：依赖了谁、版本约束是什么。
        dependencies: result.dependencies.map((dependency) => ({
          slug: dependency.slug,
          displayName: dependency.displayName,
          kind: dependency.kind,
          constraint: dependency.constraint,
        })),
        message:
          result.status === "PENDING"
            ? "已提交，命中自动过滤，正在等待运营抽查。"
            : "发布成功，资产已对外可见。",
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof PublishError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.code === "SLUG_TAKEN" ? 409 : 400 },
      );
    }

    console.error("[publish] 发布失败：", error);
    return NextResponse.json(
      { error: "internal_error", message: "发布失败，请稍后再试。" },
      { status: 500 },
    );
  }
}
