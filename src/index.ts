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
    
    // 1. 只接受 POST
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
      const body = await request.json() as any;
      // [日志] 打印收到的请求类型，确认飞书真的发了消息过来
      console.log("收到请求类型:", body.type); 

      // 2. 飞书验证 (握手逻辑)
      if (body.type === 'url_verification') {
        if (body.token !== env.LARK_VERIFICATION_TOKEN) return new Response('Invalid Token', { status: 403 });
        return new Response(JSON.stringify({ challenge: body.challenge }), { headers: { 'Content-Type': 'application/json' } });
      }

      // 3. 处理消息事件
      if (body.header && body.header.event_type === 'im.message.receive_v1') {
        const messageId = body.event.message.message_id;
        const chatId = body.event.message.chat_id;
        const msgType = body.event.message.message_type;
        const content = JSON.parse(body.event.message.content);

        // [日志] 确认解析出了消息ID和类型
        console.log(`收到消息: ${msgType} | ID: ${messageId}`); 

        // 进入后台处理 (关键！)
        ctx.waitUntil(handleMessage(env, messageId, chatId, msgType, content));
        return new Response('OK', { status: 200 });
      }

      return new Response('OK', { status: 200 });

    } catch (error) {
      console.error("主程序报错:", error);
      return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
  },
};

// --- 后台处理逻辑 (这里是我们要抓Bug的地方) ---
async function handleMessage(env: Env, messageId: string, chatId: string, msgType: string, content: any) {
  console.log("🚀 开始后台处理..."); 

  // 1. 获取 Token
  const token = await getLarkToken(env.LARK_APP_ID, env.LARK_APP_SECRET);
  if (!token) {
    console.error("❌ 获取 Token 失败！请检查 App ID 和 Secret 是否正确，或者企业是否被封禁。");
    return;
  }
  console.log("✅ 获取 Token 成功");

  let replyText = "";
  if (msgType === 'text') {
    replyText = `收到：${content.text}`;
  } else {
    replyText = "暂不支持的消息类型";
  }

  // 2. 发送回复
  console.log(`准备回复消息: ${replyText}`);
  await replyLark(token, messageId, replyText);
}

// --- 获取飞书 Token ---
async function getLarkToken(appId: string, appSecret: string) {
  console.log(`正在请求 Token... (AppID: ${appId})`); 
  
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ "app_id": appId, "app_secret": appSecret })
  });
  
  const data: any = await res.json();
  
  // [关键日志] 如果这里报错，它会告诉我们具体原因 (比如 code: 10003)
  if (data.code !== 0) {
    console.error("❌ 飞书 Token 报错详情:", JSON.stringify(data)); 
    return null;
  }
  return data.tenant_access_token;
}

// --- 回复消息 ---
async function replyLark(token: string, messageId: string, text: string) {
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reply`, {
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
  const data: any = await res.json();
  // [日志] 打印回复结果
  console.log("📬 发送结果:", JSON.stringify(data)); 
}
