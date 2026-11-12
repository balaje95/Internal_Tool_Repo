// Workflow Composer — prompt → workflow plan, designed by Claude.
//
// POST /api/workflow-ai
//   headers: x-zuper-key, x-zuper-base   (the caller's own Zuper API key + region base)
//   body:    { prompt, context }         (context = account facts gathered by the tool)
// → { plan } — a list of steps the tool compiles into real Workflow Builder nodes.
//
// Access: this site has no login gate, so the caller must prove a working Zuper key —
// it is checked against <base>/user/company before any model call. The key is used for
// that check only and never stored or logged.
//
// Needs ANTHROPIC_API_KEY in the Vercel project's environment variables.

import Anthropic from '@anthropic-ai/sdk';
import { WORKFLOW_KNOWLEDGE } from './_lib/workflow-knowledge.js';

const MODEL = 'claude-opus-5-5';
const MAX_PROMPT = 4000;
const MAX_CONTEXT = 60000;

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'kind', 'purpose', 'after', 'branch', 'method', 'path', 'body_expr', 'code', 'combine', 'conditions'],
  properties: {
    name: { type: 'string', description: 'Unique, short, Title Case. Other steps reference it via $.getNodeData(name).' },
    kind: { type: 'string', enum: ['http', 'code', 'if_else'] },
    purpose: { type: 'string', description: 'One plain-English sentence: what this step does.' },
    after: { type: 'string', description: 'Name of the step this one follows; empty = the previous step in the list.' },
    branch: { type: 'string', enum: ['', 'true', 'false'], description: 'Set when "after" is an if_else step.' },
    method: { type: 'string', enum: ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    path: { type: 'string', description: 'http only: path after /api, may contain {{ }} expressions.' },
    body_expr: { type: 'string', description: 'http only: {{ }} expression for the JSON body, or empty.' },
    code: { type: 'string', description: 'code only: JavaScript function body ending in return { ... }.' },
    combine: { type: 'string', enum: ['', 'AND', 'OR'] },
    conditions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value1', 'operation', 'value2'],
        properties: {
          value1: { type: 'string', description: '{{ }} expression to test' },
          operation: { type: 'string', enum: ['EQUAL_TO', 'NOT_EQUAL_TO', 'CONTAINS', 'NOT_CONTAINS'] },
          value2: { type: 'string' },
        },
      },
    },
  },
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['workflow_name', 'summary', 'trigger', 'steps', 'assumptions', 'unverified_endpoints', 'go_live_todos', 'clarifying_question'],
  properties: {
    workflow_name: { type: 'string' },
    summary: { type: 'string', description: 'Two or three sentences describing what the workflow does.' },
    trigger: {
      type: 'object',
      additionalProperties: false,
      required: ['event_key', 'label', 'module', 'why'],
      properties: {
        event_key: { type: 'string', description: 'e.g. customer.create, job.status_update, estimate.update' },
        label: { type: 'string', description: 'Trigger node name, e.g. "New Purchase Order"' },
        module: { type: 'string', description: 'JOB, CUSTOMER, QUOTE, INVOICE, PURCHASE_ORDER, ...' },
        why: { type: 'string' },
      },
    },
    steps: { type: 'array', items: STEP_SCHEMA },
    assumptions: { type: 'array', items: { type: 'string' } },
    unverified_endpoints: { type: 'array', items: { type: 'string' } },
    go_live_todos: { type: 'array', items: { type: 'string' } },
    clarifying_question: { type: 'string', description: 'Empty unless the request is too ambiguous to build anything sensible.' },
  },
};

const SYSTEM = `You design Zuper Workflow Builder workflows from a plain-English request.
Return a plan that the Workflow Composer compiles into real builder nodes.
Pick the trigger yourself from the request — the user does not split it into when/if/then.
Prefer endpoints marked confirmed; when you must use an unverified one, still build it and
list it in unverified_endpoints. Record every guess in assumptions. Only ask a
clarifying_question when nothing sensible can be built; otherwise leave it empty and build.
Never hardcode UIDs, keys or passwords; resolve names at run time.

${WORKFLOW_KNOWLEDGE}`;

async function verifyZuperKey(base, key) {
  if (!/^https:\/\/[a-z0-9-]+\.zuperpro\.com\/api\/?$/i.test(base || '') || !key) return null;
  try {
    const r = await fetch(base.replace(/\/$/, '') + '/user/company', {
      headers: { 'x-api-key': key, accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (!d || d.type === 'error') return null;
    const c = d.data || d;
    return (c && (c.company_name || c.name)) || 'account';
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'not_configured', message: 'ANTHROPIC_API_KEY is not set in the Vercel project.' });
  }

  const company = await verifyZuperKey(req.headers['x-zuper-base'], req.headers['x-zuper-key']);
  if (!company) return res.status(401).json({ error: 'unauthorized', message: 'Connect a valid Zuper account first.' });

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'empty prompt' });
  if (prompt.length > MAX_PROMPT) return res.status(400).json({ error: 'prompt too long' });
  const context = JSON.stringify(body.context || {}).slice(0, MAX_CONTEXT);

  const client = new Anthropic();
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: PLAN_SCHEMA } },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content:
          `Account: ${company}\nAccount context (JSON):\n${context}\n\n` +
          `Request:\n${prompt}`,
      }],
    });
    const msg = await stream.finalMessage();

    if (msg.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'refused', message: 'The model declined this request.' });
    }
    if (msg.stop_reason === 'max_tokens') {
      return res.status(502).json({ error: 'truncated', message: 'The plan was cut off — try a smaller request.' });
    }
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let plan;
    try { plan = JSON.parse(text); } catch {
      return res.status(502).json({ error: 'bad_output', message: 'The model returned invalid JSON.' });
    }
    return res.status(200).json({ plan, model: msg.model, usage: msg.usage });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'rate_limited', message: 'Busy — try again in a minute.' });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return res.status(502).json({ error: 'connection', message: 'Could not reach the model — try again.' });
    }
    if (err instanceof Anthropic.APIError) {
      return res.status(502).json({ error: 'api_error', status: err.status, message: err.message });
    }
    return res.status(500).json({ error: 'server_error', message: String((err && err.message) || err) });
  }
}
