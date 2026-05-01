/**
 * Vercel Serverless：接收两张图的 base64，用环境变量中的 Key 调用 Gemini，把原始响应还给前端解析。
 */

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";

// 与前版前端完全一致，请勿随意改动
const REVIEW_PROMPT = `你是一名资深 UI 设计走查专家,有 10 年大厂设计经验。我会给你两张图:
- 图 A:设计稿(原始设计意图)
- 图 B:实现稿(开发实现版本)

你的任务是找出图 B 相对于图 A 的真实视觉差异,并生成结构化走查报告。

【核心原则:宁缺毋滥】

这是一个生产环境的走查工具,误报会让用户失去信任。
你必须严格遵守以下"上报门槛":

✅ 应该上报:
- 用户能直接察觉的视觉差异(颜色、字号、间距明显错误)
- 影响信息完整性的问题(元素缺失、文字被截断)
- 影响品牌一致性的问题(主色错误、Logo 变形)
- 影响功能可用性的问题(按钮位置错误、关键文案缺失)

❌ 不应该上报:
- 不确定是否真的不同(任何"可能""似乎""看起来"的判断都不要报)
- 1-2 像素的微小偏移(用户感知不到)
- 图片渲染压缩造成的色差(浏览器/截图工具差异)
- 字体抗锯齿的细微差异
- 阴影、模糊等可能由截图分辨率导致的差异
- 你只能从图片侧面/边缘推测的内容(看不全的不报)

【输出要求】

最多 5-8 条差异。如果差异很少,5 条以下也可以。
绝对不要为了凑数量而上报"可能存在"的问题。

每条差异必须包含:
1. 具体的视觉描述(说出"是什么差异")
2. 设计稿值 vs 实现稿值的对比(尽可能给出具体值,如颜色/字号)
3. 修复建议(开发拿了能直接动手改的程度)

【严重度判定标准:严格执行】

- 高:严重影响功能/信息完整性。如关键元素缺失、主按钮颜色完全错误、文字被截断导致看不到关键内容
- 中:明显的视觉一致性问题但不影响功能。如次要颜色错误、间距明显错误、字重不一致
- 低:可见但不显眼的细节差异。如装饰性元素差异、不影响阅读的微小调整

如果一个问题"用户可能 3 秒内看不到",一律降到中或低。

【输出格式:严格 JSON】

请严格按以下 JSON 格式返回,不要 markdown 包裹,不要任何额外说明:

{
  "summary": {
    "total_issues": 数字,
    "consistency_score": 0-1 的小数(差异越少越接近 1,无差异返回 1.0)
  },
  "issues": [
    {
      "id": 1,
      "type": "颜色" 或 "字号" 或 "字重" 或 "间距" 或 "圆角" 或 "位置" 或 "缺失元素" 或 "尺寸" 或 "其他",
      "severity": "高" 或 "中" 或 "低",
      "title": "8-15 字的简短标题,直接说差异是什么",
      "location": "用文字描述差异在图中的位置,如'页面顶部 Logo 区右侧'",
      "description": "20-30 字的精炼描述,说清楚差异点。不要重复 title 内容。",
      "design_value": "设计稿的具体值,如'#FF5722' 或 '16px' 或 '包含图标'",
      "actual_value": "实现稿的具体值,如'#FF6B3D' 或 '14px' 或 '无图标'",
      "suggestion": "给开发的可执行建议,15-25 字。如'将按钮颜色改为 #FF5722 主色'"
    }
  ]
}

【排序与排除】

- issues 按严重度从高到低排序(高在前)
- 如果同一个区域有多个相关差异,合并成一条上报,不要拆碎
- 如果你不确定某个差异是否真实存在,不要上报,降低条数

【最后强调】

宁可少报 3 条也不要多报 1 条误报。
你的报告会被设计师直接发给开发,任何错误判断都会浪费团队时间。`;

module.exports = async (req, res) => {
  // 仅接受 POST（避免浏览器预检走错方法时可再扩展 OPTIONS）
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "仅支持 POST，请从前端调用 /api/analyze。" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !String(apiKey).trim()) {
    return res.status(500).json({
      error:
        "服务器未配置环境变量 GEMINI_API_KEY。请在 Vercel 项目 Settings → Environment Variables 中添加后再部署。",
    });
  }

  // Vercel 会把 JSON body 解析为对象；若为字符串则再 parse 一次（兼容极少数情况）
  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ error: "请求体不是合法 JSON。" });
    }
  }

  const designMimeType = body?.designMimeType;
  const designBase64 = body?.designBase64;
  const actualMimeType = body?.actualMimeType;
  const actualBase64 = body?.actualBase64;

  if (
    !designMimeType ||
    !designBase64 ||
    !actualMimeType ||
    !actualBase64 ||
    typeof designMimeType !== "string" ||
    typeof designBase64 !== "string" ||
    typeof actualMimeType !== "string" ||
    typeof actualBase64 !== "string"
  ) {
    return res.status(400).json({
      error:
        "请求体缺少字段。需要：designMimeType、designBase64、actualMimeType、actualBase64（均为字符串）。",
    });
  }

  const geminiPayload = {
    contents: [
      {
        role: "user",
        parts: [
          { text: REVIEW_PROMPT },
          { text: "图 A（设计稿）" },
          {
            inline_data: {
              mime_type: designMimeType,
              data: designBase64,
            },
          },
          { text: "图 B（实现稿）" },
          {
            inline_data: {
              mime_type: actualMimeType,
              data: actualBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
    },
  };

  const url = `${GEMINI_URL}?key=${encodeURIComponent(String(apiKey).trim())}`;

  let geminiResp;
  try {
    geminiResp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload),
    });
  } catch (e) {
    return res.status(502).json({
      error: "调用 Gemini 网络失败（可能是超时或 DNS）。",
      details: String(e && e.message ? e.message : e),
    });
  }

  const rawText = await geminiResp.text();

  // 不成功时把 Gemini 原始返回透传给前端，便于你对照报错
  if (!geminiResp.ok) {
    return res.status(502).json({
      error: `Gemini API 返回 HTTP ${geminiResp.status}`,
      details: rawText,
    });
  }

  // 前端仍用原先的 parseGeminiResponse 解析整段 Gemini 外层 JSON 字符串
  return res.status(200).json({ rawText });
};
