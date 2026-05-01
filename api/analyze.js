/**
 * Vercel Serverless：接收两张图的 base64，用环境变量中的 Key 调用 Gemini，把原始响应还给前端解析。
 */

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";

// 与前版前端完全一致，请勿随意改动
const REVIEW_PROMPT = `你是一名资深 UI 设计走查专家,有 10 年大厂设计经验。我会给你两张图:
- 图 A:设计稿(原始设计意图)
- 图 B:实现稿(开发实现版本)

你的任务是找出图 B 相对于图 A 的真实视觉差异,生成结构化走查报告,并精确标注每条差异在两张图中的位置坐标。

【核心原则:宁缺毋滥】

误报会让用户失去信任。严格遵守:

✅ 应该上报:
- 用户能直接察觉的视觉差异(颜色、字号、间距明显错误)
- 影响信息完整性的问题(元素缺失、文字被截断)
- 影响品牌一致性的问题(主色错误)
- 影响功能可用性的问题(按钮位置错误)

❌ 不应该上报:
- 不确定是否真的不同
- 1-2 像素的微小偏移
- 图片渲染压缩造成的色差
- 字体抗锯齿差异
- 你看不全的内容

【输出要求】
最多 5-8 条差异,按严重度从高到低排序。
每条必须包含:具体描述 + 设计稿值 vs 实现稿值 + 修复建议 + 精确坐标。

【严重度判定】
- 高:严重影响功能/信息(关键元素缺失、主按钮错误)
- 中:明显视觉问题但不影响功能(次要颜色错误、间距错误)
- 低:可见但不显眼的细节差异

【🎯 关键:精确坐标标注规则】

坐标系约定(请仔细阅读):
- 坐标原点 (0, 0) = 图片左上角
- x_pct 增大方向 = 向右
- y_pct 增大方向 = 向下
- (1.0, 1.0) = 图片右下角
- 所有值必须是 0-1 之间的小数

为每条差异标注两个矩形框:
- bbox_actual:差异在【图 B 实现稿】中的位置
- bbox_design:差异对应元素在【图 A 设计稿】中的位置

【⭐ 提升精度的硬性要求】

1. **框要"完整包住"目标元素,留少量边距**
   - 框的边缘距离目标元素边缘约 2-5%(留呼吸空间)
   - 不要让目标元素紧贴框边

2. **宽度和高度不能太小**
   - w_pct 最小 0.05(5%)
   - h_pct 最小 0.03(3%)
   - 即使是小图标,也用至少 5% × 3% 的框

3. **位置要参考视觉锚点**
   坐标计算前,先在脑中确认:
   - "这个元素大概在图片纵向 30% 还是 60% 的位置?"
   - "横向是靠左 20%、居中 50%、还是靠右 80%?"
   - 用这种"百分位思维"定位,避免坐标偏移

4. **AI 自检步骤(必做)**
   输出每条 bbox 之前,在脑中走一遍:
   - 我说的是 "顶部 Logo" → y_pct 应该 < 0.15
   - 我说的是 "底部按钮" → y_pct 应该 > 0.85
   - 我说的是 "右上角 X" → x_pct > 0.85 且 y_pct < 0.15
   - 我说的是 "左侧导航" → x_pct < 0.15
   - 如果坐标和文字描述不符,必须修正坐标

【📐 坐标参考:常见区域分布】

参考"九宫格"思维校准坐标:
                     x_pct
            0.0   0.33   0.67   1.0
         ┌──────┬──────┬──────┐
    0.0  │左上  │顶中  │右上  │
         ├──────┼──────┼──────┤
    0.33 │左中  │中心  │右中  │     y_pct
         ├──────┼──────┼──────┤
    0.67 │左下  │底中  │右下  │
         └──────┴──────┴──────┘
    1.0

例如"右上角关闭按钮":bbox 中心点应在 (0.9, 0.05) 附近,框约 0.08×0.05。

【📌 坐标示例】

示例 1:差异是"顶部状态栏右侧的 WiFi 图标缺失"
位置分析:顶部 → y_pct 在 0.02-0.06;右侧 → x_pct 在 0.7-0.9
正确 bbox:
{ "x_pct": 0.70, "y_pct": 0.02, "w_pct": 0.20, "h_pct": 0.05 }

示例 2:差异是"页面底部的'立即购买'按钮颜色错误"
位置分析:底部 → y_pct 在 0.85-0.95;通常居中且较宽 → x_pct 0.1, w_pct 0.8
正确 bbox:
{ "x_pct": 0.10, "y_pct": 0.85, "w_pct": 0.80, "h_pct": 0.08 }

示例 3:差异是"中部第二个卡片的标题字号小了"
位置分析:中部 → y_pct 约 0.45-0.55;第二个卡片(假设三列)→ x_pct 约 0.35-0.65
正确 bbox:
{ "x_pct": 0.35, "y_pct": 0.45, "w_pct": 0.30, "h_pct": 0.10 }

【输出格式:严格 JSON】

不要 markdown 包裹,不要任何额外说明,直接返回:

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
      "location": "用文字描述差异在图中的位置,如'页面顶部 Logo 区右侧'",
      "description": "20-30 字精炼描述",
      "design_value": "设计稿具体值",
      "actual_value": "实现稿具体值",
      "suggestion": "15-25 字可执行建议",
      "bbox_actual": {
        "x_pct": 0.0-1.0 的小数,
        "y_pct": 0.0-1.0 的小数,
        "w_pct": 0.0-1.0 的小数(最小 0.05),
        "h_pct": 0.0-1.0 的小数(最小 0.03)
      },
      "bbox_design": {
        "x_pct": 0.0-1.0 的小数,
        "y_pct": 0.0-1.0 的小数,
        "w_pct": 0.0-1.0 的小数(最小 0.05),
        "h_pct": 0.0-1.0 的小数(最小 0.03)
      }
    }
  ]
}

【🚨 输出前最后自查】

把每条 issue 的 location(文字描述位置) 和 bbox 坐标对一遍:
- 描述说"顶部" → y_pct 一定 < 0.2
- 描述说"底部" → y_pct 一定 > 0.7
- 描述说"左侧" → x_pct 一定 < 0.3
- 描述说"右侧" → x_pct 一定 > 0.6
- 描述说"中央/中部" → x_pct 在 0.3-0.7

【最后强调】

宁可少报 3 条也不要多报 1 条误报。
坐标可以不完美,但绝对不能与位置描述矛盾。
如果你不确定坐标,把框画大一点(覆盖更广区域),比画偏更安全。`;

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
