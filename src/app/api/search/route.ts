import { NextResponse } from "next/server";

import { parseSearchQuery } from "@/lib/search-params";
import { getSearchService } from "@/lib/search-service";

// 检索要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/search —— 关键词检索。
 *
 * 返回的就是页面（`/search`）用的那份结果：条目 + 总数 + 分页 + 分面。
 * 检索本身全部经由 {@link getSearchService}，这里不碰数据库。
 *
 * 查询参数：
 *   q / kind / license / official / sort / page / pageSize
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const query = parseSearchQuery(url.searchParams);

  const result = await getSearchService().search(query);

  return NextResponse.json(result);
}
