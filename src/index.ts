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
        
        // 这里的 contentStr 是为了传给后台处理
        ctx.waitUntil(handleMessage(env, messageId, msgType, content, body.event.message));
        return new Response('OK', { status: 200 });
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  },
};

// --- 核心业务逻辑 ---
async function handleMessage(env: Env, messageId: string, msgType: string, content: any, messageEvent: any) {
  // 1. 获取飞书 Token
  const token = await getLarkToken(env.LARK_APP_ID, env.LARK_APP_SECRET);
  if (!token) return;

  let finalTextInput = "";

  // 2. 判断消息类型
  if (msgType === 'text') {
    finalTextInput = content.text;
    await replyLark(token, messageId, `📝 收到文字：${finalTextInput}\n(后续将接入 AI 进行四象限分析...)`);
  
  } else if (msgType === 'audio') {
    // 3. 处理语音：下载 -> 转录
    await replyLark(token, messageId, "👂 正在听取语音..."); // 先给个反馈，防止用户以为没反应
    
    const fileKey = content.file_key;
    const audioBlob = await downloadLarkFile(token, messageId, fileKey);

    if (audioBlob) {
      // 4. 调用 Cloudflare Whisper 模型
      try {
        const response = await env.AI.run('@cf/openai/whisper', {
          audio: [...new Uint8Array(await audioBlob.arrayBuffer())]
        });
        
        finalTextInput = response.text; // 拿到转录后的文字
        
        // 回复转录结果
        await replyLark(token, messageId, `🎙️ 语音转文字成功：\n"${finalTextInput}"\n(后续将接入 AI 进行任务分析)`);
      } catch (err) {
        await replyLark(token, messageId, `❌ AI 转录失败: ${err.message}`);
      }
    }
  } else {
    await replyLark(token, messageId, "暂不支持此消息类型");
  }
}

// --- 工具函数：获取 Token ---
async function getLarkToken(appId: string, appSecret: string) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ "app_id": appId, "app_secret": appSecret })
  });
  const data: any = await res.json();
  return data.tenant_access_token;
}

// --- 工具函数：回复消息 ---
async function replyLark(token: string, messageId: string, text: string) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ "msg_type": "text", "content": JSON.stringify({ "text": text }) })
  });
}

// --- 工具函数：下载飞书资源文件 ---
async function downloadLarkFile(token: string, messageId: string, fileKey: string) {
  // 飞书下载资源的接口
  const url = `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`;
  
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!response.ok) {
    console.error("下载文件失败");
    return null;
  }
  return await response.blob();
}
