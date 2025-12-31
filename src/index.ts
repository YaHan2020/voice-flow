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

      // 1. 飞书握手验证
      if (body.type === 'url_verification') {
        if (body.token !== env.LARK_VERIFICATION_TOKEN) return new Response('Invalid Token', { status: 403 });
        return new Response(JSON.stringify({ challenge: body.challenge }), { headers: { 'Content-Type': 'application/json' } });
      }

      // 2. 接收消息事件
      if (body.header && body.header.event_type === 'im.message.receive_v1') {
        const messageId = body.event.message.message_id;
        const msgType = body.event.message.message_type;
        const content = JSON.parse(body.event.message.content);
        
        // 后台处理，快速返回 200
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
  // 1. 拿 Token
  const token = await getLarkToken(env.LARK_APP_ID, env.LARK_APP_SECRET);
  if (!token) return;

  // A. 如果是纯文本
  if (msgType === 'text') {
    // 暂时先复读，下一阶段我们将在这里接入 Llama3 做任务分类
    await replyLark(token, messageId, `🤖 收到文本：${content.text}\n(AI 任务分析功能即将上线...)`);
  } 
  
  // B. 如果是语音 (本次的核心功能！)
  else if (msgType === 'audio') {
    await replyLark(token, messageId, "👂 正在听取语音..."); 

    // 2. 下载语音文件
    const fileKey = content.file_key;
    const audioBlob = await downloadLarkFile(token, messageId, fileKey);

    if (!audioBlob) {
      await replyLark(token, messageId, "❌ 语音下载失败！请检查是否开通了 [im:resource:obtain] 和 [im:file] 权限并发布了版本。");
      return;
    }

    // 3. 调用 Whisper 进行识别
    try {
      const response = await env.AI.run('@cf/openai/whisper', {
        audio: [...new Uint8Array(await audioBlob.arrayBuffer())]
      });

      const text = response.text;
      
      // 4. 返回识别结果
      await replyLark(token, messageId, `🎙️ 语音转文字完成：\n----------------\n${text}`);

    } catch (err) {
      await replyLark(token, messageId, `❌ AI 识别出错: ${err.message}`);
    }
  } else {
    await replyLark(token, messageId, "暂不支持此消息类型");
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
