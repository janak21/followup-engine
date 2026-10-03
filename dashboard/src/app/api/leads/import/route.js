import { NextResponse } from 'next/server';
import { requireOperator } from "@/utils/role";

export async function POST(request) {
  const __guard = await requireOperator(request); if (__guard) return __guard;
  return NextResponse.json({
    error: 'CSV import now uses a staged preview and commit flow. Use /api/leads/import/preview first, then /api/leads/import/commit.',
  }, { status: 410 });
}
