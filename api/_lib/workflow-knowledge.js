// Condensed Zuper Workflow Builder knowledge for /api/workflow-ai.
//
// Distilled from the team's ZuperHuman skill (created by MSD) — only the practical
// contracts and pitfalls. Deliberately excludes the casebook (customer names) and
// internal service details, because this repository is public.
//
// Keep this text STABLE: it is the cached prefix of every request.

export const WORKFLOW_KNOWLEDGE = `
# Zuper Workflow Builder — what you must know

## How a generated workflow is assembled (by the tool, not by you)
- The tool always adds the trigger node and a "Configs" code node first. Configs returns
  { zuperBaseURL, zuperApiKey, timeZone } from workflow Variables (BASE_URL ends in /api,
  API_KEY, ZUPER_COMPANY_TIMEZONE). Every HTTP step you design gets the base URL and the
  x-api-key header automatically: you give only the METHOD and the PATH after /api.
- You design the steps AFTER Configs. Each step is one of:
  * http    — one REST call to Zuper. Output of a step named "Get Job" is read as
              $.getNodeData('Get Job')[0].data.body   (the parsed response; Zuper wraps
              records as {type, data}, so the record is usually .data.body.data).
  * code    — JavaScript. The body is the inside of a function: read earlier steps with
              $.getNodeData('<Step name>')[0].data, use require('moment-timezone'),
              require('axios'), require('form-data'), Buffer. It MUST end with
              "return { ... }". The returned object is read as
              $.getNodeData('<Code step>')[0].data.<key>. Do not use \\" inside strings
              (the editor rejects it) — use single quotes or template literals.
              Read Configs with: const { zuperBaseURL, zuperApiKey, timeZone } = $.getNodeData('Configs')[0].data;
  * if_else — branch. Conditions compare value1 (an expression) with value2 (fixed text).
              Steps after it must say branch "true" or "false".
- The trigger's payload is read as $.getNodeData('<Trigger name>')[0].data.body.
  Known shapes: customer.create → body.customer is the customer uid.
  job.* → body.job (object with job_uid) or body.job_uid. When a captured path list is
  supplied in the context, use those exact paths. Otherwise resolve defensively, e.g.
  const b = $.getNodeData('<Trigger>')[0].data.body || {};
  const jobUid = (b.job && (b.job.job_uid || b.job)) || b.job_uid;
- Expressions inside HTTP paths/bodies use double braces:
  /jobs/{{$.getNodeData('Resolve')[0]['data']['jobUid']}}
  For a JSON body, build the payload in a code step and set body_expr to
  {{$.getNodeData('Build Payload')[0]['data']['payload']}}.
- HTTP steps stop the run on error (error_action STOP) so failures are visible.

## Trigger event keys
Confirmed: customer.create (New Customer), job.new (New Job), job.status_update (Job Status
Update), estimate.update (Quote Update — quotes are the "estimate" module), invoice.new
(New Invoice). Same naming likely for: customer.update, job.update, job.schedule,
job.assign_users, job.update_checklist, estimate.new, estimate.status_update,
invoice.update, invoice.status_update, invoice.payment, payment.create.
Purchase orders / work orders probably follow purchase_order.new / purchase_order.update —
treat as unverified unless the account context lists them.
Prefer a key that appears in the account context's trigger list.

## Zuper REST endpoints (base .../api, header x-api-key)
Envelope: {"type":"success","data":...} or {"type":"error","message"}.
Jobs
- GET /jobs/{job_uid} — one job (job_title, job_category, customer, job_status[], custom_fields).
- POST /jobs {"job":{job_title, job_category:<category_uid>, job_priority, job_type:"NEW",
  customer_uid, customer_address, customer_billing_address, due_date, due_date_dt,
  custom_fields:[{label,type,value}], assigned_to:[{team_uid,user_uid,is_primary}]}}. Needs customer_uid and due_date.
- PUT /jobs {"job":{job_uid, ...fields}} — update (uid in the BODY, not the path). The
  key's user must be allowed to edit jobs (Field Executive keys get 403).
- PUT /jobs/{job_uid}/status {"status_uid":"..."} — change status. Statuses come from
  GET /jobs/status/{category_uid} → data.job_statuses[] {status_uid, status_name, status_type}.
  Match names trimmed + case-insensitive, always inside the right category.
- GET /jobs/category → categories {category_uid, category_name} (embedded statuses may be empty).
- POST /jobs/filter — search; index lags ~5 min after schedule changes.
- POST /jobs/{uid}/attachments {attachments:[{file_name,file_size:0,url}]} (adds duplicates each call).
- POST /jobs/{uid}/card {template_uid} → job card PDF bytes (only attaches files already on the job).
- POST /jobs/assign {job_uid, update_all_jobs:false, notify_users, type:"ASSIGN", users:[{team_uid,user_uid}]} (unverified live).
Customers
- GET /customers/{customer_uid}.
- POST /customers_new {"customer":{customer_first_name, customer_last_name, customer_email,
  customer_contact_no:{mobile}, customer_address{street,city,state,country,zip_code}, custom_fields}}.
- PUT /customers/{uid} {"customer":{customer_uid, ...}} (unverified live).
Quotes (estimate module)
- GET /estimate/{estimate_uid}. PUT /estimate/{uid} needs the FULL payload (never send a partial
  object; do not copy GET financing back; is_enabled is server-set).
- PUT /estimate/{uid}/status {estimate_status:"APPROVED", option_uid}.
- Deposit is never recalculated by PUT; set it explicitly; skip quotes whose deposit is COLLECTED.
Invoices
- GET /invoice/{uid}; POST /invoice {"invoice":{job, customer, template, payment_term, line_items}}.
- POST /misc/upload (multipart field "attachment") → attachment_path; POST /invoice/{uid}/attachments;
  POST /invoice/{uid}/send {template_uid,email,subject,email_body,attachments} — emails the customer,
  rate-limited (429).
- Invoices without a linked job break job lookups ("module_uid required").
Purchase orders
- Module key PURCHASE_ORDER; records under /purchase_order (GET /purchase_order/{uid},
  PUT /purchase_order/{uid} {"purchase_order":{...}}) — treat as UNVERIFIED: list it in
  unverified_endpoints and read the record back after writing. A PO usually references its job
  (job / job_uid field) — read the PO first, then GET /jobs/{job_uid}.
Settings
- GET /settings/custom_fields?module_name=JOB|CUSTOMER|... → field_name, field_type.
  Custom-field writes need the full custom_fields entry {label,type,value}.

## Rules that prevent real failures
- Read the record back after any write when correctness matters.
- Update triggers that write the same module re-trigger themselves: guard with a code step
  that compares old vs new (skip if already equal) and mention loop prevention.
- Create-type triggers fire once; data filled seconds later is not there yet.
- Two workflows on one event race; mention it if relevant.
- The Send Email node has no attachments; email PDFs through REST from a code step.
- Never hardcode keys/passwords; use Configs (variables).
- Status/category names: look them up by name at run time, never hardcode UIDs.
- Keep it minimal: the fewest steps that do the job reliably. Use a code step to compute
  values and an http step to write them.
`;
