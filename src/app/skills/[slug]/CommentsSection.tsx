import { getAssetBySlug } from "@/lib/asset-query";
import { listAssetComments } from "@/lib/comments";

import { CommentList } from "./CommentList";

/**
 * 详情页的评论区（服务端组件）。
 *
 * 评论列表与回复列表都在这里渲染（spec 决策 9 的详情页要求）。
 * 数据在服务端读，客户端组件只负责「发表新评论 / 回复 / 举报」这些动作。
 */
export async function CommentsSection({ slug }: { slug: string }) {
  const asset = await getAssetBySlug(slug);

  if (!asset) {
    return null;
  }

  const comments = await listAssetComments(asset.id);

  return (
    <section className="comments" id="comments">
      <CommentList slug={slug} initialComments={comments} />
    </section>
  );
}
