import { NextResponse } from 'next/server';
import { getTenantId } from '@/utils/tenant';
import { supabase } from '@/utils/supabase';
import { requireOperator } from "@/utils/role";

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
}

// Non-secret columns safe to return to the browser. The `config` JSONB and the
// Vault-backed secrets are deliberately excluded.
const CREDENTIAL_SAFE_COLUMNS = 'id, tenant_id, provider, n8n_credential_name, active, created_at';

// Keys that must never be persisted in tenant_credentials.config. They are
// routed to Supabase Vault via set_tenant_secret and read back through the
// SECURITY DEFINER get_tenant_secret helper.
const SECRET_KEYS = new Set([
  'auth_token',
  'api_key',
  'client_secret',
  'google_refresh_token',
  'google_access_token',
  'google_client_secret',
]);

// Split an incoming config blob into the safe (persisted) part and the secret
// part (written to Vault). Secrets never land in the stored config JSONB.
function splitSecrets(config) {
  const safeConfig = {};
  const secrets = {};
  for (const [k, v] of Object.entries(config || {})) {
    if (SECRET_KEYS.has(k)) secrets[k] = v;
    else safeConfig[k] = v;
  }
  return { safeConfig, secrets };
}

// Persist each recognized secret to Vault for this tenant+provider. Returns the
// first error encountered, or null on success.
async function writeSecretsToVault(tenantId, provider, secrets) {
  for (const [key, value] of Object.entries(secrets)) {
    const { error } = await supabase.rpc('set_tenant_secret', {
      p_tenant_id: tenantId,
      p_provider:  provider,
      p_key:       key,
      p_value:     value == null ? null : String(value),
    });
    if (error) return error;
  }
  return null;
}

// GET all credentials for the tenant
export async function GET(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role key missing.' },
      { status: 503 }
    );
  }

  try {
    const tenantId = await getTenantId(request);
    if (!tenantId) return NextResponse.json({ data: [] });

    const { data, error } = await supabase
      .from('tenant_credentials')
      .select('id, tenant_id, provider, n8n_credential_name, active, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    
    return NextResponse.json({ data: data || [] });
  } catch (err) {
    console.error('Error fetching credentials:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// POST a new credential
export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase configuration missing.' }, { status: 503 });
  }

  try {
    const { provider, n8n_credential_name, config, active } = await request.json();
    const targetTenantId = await getTenantId(request);
    if (!targetTenantId) return NextResponse.json({ error: 'No tenant found' }, { status: 404 });

    // Strip secrets out of the config before it is stored. Only safeConfig is
    // persisted; the secrets go to Vault via set_tenant_secret below.
    const { safeConfig, secrets } = splitSecrets(config);

    const newCred = {
      tenant_id: targetTenantId,
      provider,
      n8n_credential_name,
      config: safeConfig,
      active: active ?? true
    };

    const { data, error } = await supabase
      .from('tenant_credentials')
      .insert([newCred])
      .select(CREDENTIAL_SAFE_COLUMNS);

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ error: `Credential for provider '${provider}' already exists.` }, { status: 400 });
      }
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const secretErr = await writeSecretsToVault(targetTenantId, provider, secrets);
    if (secretErr) return NextResponse.json({ error: secretErr.message }, { status: 500 });

    return NextResponse.json({ data: data[0] });
  } catch (err) {
    console.error('Error creating credential:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// PUT to update an existing credential
export async function PUT(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase configuration missing.' }, { status: 503 });
  }

  try {
    const { id, provider, n8n_credential_name, config, active } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'Credential ID is required.' }, { status: 400 });
    }

    const tenantId = await getTenantId(request);
    const updates = {};
    if (provider !== undefined) updates.provider = provider;
    if (n8n_credential_name !== undefined) updates.n8n_credential_name = n8n_credential_name;
    if (active !== undefined) updates.active = active;

    // When a new config is supplied, split secrets out so only safeConfig is
    // persisted; the secrets are routed to Vault via set_tenant_secret below.
    let secrets = {};
    if (config !== undefined) {
      const split = splitSecrets(config);
      updates.config = split.safeConfig;
      secrets = split.secrets;
    }

    const { data, error } = await supabase
      .from('tenant_credentials')
      .update(updates)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select(CREDENTIAL_SAFE_COLUMNS);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) return NextResponse.json({ error: 'Credential not found' }, { status: 404 });

    // Resolve the provider for Vault addressing: prefer the body, fall back to
    // the stored row (returned above).
    if (Object.keys(secrets).length > 0) {
      const secretProvider = provider ?? data[0].provider;
      const secretErr = await writeSecretsToVault(tenantId, secretProvider, secrets);
      if (secretErr) return NextResponse.json({ error: secretErr.message }, { status: 500 });
    }

    return NextResponse.json({ data: data[0] });
  } catch (err) {
    console.error('Error updating credential:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// DELETE a credential
export async function DELETE(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase configuration missing.' }, { status: 503 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'Credential ID is required.' }, { status: 400 });
    }

    const tenantId = await getTenantId(request);
    const { error } = await supabase
      .from('tenant_credentials')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Error deleting credential:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
