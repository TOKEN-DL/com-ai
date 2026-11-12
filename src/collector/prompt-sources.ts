/**
 * Prompt 语料源目录（票 #15）。
 *
 * ## 语料从哪来
 *
 * 全部来自**明确允许再分发**的开源仓库，逐个实测过 LICENSE 原文：
 *   - CC0 1.0 / MIT / Apache-2.0 → 可存正文（FULL 档）；
 *   - CC BY 4.0 → 可存正文，但**必须署名**（见 `LicenseOverride.attribution`）；
 *   - 无 LICENSE → 只存元数据与链接（METADATA_ONLY），站内**不复制原文**。
 *
 * **明确不收**的源（实测后放弃，理由见各自的注释）：
 *   - `wide-trace/open-higgsfield` —— 无 LICENSE，且 prompt 藏在 Next.js 源码常量里；
 *   - `bingnin80-yy/awesome-topmediai-ai-music-prompts` —— LICENSE 明文禁止再发布；
 *   - `dawgshart/suno-prompt-engineering-guide` 的 `/data/*.json` —— 是 Suno, Inc. 的财产；
 *   - HF 的 `nyuuzyou/suno` / `blanchon/udio_dataset` —— CC0 只是上传者单方声明，
 *     原作者未授权。
 *
 * ## 「通用文本库里没有视频与图片」
 *
 * `f/prompts.chat` 的 `type` 字段实测只有 `TEXT`(2502) / `STRUCTURED`(374) /
 * `IMAGE`(21) —— **没有 VIDEO，也没有 AUDIO/MUSIC**。
 * 所以视频与音乐提示词只能来自下面这些专用仓库，这也是本目录存在多个源的原因。
 *
 * ## 逐字一致
 *
 * 每个 `parse` 函数返回的 `body` 都是**来源原文的原始切片**：
 * 不 trim、不规范化、不截断。详见 {@link ../collector/prompt-parse} 顶部的说明。
 */
import type { PromptModality } from "@prisma/client";

import { SourceStructureError } from "@/collector/errors";
import {
  extractFencedBlocks,
  expectJsonArray,
  expectJsonObject,
  headingBefore,
  parseCsvRecords,
  parseJson,
} from "@/collector/prompt-parse";

/** 解析出来的一条 prompt。 */
export type ParsedPrompt = {
  /** 标题（也用作 `act`）。只用于展示，**不是**复制出去的内容。 */
  title: string | null;
  /** 正文 —— 逐字原文。 */
  body: string;
  /** 面向开发者的说明。 */
  forDevs?: string | null;
  /** 贡献者署名（上游自己声明的「谁贡献的」）。 */
  contributor?: string | null;
  /** 覆盖源级模态（少数源内部混了多种模态）。 */
  modality?: PromptModality;
};

/** 一个语料源的声明式描述。 */
export type PromptSourceDefinition = {
  /** 源标识（落进 `Asset.sourceId`）。 */
  id: string;
  owner: string;
  repo: string;
  branch: string;
  /**
   * 要采的仓库内相对路径。支持 glob（`**` / `*`）。
   *
   * 写死路径而不是「扫全仓库」的原因：prompt 语料经常混着 README、
   * 教学示例、评测集（`PlexPt` 的 `question/*.md` 是 673 个评测表格，不是 prompt），
   * 扫全仓库必然误收。
   */
  paths: string[];
  /** 解析这个源的文件。形状不对要抛 {@link SourceStructureError}。 */
  parse: (path: string, content: string) => ParsedPrompt[];
  /** 模态。 */
  modality: PromptModality;
  /** 工具 / 模型标签（Flux / Seedance / Suno …）。 */
  toolTags: string[];
};

/** 把标题折成 slug 片段（只保留 ASCII 字母数字与连字符）。 */
export function slugifyFragment(value: string, maxLength = 48): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > maxLength ? slug.slice(0, maxLength).replace(/-+$/, "") : slug;
}

/** 源标识 → slug 前缀。 */
export function sourceSlugPrefix(sourceId: string): string {
  return slugifyFragment(sourceId.replace(/\//g, "-"), 40);
}

// ---------------------------------------------------------------------------
// 通用解析辅助
// ---------------------------------------------------------------------------

/** 去掉行尾的空白（只用于**标题**，正文一律不动）。 */
function cleanTitle(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * 「围栏块 + 最近的标题」解析器 —— 音乐类仓库的通用形态。
 *
 * ⚠️ 正文**不 trim**：取的是开围栏行之后到闭围栏行之前的原始切片。
 */
function parseFencedWithHeadings(
  content: string,
  source: string,
  options: { skipCodeBlocks?: boolean } = {},
): ParsedPrompt[] {
  const blocks = extractFencedBlocks(content);
  if (blocks.length === 0) {
    throw new SourceStructureError(source, "文件里一个围栏代码块都没有（格式可能变了）");
  }

  const out: ParsedPrompt[] = [];
  for (const block of blocks) {
    if (options.skipCodeBlocks && looksLikeCode(block.body)) {
      continue;
    }
    if (block.body.trim().length === 0) {
      continue;
    }
    out.push({
      title: cleanTitle(headingBefore(content, block.start)),
      body: block.body,
    });
  }
  return out;
}

/**
 * 这段围栏内容是不是代码（而不是 prompt）。
 *
 * 判据：整段看起来像脚本 —— 以 import / from / $ / curl / #! 开头，
 * 或者含 `requests.post`。
 */
function looksLikeCode(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (/^(import |from |\$ |curl |#!)/.test(trimmed)) {
    return true;
  }
  return trimmed.includes("requests.post");
}

/** 校验 CSV 表头；不匹配就是「上游改版了」。 */
function assertCsvHeader(
  actual: string[],
  expected: string[],
  source: string,
  path: string,
): void {
  const normalized = actual.map((field) => field.trim());
  const same =
    normalized.length === expected.length &&
    normalized.every((field, index) => field === expected[index]);
  if (!same) {
    throw new SourceStructureError(
      source,
      `${path} 的表头变成了 [${normalized.join(", ")}]，期望 [${expected.join(", ")}]`,
    );
  }
}

// ---------------------------------------------------------------------------
// 各源的解析函数
// ---------------------------------------------------------------------------

/**
 * `f/prompts.chat/prompts.csv` —— 通用文本语料主力（2,897 条）。
 *
 * 实测：表头恒为 `act, prompt, for_devs, type, contributor`，列数恒 5、脏行 0；
 * 71.8% 的记录在 `prompt` 字段里含换行；最大单字段 144,260 码点。
 */
function parsePromptsChatCsv(path: string, content: string): ParsedPrompt[] {
  const source = "f/prompts.chat";
  const records = parseCsvRecords(content);
  if (records.length === 0) {
    throw new SourceStructureError(source, `${path} 是空的`);
  }

  const header = records[0]?.fields ?? [];
  assertCsvHeader(header, ["act", "prompt", "for_devs", "type", "contributor"], source, path);

  const out: ParsedPrompt[] = [];
  for (const record of records.slice(1)) {
    if (record.fields.length !== header.length) {
      // 列数不对的行跳过（实测 0 条，但不能因此把整份文件判成结构变了）。
      continue;
    }
    const [act, prompt, forDevs, type, contributor] = record.fields as [
      string,
      string,
      string,
      string,
      string,
    ];

    out.push({
      title: cleanTitle(act),
      body: prompt,
      // forDevs 归一化成小写 true / false（它不是正文，不受「逐字」约束）。
      forDevs: forDevs.trim().toLowerCase() === "true" ? "true" : "false",
      contributor: cleanTitle(contributor),
      // type 是唯一的模态字段：TEXT / STRUCTURED → TEXT，IMAGE → IMAGE。
      // ⚠️ 实测**没有** VIDEO / AUDIO —— 视频与音乐只能来自专用仓库。
      modality: type.trim().toUpperCase() === "IMAGE" ? "IMAGE" : "TEXT",
    });
  }
  return out;
}

/** `PlexPt/awesome-chatgpt-prompts-zh/prompts-zh.json` —— 中文语料（124 条）。 */
function parsePlexPtJson(path: string, content: string): ParsedPrompt[] {
  const source = "PlexPt/awesome-chatgpt-prompts-zh";
  const array = expectJsonArray(parseJson(content, source), source, `${path} 的顶层`);
  return array.map((raw, index) => {
    const row = expectJsonObject(raw, source, `${path} 第 ${index + 1} 条`);
    const act = row.act;
    const prompt = row.prompt;
    if (typeof act !== "string" || typeof prompt !== "string") {
      throw new SourceStructureError(
        source,
        `${path} 第 ${index + 1} 条缺 act / prompt 字段（keys: ${Object.keys(row).join(",")}）`,
      );
    }
    return { title: cleanTitle(act), body: prompt };
  });
}

/**
 * `YouMind-OpenLab/awesome-seedance-2-prompts/README.md` —— 视频提示词（106 条）。
 *
 * 结构：`### No. N: <标题>` → `#### 📝 Prompt` → 一个围栏块。
 *
 * ⚠️ 只抓英文 README.md —— 另外 15 个语言版是同批内容的翻译，
 * 全抓会重复 16 倍。README 自己宣称「Total Prompts 6654」是虚标，
 * 实测只有 106 条 —— 入库按实际解析到的条数。
 */
function parseYouMindReadme(path: string, content: string): ParsedPrompt[] {
  const source = "YouMind-OpenLab/awesome-seedance-2-prompts";
  const headingRe = /^### No\. (\d+): ([^\r\n]+)$/gm;
  const out: ParsedPrompt[] = [];

  const matches = [...content.matchAll(headingRe)];
  if (matches.length === 0) {
    throw new SourceStructureError(source, `${path} 里没有「### No. N:」标题（格式可能变了）`);
  }

  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i] as RegExpMatchArray;
    const next = matches[i + 1];
    const section = content.slice(match.index, next?.index ?? content.length);

    const marker = section.indexOf("#### 📝 Prompt");
    if (marker === -1) {
      continue;
    }
    const blocks = extractFencedBlocks(section.slice(marker));
    const block = blocks[0];
    if (!block) {
      continue;
    }
    out.push({
      title: cleanTitle(match[2]),
      body: block.body,
    });
  }

  if (out.length === 0) {
    throw new SourceStructureError(source, `${path} 里一条 prompt 都没解析出来`);
  }
  return out;
}

/**
 * `ZeroLu/awesome-seedance/README*.md` —— 视频提示词（MIT）。
 *
 * 结构：标题层级 + 裸围栏块。README 里混着 bash / python 示例块，要跳过。
 */
function parseZeroLuReadme(path: string, content: string): ParsedPrompt[] {
  return parseFencedWithHeadings(content, "ZeroLu/awesome-seedance", {
    skipCodeBlocks: true,
  });
}

/**
 * `bytedance/Video-As-Prompt` 的 `examples/training` 下的 `validation*.json` —— 视频提示词。
 *
 * 结构：`{ "data": [ { "caption": "..." } ] }`。caption 就是提示词正文。
 *
 * ⚠️ 这个仓库本质是 huggingface/diffusers 的 fork，
 * `diffusers/` 子树有 2,000+ 个无关文件 —— 采集时必须排除。
 */
function parseVideoAsPromptJson(path: string, content: string): ParsedPrompt[] {
  const source = "bytedance/Video-As-Prompt";
  const root = expectJsonObject(parseJson(content, source), source, `${path} 的顶层`);
  const data = expectJsonArray(root.data, source, `${path} 的 data`);
  const out: ParsedPrompt[] = [];
  for (const raw of data) {
    const row = expectJsonObject(raw, source, `${path} 的 data 条目`);
    if (typeof row.caption !== "string" || row.caption.trim().length === 0) {
      continue;
    }
    out.push({
      // 标题只是展示用的截断（正文仍是完整 caption）。
      title: cleanTitle(row.caption.slice(0, 60)),
      body: row.caption,
    });
  }
  return out;
}

/**
 * `Anil-matcha/awesome-flux-3-api-prompts/README.md` —— 图片 / 视频提示词。
 *
 * 结构：`## Prompt Library` 段里的 `#### N. 标题` + 围栏块。
 *
 * ⚠️ 必须限定在 `## Prompt Library` 段内 —— README 通篇还有 API 文档与
 * bash / python 示例块，不限定就会把它们当 prompt 收进来。
 *
 * ⚠️ 这个仓库**没有 LICENSE 文件**（README 的 `## License` 段只写了 "MIT"，
 * badge 还指向不存在的文件）→ 落 METADATA_ONLY 档，站内不复制原文。
 * 模态按每个条目的 `Best for:` 判定（`flux-3-image-to-video` → VIDEO）。
 */
function parseAnilMatchaFluxReadme(path: string, content: string): ParsedPrompt[] {
  const source = "Anil-matcha/awesome-flux-3-api-prompts";
  const start = content.indexOf("## Prompt Library");
  if (start === -1) {
    throw new SourceStructureError(source, `${path} 里没有「## Prompt Library」段（格式可能变了）`);
  }
  const end = content.indexOf("## Tips & Best Practices", start);
  const section = content.slice(start, end === -1 ? undefined : end);

  const blocks = extractFencedBlocks(section);
  if (blocks.length === 0) {
    throw new SourceStructureError(source, `${path} 的 Prompt Library 段里没有围栏块`);
  }

  const out: ParsedPrompt[] = [];
  for (const block of blocks) {
    // 标题取块前面最近的 `#### N. 标题`。
    const heading = headingBefore(section, block.start);
    if (!heading) {
      continue;
    }
    // 模态：看块后面的 `Best for:` 行。
    const after = section.slice(block.end, block.end + 400);
    const bestFor = /\*\*Best for:\*\*\s*`?([^`\r\n]+)`?/.exec(after);
    const modality: PromptModality =
      bestFor && bestFor[1] && bestFor[1].toLowerCase().includes("video") ? "VIDEO" : "IMAGE";

    out.push({ title: cleanTitle(heading), body: block.body, modality });
  }
  return out;
}

/**
 * `samuelgrupolimex-prog/suno-style-recipes/styles.csv` —— 音乐曲风（564 条，CC0）。
 *
 * 表头：`style, family, bpm, weirdness, style_influence, style_prompt, structure, url`。
 * `style_prompt` 含逗号 → 必须走 RFC 4180。
 *
 * ⚠️ 每行的 `url` 指向作者的商业站。CC0 允许拿走数据，
 * 但**不能暗示与该商业站有 affiliation** —— 所以这里既不把它当作者、
 * 也不当来源链接（来源链接用 GitHub 上的文件地址）。
 */
function parseSunoStyleRecipesCsv(path: string, content: string): ParsedPrompt[] {
  const source = "samuelgrupolimex-prog/suno-style-recipes";
  const records = parseCsvRecords(content);
  if (records.length === 0) {
    throw new SourceStructureError(source, `${path} 是空的`);
  }

  const header = records[0]?.fields ?? [];
  assertCsvHeader(
    header,
    [
      "style",
      "family",
      "bpm",
      "weirdness",
      "style_influence",
      "style_prompt",
      "structure",
      "url",
    ],
    source,
    path,
  );

  const out: ParsedPrompt[] = [];
  for (const record of records.slice(1)) {
    if (record.fields.length !== header.length) {
      continue;
    }
    const [style, , , , , stylePrompt] = record.fields as string[];
    if (!stylePrompt || stylePrompt.trim().length === 0) {
      continue;
    }
    out.push({ title: cleanTitle(style), body: stylePrompt });
  }
  return out;
}

/**
 * `naqashmunir21/awesome-suno-prompts/packs/*.json` —— 曲风包。
 *
 * 结构：顶层 JSON 数组，条目形如 `{ id, title, prompt, ... }`。
 */
function parseSunoPacksJson(path: string, content: string): ParsedPrompt[] {
  const source = "naqashmunir21/awesome-suno-prompts";
  const array = expectJsonArray(parseJson(content, source), source, `${path} 的顶层`);
  return array.map((raw, index) => {
    const row = expectJsonObject(raw, source, `${path} 第 ${index + 1} 条`);
    if (typeof row.prompt !== "string") {
      throw new SourceStructureError(source, `${path} 第 ${index + 1} 条缺 prompt 字段`);
    }
    return { title: cleanTitle(typeof row.title === "string" ? row.title : null), body: row.prompt };
  });
}

/**
 * `Anil-matcha/awesome-minimax-music-3-prompts/prompts/catalog.json` —— 音乐（21 条，CC BY 4.0）。
 *
 * 结构：`{ "$schema", "model", ..., "entries": [ { id, title, genre, prompt, ... } ] }`。
 */
function parseMinimaxMusicCatalog(path: string, content: string): ParsedPrompt[] {
  const source = "Anil-matcha/awesome-minimax-music-3-prompts";
  const root = expectJsonObject(parseJson(content, source), source, `${path} 的顶层`);
  const entries = expectJsonArray(root.entries, source, `${path} 的 entries`);
  return entries.map((raw, index) => {
    const row = expectJsonObject(raw, source, `${path} 第 ${index + 1} 条`);
    if (typeof row.prompt !== "string") {
      throw new SourceStructureError(source, `${path} 第 ${index + 1} 条缺 prompt 字段`);
    }
    return {
      title: cleanTitle(typeof row.title === "string" ? row.title : null),
      body: row.prompt,
    };
  });
}

/**
 * `musegen/awesome-music-prompts/prompts/*.md` —— 音乐（106 条，MIT）。
 *
 * ⚠️ 同一仓库里标题层级不统一：`genres.md` 用 `###`，而 moods / use-cases /
 * vocals / negative-prompts / tempo-and-structure 用 `##` + 粗体小标题。
 * 只认 `###` 会少收约 70 条 —— 所以标题识别两种都支持。
 */
function parseMusegenReadme(path: string, content: string): ParsedPrompt[] {
  return parseFencedWithHeadings(content, "musegen/awesome-music-prompts");
}

/** `yzfly/awesome-music-prompts/README*.md` —— 音乐（MIT）。 */
function parseYzflyReadme(path: string, content: string): ParsedPrompt[] {
  return parseFencedWithHeadings(content, "yzfly/awesome-music-prompts");
}

/** `suno-ai-farm/awesome-ai-music-prompts/README.md` —— 音乐（MIT）。 */
function parseSunoAiFarmReadme(path: string, content: string): ParsedPrompt[] {
  return parseFencedWithHeadings(content, "suno-ai-farm/awesome-ai-music-prompts");
}

// ---------------------------------------------------------------------------
// 语料源目录
// ---------------------------------------------------------------------------

/**
 * 语料源目录。
 *
 * 顺序 = 采集顺序（主力源在前）。
 *
 * ⚠️ `paths` 里带 `**` 的源需要先列仓库文件树（GitHub trees API）才能展开，
 *    采集器会按需调用。
 */
export const PROMPT_SOURCES: PromptSourceDefinition[] = [
  {
    id: "f/prompts.chat",
    owner: "f",
    repo: "prompts.chat",
    branch: "main",
    paths: ["prompts.csv"],
    parse: parsePromptsChatCsv,
    modality: "TEXT",
    toolTags: ["chatgpt"],
  },
  {
    id: "PlexPt/awesome-chatgpt-prompts-zh",
    owner: "PlexPt",
    repo: "awesome-chatgpt-prompts-zh",
    branch: "main",
    paths: ["prompts-zh.json"],
    parse: parsePlexPtJson,
    modality: "TEXT",
    toolTags: ["chatgpt"],
  },
  {
    id: "YouMind-OpenLab/awesome-seedance-2-prompts",
    owner: "YouMind-OpenLab",
    repo: "awesome-seedance-2-prompts",
    branch: "main",
    paths: ["README.md"],
    parse: parseYouMindReadme,
    modality: "VIDEO",
    toolTags: ["seedance", "seedance-2"],
  },
  {
    id: "ZeroLu/awesome-seedance",
    owner: "ZeroLu",
    repo: "awesome-seedance",
    branch: "main",
    paths: ["README.md", "README-zh.md", "prompts/commercial-use-cases.md"],
    parse: parseZeroLuReadme,
    modality: "VIDEO",
    toolTags: ["seedance", "seedance-2"],
  },
  {
    id: "bytedance/Video-As-Prompt",
    owner: "bytedance",
    repo: "Video-As-Prompt",
    branch: "main",
    // ⚠️ 必须排除 diffusers/ 子树（2,000+ 个无关 blob）。
    paths: ["examples/training/**/validation*.json"],
    parse: parseVideoAsPromptJson,
    modality: "VIDEO",
    toolTags: ["cogvideox", "video-as-prompt"],
  },
  {
    id: "Anil-matcha/awesome-flux-3-api-prompts",
    owner: "Anil-matcha",
    repo: "awesome-flux-3-api-prompts",
    branch: "main",
    paths: ["README.md"],
    parse: parseAnilMatchaFluxReadme,
    modality: "IMAGE",
    toolTags: ["flux", "flux-3"],
  },
  {
    id: "samuelgrupolimex-prog/suno-style-recipes",
    owner: "samuelgrupolimex-prog",
    repo: "suno-style-recipes",
    branch: "main",
    paths: ["styles.csv"],
    parse: parseSunoStyleRecipesCsv,
    modality: "MUSIC",
    toolTags: ["suno"],
  },
  {
    id: "naqashmunir21/awesome-suno-prompts",
    owner: "naqashmunir21",
    repo: "awesome-suno-prompts",
    branch: "main",
    paths: [
      "prompts/afrobeats.md",
      "prompts/country.md",
      "prompts/edm.md",
      "prompts/hip-hop.md",
      "prompts/indie.md",
      "prompts/jazz-blues.md",
      "prompts/jersey-club.md",
      "prompts/k-pop.md",
      "prompts/phonk.md",
      "prompts/pop.md",
      "prompts/regional-mexican.md",
      "prompts/rnb-soul.md",
      "prompts/rock.md",
      "packs/cross-genre-fusion.json",
      "packs/gym-workout.json",
      "packs/heartbreak-emotional.json",
      "packs/viral-tiktok-reels.json",
    ],
    parse: (path, content) =>
      path.endsWith(".json")
        ? parseSunoPacksJson(path, content)
        : parseFencedWithHeadings(content, "naqashmunir21/awesome-suno-prompts"),
    modality: "MUSIC",
    toolTags: ["suno"],
  },
  {
    id: "musegen/awesome-music-prompts",
    owner: "musegen",
    repo: "awesome-music-prompts",
    branch: "main",
    paths: [
      "prompts/genres.md",
      "prompts/moods.md",
      "prompts/negative-prompts.md",
      "prompts/tempo-and-structure.md",
      "prompts/use-cases.md",
      "prompts/vocals.md",
    ],
    parse: parseMusegenReadme,
    modality: "MUSIC",
    toolTags: ["suno"],
  },
  {
    id: "yzfly/awesome-music-prompts",
    owner: "yzfly",
    repo: "awesome-music-prompts",
    branch: "main",
    paths: ["README.md", "README.zh-CN.md"],
    parse: parseYzflyReadme,
    modality: "MUSIC",
    toolTags: ["stable-audio", "musicgen", "musicfx"],
  },
  {
    id: "suno-ai-farm/awesome-ai-music-prompts",
    owner: "suno-ai-farm",
    repo: "awesome-ai-music-prompts",
    branch: "main",
    paths: ["README.md"],
    parse: parseSunoAiFarmReadme,
    modality: "MUSIC",
    toolTags: ["suno", "udio", "musicgen", "stable-audio"],
  },
  {
    id: "Anil-matcha/awesome-minimax-music-3-prompts",
    owner: "Anil-matcha",
    repo: "awesome-minimax-music-3-prompts",
    // ⚠️ 这个仓库的默认分支是 master，不是 main。
    branch: "master",
    paths: ["prompts/catalog.json"],
    parse: parseMinimaxMusicCatalog,
    modality: "MUSIC",
    toolTags: ["minimax-music-3"],
  },
];

/** 按 id 找源定义。 */
export function findPromptSource(id: string): PromptSourceDefinition | undefined {
  return PROMPT_SOURCES.find((source) => source.id === id);
}
