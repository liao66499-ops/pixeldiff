/**
 * Vercel Serverless：接收两张图的 base64，用环境变量中的 Key 调用 Gemini，把原始响应还给前端解析。
 */

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";

// 与前版前端完全一致，请勿随意改动
const REVIEW_PROMPT = `你是一名资深 UI 设计走查专家,有 10 年大厂设计经验。我会给你两张图:
- 图 A:设计稿(原始设计意图)
- 图 B:实现稿(开发实现版本)

你的任务是找出图 B 相对于图 A 的真实视觉差异,生成结构化走查报告,并标注每条差异在两张图中的大致位置。

【核心原则:宁缺毋滥】

误报会让用户失去信任。严格遵守:

✅ 应该上报:
- 用户能直接察觉的视觉差异(颜色、字号、间距明显错误)
- 影响信息完整性的问题(元素缺失、文字被截断)
- 影响品牌一致性的问题(主色错误)
- 影响功能可用性的问题(按钮位置错误)

❌ 不应该上报:
- 不确定是否真的不同(任何"可能""似乎"的判断都不要报)
- 1-2 像素的微小偏移
- 图片渲染压缩造成的色差
- 字体抗锯齿差异
- 你看不全的内容

【输出要求】

最多 5-8 条差异。
每条必须包含:具体描述 + 设计稿值 vs 实现稿值 + 修复建议。

【严重度判定】

- 高:严重影响功能/信息(关键元素缺失、主按钮错误)
- 中:明显视觉问题但不影响功能(次要颜色错误、间距错误)
- 低:可见但不显眼的细节差异

【关键:位置坐标(新增)】

为每条差异标注两个矩形框,使用百分比坐标(0-1 之间的小数):

bbox_actual:差异在图 B(实现稿)中的位置
  - 这是"错误的位置/状态"
  - x_pct, y_pct:左上角相对于图 B 的位置(0=最左/最上, 1=最右/最下)
  - w_pct, h_pct:框的宽度和高度,相对于图 B 的尺寸

bbox_design:差异对应元素在图 A(设计稿)中的位置
  - 这是"正确的位置/参考"
  - 同样是百分比

如果一个元素在实现稿中"缺失",bbox_actual 标注它本应出现的位置即可。

百分比要尽量准确,但不要执着于像素级精度。框要稍微大一点,把目标元素完整框住,框外边距留一点点。

【输出格式:严格 JSON】

不要 markdown 包裹,不要任何额外说明,直接返回 JSON:

{
  "summary": {
    "total_issues": 数字,
    "consistency_score": 0-1 的小数
  },
  "issues": [
    {
      "id": 1,
      "type": "颜色" 或 "字号" 或 "字重" 或 "间距" 或 "圆角" 或 "位置" 或 "缺失元素" 或 "尺寸" 或 "其他",
      "severity": "高" 或 "中" 或 "低",
      "title": "8-15 字简短标题",
      "location": "如'页面顶部 Logo 区右侧'",
      "description": "20-30 字精炼描述",
      "design_value": "设计稿具体值",
      "actual_value": "实现稿具体值",
      "suggestion": "15-25 字可执行建议",
      "bbox_actual": {
        "x_pct": 0.0-1.0 的小数,
        "y_pct": 0.0-1.0 的小数,
        "w_pct": 0.0-1.0 的小数,
        "h_pct": 0.0-1.0 的小数
      },
      "bbox_design": {
        "x_pct": 0.0-1.0 的小数,
        "y_pct": 0.0-1.0 的小数,
        "w_pct": 0.0-1.0 的小数,
        "h_pct": 0.0-1.0 的小数
      }
    }
  ]
}

【bbox 示例】

如果差异是"主按钮在图 B 底部偏左",而设计稿中按钮居中:
- bbox_actual:{ x_pct: 0.05, y_pct: 0.85, w_pct: 0.4, h_pct: 0.08 }
- bbox_design:{ x_pct: 0.25, y_pct: 0.88, w_pct: 0.5, h_pct: 0.08 }

【排序】

issues 按严重度从高到低排序。

【最后强调】

宁可少报 3 条也不要多报 1 条误报。
bbox 坐标要尽量准,但允许有一定误差。`;

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
