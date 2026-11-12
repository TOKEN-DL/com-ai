/**
 * Prompt 语料的解析基元（票 #15）。
 *
 * 三个源各有三种格式（CSV / JSON / Markdown），但**只有一个硬要求**：
 * **解析出来的正文必须与来源逐字一致** ——
 * 验收标准里「一键复制出的提示词原文与来源逐字一致」是硬指标。
 *
 * 所以这个文件里的所有解析函数都遵守同一条规矩：
 *
 * > **不 trim、不规范化、不截断。**
 *
 * 需要「看起来整齐」的地方（标题）可以 trim；**正文不行**。
 * 一条 prompt 末尾有没有换行、引号是 `""` 还是 `"`、中间是 LF 还是 CRLF ——
 * 都是来源的一部分，照抄。
 *
 * ## CSV 为什么自己写
 *
 * `f/prompts.chat/prompts.csv` 的实测形态（见实测笔记）：
 *   - 10,471,671 字节 / 2,898 条记录，但**物理行数 198,391** ——
 *     72% 的记录在 `prompt` 字段里含换行，任何 `split("\n")` / `split(",")`
 *     的写法都会产出完全错误的数据；
 *   - 记录分隔符全是 CRLF，**字段内换行是裸 LF**；
 *   - 最大单字段 144,260 码点，**超过 Python csv 模块默认的 131,072 上限**。
 *
 * 所以必须走 RFC 4180 状态机（引号内的逗号与换行都是数据）。
 * 这段状态机与 Python `csv` 模块对 2,898 条记录逐条 SHA-256 完全一致，
 * 且在「本地文件流 / 加 BOM / chunk 切到 1、3、7、13 字节 / 网络流」七种条件下
 * 结果都逐字节相同。
 */
import { SourceStructureError } from "@/collector/errors";

/** 一条 CSV 记录。 */
export type CsvRecord = {
  /** 解析后的字段值（已解开引号、还原 `""` 转义）。 */
  fields: string[];
  /** 记录序号，从 1 开始。注意：这是「记录号」不是物理行号。 */
  recordNumber: number;
};

export type CsvParserOptions = {
  /** 每解析完一条记录调用一次。返回 false 可提前停止解析。 */
  onRecord?: (record: CsvRecord) => boolean | void;
};

/**
 * RFC 4180 CSV 解析器（零依赖）。
 *
 * 状态机：
 *   - `start` —— 字段开头（引号或裸字符）；
 *   - `unquoted` —— 裸字段；
 *   - `quoted` —— 引号内（逗号与换行都是**数据**）；
 *   - `afterQuoted` —— 闭引号之后（可能是 `""` 转义，也可能是字段结束）。
 */
export class CsvParser {
  /** 当前字段的内容缓冲。 */
  private buffer = "";
  private fields: string[] = [];
  private state: "start" | "unquoted" | "quoted" | "afterQuoted" = "start";
  /** 上一个字符是不是 CR —— 用来吞掉 CRLF 里的 LF。 */
  private lastWasCr = false;
  private recordNumber = 0;
  private sawFirstChunk = false;
  private stopped = false;
  private readonly options: CsvParserOptions;

  constructor(options: CsvParserOptions = {}) {
    this.options = options;
  }

  /** 推入一段已解码的文本。chunk 边界可以落在引号中间。 */
  push(text: string): void {
    if (this.stopped) {
      return;
    }

    // 显式剥掉 UTF-8 BOM：TextDecoder 默认会剥，但上层换了 decoder 就会漏。
    if (!this.sawFirstChunk) {
      this.sawFirstChunk = true;
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
    }

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];

      // CRLF：\r 已经结束记录，紧跟的 \n 必须吞掉，否则会多出一条空记录。
      if (this.lastWasCr) {
        this.lastWasCr = false;
        if (char === "\n") {
          continue;
        }
      }

      switch (this.state) {
        case "start":
          if (char === '"') {
            this.state = "quoted";
          } else if (char === ",") {
            this.endField();
          } else if (char === "\n") {
            this.endField();
            this.endRecord();
          } else if (char === "\r") {
            this.lastWasCr = true;
            this.endField();
            this.endRecord();
          } else {
            this.buffer += char;
            this.state = "unquoted";
          }
          break;

        case "unquoted":
          if (char === ",") {
            this.endField();
            this.state = "start";
          } else if (char === "\n") {
            this.endField();
            this.endRecord();
            this.state = "start";
          } else if (char === "\r") {
            this.lastWasCr = true;
            this.endField();
            this.endRecord();
            this.state = "start";
          } else {
            this.buffer += char;
          }
          break;

        case "quoted":
          if (char === '"') {
            this.state = "afterQuoted";
          } else {
            // 引号内的换行 / 逗号都是数据。
            this.buffer += char;
          }
          break;

        case "afterQuoted":
          if (char === '"') {
            // `""` → 字面量双引号。
            this.buffer += '"';
            this.state = "quoted";
          } else if (char === ",") {
            this.endField();
            this.state = "start";
          } else if (char === "\n") {
            this.endField();
            this.endRecord();
            this.state = "start";
          } else if (char === "\r") {
            this.lastWasCr = true;
            this.endField();
            this.endRecord();
            this.state = "start";
          }
          // 闭合引号后的其它字符按 RFC 忽略。
          break;
      }
    }
  }

  /** 文件结束时冲刷最后一条记录（文件末尾可能没有换行符）。 */
  end(): void {
    if (this.stopped) {
      return;
    }
    if (this.state === "quoted") {
      // 容忍未闭合引号（脏数据）。
      this.endField();
    } else if (this.buffer.length > 0 || this.fields.length > 0) {
      this.endField();
    }
    this.endRecord();
  }

  private endField(): void {
    this.fields.push(this.buffer);
    this.buffer = "";
  }

  private endRecord(): void {
    if (this.fields.length === 0) {
      return; // 空行跳过
    }
    this.recordNumber += 1;
    const record: CsvRecord = { fields: this.fields, recordNumber: this.recordNumber };
    this.fields = [];
    if (this.options.onRecord && this.options.onRecord(record) === false) {
      this.stopped = true;
    }
  }
}

/**
 * 解析一整段 CSV 文本，返回全部记录。
 *
 * 字段值**原样返回**（不 trim）—— 上游的 `prompt` 字段里有多少空白就是多少。
 */
export function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  const parser = new CsvParser({
    onRecord: (record) => {
      records.push(record);
    },
  });
  parser.push(text);
  parser.end();
  return records;
}

/** 一个围栏代码块。 */
export type FencedBlock = {
  /**
   * 围栏里的正文。
   *
   * ⚠️ **逐字原文**：从开围栏那一行之后到闭围栏那一行之前的**全部字符**，
   * 含末尾的行结束符。不 trim、不改行尾 —— 详见本文件顶部的说明。
   */
  body: string;
  /** 围栏的语言标记（```md 里的 `md`）；没有就是 null。 */
  language: string | null;
  /** 围栏块在原文里的起始偏移（含开围栏行）。 */
  start: number;
  /** 围栏块在原文里的结束偏移（不含闭围栏行）。 */
  end: number;
};

/**
 * 提取 Markdown 里的围栏代码块。
 *
 * 正文取的是**开围栏行之后到闭围栏行之前的原始切片**，
 * 所以 `source.slice(block.start, block.end)` 能逐字还原出这段正文 ——
 * 测试就靠这条断言「复制出来的与来源逐字一致」。
 *
 * 闭围栏必须顶格或至多缩进 3 个空格（CommonMark 的规则），
 * 否则正文里的缩进代码块会被误判成围栏。
 */
export function extractFencedBlocks(markdown: string): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  // 开围栏：行首至多 3 个空格 + ``` + 语言标记。
  const openRe = /^[ \t]{0,3}```([^\r\n]*)\r?\n/gm;

  let match: RegExpExecArray | null;
  while ((match = openRe.exec(markdown)) !== null) {
    const bodyStart = match.index + match[0].length;
    // 闭围栏：行首至多 3 个空格 + ```（后面必须换行或到文件末尾）。
    const closeRe = /^[ \t]{0,3}```(?=\r?\n|$)/gm;
    closeRe.lastIndex = bodyStart;
    const close = closeRe.exec(markdown);
    if (!close) {
      // 没有闭围栏 —— 文件被截断。剩下的不算一条。
      break;
    }

    blocks.push({
      body: markdown.slice(bodyStart, close.index),
      language: (match[1] ?? "").trim() || null,
      start: match.index,
      end: close.index,
    });

    // 从闭围栏之后继续找（闭围栏行本身不参与匹配）。
    openRe.lastIndex = close.index + close[0].length;
  }

  return blocks;
}

/**
 * 围栏块前面最近的标题。
 *
 * 认两种形态：
 *   - Markdown 标题（`#` ~ `####`）；
 *   - 独占一行的**粗体小标题**（`**Pop — Radio Anthem**`）——
 *     `musegen/awesome-music-prompts` 的 moods / use-cases / vocals 等文件
 *     用的是这种形态而**不是** `###`，只认标题会少收约 70 条。
 *
 * 粗体只在块前 12 行内找：再远就多半是上一段正文里的强调，
 * 拿它当标题反而更糟。
 *
 * 找不到标题时返回 null —— 标题只用来展示，不影响正文。
 */
export function headingBefore(markdown: string, offset: number): string | null {
  const before = markdown.slice(0, offset);
  const lines = before.split(/\r?\n/);

  // ① 先找最近的 Markdown 标题（不限距离）。
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = /^[ \t]{0,3}#{1,4}[ \t]+([^\r\n]+?)[ \t]*$/.exec(lines[i] ?? "");
    if (match) {
      const title = (match[1] ?? "").trim();
      if (title.length > 0) {
        return title;
      }
    }
  }

  // ② 没有 Markdown 标题 → 在附近找粗体小标题。
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i -= 1) {
    const match = /^[ \t]{0,3}\*\*([^*\r\n]+)\*\*[ \t]*$/.exec(lines[i] ?? "");
    if (match) {
      const title = (match[1] ?? "").trim();
      if (title.length > 0) {
        return title;
      }
    }
  }

  return null;
}

/** 解析 JSON，失败时抛 {@link SourceStructureError}（结构变了要显式失败）。 */
export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SourceStructureError(
      source,
      `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 断言 JSON 是数组；不是就抛 {@link SourceStructureError}。 */
export function expectJsonArray(value: unknown, source: string, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SourceStructureError(source, `${what} 不是数组（实际是 ${typeof value}）`);
  }
  return value;
}

/** 断言 JSON 是对象；不是就抛 {@link SourceStructureError}。 */
export function expectJsonObject(
  value: unknown,
  source: string,
  what: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceStructureError(source, `${what} 不是对象`);
  }
  return value as Record<string, unknown>;
}
