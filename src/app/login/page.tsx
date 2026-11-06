import { getEmailSender } from "@/lib/email";
import { isGitHubOAuthConfigured } from "@/lib/auth-config";
import { LoginPanel } from "./LoginPanel";

// 登录页要读环境变量（判断哪些登录方式可用），不许被静态化。
export const dynamic = "force-dynamic";

/** 取查询参数里的第一个值。 */
function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * 登录页。
 *
 * 主方式是邮箱魔法链接（spec 决策 10），GitHub OAuth 是备选。
 * 两种方式**没配好凭据都不会崩** —— 页面上明确写出「未配置」，
 * 用户改用另一种方式即可。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const sender = getEmailSender();

  return (
    <main>
      <h1>登录</h1>
      <p className="lede">用邮箱收一个一次性链接，点一下就登录 —— 不用记密码。</p>

      <LoginPanel
        token={first(params.token)}
        status={first(params.status)}
        message={first(params.message)}
        mergedFavorites={first(params.mergedFavorites)}
        mergedLikes={first(params.mergedLikes)}
        mergedFavoritesDeduplicated={first(params.mergedFavoritesDeduplicated)}
        mergedLikesDeduplicated={first(params.mergedLikesDeduplicated)}
        githubEnabled={isGitHubOAuthConfigured()}
        emailExposesLink={sender.exposesLink}
      />
    </main>
  );
}
