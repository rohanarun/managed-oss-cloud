import type { Response } from "express";
import { z } from "zod";
import type { SuiteRecord } from "../shared/suite.js";

const fieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
  type: z.enum(["short-text", "long-text", "boolean", "integer", "decimal", "date", "date-time", "choice", "multi-choice", "email", "url"]),
  required: z.boolean(),
  purpose: z.string().min(1).max(4_000),
  privacy: z.enum(["public", "internal", "restricted"]),
  choices: z.array(z.string().min(1).max(500)).max(100).optional(),
}).strict();

const logicSchema = z.object({
  when: z.object({ field: z.string(), equals: z.unknown() }).passthrough(),
  effect: z.enum(["show", "hide", "require"]),
  target: z.string(),
}).passthrough();

const formContentSchema = z.object({
  title: z.string().min(1).max(200),
  schema: z.object({ version: z.unknown().optional(), fields: z.array(fieldSchema).min(1).max(200) }).passthrough(),
  logic: z.array(logicSchema).max(200),
}).passthrough();

export const publicFormSubmissionSchema = z.object({
  responseValues: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length <= 200, "Too many response fields."),
  respondentKey: z.string().min(1).max(512).optional(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,200}$/),
}).strict();

export const publicAvailabilityQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  timeZone: z.string().trim().min(1).max(100),
}).strict();

export const publicBookingSchema = z.object({
  hostId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{16,200}$/),
  invitee: z.object({
    name: z.string().trim().min(1).max(160),
    email: z.string().trim().toLowerCase().email().max(254),
    timeZone: z.string().trim().min(1).max(100),
    notes: z.string().trim().min(1).max(2_000).optional(),
    consent: z.object({
      granted: z.literal(true),
      policyVersion: z.string().trim().min(1).max(100),
    }).strict(),
  }).strict(),
}).strict();

export const PUBLIC_BOOKING_POLICY_VERSION = "booking-privacy-v1";

export interface PublicFormRelease {
  id: string;
  title: string;
  fields: z.infer<typeof fieldSchema>[];
  logic: z.infer<typeof logicSchema>[];
}

export interface PublicEventRelease {
  id: string;
  title: string;
  slug: string;
  durationMinutes: number;
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function safeScriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/&/g, "\\u0026");
}

function labelFor(key: string) {
  return key.split("-").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ");
}

function formControl(field: z.infer<typeof fieldSchema>) {
  const id = `field-${field.key}`;
  const required = field.required ? " required" : "";
  const common = `id="${id}" name="${escapeHtml(field.key)}" data-field="${escapeHtml(field.key)}" data-type="${escapeHtml(field.type)}"${required}`;
  if (field.type === "long-text") return `<textarea ${common} rows="5" maxlength="20000"></textarea>`;
  if (field.type === "boolean") return `<label class="choice"><input type="checkbox" ${common}> Yes</label>`;
  if (field.type === "choice") {
    const options = (field.choices ?? []).map((choice) => `<option value="${escapeHtml(choice)}">${escapeHtml(choice)}</option>`).join("");
    return `<select ${common}><option value="">Choose one</option>${options}</select>`;
  }
  if (field.type === "multi-choice") {
    const options = (field.choices ?? []).map((choice) => `<option value="${escapeHtml(choice)}">${escapeHtml(choice)}</option>`).join("");
    return `<select ${common} multiple size="${Math.min(8, Math.max(3, field.choices?.length ?? 3))}">${options}</select>`;
  }
  const type = field.type === "email" ? "email"
    : field.type === "url" ? "url"
      : field.type === "integer" || field.type === "decimal" ? "number"
        : field.type === "date" ? "date"
          : field.type === "date-time" ? "datetime-local"
            : "text";
  const step = field.type === "integer" ? ' step="1"' : field.type === "decimal" ? ' step="any"' : "";
  return `<input type="${type}" ${common}${step} maxlength="${field.type === "short-text" ? 4000 : 20000}">`;
}

export function publicFormRelease(record: SuiteRecord): PublicFormRelease | undefined {
  if (record.moduleId !== "forms" || record.recordType !== "form-release" || record.state !== "published" || record.data.public !== true) return undefined;
  const content = formContentSchema.safeParse(record.data.content);
  if (!content.success) return undefined;
  return { id: record.id, title: content.data.title, fields: content.data.schema.fields, logic: content.data.logic };
}

export function publicEventRelease(record: SuiteRecord): PublicEventRelease | undefined {
  if (record.moduleId !== "schedule" || record.recordType !== "event-release" || record.state !== "published" || record.data.public !== true) return undefined;
  const content = z.object({
    name: z.string().min(1).max(200),
    slug: z.string().regex(/^[a-z][a-z0-9-]{1,79}$/),
    durationMinutes: z.number().int().min(5).max(1_440),
  }).passthrough().safeParse(record.data.content);
  if (!content.success) return undefined;
  return { id: record.id, title: content.data.name, slug: content.data.slug, durationMinutes: content.data.durationMinutes };
}

export function setPublicPortalHeaders(response: Response, nonce: string) {
  response.set("Cache-Control", "no-store, max-age=0");
  response.set("Pragma", "no-cache");
  response.set("Referrer-Policy", "no-referrer");
  response.set("X-Robots-Tag", "noindex, nofollow");
  response.set("Content-Security-Policy", `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self'; img-src 'self' data:; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`);
}

function portalStyles() {
  return `:root{color-scheme:light;--ink:#14211f;--muted:#5d6b68;--line:#d9e2df;--paper:#f7faf8;--accent:#0d765f;--accent2:#aef0d7}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 10%,#d9fff2 0,transparent 36rem),var(--paper);color:var(--ink);font:16px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,sans-serif}main{width:min(92vw,72rem);margin:0 auto;padding:4rem 0 7rem}.brand{font-weight:750;letter-spacing:-.03em}.shell{display:grid;grid-template-columns:minmax(0,.9fr) minmax(22rem,1.1fr);gap:clamp(2rem,7vw,7rem);align-items:start;margin-top:5rem}.intro{position:sticky;top:3rem}h1{max-width:72rem;margin:.4rem 0 1rem;font-size:clamp(3rem,7vw,6.5rem);line-height:.88;letter-spacing:-.075em}h2{margin:.25rem 0 1.25rem;font-size:clamp(2rem,4vw,3.3rem);line-height:1;letter-spacing:-.055em}.lede{max-width:34rem;color:var(--muted);font-size:1.1rem}.card{background:rgba(255,255,255,.9);border:1px solid var(--line);border-radius:1.75rem;padding:clamp(1.4rem,4vw,2.5rem);box-shadow:0 2rem 6rem rgba(20,33,31,.1)}.field{margin:0 0 1.5rem}.field[hidden]{display:none}.field>label{display:block;margin-bottom:.45rem;font-weight:720}.hint{display:block;margin-top:.45rem;color:var(--muted);font-size:.9rem}.privacy{color:var(--accent);font-weight:650}input,textarea,select,button{font:inherit}input:not([type=checkbox]),textarea,select{width:100%;border:1px solid #b9c8c4;border-radius:.8rem;background:#fff;color:var(--ink);padding:.85rem 1rem}select[multiple]{min-height:8rem}input:focus-visible,textarea:focus-visible,select:focus-visible,button:focus-visible{outline:3px solid #62d8b6;outline-offset:3px}.choice{display:flex!important;gap:.6rem;align-items:center;font-weight:500!important}.choice input{width:1.2rem;height:1.2rem}button{border:0;border-radius:999px;padding:.9rem 1.25rem;background:var(--ink);color:#fff;font-weight:750;cursor:pointer}button:hover{background:var(--accent)}button:disabled{cursor:not-allowed;opacity:.55}.status{min-height:1.6rem;margin-top:1rem;font-weight:650}.status[data-kind=success]{color:#087052}.status[data-kind=error]{color:#a12424}.legal{margin-top:1.5rem;color:var(--muted);font-size:.86rem}.slots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem;max-height:24rem;overflow:auto;padding:.25rem}.slot{border:1px solid #a9bdb7;background:#fff;color:var(--ink);border-radius:.75rem;text-align:left}.slot[aria-pressed=true]{border-color:var(--accent);background:var(--accent2)}.booking-form{margin-top:2rem;padding-top:2rem;border-top:1px solid var(--line)}.booking-form[hidden]{display:none}.empty{padding:1.5rem;border:1px dashed #9db3ad;border-radius:1rem;color:var(--muted)}@media(max-width:820px){main{padding-top:2rem}.shell{grid-template-columns:1fr;margin-top:3rem}.intro{position:static}h1{font-size:clamp(3.4rem,17vw,5.5rem)}.slots{grid-template-columns:1fr}}`;
}

export function renderPublicFormPage(input: { workspaceName: string; release: PublicFormRelease; submitPath: string; nonce: string }) {
  const fields = input.release.fields.map((field) => `<div class="field" data-field-row="${escapeHtml(field.key)}"><label for="field-${escapeHtml(field.key)}">${escapeHtml(labelFor(field.key))}${field.required ? " <span aria-hidden=\"true\">*</span>" : ""}</label>${formControl(field)}<small class="hint">${escapeHtml(field.purpose)} <span class="privacy">${field.privacy === "public" ? "Shared as disclosed." : "Kept private in this workspace."}</span></small></div>`).join("");
  const logic = safeScriptJson(input.release.logic);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(input.release.title)}</title><style nonce="${input.nonce}">${portalStyles()}</style></head><body><main><div class="brand">${escapeHtml(input.workspaceName)}</div><div class="shell"><section class="intro"><p>Secure form</p><h1>${escapeHtml(input.release.title)}</h1><p class="lede">Complete the fields at right. Your answers are validated against this exact published form version.</p></section><section class="card"><form id="public-form" data-endpoint="${escapeHtml(input.submitPath)}" novalidate>${fields}<button type="submit">Send response</button><p id="form-status" class="status" role="status" aria-live="polite"></p></form><p class="legal">Responses are transmitted directly to this workspace. No advertising profile or third-party tracking is created.</p></section></div></main><script id="form-logic" type="application/json" nonce="${input.nonce}">${logic}</script><script nonce="${input.nonce}">(()=>{const form=document.getElementById('public-form'),status=document.getElementById('form-status'),rules=JSON.parse(document.getElementById('form-logic').textContent),key='form.'+crypto.randomUUID();function value(el){if(el.dataset.type==='boolean')return el.checked;if(el.dataset.type==='multi-choice')return [...el.selectedOptions].map(x=>x.value);if(el.dataset.type==='integer')return el.value===''?undefined:Number.parseInt(el.value,10);if(el.dataset.type==='decimal')return el.value===''?undefined:Number(el.value);if(el.dataset.type==='date-time')return el.value?new Date(el.value).toISOString():undefined;return el.value===''?undefined:el.value}function apply(){for(const el of form.querySelectorAll('[data-field]')){const row=form.querySelector('[data-field-row=\"'+CSS.escape(el.dataset.field)+'\"]');if(row)row.hidden=false;el.disabled=false;el.required=el.dataset.baseRequired==='true'}const values=Object.fromEntries([...form.querySelectorAll('[data-field]')].map(el=>[el.dataset.field,value(el)]));for(const rule of rules){const row=form.querySelector('[data-field-row=\"'+CSS.escape(rule.target)+'\"]'),target=form.querySelector('[data-field=\"'+CSS.escape(rule.target)+'\"]');if(!row||!target)continue;const match=JSON.stringify(values[rule.when.field])===JSON.stringify(rule.when.equals);if(rule.effect==='hide'&&match){row.hidden=true;target.disabled=true;target.required=false}else if(rule.effect==='show'){row.hidden=!match;target.disabled=!match}else if(rule.effect==='require'){target.required=match||target.dataset.baseRequired==='true'}}}for(const el of form.querySelectorAll('[data-field]'))el.dataset.baseRequired=String(el.required);form.addEventListener('input',apply);apply();form.addEventListener('submit',async event=>{event.preventDefault();status.textContent='';status.dataset.kind='';if(!form.reportValidity())return;const responseValues={};for(const el of form.querySelectorAll('[data-field]')){if(el.disabled)continue;const item=value(el);if(item!==undefined)responseValues[el.dataset.field]=item}const button=form.querySelector('button');button.disabled=true;try{const response=await fetch(form.dataset.endpoint,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify({responseValues,idempotencyKey:key})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'The response could not be accepted.');status.textContent='Response received. You can close this page.';status.dataset.kind='success';for(const control of form.elements)control.disabled=true}catch(error){button.disabled=false;status.textContent=error instanceof Error?error.message:'The response could not be accepted.';status.dataset.kind='error';status.focus()}})})();</script></body></html>`;
}

export function renderPublicBookingPage(input: { workspaceName: string; release: PublicEventRelease; availabilityPath: string; bookingPath: string; nonce: string }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Book ${escapeHtml(input.release.title)}</title><style nonce="${input.nonce}">${portalStyles()}</style></head><body><main><div class="brand">${escapeHtml(input.workspaceName)}</div><div class="shell"><section class="intro"><p>${input.release.durationMinutes}-minute meeting</p><h1>${escapeHtml(input.release.title)}</h1><p class="lede">Choose a live available time. The selected interval is checked again atomically when you confirm.</p></section><section class="card" id="booking" data-availability="${escapeHtml(input.availabilityPath)}" data-booking="${escapeHtml(input.bookingPath)}" data-policy="${PUBLIC_BOOKING_POLICY_VERSION}"><h2>Choose a time</h2><p id="zone-label" class="hint"></p><div id="slots" class="slots" role="group" aria-label="Available meeting times"><p class="empty">Loading current availability.</p></div><form id="booking-form" class="booking-form" hidden><div class="field"><label for="invitee-name">Your name</label><input id="invitee-name" autocomplete="name" required maxlength="160"></div><div class="field"><label for="invitee-email">Email</label><input id="invitee-email" type="email" autocomplete="email" required maxlength="254"></div><div class="field"><label for="invitee-notes">Notes <span class="hint">Optional</span></label><textarea id="invitee-notes" rows="4" maxlength="2000"></textarea></div><div class="field"><label class="choice"><input id="invitee-consent" type="checkbox" required> I agree that these details are used to administer this booking.</label></div><button type="submit">Confirm booking</button><p id="booking-status" class="status" role="status" aria-live="polite"></p></form><p class="legal">Your contact details remain private to this workspace. Calendar and email delivery are reported separately and never inferred.</p></section></div></main><script nonce="${input.nonce}">(()=>{const root=document.getElementById('booking'),slots=document.getElementById('slots'),form=document.getElementById('booking-form'),status=document.getElementById('booking-status'),zone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',key='booking.'+crypto.randomUUID();let selected;document.getElementById('zone-label').textContent='Times shown in '+zone;function range(){const from=new Date();from.setSeconds(0,0);const remainder=from.getMinutes()%5;if(remainder)from.setMinutes(from.getMinutes()+5-remainder);const to=new Date(from.getTime()+14*86400000);return{from:from.toISOString(),to:to.toISOString()}}async function load(){selected=undefined;form.hidden=true;slots.innerHTML='<p class=\"empty\">Loading current availability.</p>';const query=new URLSearchParams({...range(),timeZone:zone});try{const response=await fetch(root.dataset.availability+'?'+query,{credentials:'omit',referrerPolicy:'no-referrer'}),body=await response.json();if(!response.ok)throw new Error();slots.replaceChildren();for(const slot of body.slots.slice(0,120)){const button=document.createElement('button');button.type='button';button.className='slot';button.setAttribute('aria-pressed','false');button.textContent=new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:zone}).format(new Date(slot.startsAt));button.addEventListener('click',()=>{for(const current of slots.querySelectorAll('button'))current.setAttribute('aria-pressed','false');button.setAttribute('aria-pressed','true');selected=slot;form.hidden=false;document.getElementById('invitee-name').focus()});slots.append(button)}if(!body.slots.length)slots.innerHTML='<p class=\"empty\">No times are available in the next two weeks.</p>'}catch{slots.innerHTML='<p class=\"empty\">Availability could not be loaded safely. Try again shortly.</p>'}}form.addEventListener('submit',async event=>{event.preventDefault();status.textContent='';if(!selected||!form.reportValidity())return;const button=form.querySelector('button');button.disabled=true;const notes=document.getElementById('invitee-notes').value.trim();const payload={hostId:selected.hostId,startsAt:selected.startsAt,endsAt:selected.endsAt,idempotencyKey:key,invitee:{name:document.getElementById('invitee-name').value,email:document.getElementById('invitee-email').value,timeZone:zone,...(notes?{notes}:{}),consent:{granted:true,policyVersion:root.dataset.policy}}};try{const response=await fetch(root.dataset.booking,{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||'The booking could not be confirmed.');status.textContent='Booked for '+new Intl.DateTimeFormat(undefined,{dateStyle:'full',timeStyle:'short',timeZone:zone}).format(new Date(body.startsAt))+'.';status.dataset.kind='success';for(const control of form.elements)control.disabled=true;for(const control of slots.querySelectorAll('button'))control.disabled=true}catch(error){button.disabled=false;status.textContent=error instanceof Error?error.message:'The booking could not be confirmed.';status.dataset.kind='error';if(error instanceof Error&&/no longer available/i.test(error.message))load()}});load()})();</script></body></html>`;
}
