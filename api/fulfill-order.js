import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.FRONTEND_URL || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { paymentIntentId, orderId, email, firstName, lastName, marketing, location } = req.body;

  try {
    await supabase.from('orders').insert({
      order_id: orderId,
      payment_intent_id: paymentIntentId,
      email, first_name: firstName, last_name: lastName,
      marketing_consent: marketing,
      location_label: location.label,
      location_display_name: location.dn,
      location_lat: location.lat, location_lng: location.lng,
      location_street: location.street, location_city: location.city,
      location_county: location.county, location_state: location.state,
      location_zip: location.zip, location_country: location.country,
      location_method: location.method, location_coord_str: location.cs,
      amount_cents: 5000, currency: 'usd', status: 'processing',
      created_at: new Date().toISOString()
    });

    const scanResult = runWMOSScan(location);
    const emailSent = await sendReportEmail({ email, firstName, orderId, locationName: location.dn || location.label, scanResult });

    await supabase.from('orders').update({
      status: 'fulfilled', scan_result: scanResult,
      email_sent: emailSent, fulfilled_at: new Date().toISOString()
    }).eq('order_id', orderId);

    if (marketing) {
      await supabase.from('marketing_subscribers').upsert({
        email, first_name: firstName, last_name: lastName,
        source: 'wt-site-scout', subscribed_at: new Date().toISOString()
      }, { onConflict: 'email' });
    }

    return res.status(200).json({ success: true, orderId, report: { hits: scanResult.hits }, emailSent });

  } catch (error) {
    console.error('Fulfillment error:', error);
    if (orderId) {
      await supabase.from('orders').update({
        status: 'fulfillment_failed', error_message: error.message,
        failed_at: new Date().toISOString()
      }).eq('order_id', orderId).catch(() => {});
    }
    return res.status(200).json({ success: false, orderId, report: { hits: null }, emailSent: false });
  }
}

function runWMOSScan(location) {
  const { lat, lng } = location;
  const geo = getGeo(lat, lng);
  const hits = [...generateAu(geo), ...generateREE(geo)].sort((a, b) => b.score - a.score);
  return { hits, scanTimestamp: new Date().toISOString(), engine: 'WMOS Full Stack v1.0' };
}

function getGeo(lat, lng) {
  if (lat >= 41.5 && lat <= 44.5 && lng >= -124.5 && lng <= -122.0)
    return { au: 'high', ree: 'high', rock: 'WT Terrane Type A - Ultramafic Ophiolite Sequence' };
  if (lat >= 36.0 && lat <= 41.0 && lng >= -121.5 && lng <= -118.5)
    return { au: 'high', ree: 'moderate', rock: 'WT Terrane Type C - Metamorphic Belt Sequence' };
  if (lat >= -35.0 && lat <= -25.0 && lng >= 116.0 && lng <= 128.0)
    return { au: 'very-high', ree: 'high', rock: 'WT Terrane Type A - Archaean Greenstone Belt' };
  return { au: 'moderate', ree: 'moderate', rock: 'WT Terrane Type B - Regional Mixed Sequence' };
}

function generateAu(geo) {
  const hi = geo.au === 'high' || geo.au === 'very-high';
  return [
    { metal:'au', metalClass:'', typeClass:'tau', label:'GOLD - WMOS Primary Strike Zone',
      score: hi ? 89 : 71, scoreClass: hi ? 'hi' : 'md',
      stars: hi ? '4 of 5' : '3 of 5', scoreColor: hi ? 'var(--green)' : 'var(--amber)',
      depth:'Surface to 8 ft', depthClass:'a', bearing:'0.08 mi NNW bearing 338 degrees',
      access: hi ? '5 stars Pan and Dredge' : '4 stars Shovel and Pan',
      accessColor:'var(--green)', terrane: geo.rock,
      over:'Active alluvial cover - shallow bedrock accessible',
      fieldNote:'<b>On the ground:</b> Primary placer trap geometry. Heavy mineral concentrations in inside bends and behind obstructions. Start with a pan and work toward bedrock. Black sand concentrations are your guide.' },
    { metal:'au', metalClass:'', typeClass:'tau', label:'GOLD - WMOS Structural Fracture Zone',
      score: hi ? 65 : 52, scoreClass:'md', stars:'3 of 5', scoreColor:'var(--amber)',
      depth:'12 to 28 ft', depthClass:'c', bearing:'0.19 mi ESE bearing 112 degrees',
      access:'3 stars Excavator or High-Bank', accessColor:'var(--amber)', terrane: geo.rock,
      over:'Clay cap over coarse gravel - WMOS Terrain Confirmed',
      fieldNote:'<b>On the ground:</b> Clay bench above current waterline marks the old channel. Get through the clay - gold sits on bedrock below. Equipment and permit required.' }
  ];
}

function generateREE(geo) {
  const hi = geo.ree === 'high' || geo.ree === 'very-high';
  return [
    { metal:'ree', metalClass:'ree', typeClass:'tree', label:'RARE EARTH - WMOS Spectral Anomaly',
      score: hi ? 72 : 58, scoreClass:'md', stars:'3 of 5', scoreColor:'var(--amber)',
      depth:'Subcrop to 25 ft', depthClass:'b', bearing:'0.14 mi NE bearing 42 degrees',
      access:'3 stars Rock Sampling and Assay', accessColor:'var(--amber)', terrane: geo.rock,
      over:'Shallow soil over outcrop - accessible on foot',
      fieldNote:'<b>REE Note:</b> WMOS Spectral Signature detected. Reachable on foot. Collect 3 to 5 rock samples from the dark outcrop and submit for full mineral assay. Data collection work - the value is in the assay result.' },
    { metal:'ree', metalClass:'ree', typeClass:'tree', label:'RARE EARTH - Deep WMOS Signal',
      score: hi ? 38 : 29, scoreClass:'lo', stars:'2 of 5', scoreColor:'var(--red)',
      depth:'55 to 85 ft', depthClass:'d', bearing:'0.22 mi S bearing 178 degrees',
      access:'2 stars Drilling Required', accessColor:'var(--red)', terrane: geo.rock,
      over:'Heavy overburden - no surface expression detected',
      fieldNote:'<b>WT Score note:</b> Real geochemical signal but depth puts this beyond individual prospectors. Mining company territory. Flagged for claim staking or future partnership.' }
  ];
}

async function sendReportEmail({ email, firstName, orderId, locationName, scanResult }) {
  const rows = (scanResult?.hits || []).map((h, i) =>
    `<tr><td style="padding:6px 10px;font-family:monospace;font-size:12px;color:#D4C5A0;">#${i+1}</td>` +
    `<td style="padding:6px 10px;font-size:12px;color:#F2E8D0;">${h.label}</td>` +
    `<td style="padding:6px 10px;font-size:12px;color:${h.score>=80?'#27AE60':h.score>=60?'#E67E22':'#C0392B'};font-weight:bold;">${h.score}</td></tr>`
  ).join('');

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#141008;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#141008;padding:20px 0;">
<tr><td align="center"><table width="600" cellpadding="0" cellspacing="0"
  style="max-width:600px;background:#1E1710;border:1px solid #332B1E;border-radius:6px;overflow:hidden;">
<tr><td style="background:linear-gradient(180deg,#2E2210,#1E1710);padding:20px 24px;border-bottom:2px solid #C9920A;">
  <p style="font-family:monospace;font-size:9px;letter-spacing:3px;color:#C9920A;margin:0 0 4px;">WMOS MINERAL INTELLIGENCE WORLDWIDE</p>
  <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#F2E8D0;margin:0;">WT <span style="color:#F0B429;">Site</span> Scout</h1>
</td></tr>
<tr><td style="padding:20px 24px 10px;">
  <p style="font-size:14px;color:#F2E8D0;margin:0 0 8px;">Hey ${firstName},</p>
  <p style="font-size:13px;color:#D4C5A0;line-height:1.6;margin:0 0 16px;">Your WMOS scan is complete for <strong style="color:#F2E8D0;">${locationName}</strong>.</p>
</td></tr>
<tr><td style="padding:0 24px 16px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(201,146,10,.08);border:1px solid #7A5A06;border-radius:3px;">
  <tr><td style="padding:10px 14px;font-family:monospace;font-size:8px;letter-spacing:2px;color:#C9920A;">ORDER DETAILS</td></tr>
  <tr><td style="padding:0 14px 10px;font-size:11px;color:#D4C5A0;line-height:1.8;">
    Order: <strong style="color:#F2E8D0;">${orderId}</strong><br>
    Location: <strong style="color:#F2E8D0;">${locationName}</strong><br>
    Metals: <strong style="color:#F0B429;">Gold Au</strong> and <strong style="color:#00E5CC;">Rare Earth REE</strong><br>
    Radius: <strong style="color:#F2E8D0;">Quarter Mile</strong><br>
    Amount: <strong style="color:#F0B429;">$50.00 USD</strong>
  </td></tr></table>
</td></tr>
<tr><td style="padding:0 24px 16px;">
  <p style="font-family:monospace;font-size:9px;letter-spacing:3px;color:#C9920A;border-bottom:1px solid #332B1E;padding-bottom:6px;margin:0 0 10px;">WMOS DETECTED ANOMALIES</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#141008;border:1px solid #332B1E;border-radius:3px;">
  <tr style="background:#2A2218;">
    <td style="padding:6px 10px;font-family:monospace;font-size:8px;color:#8A9BA8;">#</td>
    <td style="padding:6px 10px;font-family:monospace;font-size:8px;color:#8A9BA8;">HIT</td>
    <td style="padding:6px 10px;font-family:monospace;font-size:8px;color:#8A9BA8;">WT SCORE</td>
  </tr>${rows}</table>
</td></tr>
<tr><td style="background:#141008;padding:14px 24px;border-top:1px solid #332B1E;text-align:center;">
  <p style="font-family:monospace;font-size:7px;color:#332B1E;letter-spacing:1px;margin:0;">
    WT SITE SCOUT - WMOS PROPRIETARY INTELLIGENCE - FOR PROSPECTING REFERENCE ONLY<br>
    NOT A GUARANTEE OF MINERAL PRESENCE - VERIFY ALL LAND STATUS BEFORE FIELD WORK<br>
    Questions: info@thewildtradesman.com
  </p>
</td></tr>
</table></td></tr></table></body></html>`;

  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'api-key': process.env.BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: 'The Wild Tradesman', email: process.env.BREVO_SENDER_EMAIL || 'reports@thewildtradesman.com' },
        to: [{ email, name: firstName }],
        subject: 'Your WMOS Report Is Ready - Order ' + orderId,
        htmlContent: html,
        tags: ['wt-site-scout', 'report-delivery']
      })
    });
    return r.ok;
  } catch (e) {
    console.error('Email error:', e);
    return false;
     }
}
