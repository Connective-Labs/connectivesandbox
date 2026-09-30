// Data-layer model types. These describe what the adapters return; from
// Phase 4 the same shapes come from Supabase. Nothing in src/engine/ imports
// from here.

export type UserRole = 'owner' | 'admin' | 'agent'

export interface User {
  id: string
  email: string
  name: string
  role: UserRole
}

export interface Client {
  id: string
  name: string
  slug: string
  created_at: string
}

export type SessionStatus = 'open' | 'judged' | 'review' | 'closed'

export interface SessionRecord {
  id: string
  client_id: string
  workflow_id: string
  title: string
  status: SessionStatus
  created_at: string
}

export type DecisionDisposition = 'auto' | 'review' | 'escalated'

export interface DecisionRecord {
  id: string
  session_id: string
  workflow_id: string
  judge_id: string
  question: string
  answer: string | boolean | number
  confidence: number
  disposition: DecisionDisposition
  created_at: string
  /** Milliseconds the judge took; absent on rows imported from older backends. */
  latency_ms?: number
}

export interface ChatMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export interface AuthSession {
  user: User
  token: string
}

export interface WorkflowSummary {
  id: string
  name: string
  description: string
  client_id: string
  version: number
  updated_at: string
}
