import { NextResponse } from 'next/server';
import { supabase } from '@/utils/supabase';
import { getTenantId } from '@/utils/tenant';

function isSupabaseConfigured() {
  return !!process.env.NEXT_PUBLIC_SUPABASE_URL && 
         (!!process.env.SUPABASE_SERVICE_ROLE_KEY || !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

function buildLastSevenDays() {
  const days = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);

  for (let i = 0; i < 7; i += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    days.push({
      label: day.toLocaleDateString('en-US', { weekday: 'short' }),
      start: day,
      end: next,
    });
  }
  return days;
}

export async function GET(request) {
  try {
    const mockData = {
      kpis: {
        responseRate: "42.5%",
        callSuccessRate: "72.1%",
        activeJourneys: "4",
        dailySentCounts: "72"
      },
      actionBreakdown: [
        { type: "Email", count: 124 },
        { type: "SMS", count: 210 },
        { type: "Call", count: 86 }
      ],
      responseRatesOverTime: [
        { label: "Mon", rate: 35 },
        { label: "Tue", rate: 42 },
        { label: "Wed", rate: 38 },
        { label: "Thu", rate: 45 },
        { label: "Fri", rate: 50 },
        { label: "Sat", rate: 48 },
        { label: "Sun", rate: 52 }
      ],
      dailySentOverTime: [
        { label: "Mon", count: 45 },
        { label: "Tue", count: 52 },
        { label: "Wed", count: 68 },
        { label: "Thu", count: 72 },
        { label: "Fri", count: 58 },
        { label: "Sat", count: 24 },
        { label: "Sun", count: 18 }
      ]
    };

    if (!isSupabaseConfigured()) {
      return NextResponse.json({ data: mockData });
    }

    try {
      const tenantId = await getTenantId(request);
      const oneDayAgo = new Date(Date.now() - 24 * 3600_000);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000);
      const [actionsRes, eventsRes, journeysRes] = await Promise.all([
        supabase.from('actions').select('id, action_type, status, created_at').eq('tenant_id', tenantId),
        supabase.from('events').select('id, lead_id, channel, direction, call_outcome, raw_payload, created_at').eq('tenant_id', tenantId),
        supabase.from('journeys').select('id').eq('tenant_id', tenantId).eq('active', true)
      ]);

      if (actionsRes.error || eventsRes.error || journeysRes.error) {
        throw new Error(actionsRes.error?.message || eventsRes.error?.message || journeysRes.error?.message);
      }

      const actions = actionsRes.data || [];
      const events = eventsRes.data || [];
      const activeJourneys = journeysRes.data || [];

      const events30d = events.filter(e => new Date(e.created_at) >= thirtyDaysAgo);

      // Unique email/SMS inbound replies divided by unique email/SMS contacted leads in the last 30 days.
      const contactedLeadIds = new Set(
        events30d
          .filter(e => ['email', 'sms'].includes(e.channel) && e.direction === 'outbound' && e.lead_id)
          .map(e => e.lead_id)
      );
      const repliedLeadIds = new Set(
        events30d
          .filter(e => ['email', 'sms'].includes(e.channel) && e.direction === 'inbound' && e.lead_id && e.raw_payload?.bounce !== true)
          .map(e => e.lead_id)
      );
      const responseRate = contactedLeadIds.size > 0
        ? `${((repliedLeadIds.size / contactedLeadIds.size) * 100).toFixed(1)}%`
        : "0.0%";

      // Calls answered divided by outbound call attempts in the last 30 days.
      const callAttempts = events30d.filter(e => e.channel === 'call' && e.direction === 'outbound');
      const answeredCalls = callAttempts.filter(e => e.call_outcome === 'answered').length;
      const callSuccessRate = callAttempts.length > 0
        ? `${((answeredCalls / callAttempts.length) * 100).toFixed(1)}%`
        : "0.0%";

      // Active journeys count
      const activeJourneysCount = activeJourneys.length.toString();

      // Daily sent counts (actions completed in last 24h)
      const outboundTypes = ['email', 'sms', 'call'];
      const dailySent = actions.filter(a => outboundTypes.includes(a.action_type) && a.status === 'completed' && new Date(a.created_at) >= oneDayAgo).length;
      const dailySentCounts = dailySent.toString();

      // Action Breakdown: actions attempted/created in the last 30 days.
      const actions30d = actions.filter(a => new Date(a.created_at) >= thirtyDaysAgo);
      const emailCount = actions30d.filter(a => a.action_type === 'email').length;
      const smsCount = actions30d.filter(a => a.action_type === 'sms').length;
      const callCount = actions30d.filter(a => a.action_type === 'call').length;

      const actionBreakdown = [
        { type: "Email", count: emailCount },
        { type: "SMS", count: smsCount },
        { type: "Call", count: callCount }
      ];
      const days = buildLastSevenDays();
      const responseRatesOverTime = days.map(day => {
        const dayEvents = events.filter(e => {
          const created = new Date(e.created_at);
          return created >= day.start && created < day.end;
        });
        const dayContacted = new Set(
          dayEvents
            .filter(e => ['email', 'sms'].includes(e.channel) && e.direction === 'outbound' && e.lead_id)
            .map(e => e.lead_id)
        );
        const dayReplied = new Set(
          dayEvents
            .filter(e => ['email', 'sms'].includes(e.channel) && e.direction === 'inbound' && e.lead_id && e.raw_payload?.bounce !== true)
            .map(e => e.lead_id)
        );
        return {
          label: day.label,
          rate: dayContacted.size > 0 ? Math.round((dayReplied.size / dayContacted.size) * 100) : 0,
        };
      });
      const dailySentOverTime = days.map(day => ({
        label: day.label,
        count: actions.filter(a => {
          const created = new Date(a.created_at);
          return outboundTypes.includes(a.action_type) && a.status === 'completed' && created >= day.start && created < day.end;
        }).length,
      }));

      return NextResponse.json({
        data: {
          kpis: {
            responseRate,
            callSuccessRate,
            activeJourneys: activeJourneysCount,
            dailySentCounts
          },
          actionBreakdown,
          responseRatesOverTime,
          dailySentOverTime
        }
      });
    } catch (dbErr) {
      console.warn('Database query error during analytics calculation, falling back to mock data:', dbErr.message);
      return NextResponse.json({ data: mockData });
    }
  } catch (err) {
    console.error('Unexpected error fetching analytics:', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
