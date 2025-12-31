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
      console.log("收到请求类型:", body.type); // [日志] 打印请求类型

      // 2. 飞书验证
      if (body.type === 'url_verification') {
        if (body.token !== env.LARK_VERIFICATION_TOKEN) return new Response('Invalid Token', { status: 403 });
        return new Response(JSON.stringify({ challenge: body.challenge }), { headers: { 'Content-Type': 'application/json' } });
      }

      // 3. 处理消息
      if (body.header && body.header.event_type === 'im.message.receive_v1') {
        const messageId = body.event.message.message_id;
        const chatId = body.event.message.chat_id;
        const msgType = body.event.message.message_type;
        const content = JSON.parse(body.event.message.content);

        console.log(`收到消息: ${msgType} | ID: ${messageId}`); // [日志]

        // 进入后台处理
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

async function handleMessage(env: Env, messageId: string, chatId: string, msgType: string, content: any) {
  console.log("开始后台处理..."); // [日志]

  // 1. 获取 Token
  const token = await getLarkToken(env.LARK_APP_ID, env.LARK_APP_SECRET);
  if (!token) {
    console.error("❌ 获取 Token 失败！请检查 App ID 和 Secret");
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

async function getLarkToken(appId: string, appSecret: string) {
  console.log(`正在请求 Token, AppID: ${appId}`); // [日志] 不要打印 Secret
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ "app_id": appId, "app_secret": appSecret })
  });
  const data: any = await res.json();
  
  if (data.code !== 0) {
    console.error("❌ 飞书 Token 报错:", JSON.stringify(data)); // [关键] 看看飞书返回了什么错误
    return null;
  }
  return data.tenant_access_token;
}

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
  console.log("发送结果:", JSON.stringify(data)); // [日志]
}
