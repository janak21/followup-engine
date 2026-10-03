import { NextResponse } from "next/server";
import { requireOperator } from "@/utils/role";
import { supabase } from "@/utils/supabase";
import { getTenantId } from "@/utils/tenant";

const OPS = {
  pause: "pause_journey_run",
  resume: "resume_journey_run",
  cancel: "cancel_journey_run",
};

export async function POST(request, { params }) {
  const guard = await requireOperator(request);
  if (guard) return guard;
  try {
    const { id } = await params;
    const { op } = await request.json();
    const rpc = OPS[op];
    if (!rpc) return NextResponse.json({ error: `op must be one of ${Object.keys(OPS).join(", ")}` }, { status: 400 });
    const tenantId = await getTenantId(request);
    const { data, error } = await supabase.rpc(rpc, { p_run_id: id, p_tenant_id: tenantId });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const okStatuses = { pause: "paused", resume: "running", cancel: "cancelled" };
    if (data?.status !== okStatuses[op]) {
      return NextResponse.json({ error: data?.status || "failed", detail: data }, { status: 409 });
    }
    return NextResponse.json({ data });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}