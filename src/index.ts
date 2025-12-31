export interface Env {
  AI: any;
  DB: D1Database;
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  LARK_VERIFICATION_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
      const body = await request.json() as any;

      // 1. 飞书验证
      if (body.type === 'url_verification') {
        if (body.token !== env.LARK_VERIFICATION_TOKEN) return new Response('Invalid Token', { status: 403 });
        return new Response(JSON.stringify({ challenge: body.challenge }), { headers: { 'Content-Type': 'application/json' } });
      }

      // 2. 接收消息
      if (body.header && body.header.event_type === 'im.message.receive_v1') {
        const messageId = body.event.message.message_id;
        const msgType = body.event.message.message_type;
        const content = JSON.parse(body.event.message.content);
        
        ctx.waitUntil(handleMessage(env, messageId, msgType, content));
        return new Response('OK', { status: 200 });
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  },
};

// --- 核心业务逻辑 ---
async function handleMessage(env: Env, messageId: string, msgType: string, content: any) {
  const token = await getLarkToken(env.LARK_APP_ID, env.LARK_APP_SECRET);
  if (!token) return;

  let userText = "";

  // 1. 获取用户输入的文字（直接文本 或 语音转录）
  if (msgType === 'text') {
    userText = content.text;
  } else if (msgType === 'audio') {
    await replyLark(token, messageId, "👂 正在听取语音...");
    const fileKey = content.file_key;
    const audioBlob = await downloadLarkFile(token, messageId, fileKey);
    
    if (!audioBlob) {
      await replyLark(token, messageId, "❌ 语音下载失败，请检查权限。");
      return;
    }

    // 调用 Whisper 转录
    try {
      const response = await env.AI.run('@cf/openai/whisper', {
        audio: [...new Uint8Array(await audioBlob.arrayBuffer())]
      });
      userText = response.text;
      // 告诉用户转录结果
      await replyLark(token, messageId, `🎙️ 转录内容：${userText}`); 
    } catch (err) {
      await replyLark(token, messageId, `❌ 语音识别出错: ${err.message}`);
      return;
    }
  } else {
    await replyLark(token, messageId, "暂不支持此类型");
    return;
  }

  // 2. 如果内容太短，就不分析了
  if (!userText || userText.trim().length < 2) {
    await replyLark(token, messageId, "🤖 这一句话太短了，我没法分析任务哦~");
    return;
  }

  // 3. 调用 Llama-3 进行四象限分析
  // await replyLark(token, messageId, "🧠 AI 正在分析任务..."); // (可选: 调试用)

  const prompt = `
    你是一个高效的时间管理专家。请分析用户的任务："${userText}"。
    根据艾森豪威尔矩阵（四象限法则），将其分类为以下之一：
    1. 【重要且紧急】(马上做)
    2. 【重要不紧急】(计划做)
    3. 【紧急不重要】(授权做/凑合做)
    4. 【不紧急不重要】(不做/记下来)

    请直接输出分析结果，格式要求如下：
    ----------------
    📊 **任务分类**：[类别名称]
    💡 **行动建议**：[一句话建议]
    📌 **原任务**：${userText}
    ----------------
    不要输出任何多余的废话，只输出上面的格式。
  `;

  try {
    const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [{ role: 'user', content: prompt }]
    });

    const analysisResult = aiResponse.response;
    
    // 4. 发送最终结果
    await replyLark(token, messageId, analysisResult);

  } catch (err) {
    await replyLark(token, messageId, `❌ AI 思考失败: ${err.message}`);
  }
}

// --- 助手函数 ---
async function getLarkToken(appId: string, appSecret: string) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ "app_id": appId, "app_secret": appSecret })
  });
  const data: any = await res.json();
  return data.tenant_access_token;
}

async function replyLark(token: string, messageId: string, text: string) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ "msg_type": "text", "content": JSON.stringify({ "text": text }) })
  });
}

async function downloadLarkFile(token: string, messageId: string, fileKey: string) {
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`;
  const response = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!response.ok) return null;
  return await response.blob();
}
