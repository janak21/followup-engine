import { NextResponse } from "next/server";
import { supabase } from "@/utils/supabase";
import { getTenantId } from "@/utils/tenant";

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const tenantId = await getTenantId(request);
    const { data: runs, error } = await supabase
      .from("journey_runs")
      .select("id, journey_id, journey_key, status, current_step, next_action_at, trigger_type, created_at, completed_at")
      .eq("tenant_id", tenantId)
      .eq("lead_id", id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const journeyIds = [...new Set((runs || []).map((r) => r.journey_id).filter(Boolean))];
    let namesById = {};
    if (journeyIds.length > 0) {
      const { data: journeys } = await supabase
        .from("journeys").select("id, name, paused").in("id", journeyIds);
      namesById = Object.fromEntries((journeys || []).map((j) => [j.id, j]));
    }
    return NextResponse.json({
      data: (runs || []).map((r) => ({
        ...r,
        journey_name: namesById[r.journey_id]?.name || r.journey_key,
        journey_paused: namesById[r.journey_id]?.paused || false,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}