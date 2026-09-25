import { jevEndpoint, type ProviderConfig } from '@quizpilot/providers';
import { t } from '../lib/i18n';

export interface Preset {
  id: string;
  label: string;
  type: ProviderConfig['type'];
  /** Jev only: which API to reach it through. */
  via?: 'typesafe' | 'openrouter';
  baseURL?: string;
  model?: string;
  vision?: boolean;
  keyless?: boolean;
  hint?: string;
  /** Extra request headers the service needs. */
  headers?: Record<string, string>;
  /** false for servers that reject response_format: json_object. */
  jsonMode?: boolean;
}

/**
 * Services with an OpenAI-compatible API. Default models are a starting point: model names change
 * often, so the add form can list what the key actually offers ("获取模型列表").
 */
export const PRESETS: Preset[] = [
  {
    id: 'jev',
    label: t('preset_jevOpenRouter'),
    type: 'jev',
    via: 'openrouter',
    hint: t('preset_jevOpenRouterHint'),
  },
  {
    id: 'jev',
    label: t('preset_jevTypeSafe'),
    type: 'jev',
    via: 'typesafe',
    hint: t('preset_jevTypeSafeHint'),
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    type: 'openai-compatible',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4.1-flash',
    vision: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    type: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    vision: true,
  },
  {
    id: 'claude',
    label: 'Claude (Anthropic)',
    type: 'openai-compatible',
    baseURL: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-4-5',
    vision: true,
    // Anthropic's OpenAI-compatible endpoint ignores json_object, and wants this header for
    // requests that come from a browser.
    jsonMode: false,
    headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
  },
  {
    id: 'gemini',
    label: 'Gemini (Google)',
    type: 'openai-compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    vision: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    type: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    vision: false,
  },
  {
    id: 'qwen',
    label: t('preset_qwen'),
    type: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-max',
    vision: true,
  },
  {
    id: 'kimi',
    label: t('preset_kimi'),
    type: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    vision: false,
  },
  {
    id: 'glm',
    label: t('preset_glm'),
    type: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
    vision: true,
  },
  {
    id: 'doubao',
    label: t('preset_doubao'),
    type: 'openai-compatible',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    vision: false,
    hint: t('preset_doubaoHint'),
  },
  {
    id: 'siliconflow',
    label: t('preset_siliconflow'),
    type: 'openai-compatible',
    baseURL: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
    vision: true,
  },
  {
    id: 'hunyuan',
    label: t('preset_hunyuan'),
    type: 'openai-compatible',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    model: 'hunyuan-turbos-latest',
    vision: false,
  },
  {
    id: 'qianfan',
    label: t('preset_qianfan'),
    type: 'openai-compatible',
    baseURL: 'https://qianfan.baidubce.com/v2',
    model: '',
    vision: false,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    type: 'openai-compatible',
    baseURL: 'https://api.minimaxi.com/v1',
    model: '',
    vision: false,
  },
  {
    id: 'groq',
    label: 'Groq',
    type: 'openai-compatible',
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    vision: false,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    type: 'openai-compatible',
    baseURL: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    vision: true,
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    type: 'openai-compatible',
    baseURL: 'https://api.x.ai/v1',
    model: '',
    vision: false,
  },
  {
    id: 'ollama',
    label: t('preset_ollama'),
    type: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    model: 'qwen2.5vl',
    vision: true,
    keyless: true,
  },
  {
    id: 'lmstudio',
    label: t('preset_lmstudio'),
    type: 'openai-compatible',
    baseURL: 'http://localhost:1234/v1',
    model: '',
    vision: false,
    keyless: true,
  },
  {
    id: 'custom',
    label: t('preset_custom'),
    type: 'openai-compatible',
    baseURL: 'https://',
    model: '',
    vision: false,
  },
];

/** Unique lowercase id derived from the preset id. */
export function uniqueId(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

/** Origin permission pattern needed to call a provider. */
export function originPattern(config: ProviderConfig): string {
  const url = config.type === 'jev' ? jevEndpoint(config).url : config.baseURL;
  return `${new URL(url).origin}/*`;
}
