import { NextResponse } from "next/server";
import { requireOperator } from "@/utils/role";
import { supabase } from "@/utils/supabase";
import { getTenantId } from "@/utils/tenant";

export async function POST(request, { params }) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  try {
    const { id } = await params;
    const tenantId = await getTenantId(request);
    const { data, error } = await supabase.rpc("publish_journey_draft", {
      p_journey_id: id,
      p_tenant_id: tenantId,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (data?.status !== "published") {
      return NextResponse.json({ error: data?.status || "publish_failed", detail: data }, { status: 409 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}

// Discard the draft.
export async function DELETE(request, { params }) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  try {
    const { id } = await params;
    const tenantId = await getTenantId(request);
    const { error } = await supabase
      .from("journeys")
      .update({ draft_spec: null, draft_updated_at: null })
      .eq("id", id)
      .eq("tenant_id", tenantId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data: { discarded: true } });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}