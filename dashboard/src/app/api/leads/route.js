import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { validateAndCoerceCustomFields } from '@/utils/customFields';
import { requireOperator } from "@/utils/role";
import {
  getMockLeads,
  getMockLeadTimeline,
  addMockLead,
  editMockLead,
  deleteMockLead
} from '@/utils/mockDb';

// Load the tenant's custom-field schema. Returns an array of field defs (possibly empty).
async function loadCustomFieldsSchema(tenantId) {
  try {
    const { data } = await supabase
      .from('tenants')
      .select('config')
      .eq('id', tenantId)
      .maybeSingle();
    return Array.isArray(data?.config?.custom_fields) ? data.config.custom_fields : [];
  } catch {
    return [];
  }
}

// Helper to check if Supabase is fully configured
function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// Helper to get active tenant ID from DB, falling back to seed UUID


export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '100', 10);
    const leadId = searchParams.get('leadId');
    const importBatchId = searchParams.get('import') || searchParams.get('source_batch_id');
    const getTimeline = searchParams.get('timeline') === 'true';
    // Scope: 'current' (default) shows only actions + events tied to the lead's
    // CURRENT journey enrollment. 'all' shows the entire history including
    // prior enrollments (the phantom-event surface). 'current' is the right
    // default for daily operations — historical noise drowns out signal.
    const journeyFilter = (searchParams.get('journey_filter') || 'current').toLowerCase();

    // If timeline query is requested
    if (getTimeline && leadId) {
      if (!isSupabaseConfigured()) {
        return NextResponse.json(
          { error: 'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' },
          { status: 503 }
        );
      }

      try {
        // Step 1: fetch the lead to know tenant_id and journey_template
        const { data: lead, error: leadErr } = await supabase
          .from('leads')
          .select('id, tenant_id, journey_template, journey_status, current_step, assigned_sender_id, responded, opt_out, callback_requested')
          .eq('id', leadId)
          .maybeSingle();

        if (leadErr) {
          return NextResponse.json({ error: leadErr.message }, { status: 500 });
        }
        if (!lead) {
          return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
        }

        // Step 2: parallel fetch — actions, events, journey spec, recent tenant errors
        const [actionsRes, eventsRes, journeyRes, errorsRes] = await Promise.all([
          supabase.from('actions').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }),
          supabase.from('events').select('*').eq('lead_id', leadId).order('created_at', { ascending: false }),
          lead.journey_template
            ? supabase.from('journeys').select('id, journey_key, name, version, active, spec')
                .eq('tenant_id', lead.tenant_id).eq('journey_key', lead.journey_template).eq('active', true)
                .order('version', { ascending: false }).limit(1).maybeSingle()
            : Promise.resolve({ data: null }),
          supabase.from('error_logs').select('*')
            .eq('tenant_id', lead.tenant_id).order('created_at', { ascending: false }).limit(50)
        ]);

        if (actionsRes.error || eventsRes.error) {
          return NextResponse.json(
            { error: actionsRes.error?.message || eventsRes.error?.message },
            { status: 500 }
          );
        }

        // ── Journey-scope filter ────────────────────────────────────────
        // When journey_filter='current' (default) and the lead is enrolled
        // in a journey, drop actions whose enrolled_via doesn't match.
        // For events, drop those tied to a dropped action (via action_id).
        // Inbound events with no action_id stay visible (they're real-time
        // reactions, not enrollment-scoped). Same for system/engine events
        // that have no action_id.
        let actionsAll = actionsRes.data || [];
        let eventsAll  = eventsRes.data  || [];
        const filterCurrent = journeyFilter === 'current' && !!lead.journey_template;
        let totalActions = actionsAll.length;
        let totalEvents  = eventsAll.length;

        if (filterCurrent) {
          const currentJourney = lead.journey_template;
          actionsAll = actionsAll.filter(a => {
            const enrolledVia = a?.payload?.enrolled_via;
            // If enrolled_via is missing (very old rows pre-stamping), include
            // when the lead is currently in only one journey — safer to show
            // than hide. If the lead has been in multiple journeys, the
            // unstamped rows are likely from a different one — but we don't
            // know, so prefer showing to avoid silent data loss.
            return !enrolledVia || enrolledVia === currentJourney;
          });
          const allowedActionIds = new Set(actionsAll.map(a => a.id));
          eventsAll = eventsAll.filter(e => {
            // Keep events with no action_id (inbound replies, system logs).
            if (!e.action_id) return true;
            return allowedActionIds.has(e.action_id);
          });
        }

        const nowMs = Date.now();
        const actionItems = actionsAll.map(act => {
          const runAtMs = act.run_at ? new Date(act.run_at).getTime() : null;
          const isPending = act.status === 'pending';
          const isFuture = isPending && runAtMs && runAtMs > nowMs;
          const rescheduleCount = act.reschedule_count || 0;
          const wasRescheduled = isPending && rescheduleCount > 0;
          const skipReason = act.last_skip_reason || null;

          let subtitle = null;
          if (isFuture) {
            const when = new Date(act.run_at).toLocaleString();
            if (wasRescheduled) {
              subtitle = `Rescheduled ${rescheduleCount}× — next attempt ${when}${skipReason ? ` (last reason: ${skipReason})` : ''}`;
            } else {
              subtitle = `Scheduled for ${when}`;
            }
          } else if (isPending && runAtMs && runAtMs <= nowMs) {
            subtitle = `Due now (run_at ${new Date(act.run_at).toLocaleString()})`;
          } else if (act.status === 'failed') {
            subtitle = act.error_message || 'Failed';
          } else if (act.status === 'skipped') {
            subtitle = `Skipped: ${skipReason || act.error_message || 'see error_logs'}`;
          } else if (act.status === 'cancelled') {
            subtitle = 'Cancelled';
          }

          // AI escalation team_alerts: re-classify to system so the
          // Conversation view picks them up as an amber chip with the
          // LLM's reasoning + suggested reply (so the operator can see
          // why the AI bailed and what it would have said).
          const isAIEscalation = act.action_type === 'team_alert'
            && (act.payload?.source === 'ai_reply_escalation');
          const channel = isAIEscalation ? 'system' : act.action_type;
          const type = isAIEscalation ? 'system' : 'outbound';
          const title = isAIEscalation
            ? `Needs your reply (AI escalated)`
            : `Outbound ${act.action_type?.toUpperCase()} (step ${act.step_index})`;
          return {
            id: act.id,
            type,
            channel,
            title,
            subtitle,
            status: act.status,
            timestamp: act.completed_at || act.run_at,
            runAt: act.run_at,
            isFuture,
            isPending,
            wasRescheduled,
            rescheduleCount,
            skipReason,
            canRunNow: isPending,
            details: act.payload || {},
            error: act.error_message,
            provider: act.provider,
            providerId: act.provider_id,
            templateKey: act.template_key,
            stepIndex: act.step_index,
            // AI escalation surface for the conversation bubble.
            isAIEscalation,
            aiEscalationReason: isAIEscalation ? (act.payload?.reason || null) : null,
            aiSuggestedReply:   isAIEscalation ? (act.payload?.ai_suggested_reply || null) : null,
            aiIntent:           isAIEscalation ? (act.payload?.intent || null) : null,
            aiConfidence:       isAIEscalation ? (act.payload?.confidence ?? null) : null,
            aiReasoning:        isAIEscalation ? (act.payload?.reasoning || null) : null,
          };
        });

        // Index actions by id so we can enrich events with their parent
        // action's payload (AI metadata, source flags, etc.). The event
        // table only stores the canonical send payload; AI provenance
        // (source='ai_reply', agent_id, intent, confidence) lives on the
        // action that triggered the send.
        const actionsById = new Map();
        for (const a of actionsAll) actionsById.set(a.id, a);

        const eventItems = eventsAll.map(evt => {
          const parentAction = evt.action_id ? actionsById.get(evt.action_id) : null;
          const ap = parentAction?.payload || {};
          return ({
            id: evt.id,
            // Direction-aware typing. Outbound events were previously typed
            // as 'event' which made the Conversation view render them as
            // centered "system" chips instead of outbound bubbles. Anything
            // with no clear direction (system logs etc.) stays 'event'.
            type: evt.direction === 'inbound'
                    ? 'inbound'
                    : evt.direction === 'outbound'
                      ? 'outbound'
                      : 'event',
            actionId: evt.action_id || null,
            channel: evt.channel,
            title: evt.direction === 'inbound'
              ? `Inbound ${evt.channel?.toUpperCase()}`
              : evt.channel === 'call'
                ? `Call result: ${evt.call_outcome || 'unknown'}`
                : `${evt.channel?.toUpperCase()} sent`,
            status: evt.call_outcome || evt.sms_status || evt.email_status || 'logged',
            timestamp: evt.created_at,
            body: evt.body,
            subject: evt.subject,
            callDuration: evt.call_duration_seconds,
            callRecordingUrl: evt.call_recording_url,
            callTranscript: evt.call_transcript,
            callSummary: evt.call_summary,
            from: evt.from_address,
            to: evt.to_address,
            // AI metadata bubbled up from the parent action — drives the
            // "AI" badge in the conversation view.
            aiSource:     ap.source || null,            // 'ai_reply' | null
            aiAgentName:  ap.agent_name || null,
            aiIntent:     ap.ai_intent || null,
            aiConfidence: ap.ai_confidence ?? null,
            aiReasoning:  ap.ai_reasoning || null,
          });
        });

        // Convert lead-relevant errors (matched by raw_error referencing lead_id or by recency)
        const errorItems = (errorsRes.data || [])
          .filter(err => {
            const raw = err.raw_error;
            if (!raw) return false;
            try {
              const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
              return s.includes(leadId);
            } catch {
              return false;
            }
          })
          .map(err => ({
            id: `err_${err.id}`,
            type: 'error',
            channel: 'system',
            title: `Error: ${err.workflow_name || 'unknown workflow'}`,
            status: err.severity || 'error',
            timestamp: err.created_at,
            error: err.error_message,
            details: err.raw_error,
          }));

        // Build warnings list (non-timeline; surfaced separately)
        const warnings = [];

        if (!lead.journey_template) {
          warnings.push({
            severity: 'error',
            code: 'journey_template_missing',
            message: 'Lead has no journey_template. It will never advance through a sequence.',
          });
        } else if (!journeyRes.data) {
          warnings.push({
            severity: 'error',
            code: 'journey_not_found',
            message: `journey_template "${lead.journey_template}" does not match any active journey for this tenant. Step 0 may have sent, but advance_journey will silently mark the lead "completed" after the first step. Fix by updating the lead's journey_template to a valid key.`,
          });
        }

        // Only warn about premature completion if the journey is actually missing.
        // A legitimate exit at step 0 (e.g., call answered) is not a bug.
        if (lead.journey_status === 'completed'
            && (actionsRes.data || []).length <= 1
            && !journeyRes.data) {
          warnings.push({
            severity: 'warning',
            code: 'completed_with_one_action',
            message: 'Lead status is "completed" but only one action ran AND the journey template was not found. The engine likely exited prematurely. Check the lead\'s journey_template field.',
          });
        }

        // Informational: surface the actual exit outcome if the journey terminated.
        if (lead.journey_status
            && journeyRes.data
            && ['completed','responded','opted_out','callback_booked','error'].includes(lead.journey_status)) {
          const lastCompleted = (actionsRes.data || []).find(a => a.status === 'completed');
          const lastEvent = (eventsRes.data || []).find(e => e.direction === 'outbound' || e.call_outcome);
          const exitOutcome = lastEvent?.call_outcome
            || lastEvent?.sms_status
            || lastEvent?.email_status
            || lastCompleted?.result?.outcome
            || 'unknown';
          warnings.push({
            severity: 'info',
            code: 'journey_exited',
            message: `Journey "${journeyRes.data.journey_key}" exited with status "${lead.journey_status}" after step ${lead.current_step ?? 0}. Last recorded outcome: ${exitOutcome}.`,
          });
        }

        if (lead.journey_template && journeyRes.data && lead.journey_status === 'active') {
          const stepsCount = (journeyRes.data.spec?.steps || []).length;
          if (lead.current_step >= stepsCount - 1) {
            warnings.push({
              severity: 'info',
              code: 'on_last_step',
              message: `Lead is on the last step (${lead.current_step + 1} of ${stepsCount}). Next outcome will exit the journey.`,
            });
          }
        }

        const combined = [...actionItems, ...eventItems, ...errorItems]
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        return NextResponse.json({
          data: combined,
          warnings,
          journey: journeyRes.data || null,
          lead,
          scope: {
            filter:           journeyFilter,                                  // 'current' | 'all'
            applied:          filterCurrent,                                  // whether filter actually filtered anything
            current_journey:  lead.journey_template || null,
            actions_total:    totalActions,
            actions_shown:    actionsAll.length,
            actions_hidden:   totalActions - actionsAll.length,
            events_total:     totalEvents,
            events_shown:     eventsAll.length,
            events_hidden:    totalEvents - eventsAll.length,
          },
        });
      } catch (err) {
        console.error('Timeline fetch failed:', err);
        return NextResponse.json({ error: err.message || 'Timeline fetch failed' }, { status: 500 });
      }
    }

    // Standard list query
    if (!isSupabaseConfigured()) {
      return NextResponse.json(
        { error: 'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.' },
        { status: 503 }
      );
    }

    const tenantId = await getTenantId(request);
    let query = supabase
      .from('leads')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (importBatchId) {
      query = query.eq('source_batch_id', importBatchId);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Supabase leads fetch failed:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error('Unexpected error fetching leads:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role key is missing. Add SUPABASE_SERVICE_ROLE_KEY to .env.local and restart the dev server.' },
      { status: 503 }
    );
  }
  try {
    const body = await request.json();
    const tenantId = await getTenantId(request);

    if (!body.journey_template) {
      return NextResponse.json(
        { error: 'journey_template is required. Pick a valid journey from the dropdown.' },
        { status: 400 }
      );
    }

    // Validate journey_template before insert so we don't create orphan leads
    const { data: journey, error: journeyError } = await supabase
      .from('journeys')
      .select('id, journey_key, spec')
      .eq('tenant_id', tenantId)
      .eq('journey_key', body.journey_template)
      .eq('active', true)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (journeyError) {
      return NextResponse.json({ error: `Journey lookup failed: ${journeyError.message}` }, { status: 500 });
    }
    if (!journey) {
      return NextResponse.json(
        { error: `journey_template "${body.journey_template}" not found for tenant. Pick a valid journey from the dropdown.` },
        { status: 400 }
      );
    }

    // Custom-field validation. Schema is the source of truth — coerce and reject
    // anything that doesn't match the declared type / required-ness.
    const schema = await loadCustomFieldsSchema(tenantId);
    const cfResult = validateAndCoerceCustomFields(body.custom_fields || {}, schema);
    if (!cfResult.ok) {
      return NextResponse.json(
        { error: 'Custom field validation failed', field_errors: cfResult.errors },
        { status: 400 }
      );
    }

    // journey_status: if the operator picked a journey during lead creation, the
    // lead is enrolled — force 'active'. Client-side default of 'new' from an old
    // form leaked through in the past, and downstream UI reads 'new' as
    // "Not enrolled" which is misleading (the lead IS enrolled + has a queued
    // action). Never let 'new' land alongside a real journey_template.
    const resolvedJourneyStatus = body.journey_template
      ? 'active'
      : (body.journey_status || 'new');

    const leadInsert = {
      tenant_id: tenantId,
      first_name: body.first_name || '',
      last_name: body.last_name || '',
      email: body.email || null,
      phone_raw: body.phone_raw || null,
      phone_e164: body.phone_e164 || body.phone_raw || null,
      journey_template: body.journey_template,
      journey_status: resolvedJourneyStatus,
      custom_fields: cfResult.value,
      raw_payload: body.raw_payload || {},
      source: body.source || 'Manual Add'
    };

    const { data, error } = await supabase
      .from('leads')
      .insert([leadInsert])
      .select();

    if (error) {
      console.error('Failed to insert lead into Supabase:', error);
      return NextResponse.json(
        { error: `Insert failed: ${error.message}. If this says "permission denied" or "violates RLS", your env vars are using the anon key — set SUPABASE_SERVICE_ROLE_KEY.` },
        { status: 500 }
      );
    }

    const newLead = data[0];

    if (journey?.journey_key) {
      const { data: enroll, error: enrollErr } = await supabase.rpc("enroll_lead_in_journey", {
        p_tenant_id: tenantId,
        p_lead_id: newLead.id,
        p_journey_key: journey.journey_key,
        p_source: "lead_create",
      });
      if (enrollErr || (enroll && !["enrolled", "already_active"].includes(enroll.status))) {
        const detail = enrollErr?.message || enroll?.status || "unknown";
        console.error("Lead created but enrollment failed:", detail);
        return NextResponse.json(
          { data: newLead, warning: `Lead created but journey enrollment failed: ${detail}` }
        );
      }
    }

    return NextResponse.json({ data: newLead });
  } catch (err) {
    console.error('Error in POST leads:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function PUT(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const body = await request.json();
    const { id, ...updateData } = body;

    if (!id) {
      return NextResponse.json({ error: 'Lead ID is required' }, { status: 400 });
    }

    if (!isSupabaseConfigured()) {
      const updated = editMockLead(id, updateData);
      return NextResponse.json({ data: updated });
    }
    const tenantId = await getTenantId(request);

    // Validate custom_fields only if the caller is actually updating them.
    let coercedCustomFields = updateData.custom_fields;
    if (updateData.custom_fields !== undefined) {
      // Resolve tenant by looking up the lead first (PUT body has no tenant_id).
      const { data: existing } = await supabase
        .from('leads').select('tenant_id').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
      if (!existing) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });
      const schema = await loadCustomFieldsSchema(tenantId);
      const cfResult = validateAndCoerceCustomFields(updateData.custom_fields || {}, schema);
      if (!cfResult.ok) {
        return NextResponse.json(
          { error: 'Custom field validation failed', field_errors: cfResult.errors },
          { status: 400 }
        );
      }
      coercedCustomFields = cfResult.value;
    }

    const leadUpdate = {
      first_name: updateData.first_name,
      last_name: updateData.last_name,
      email: updateData.email,
      phone_raw: updateData.phone_raw,
      phone_e164: updateData.phone_e164 || updateData.phone_raw,
      journey_template: updateData.journey_template,
      journey_status: updateData.journey_status,
      custom_fields: coercedCustomFields,
      raw_payload: updateData.raw_payload,
      responded: updateData.responded,
      opt_out: updateData.opt_out
    };

    // Remove undefined fields
    Object.keys(leadUpdate).forEach(key => leadUpdate[key] === undefined && delete leadUpdate[key]);

    const { data, error } = await supabase
      .from('leads')
      .update(leadUpdate)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select();

    if (error) {
      console.warn('Failed to update lead in Supabase, updating mock DB:', error.message);
      const updated = editMockLead(id, updateData);
      return NextResponse.json({ data: updated });
    }

    return NextResponse.json({ data: data[0] });
  } catch (err) {
    console.error('Error in PUT leads:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Lead ID is required' }, { status: 400 });
    }

    if (!isSupabaseConfigured()) {
      const success = deleteMockLead(id);
      return NextResponse.json({ success });
    }
    const tenantId = await getTenantId(request);

    const { error } = await supabase
      .from('leads')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) {
      console.warn('Failed to delete lead in Supabase, deleting from mock DB:', error.message);
      const success = deleteMockLead(id);
      return NextResponse.json({ success });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error in DELETE leads:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
