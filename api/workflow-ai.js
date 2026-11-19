// Workflow Composer — prompt → workflow plan, designed by Claude.
//
// POST /api/workflow-ai
//   headers: x-zuper-key, x-zuper-base   (the caller's own Zuper API key + region base)
//   body:    { prompt, context }         (context = account facts gathered by the tool)
// → { plan } — a list of steps the tool compiles into real Workflow Builder nodes.
//
//   body:    { mode:'fix', prompt, context, workflow, run }
// → { fix }  — a diagnosis plus field-level edits to an EXISTING workflow's draft nodes.
//              The browser applies, validates and saves them (never publishes on its own).
//              Secrets are swapped for «secret:N» placeholders in the browser before they
//              are sent, and restored there afterwards.
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
const MAX_FIX_CONTEXT = 180000;

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

const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['diagnosis', 'failing_step', 'changes', 'manual_steps', 'test_plan', 'clarifying_question'],
  properties: {
    diagnosis: { type: 'string', description: 'Cause first, in two to five plain sentences.' },
    failing_step: { type: 'string', description: 'Name of the step where it goes wrong, or empty.' },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['node_uid', 'step_name', 'field_path', 'new_value_json', 'reason'],
        properties: {
          node_uid: { type: 'string', description: 'node_uid of an existing node, copied exactly.' },
          step_name: { type: 'string' },
          field_path: { type: 'string', description: 'Dot path inside the node: "is_active", or one starting with "form_fields." (array indexes as numbers, e.g. form_fields.conditions.0.value2.value).' },
          new_value_json: { type: 'string', description: 'The complete new value as JSON text; a string value is a JSON string. For code, the full new source as a JSON string.' },
          reason: { type: 'string' },
        },
      },
    },
    manual_steps: { type: 'array', items: { type: 'string' }, description: 'Fixes that cannot be done by editing node fields: adding/removing/rewiring nodes, user roles, Variables, data fixes.' },
    test_plan: { type: 'array', items: { type: 'string' } },
    clarifying_question: { type: 'string', description: 'Empty unless nothing sensible can be changed.' },
  },
};

// Shared knowledge first so both modes reuse one cached prefix; the task text follows.
const KNOWLEDGE = `You are an expert on Zuper's Workflow Builder.

${WORKFLOW_KNOWLEDGE}`;

const BUILD_TASK = `TASK: design a NEW workflow from a plain-English request.
Return a plan that the Workflow Composer compiles into real builder nodes.
Pick the trigger yourself from the request — the user does not split it into when/if/then.
Prefer endpoints marked confirmed; when you must use an unverified one, still build it and
list it in unverified_endpoints. Record every guess in assumptions. Only ask a
clarifying_question when nothing sensible can be built; otherwise leave it empty and build.
Never hardcode UIDs, keys or passwords; resolve names at run time.`;

const FIX_TASK = `TASK: fix or change an EXISTING workflow.
You get its draft nodes (node_uid, name, action_key, is_active, form_fields), its connections
(by step name), and usually one recent run with per-step status, errors and output excerpts.
- Diagnose first: find the first step whose output differs from what the next step expected.
  Use the debugging playbook. A COMPLETED run can still hide a failed HTTP call.
- Then make the SMALLEST set of field edits that fixes it, or that does what the user asked.
  Edit only nodes you were given; copy node_uid exactly; never rename steps (other steps
  read them by name).
- Existing workflows use many node types (zuper_update, send_email, http_request, code,
  if_else, ...). Keep each field's existing shape: if it is {type, value}, write that shape.
- Text shown as «secret:N» is a hidden credential. If you rewrite a field that contains one,
  keep the placeholder exactly where it was; never invent, move or remove secrets.
- Anything needing new/removed/rewired nodes, account settings, user roles or data fixes goes
  in manual_steps with precise instructions.
- If there is no error and no instruction, say so in diagnosis and return no changes.`;

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
  const mode = body.mode === 'fix' ? 'fix' : 'build';
  const prompt = String(body.prompt || '').trim();
  if (!prompt && mode === 'build') return res.status(400).json({ error: 'empty prompt' });
  if (prompt.length > MAX_PROMPT) return res.status(400).json({ error: 'prompt too long' });
  const context = JSON.stringify(body.context || {}).slice(0, MAX_CONTEXT);

  let userText;
  if (mode === 'fix') {
    const wf = body.workflow;
    if (!wf || !Array.isArray(wf.nodes) || !wf.nodes.length) return res.status(400).json({ error: 'no workflow nodes supplied' });
    const wfText = JSON.stringify(wf);
    const runText = body.run ? JSON.stringify(body.run) : '';
    if (wfText.length + runText.length > MAX_FIX_CONTEXT) {
      return res.status(413).json({ error: 'too_large', message: 'This workflow is too large to send in one request. Use the node editor instead.' });
    }
    userText =
      `Account: ${company}\nAccount context (JSON):\n${context}\n\n` +
      `Workflow (draft, JSON):\n${wfText}\n\n` +
      (runText ? `Recent run (JSON):\n${runText}\n\n` : 'No run was selected.\n\n') +
      `User's instruction:\n${prompt || '(none — fix the error shown in the run)'}`;
  } else {
    userText = `Account: ${company}\nAccount context (JSON):\n${context}\n\nRequest:\n${prompt}`;
  }

  const client = new Anthropic();
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: mode === 'fix' ? FIX_SCHEMA : PLAN_SCHEMA } },
      system: [
        { type: 'text', text: KNOWLEDGE, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: mode === 'fix' ? FIX_TASK : BUILD_TASK },
      ],
      messages: [{ role: 'user', content: userText }],
    });
    const msg = await stream.finalMessage();

    if (msg.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'refused', message: 'The model declined this request.' });
    }
    if (msg.stop_reason === 'max_tokens') {
      return res.status(502).json({ error: 'truncated', message: 'The plan was cut off — try a smaller request.' });
    }
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let out;
    try { out = JSON.parse(text); } catch {
      return res.status(502).json({ error: 'bad_output', message: 'The model returned invalid JSON.' });
    }
    return res.status(200).json(mode === 'fix'
      ? { fix: out, model: msg.model, usage: msg.usage }
      : { plan: out, model: msg.model, usage: msg.usage });
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
