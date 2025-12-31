export interface Env {
  AI: any;
  DB: D1Database;
  LARK_APP_ID: string;
  LARK_APP_SECRET: string;
  LARK_VERIFICATION_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  // 1. 获取文本 (支持语音转文字)
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
    try {
      const response = await env.AI.run('@cf/openai/whisper', { audio: [...new Uint8Array(await audioBlob.arrayBuffer())] });
      userText = response.text;
      await replyLark(token, messageId, `🎙️ 识别内容：${userText}`); 
    } catch (err) {
      await replyLark(token, messageId, `❌ 转录出错: ${err.message}`);
      return;
    }
  } else {
    return; // 不支持的类型直接忽略
  }

  // 2. 获取当前时间 (关键！AI 需要知道现在是几月几号)
  // 注意：Cloudflare 是 UTC 时间，我们手动加 8 小时变成北京时间给 AI 参考
  const now = new Date();
  const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

  // 3. AI 分析与提取 (Llama-3)
  // 我们要求 AI 如果发现是任务，就输出 JSON 格式的时间，方便我们写日历
  const prompt = `
    当前北京时间是：${beijingTime}。
    你是一个智能助理。请分析用户的话："${userText}"。
    
    如果是需要提醒的任务，请提取具体时间，并严格按照以下 JSON 格式输出：
    {
      "is_task": true,
      "summary": "任务标题",
      "start_time": "YYYY-MM-DD HH:mm:ss", 
      "end_time": "YYYY-MM-DD HH:mm:ss",
      "quadrant": "重要且紧急" (或其他象限)
    }

    如果只是普通闲聊或没有具体时间，请输出：
    {
      "is_task": false,
      "reply": "你的回复内容"
    }

    只输出 JSON，不要有其他废话。
    注意：start_time 必须是基于当前时间的推算。如果不确定结束时间，默认加1小时。
  `;

  try {
    const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [{ role: 'user', content: prompt }]
    });

    // 清理 AI 可能输出的 Markdown 标记
    const rawJson = aiResponse.response.replace(/```json/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(rawJson);

    if (result.is_task) {
      // 4. 创建飞书日历
      // 将北京时间字符串转回时间戳 (简单处理)
      const startTimeStamp = new Date(result.start_time).getTime() / 1000;
      const endTimeStamp = new Date(result.end_time).getTime() / 1000;

      // 调用飞书日历 API
      const calendarRes = await createCalendarEvent(token, result.summary, startTimeStamp, endTimeStamp);
      
      if (calendarRes) {
         await replyLark(token, messageId, `✅ 已创建日程！\n📅 **${result.summary}**\n⏰ ${result.start_time}\n📊 分类：${result.quadrant}\n(请在飞书或手机日历查看提醒)`);
      } else {
         await replyLark(token, messageId, `❌ 日历创建失败，可能是日期格式 AI 没算对，或者权限没发布。`);
      }

    } else {
      // 普通回复
      await replyLark(token, messageId, result.reply);
    }

  } catch (err) {
    await replyLark(token, messageId, `❌ 处理失败: ${err.message}`);
    console.error(err);
  }
}

// --- 助手函数 ---

// 创建日历 (核心新增功能)
async function createCalendarEvent(token: string, summary: string, startTime: number, endTime: number) {
  // 飞书日历 API (primary 代表默认日历)
  const res = await fetch('https://open.feishu.cn/open-apis/calendar/v4/calendars/primary/events', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      "summary": summary,
      "start_time": { "timestamp": startTime.toString(), "timezone": "Asia/Shanghai" },
      "end_time": { "timestamp": endTime.toString(), "timezone": "Asia/Shanghai" },
      "reminders": [{ "minutes": 15 }] // 默认提前15分钟提醒
    })
  });
  
  if (res.status === 200) return true;
  const err = await res.json() as any;
  console.error("日历创建失败:", JSON.stringify(err));
  return false;
}

async function getLarkToken(appId: string, appSecret: string) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ "app_id": appId, "app_secret": appSecret })
  });
  return (await res.json() as any).tenant_access_token;
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
