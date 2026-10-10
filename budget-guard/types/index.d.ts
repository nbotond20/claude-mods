export type Limits = {
  /** context tokens at which every prompt gets a warning */
  warn: number
  /** context tokens at which prompts are held until /compact (or "force:" prefix) */
  block: number
  /** subagents allowed per session */
  maxAgents: number
  /** tokens one turn may add before a toast */
  bigTurn: number
  /** let Read open images */
  allowImages: boolean
  /** pick model and effort from the session's first prompt */
  route: boolean
  /** put Explore-type subagents on Haiku, the rest on Sonnet */
  routeAgents: boolean
  /** context tokens from which a new-task prompt is held with clear/compact/keep */
  newTaskAt: number
  /** keep the 5-minute prompt cache warm while idle (LiteLLM sessions by default) */
  keepAlive: boolean
  /** tail noisy build/test commands */
  trimOutput: boolean
}

export type Context = { tokens: number; window: number; percent: number }

export type Spend = { spend: number; baseline: number; maxBudget: number | null; resetAt: string | null; at: number; error: string | null }

/** The model and effort the first prompt chose for the main loop. */
export type Route = {
  tier: 'quick' | 'normal' | 'hard'
  model: string
  effort: 'low' | 'medium' | 'high'
  /** the model the engine named when the route was taken; a different one means the user switched */
  engineModel: string
}

/** A prompt held because it looks like a new task over a big context. */
export type Pending = { text: string; tokens: number }

export type SavingCategory = 'route-session' | 'route-agents' | 'new-task' | 'output-trim' | 'keep-alive' | 'guards'

/** Estimated dollars saved and how often, by category. */
export type Savings = Partial<Record<SavingCategory, { usd: number; count: number }>>

/** What every session file on disk adds up to. */
export type History = {
  days: Record<string, { saved: number; spent: number }>
  byCategory: Savings
  byProfile: Record<string, { saved: number; spent: number }>
  sessions: number
  loadedAt: number
}

/** How this session pays: a LiteLLM gateway (real $), an API key (real $), or a subscription (limits, $ is API-equivalent). */
export type Billing = 'gateway' | 'api-key' | 'subscription' | 'unknown'

/** One reading for the burn rate. */
export type Sample = { t: number; cost: number | null; key: number | null; fiveHour: number | null; sevenDay: number | null }

export type Limit = { kind: string; percent: number; resetsAt: string | null }

export type LiveAgent = { id: string; type: string; status: string; model: string; description: string }

export type LiveTask = { id: string; type: string; status: string; description: string }

export type MainModel = { model: string; effort: string | null }

/** Soft spending limits for this profile: shown, never enforced. */
export type Budgets = { daily: number | null; monthly: number | null }

/** Spend so far today and this month (local time): real $ on a gateway, API-equivalent otherwise. */
export type Periods = { kind: 'real' | 'api-equiv'; today: number; month: number; since: string | null }

declare module 'claude-code' {
  interface PluginState {
    'budget-guard': {
      limits: Limits
      context: Context | null
      costUsd: number | null
      lastTokens: number
      lastDelta: number
      agents: number
      screenshots: number
      litellm: Spend | null
      route: Route | null
      routeDecided: boolean
      agentModels: Record<string, string>
      prompts: string[]
      pending: Pending | null
      savings: Savings
      history: History | null
      billing: Billing
      samples: Sample[]
      limitsNow: Limit[]
      mainModel: MainModel | null
      liveAgents: LiveAgent[]
      liveTasks: LiveTask[]
      budgets: Budgets
      periods: Periods | null
    }
  }
}
