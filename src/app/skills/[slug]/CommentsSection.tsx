import type { CommentView } from "@/lib/comments";

import { CommentList } from "./CommentList";

/**
 * 详情页的评论区（同步组件）。
 *
 * 数据由详情页（服务端组件）读好传进来 —— 这样页面读数据的路径只有一条，
 * 页面与接口拿到的评论列表也是同一份。客户端组件只负责
 * 「发表新评论 / 回复 / 举报」这些动作。
 */
export function CommentsSection({
  slug,
  comments,
}: {
  slug: string;
  comments: CommentView[];
}) {
  return (
    <section className="comments" id="comments">
      <CommentList slug={slug} initialComments={comments} />
    </section>
  );
}
