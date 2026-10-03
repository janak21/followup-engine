// Memory-based mock database for seamless fallback and interactive frontend edits.
// This preserves edits, additions, and deletions in the current server lifecycle.

if (!globalThis.mockDb) {
  const now = new Date();
  
  // Helper to subtract/add time
  const hoursAgo = (h) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
  const daysAgo = (d) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();
  const minsAgo = (m) => new Date(now.getTime() - m * 60 * 1000).toISOString();
  const minsAhead = (m) => new Date(now.getTime() + m * 60 * 1000).toISOString();

  globalThis.mockDb = {
    leads: [
      {
        id: "1",
        first_name: "Sarah",
        last_name: "Jenkins",
        email: "sarah.j@acme.com",
        phone_raw: "+1 (555) 019-9283",
        phone_e164: "+15550199283",
        journey_template: "enterprise_onboarding",
        journey_status: "active",
        responded: true,
        opt_out: false,
        raw_payload: { company: "Acme Corp", size: "500-1000", source: "Inbound Webinar" },
        created_at: daysAgo(2),
        updated_at: daysAgo(2)
      },
      {
        id: "2",
        first_name: "David",
        last_name: "Miller",
        email: "david@millertech.co",
        phone_raw: "+1 (555) 018-8374",
        phone_e164: "+15550188374",
        journey_template: "inbound_demo_request",
        journey_status: "completed",
        responded: true,
        opt_out: false,
        raw_payload: { company: "Miller Tech", source: "Organic Search", role: "CTO" },
        created_at: daysAgo(5),
        updated_at: daysAgo(1)
      },
      {
        id: "3",
        first_name: "Marcus",
        last_name: "Vance",
        email: "marcus.vance@vancesolutions.com",
        phone_raw: "+1 (555) 017-7463",
        phone_e164: "+15550177463",
        journey_template: "re_engagement_cold",
        journey_status: "paused",
        responded: false,
        opt_out: true,
        raw_payload: { company: "Vance Solutions", lead_score: 82 },
        created_at: daysAgo(10),
        updated_at: daysAgo(4)
      },
      {
        id: "4",
        first_name: "Elena",
        last_name: "Rostova",
        email: "elena@rostova.io",
        phone_raw: "+1 (555) 016-6552",
        phone_e164: "+15550166552",
        journey_template: "inbound_demo_request",
        journey_status: "new",
        responded: false,
        opt_out: false,
        raw_payload: { company: "Rostova LLC", referral: "Partner Network" },
        created_at: hoursAgo(1),
        updated_at: hoursAgo(1)
      },
      {
        id: "5",
        first_name: "Tyler",
        last_name: "Durden",
        email: "tyler@soapcorp.biz",
        phone_raw: "+1 (555) 015-5441",
        phone_e164: "+15550155441",
        journey_template: "enterprise_onboarding",
        journey_status: "failed",
        responded: true,
        opt_out: false,
        raw_payload: { company: "Soap Corp", department: "Operations" },
        created_at: daysAgo(3),
        updated_at: daysAgo(3)
      }
    ],
    journeys: [
      { id: "j1", journey_key: "demo_journey_1", name: "Demo Email Journey", active: true, created_at: daysAgo(30) },
      { id: "j2", journey_key: "enterprise_onboarding", name: "Enterprise Onboarding", active: true, created_at: daysAgo(30) },
      { id: "j3", journey_key: "inbound_demo_request", name: "Inbound Demo Request", active: true, created_at: daysAgo(30) },
      { id: "j4", journey_key: "re_engagement_cold", name: "Re-engagement Cold Campaign", active: true, created_at: daysAgo(30) }
    ],
    senders: [
      {
        id: "s1",
        sender_slot: "slot_1",
        sender_name: "Sender Alpha",
        sender_email: "alpha@example.com",
        domain: "example.com",
        active: true,
        daily_limit: 100,
        sent_today: 24,
        warmup_stage: "active",
        health_status: "green",
        total_sent: 1240,
        last_sent_at: minsAgo(15)
      },
      {
        id: "s2",
        sender_slot: "slot_2",
        sender_name: "Sender Beta",
        sender_email: "beta@example.com",
        domain: "example.com",
        active: true,
        daily_limit: 50,
        sent_today: 48,
        warmup_stage: "active",
        health_status: "green",
        total_sent: 890,
        last_sent_at: minsAgo(5)
      },
      {
        id: "s3",
        sender_slot: "slot_3",
        sender_name: "Sender Gamma",
        sender_email: "gamma@example.com",
        domain: "example.com",
        active: false,
        daily_limit: 200,
        sent_today: 0,
        warmup_stage: "paused",
        health_status: "yellow",
        total_sent: 4320,
        last_sent_at: daysAgo(1)
      }
    ],
    templates: [
      {
        id: "t1",
        template_key: "demo_email_1",
        channel: "email",
        subject: "Hello from Example Co",
        body: "Hi {{first_name}},\n\nThis is a test email from the new Follow-Up Engine.\n\nBest,\nJanak",
        active: true
      },
      {
        id: "t2",
        template_key: "sms_intro",
        channel: "sms",
        subject: null,
        body: "Hi {{first_name}}, thanks for your interest in Example Co! Ready to hop on a quick call this week? Reply YES to confirm.",
        active: true
      },
      {
        id: "t3",
        template_key: "call_script_1",
        channel: "call",
        subject: null,
        body: "Interactive AI Agent calling to discuss scheduling options.",
        active: true
      }
    ],
    tenant: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "Internal",
      timezone: "America/New_York",
      business_hours: {
        start: "09:00",
        end: "17:00",
        days: ["Mon", "Tue", "Wed", "Thu", "Fri"]
      },
      team_alert_email: "alerts@example.com"
    },
    // Actions are outbound interactions
    actions: [
      {
        id: "a1",
        lead_id: "1",
        action_type: "email",
        step_index: 0,
        template_key: "demo_email_1",
        run_at: daysAgo(2),
        status: "completed",
        payload: { subject: "Hello from Example Co", body: "Hi Sarah, This is a test email..." },
        completed_at: daysAgo(2)
      },
      {
        id: "a2",
        lead_id: "1",
        action_type: "call",
        step_index: 1,
        template_key: "call_script_1",
        run_at: daysAgo(1),
        status: "completed",
        payload: { script: "Interactive AI Agent calling..." },
        completed_at: daysAgo(1)
      },
      {
        id: "a3",
        lead_id: "2",
        action_type: "email",
        step_index: 0,
        template_key: "demo_email_1",
        run_at: daysAgo(5),
        status: "completed",
        completed_at: daysAgo(5)
      },
      {
        id: "a4",
        lead_id: "2",
        action_type: "call",
        step_index: 1,
        template_key: "call_script_1",
        run_at: daysAgo(3),
        status: "failed",
        error_message: "No answer after 4 rings",
        completed_at: daysAgo(3)
      },
      {
        id: "a5",
        lead_id: "2",
        action_type: "sms",
        step_index: 2,
        template_key: "sms_intro",
        run_at: daysAgo(2),
        status: "completed",
        completed_at: daysAgo(2)
      },
      {
        id: "a6",
        lead_id: "2",
        action_type: "call",
        step_index: 3,
        template_key: "call_script_1",
        run_at: hoursAgo(2),
        status: "completed",
        completed_at: hoursAgo(2)
      },
      {
        id: "a7",
        lead_id: "4",
        action_type: "email",
        step_index: 0,
        template_key: "demo_email_1",
        run_at: minsAhead(15),
        status: "pending"
      },
      {
        id: "a8",
        lead_id: "5",
        action_type: "email",
        step_index: 0,
        template_key: "demo_email_1",
        run_at: daysAgo(3),
        status: "completed",
        completed_at: daysAgo(3)
      }
    ],
    // Events are inbound interactions or trigger events
    events: [
      {
        id: "e1",
        lead_id: "1",
        channel: "email",
        direction: "inbound",
        provider: "gmail",
        from_address: "sarah.j@acme.com",
        to_address: "alpha@example.com",
        subject: "Re: Hello from Example Co",
        body: "Thanks for the email! I'm interested. Can we do a call?",
        created_at: daysAgo(1.5)
      },
      {
        id: "e2",
        lead_id: "1",
        channel: "call",
        direction: "outbound", // out of the system call outcomes
        provider: "retell",
        call_duration_seconds: 145,
        call_outcome: "connected",
        call_disposition: "interested",
        call_recording_url: "https://actions.retellai.com/recordings/demo-sarah.mp3",
        call_transcript: "Sarah: Hello?\nAI: Hi Sarah, this is the AI assistant from Example Co. I noticed you wanted to schedule a call.\nSarah: Oh, yes, absolutely. I'm looking for a follow-up engine that can automate SMS and email outreach based on trigger events.\nAI: That's exactly what Example Co is built for! We support complex journeys and native voice calling as well.\nSarah: Awesome, send me a calendar link via text and I will book a slot.",
        call_summary: "Sarah is interested in follow-up automation. Requested a calendar booking link.",
        created_at: daysAgo(1)
      },
      {
        id: "e3",
        lead_id: "1",
        channel: "sms",
        direction: "inbound",
        provider: "twilio",
        from_address: "+15550199283",
        to_address: "+15550201010",
        body: "Yes, 3 PM tomorrow works for me!",
        created_at: hoursAgo(10)
      },
      {
        id: "e4",
        lead_id: "2",
        channel: "web",
        direction: "inbound",
        provider: "website_form",
        body: "Demo request form submitted",
        created_at: daysAgo(5)
      },
      {
        id: "e5",
        lead_id: "2",
        channel: "email",
        direction: "inbound",
        provider: "gmail",
        body: "Sure, let's connect.",
        created_at: daysAgo(4)
      },
      {
        id: "e6",
        lead_id: "2",
        channel: "email",
        direction: "inbound",
        provider: "gmail",
        body: "Sorry I missed your call, can you call me tomorrow?",
        created_at: daysAgo(1)
      },
      {
        id: "e7",
        lead_id: "2",
        channel: "call",
        direction: "outbound",
        provider: "retell",
        call_duration_seconds: 210,
        call_outcome: "connected",
        call_disposition: "converted",
        call_recording_url: "https://actions.retellai.com/recordings/demo-david.mp3",
        call_transcript: "David: Hello, David speaking.\nAI: Hi David, calling back as requested.\nDavid: Perfect timing. We reviewed the docs and we are ready to proceed with a trial.\nAI: Wonderful! I'll trigger the onboarding setup.",
        call_summary: "CTO David Miller agreed to start a contract trial. Set up onboarding workflow.",
        created_at: hoursAgo(2)
      },
      {
        id: "e8",
        lead_id: "4",
        channel: "web",
        direction: "inbound",
        provider: "website_form",
        body: "Elena Rostova signed up for the live demo stream",
        created_at: hoursAgo(1)
      }
    ]
  };
}

export function getMockLeads() {
  return globalThis.mockDb.leads;
}

export function getMockLeadTimeline(leadId) {
  const leadActions = globalThis.mockDb.actions.filter(a => a.lead_id === leadId);
  const leadEvents = globalThis.mockDb.events.filter(e => e.lead_id === leadId);
  
  // Map actions to a standard timeline format
  const actionItems = leadActions.map(act => ({
    id: act.id,
    type: 'outbound',
    channel: act.action_type,
    title: `Outbound ${act.action_type.toUpperCase()}`,
    status: act.status,
    timestamp: act.completed_at || act.run_at,
    details: act.payload || {},
    error: act.error_message
  }));

  // Map events to a standard timeline format
  const eventItems = leadEvents.map(evt => ({
    id: evt.id,
    type: 'inbound',
    channel: evt.channel,
    title: evt.direction === 'inbound' ? `Inbound ${evt.channel.toUpperCase()}` : `Call Result (${evt.call_outcome})`,
    status: evt.call_outcome || 'received',
    timestamp: evt.created_at,
    body: evt.body,
    callDuration: evt.call_duration_seconds,
    callRecordingUrl: evt.call_recording_url,
    callTranscript: evt.call_transcript,
    callSummary: evt.call_summary,
    from: evt.from_address
  }));

  // Sort chronologically (oldest to newest) or reverse (newest to oldest)
  // Let's do newest first
  return [...actionItems, ...eventItems].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export function addMockLead(leadData) {
  const newId = (globalThis.mockDb.leads.length + 1).toString();
  const nowStr = new Date().toISOString();
  const newLead = {
    id: newId,
    first_name: leadData.first_name || "",
    last_name: leadData.last_name || "",
    email: leadData.email || "",
    phone_raw: leadData.phone_raw || "",
    phone_e164: leadData.phone_e164 || leadData.phone_raw || "",
    journey_template: leadData.journey_template || "demo_journey_1",
    journey_status: leadData.journey_status || "new",
    responded: false,
    opt_out: false,
    custom_fields: leadData.custom_fields || {},
    raw_payload: leadData.raw_payload || {},
    created_at: nowStr,
    updated_at: nowStr
  };
  globalThis.mockDb.leads.unshift(newLead);
  
  // Add a trigger event for the new lead
  globalThis.mockDb.events.push({
    id: "e_new_" + newId,
    lead_id: newId,
    channel: "system",
    direction: "inbound",
    provider: "followup_engine",
    body: `Lead enrolled in journey ${newLead.journey_template}`,
    created_at: nowStr
  });

  // Find step 0 from seed journeys and queue the first action
  let step0 = { type: 'email', template_key: 'demo_email_1' };
  const newAction = {
    id: "a_new_" + newId + "_0",
    lead_id: newId,
    action_type: step0.type,
    step_index: 0,
    template_key: step0.template_key,
    run_at: nowStr,
    status: "pending",
    payload: { subject: "Hello from Example Co", body: `Hi ${newLead.first_name}, This is a test email...` }
  };
  globalThis.mockDb.actions.push(newAction);

  return newLead;
}

export function editMockLead(id, leadData) {
  const index = globalThis.mockDb.leads.findIndex(l => l.id === id);
  if (index !== -1) {
    const updated = {
      ...globalThis.mockDb.leads[index],
      ...leadData,
      updated_at: new Date().toISOString()
    };
    globalThis.mockDb.leads[index] = updated;
    return updated;
  }
  return null;
}

export function deleteMockLead(id) {
  const index = globalThis.mockDb.leads.findIndex(l => l.id === id);
  if (index !== -1) {
    globalThis.mockDb.leads.splice(index, 1);
    // clean up associated actions/events from mockDb to keep clean state
    globalThis.mockDb.actions = globalThis.mockDb.actions.filter(a => a.lead_id !== id);
    globalThis.mockDb.events = globalThis.mockDb.events.filter(e => e.lead_id !== id);
    return true;
  }
  return false;
}

export function getMockJourneys() {
  return globalThis.mockDb.journeys;
}

export function getMockSenders() {
  return globalThis.mockDb.senders;
}

export function editMockSender(id, senderData) {
  const index = globalThis.mockDb.senders.findIndex(s => s.id === id);
  if (index !== -1) {
    globalThis.mockDb.senders[index] = {
      ...globalThis.mockDb.senders[index],
      ...senderData
    };
    return globalThis.mockDb.senders[index];
  }
  return null;
}

export function getMockTemplates() {
  return globalThis.mockDb.templates;
}

export function addMockTemplate(tplData) {
  const newId = "t_" + (globalThis.mockDb.templates.length + 1);
  const newTpl = {
    id: newId,
    template_key: tplData.template_key || "new_template",
    channel: tplData.channel || "email",
    subject: tplData.subject || "",
    body: tplData.body || "",
    active: tplData.active ?? true
  };
  globalThis.mockDb.templates.push(newTpl);
  return newTpl;
}

export function editMockTemplate(id, tplData) {
  const index = globalThis.mockDb.templates.findIndex(t => t.id === id);
  if (index !== -1) {
    globalThis.mockDb.templates[index] = {
      ...globalThis.mockDb.templates[index],
      ...tplData
    };
    return globalThis.mockDb.templates[index];
  }
  return null;
}

export function deleteMockTemplate(id) {
  const index = globalThis.mockDb.templates.findIndex(t => t.id === id);
  if (index !== -1) {
    globalThis.mockDb.templates.splice(index, 1);
    return true;
  }
  return false;
}

export function addMockJourney(jData) {
  const newId = "j_" + (globalThis.mockDb.journeys.length + 1);
  const newJ = {
    id: newId,
    journey_key: jData.journey_key || "new_journey",
    name: jData.name || "New Journey",
    active: jData.active ?? true,
    created_at: new Date().toISOString()
  };
  globalThis.mockDb.journeys.push(newJ);
  return newJ;
}

export function editMockJourney(id, jData) {
  const index = globalThis.mockDb.journeys.findIndex(j => j.id === id);
  if (index !== -1) {
    globalThis.mockDb.journeys[index] = {
      ...globalThis.mockDb.journeys[index],
      ...jData
    };
    return globalThis.mockDb.journeys[index];
  }
  return null;
}

export function deleteMockJourney(id) {
  const index = globalThis.mockDb.journeys.findIndex(j => j.id === id);
  if (index !== -1) {
    globalThis.mockDb.journeys.splice(index, 1);
    return true;
  }
  return false;
}

export function getMockTenant() {
  return globalThis.mockDb.tenant;
}

export function updateMockTenant(tenantData) {
  globalThis.mockDb.tenant = {
    ...globalThis.mockDb.tenant,
    ...tenantData
  };
  return globalThis.mockDb.tenant;
}
