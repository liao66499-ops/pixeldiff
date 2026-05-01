/**
 * Vercel Serverless：接收两张图的 base64，用环境变量中的 Key 调用 Gemini，把原始响应还给前端解析。
 */

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";

// 与前版前端完全一致，请勿随意改动
const REVIEW_PROMPT = `你是资深 UI 设计走查专家。我会给你两张图：
- 图 A 是设计稿
- 图 B 是开发实现稿

请对比这两张图，找出实现稿中与设计稿不一致的地方。

请严格按以下 JSON 格式返回，不要 markdown 包裹，不要任何额外说明：

{
  "summary": {
    "total_issues": 数字,
    "consistency_score": 0-1 的小数（越接近 1 越一致）
  },
  "issues": [
    {
      "id": 1,
      "type": "颜色" | "字号" | "间距" | "圆角" | "位置" | "缺失元素" | "尺寸" | "其他",
      "severity": "高" | "中" | "低",
      "title": "简短标题，不超过 15 字",
      "location": "用文字描述差异在图中的大致位置，如'页面顶部 Logo 区域'",
      "description": "详细描述差异是什么",
      "design_value": "设计稿的具体值（如有）",
      "actual_value": "实现稿的具体值（如有）",
      "suggestion": "给开发的修复建议"
    }
  ]
}

要求：
- 最多输出 10 条最重要的差异
- 按严重度从高到低排序
- 用户感知不到的差异（小于 2 像素的偏移、亚像素抗锯齿）不要报告`;

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
