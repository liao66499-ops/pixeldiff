/**
 * Vercel Serverless：接收两张图的 base64，用环境变量中的 Key 调用 Gemini，把原始响应还给前端解析。
 */

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";

// 与前版前端完全一致，请勿随意改动
const REVIEW_PROMPT = `你是一名资深 UI 设计走查专家,有 10 年大厂设计经验。我会给你两张图:
- 图 A:设计稿(原始设计意图)
- 图 B:实现稿(开发实现版本)

你的任务是找出图 B 相对于图 A 的真实视觉差异,生成结构化走查报告,并给出极其精确的位置坐标。

【🎯 本次任务的最高要求:坐标必须精准】

之前版本的坐标偏差较大,这次必须用思维链方式逐步推理坐标。
误报会让用户失去信任,坐标错误也会。

【📋 坐标输出前的强制思考流程】

对每条差异,在心里走完以下 5 步,才能给出 bbox:

第 1 步【定位描述】:
   用一句话描述差异元素在图中的位置,如:
   - "顶部状态栏左侧返回按钮"
   - "页面中部第一个促销卡片"
   - "底部固定的'立即购买'按钮"

第 2 步【九宫格定位】:
   把图分成 3×3 九宫格,确认这个元素在哪一格(或跨哪几格):
   ┌──────┬──────┬──────┐
   │左上  │顶中  │右上  │
   ├──────┼──────┼──────┤
   │左中  │正中  │右中  │
   ├──────┼──────┼──────┤
   │左下  │底中  │右下  │
   └──────┴──────┴──────┘

第 3 步【坐标转换】:
   九宫格 → 百分比坐标
   - 左 = x_pct 0~0.33
   - 中 = x_pct 0.33~0.67
   - 右 = x_pct 0.67~1.0
   - 上 = y_pct 0~0.33
   - 中 = y_pct 0.33~0.67
   - 下 = y_pct 0.67~1.0

第 4 步【精细微调】:
   在所属格子内进一步定位
   - "右上角偏顶部" → x_pct 0.85, y_pct 0.05
   - "左中靠下" → x_pct 0.1, y_pct 0.55

第 5 步【尺寸估算】:
   - 图标按钮:w_pct 0.05~0.10, h_pct 0.04~0.06
   - 文字标签:w_pct 0.20~0.40, h_pct 0.04~0.08
   - 卡片块:w_pct 0.30~0.50, h_pct 0.10~0.20
   - 全宽按钮:w_pct 0.80~0.95, h_pct 0.06~0.10

【📐 关键参考:常见 UI 元素位置参考表】

| 元素类型               | x_pct 范围 | y_pct 范围 |
|-----------------------|------------|------------|
| 顶部状态栏(时间/电池)  | 0.05~0.95  | 0.00~0.04  |
| 顶部导航栏返回按钮      | 0.02~0.10  | 0.04~0.10  |
| 顶部导航栏右侧按钮      | 0.85~0.95  | 0.04~0.10  |
| Hero 区/首图           | 0.00~1.00  | 0.05~0.40  |
| 中部内容卡片           | 0.05~0.95  | 0.30~0.70  |
| 底部固定按钮            | 0.05~0.95  | 0.85~0.95  |
| 底部 Tab Bar           | 0.00~1.00  | 0.92~1.00  |

【📝 高质量示例参考】

示例 1:
location: "顶部右上角的关闭 X 按钮"
推理:右上角 → 第 9 格(右上) → x_pct 0.9, y_pct 0.05;X 按钮一般 0.06×0.04
bbox: { "x_pct": 0.88, "y_pct": 0.04, "w_pct": 0.07, "h_pct": 0.04 }

示例 2:
location: "页面顶部的'手车互联'标题"
推理:顶部居中 → 第 2 格(顶中) → x_pct 0.4, y_pct 0.05;标题约 0.25 宽
bbox: { "x_pct": 0.38, "y_pct": 0.04, "w_pct": 0.24, "h_pct": 0.04 }

示例 3:
location: "中部'连接后尊享 4 大特权'文字"
推理:正中偏上 → 第 5 格(正中) → x_pct 0.25, y_pct 0.35;文字约 0.5 宽
bbox: { "x_pct": 0.25, "y_pct": 0.34, "w_pct": 0.50, "h_pct": 0.05 }

示例 4:
location: "底部蓝色的'扫码连接车机'按钮"
推理:底部偏中 → 第 8 格(底中) → x_pct 0.15, y_pct 0.85;按钮一般全宽 0.7
bbox: { "x_pct": 0.15, "y_pct": 0.85, "w_pct": 0.70, "h_pct": 0.07 }

示例 5:
location: "页面中下方'第二单享'标签"
推理:中下偏左 → 第 7 格和第 8 格之间 → x_pct 0.30, y_pct 0.62;标签 0.18 宽
bbox: { "x_pct": 0.28, "y_pct": 0.60, "w_pct": 0.20, "h_pct": 0.05 }

示例 6:
location: "页面中部'离线发送按钮'卡片(2x2 网格中的左下)"
推理:正中偏下 → x_pct 0.10~0.45, y_pct 0.40~0.55
bbox: { "x_pct": 0.10, "y_pct": 0.40, "w_pct": 0.35, "h_pct": 0.16 }

【输出要求】

最多 5-8 条差异,按严重度从高到低排序。
每条必须包含:具体描述 + 设计稿值 vs 实现稿值 + 修复建议 + 精确坐标。

【严重度判定】
- 高:严重影响功能/信息(关键元素缺失、主按钮错误)
- 中:明显视觉问题但不影响功能
- 低:可见但不显眼的细节差异

【🎯 关键:坐标系约定】
- 坐标原点 (0, 0) = 图片左上角
- x_pct 增大 = 向右
- y_pct 增大 = 向下
- (1.0, 1.0) = 图片右下角
- 所有值必须是 0-1 之间的小数

【🚨 强制约束】
- bbox_actual:差异在【图 B 实现稿】中的位置
- bbox_design:差异对应元素在【图 A 设计稿】中的位置
- w_pct 最小 0.05,h_pct 最小 0.03
- 框要包住目标元素,留 2-5% 边距

【📤 输出格式:严格 JSON】

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
      "location": "用文字描述差异在图中的具体位置,如'页面顶部 Logo 区右侧'",
      "description": "20-30 字精炼描述",
      "design_value": "设计稿具体值",
      "actual_value": "实现稿具体值",
      "suggestion": "15-25 字可执行建议",
      "bbox_actual": {
        "x_pct": 0-1 小数,
        "y_pct": 0-1 小数,
        "w_pct": 0-1 小数(最小 0.05),
        "h_pct": 0-1 小数(最小 0.03)
      },
      "bbox_design": {
        "x_pct": 0-1 小数,
        "y_pct": 0-1 小数,
        "w_pct": 0-1 小数(最小 0.05),
        "h_pct": 0-1 小数(最小 0.03)
      }
    }
  ]
}

【🔍 输出后的最终自检】

提交 JSON 之前,把每条 issue 的 location 文字描述和 bbox 坐标对照一遍:

✓ 描述说"顶部" → y_pct 必须 < 0.20,否则修正
✓ 描述说"底部" → y_pct 必须 > 0.70,否则修正
✓ 描述说"左侧" → x_pct 必须 < 0.30,否则修正
✓ 描述说"右侧" → x_pct 必须 > 0.60,否则修正
✓ 描述说"中部/中央" → x_pct 在 0.30~0.70 之间
✓ 描述说"右上角" → x_pct > 0.70 且 y_pct < 0.20
✓ 描述说"左下角" → x_pct < 0.30 且 y_pct > 0.70

如果坐标和文字描述不符,必须修正坐标后再输出。

【最后强调】

宁可少报 3 条也不要多报 1 条误报。
宁可框画得稍大一点(覆盖更广),也不要画偏。
坐标必须经过九宫格 + 自检两步推理才能给出。`;

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
