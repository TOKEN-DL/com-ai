import { handleInteractionRoute } from "@/lib/interaction-route";

// 互动要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/** POST /api/assets/{slug}/like —— 点赞（游客态可用）。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  return handleInteractionRoute(request, slug, "like", "set");
}

/** DELETE /api/assets/{slug}/like —— 取消点赞。 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  return handleInteractionRoute(request, slug, "like", "clear");
}
