export interface Env {
  AI: any;
  DB: D1Database;
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  LARK_VERIFICATION_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // 1. 只接受 POST
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
      const body = await request.json() as any;

      // 2. 飞书验证 (握手逻辑)
      if (body.type === 'url_verification') {
        if (body.token !== env.LARK_VERIFICATION_TOKEN) return new Response('Invalid Token', { status: 403 });
        return new Response(JSON.stringify({ challenge: body.challenge }), { headers: { 'Content-Type': 'application/json' } });
      }

      // 3. 处理消息事件 (v2.0 只有验证通过才处理)
      if (body.header && body.header.event_type === 'im.message.receive_v1') {
        const messageId = body.event.message.message_id;
        const chatId = body.event.message.chat_id;
        const contentStr = body.event.message.content;
        const msgType = body.event.message.message_type;
        
        // 解析 content (飞书返回的是 JSON 字符串)
        const content = JSON.parse(contentStr);

        // 4. 为了防止飞书超时重试，我们先返回 200 OK，剩下的活交给后台 (waitUntil)
        ctx.waitUntil(handleMessage(env, messageId, chatId, msgType, content));
        return new Response('OK', { status: 200 });
      }

      return new Response('OK', { status: 200 });

    } catch (error) {
      console.error(error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  },
};

// --- 核心处理逻辑 ---
async function handleMessage(env: Env, messageId: string, chatId: string, msgType: string, content: any) {
  // 获取飞书的 Tenant Access Token (通行证)
  const token = await getLarkToken(env.LARK_APP_ID, env.LARK_APP_SECRET);
  if (!token) return;

  let replyText = "";

  // A. 如果是文本消息
  if (msgType === 'text') {
    replyText = `收到文本：${content.text}\nAI 正在准备接入...`;
  } 
  // B. 如果是语音消息 (我们的大目标！)
  else if (msgType === 'audio') {
    replyText = `收到语音 (Key: ${content.file_key})，准备进行转录...`;
    // 这里后面会加入 Whisper 调用代码
  } 
  // C. 其他
  else {
    replyText = "暂不支持此消息类型";
  }

  // 发送回复
  await replyLark(token, messageId, replyText);
}

// --- 助手函数：获取飞书 Token ---
async function getLarkToken(appId: string, appSecret: string) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ "app_id": appId, "app_secret": appSecret })
  });
  const data: any = await res.json();
  return data.tenant_access_token;
}

// --- 助手函数：回复消息 ---
async function replyLark(token: string, messageId: string, text: string) {
  await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      "msg_type": "text",
      "content": JSON.stringify({ "text": text })
    })
  });
}
