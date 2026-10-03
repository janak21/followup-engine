// POST /api/ai-agents/from-template
//
// One-shot: create an agent + its seed KB items from a template id.
//
// Body: { template_id: string, name_override?: string }
//
// - Resolves the template from the static AI_AGENT_TEMPLATES list.
// - Inserts the agent row with the template's default config.
// - If the tenant already has an agent by the same name, appends " (copy)"
//   until it's unique — the operator can rename later.
// - Then inserts every KB item from the template attached to the new agent.
//   KB insertion failures are non-fatal (agent is already created); we return
//   a partial success indicator so the UI can flag it.
//
// Returns: { data: { agent, knowledge_created, knowledge_failed } }

import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from '@/utils/role';
import { getTemplateById } from '@/lib/aiAgentTemplates';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

async function resolveUniqueName(tenantId, baseName) {
  // Try the base name first; if it collides on the UNIQUE (tenant_id, name),
  // append " (copy)", " (copy 2)", etc. Cheap linear probe — operators
  // never realistically hit 3+ copies of the same template.
  let candidate = baseName;
  for (let i = 0; i < 5; i++) {
    const { data } = await supabase
      .from('ai_agents')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('name', candidate)
      .maybeSingle();
    if (!data) return candidate;
    candidate = i === 0 ? `${baseName} (copy)` : `${baseName} (copy ${i + 1})`;
  }
  // Fallback: timestamp suffix. Extremely unlikely to hit this branch.
  return `${baseName} (copy ${Date.now()})`;
}

export async function POST(request) {
  const guard = await requireOperator(request); if (guard) return guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured.' }, { status: 503 });
  }

  try {
    const body = await request.json();
    const templateId = body?.template_id;
    if (!templateId) {
      return NextResponse.json({ error: 'template_id is required' }, { status: 400 });
    }

    const template = getTemplateById(templateId);
    if (!template) {
      return NextResponse.json({ error: `Unknown template_id: ${templateId}` }, { status: 400 });
    }

    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ error: 'No tenant' }, { status: 404 });

    const desiredName = (body?.name_override || template.agent.name || 'New Agent').trim();
    const finalName = await resolveUniqueName(tenantId, desiredName);

    // Insert the agent row. Everything from the template.agent block, tenant
    // scoped, forced enabled=true by default so the operator lands on a
    // ready-to-tune-and-test agent.
    const agentInsert = {
      tenant_id: tenantId,
      name: finalName,
      description: template.agent.description,
      enabled: true,
      provider: template.agent.provider,
      model: template.agent.model,
      system_prompt: template.agent.system_prompt,
      temperature: template.agent.temperature,
      max_tokens: template.agent.max_tokens,
      confidence_threshold: template.agent.confidence_threshold,
      max_replies_per_lead: template.agent.max_replies_per_lead,
      escalate_on_intents: template.agent.escalate_on_intents,
    };

    const { data: agent, error: agentErr } = await supabase
      .from('ai_agents')
      .insert([agentInsert])
      .select()
      .single();
    if (agentErr) {
      return NextResponse.json({ error: `Failed to create agent: ${agentErr.message}` }, { status: 500 });
    }

    // Insert KB items. Non-atomic on purpose — if a specific KB row fails
    // (rare, e.g. weird content), the operator still has a usable agent.
    const kbSeeds = (template.knowledge || []).map((kb, idx) => ({
      agent_id: agent.id,
      title: kb.title,
      content: kb.content,
      active: true,
      sort_order: idx,
    }));

    let knowledgeCreated = 0;
    let knowledgeFailed = [];
    if (kbSeeds.length > 0) {
      const { data: kbRows, error: kbErr } = await supabase
        .from('ai_agent_knowledge')
        .insert(kbSeeds)
        .select('id');
      if (kbErr) {
        knowledgeFailed = kbSeeds.map((s) => s.title);
      } else {
        knowledgeCreated = kbRows?.length || 0;
      }
    }

    return NextResponse.json({
      data: {
        agent,
        template_id: template.id,
        template_name: template.name,
        knowledge_created: knowledgeCreated,
        knowledge_failed: knowledgeFailed,
      },
    });
  } catch (err) {
    console.error('Error creating agent from template:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

// GET — list the templates so the UI can render the picker. Public shape
// (no secrets); operator role NOT required for read, since the same list is
// baked into the client bundle anyway. Simpler to source both from here so
// UI stays in sync with the server.
export async function GET() {
  const { AI_AGENT_TEMPLATES } = await import('@/lib/aiAgentTemplates');
  // Return a slim preview + full details. The UI shows a card list, then
  // expands into the full prompt + KB on demand.
  const templates = AI_AGENT_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    tagline: t.tagline,
    description: t.description,
    icon_color: t.icon_color,
    agent: {
      name: t.agent.name,
      description: t.agent.description,
      provider: t.agent.provider,
      model: t.agent.model,
      temperature: t.agent.temperature,
      max_tokens: t.agent.max_tokens,
      confidence_threshold: t.agent.confidence_threshold,
      max_replies_per_lead: t.agent.max_replies_per_lead,
      escalate_on_intents: t.agent.escalate_on_intents,
      system_prompt: t.agent.system_prompt,
    },
    knowledge: t.knowledge,
  }));
  return NextResponse.json({ data: templates });
}
