// supabase/functions/transcribe/index.ts
// Supabase Edge Function: 语音转写代理
// 使用 Groq whisper-large-v3 模型进行语音转文字
// 
// 部署命令：
// supabase secrets set GROQ_API_KEY=gsk_your_actual_key_here
// supabase functions deploy transcribe

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0'

/**
 * 允许的来源白名单
 * 安全修复：限制 CORS 来源，防止任意网站调用 API
 */
const ALLOWED_ORIGINS = [
  'https://dde-eight.vercel.app',
  'https://nanoflow.app',
  'http://localhost:4200',      // 开发环境
  'http://localhost:5173',      // Vite 开发服务器
];

/**
 * 根据请求来源返回 CORS 头
 * 只有白名单中的来源才会被允许
 */
function getCorsHeaders(origin: string | null): Record<string, string> {
  const isAllowed = origin && ALLOWED_ORIGINS.some(allowed => 
    origin === allowed || origin.endsWith('.vercel.app')
  );
  
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin! : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin', // 重要：告知缓存根据 Origin 区分响应
  };
}

/** 每用户每日转写限额 */
const DAILY_QUOTA_PER_USER = 50

/** Groq API 端点 */
const GROQ_API_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'

/** 最大文件大小 25MB */
const MAX_FILE_SIZE = 25 * 1024 * 1024

serve(async (req: Request) => {
  // 获取请求来源，用于 CORS 响应
  const origin = req.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  // 📊 请求入口日志 - 帮助确认请求是否到达
  console.log('🎤 [Transcribe] Request received:', {
    method: req.method,
    url: req.url,
    origin,
    hasAuth: !!req.headers.get('Authorization'),
    contentType: req.headers.get('Content-Type'),
    timestamp: new Date().toISOString()
  });

  // 处理跨域预检
  if (req.method === 'OPTIONS') {
    console.log('🎤 [Transcribe] CORS preflight request');
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // 1. 认证检查
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      console.error('🎤 [Transcribe] No Authorization header');
      return new Response(
        JSON.stringify({ error: 'Unauthorized', code: 'AUTH_REQUIRED' }), 
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    
    // 从 Authorization header 提取 token
    const token = authHeader.replace('Bearer ', '');
    console.log('🎤 [Transcribe] Token present, validating user...');

    // 使用 SUPABASE_SERVICE_ROLE_KEY 查询配额（绕过 RLS）
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )
    
    // 🔧 修复：直接使用 token 验证用户，而不是依赖 header 配置
    // auth.getUser(token) 会直接验证传入的 JWT token
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token)
    if (authError || !user) {
      console.error('🎤 [Transcribe] Auth validation failed:', authError?.message || 'No user');
      return new Response(
        JSON.stringify({ error: 'Invalid token', code: 'AUTH_INVALID' }), 
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    
    console.log('🎤 [Transcribe] User authenticated:', user.id.slice(0, 8) + '...');

    // 2. 配额检查（使用 service_role 查询，确保准确）
    const today = new Date().toISOString().split('T')[0]
    const { count, error: countError } = await supabaseAdmin
      .from('transcription_usage')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('date', today)

    if (countError) {
      console.error('🎤 [Transcribe] Quota check error:', countError)
      // 配额检查失败时仍允许请求，避免影响正常使用
    } else if ((count ?? 0) >= DAILY_QUOTA_PER_USER) {
      console.warn('🎤 [Transcribe] Quota exceeded for user:', user.id.slice(0, 8));
      return new Response(
        JSON.stringify({ error: '今日转写次数已达上限', code: 'QUOTA_EXCEEDED' }), 
        { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    
    console.log('🎤 [Transcribe] Quota check passed, today usage:', count ?? 0);

    // 3. 从请求中获取 FormData（包含录音文件）
    const formData = await req.formData()
    const audioFile = formData.get('file')

    if (!audioFile || !(audioFile instanceof File)) {
      console.error('🎤 [Transcribe] No audio file in request');
      return new Response(
        JSON.stringify({ error: 'No audio file uploaded', code: 'FILE_MISSING' }), 
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    
    console.log('🎤 [Transcribe] Audio file received:', {
      name: audioFile.name,
      size: audioFile.size,
      type: audioFile.type
    });

    // 4. 检查文件大小
    if (audioFile.size > MAX_FILE_SIZE) {
      console.error('🎤 [Transcribe] File too large:', audioFile.size);
      return new Response(
        JSON.stringify({ error: '音频文件过大，请控制在 25MB 以内', code: 'FILE_TOO_LARGE' }), 
        { status: 413, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 5. 准备发给 Groq 的数据
    const groqFormData = new FormData()
    groqFormData.append('file', audioFile)
    groqFormData.append('model', 'whisper-large-v3')
    // 引导模型输出简体中文
    groqFormData.append('prompt', '这是一段关于软件开发、项目管理或日常工作的语音记录，请用简体中文转写')
    groqFormData.append('language', 'zh')

    // 6. 调用 Groq API
    const groqApiKey = Deno.env.get('GROQ_API_KEY')
    if (!groqApiKey) {
      console.error('🎤 [Transcribe] GROQ_API_KEY not configured')
      return new Response(
        JSON.stringify({ error: '转写服务未配置', code: 'SERVICE_NOT_CONFIGURED' }), 
        { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    
    console.log('🎤 [Transcribe] Calling Groq API with whisper-large-v3...');

    const groqResponse = await fetch(GROQ_API_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
      },
      body: groqFormData,
    })

    if (!groqResponse.ok) {
      const errorText = await groqResponse.text()
      console.error('🎤 [Transcribe] Groq API Error:', groqResponse.status, errorText)
      
      // 根据 Groq 错误码返回合适的响应
      if (groqResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: 'Groq API 请求过于频繁，请稍后再试', code: 'GROQ_RATE_LIMITED' }), 
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      
      return new Response(
        JSON.stringify({ error: '转写服务暂不可用', code: 'SERVICE_UNAVAILABLE' }), 
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const data = await groqResponse.json()
    
    console.log('🎤 [Transcribe] Groq response received:', {
      textLength: data.text?.length || 0,
      duration: data.duration,
      language: data.language
    });

    // 7. 记录使用量（异步，不阻塞响应）
    const recordUsage = async () => {
      try {
        await supabaseAdmin.from('transcription_usage').insert({
          id: crypto.randomUUID(),
          user_id: user.id,
          date: today,
          audio_seconds: Math.round(audioFile.size / 16000)  // 估算：webm opus 约 16KB/s
        })
      } catch (e) {
        console.error('Failed to record usage:', e)
      }
    }
    
    // Deno Deploy 支持 waitUntil
    // @ts-ignore - EdgeRuntime 在 Supabase Edge Functions 中可用
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(recordUsage())
    } else {
      // 本地开发时同步执行
      await recordUsage()
    }

    // 8. 返回转写后的文本
    return new Response(JSON.stringify({ 
      text: data.text,
      duration: data.duration,
      language: data.language 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    })

  } catch (error: unknown) {
    console.error('Transcribe Error:', error)
    
    // 详细错误日志（帮助诊断生产环境问题）
    if (error instanceof Error) {
      console.error('Error details:', {
        name: error.name,
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 3).join('\n') // 只记录前3行堆栈
      });
    }
    
    const message = error instanceof Error ? error.message : 'Unknown error'
    return new Response(JSON.stringify({ error: message, code: 'INTERNAL_ERROR' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    })
  }
})
