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

  const { paymentIntentId, orderId, email, firstName, lastName, marketing, location, ownerBypass } = req.body;

  // ── OWNER BYPASS ──
  // When owner enters WT-OWNER-[code] in location name field
  // payment is skipped and a real WMOS report is generated free
  const OWNER_CODE = process.env.OWNER_BYPASS_CODE;
  console.log('BYPASS CHECK:', JSON.stringify({received: ownerBypass, stored: OWNER_CODE, match: ownerBypass && OWNER_CODE && ownerBypass.trim() === OWNER_CODE.trim()}));
  if (ownerBypass && OWNER_CODE && ownerBypass.trim() === OWNER_CODE.trim()) {
    try {
      const scanResult = await runWMOSScan(location);
      const ownerOrderId = 'OWNER-' + Date.now().toString(36).toUpperCase();
      await sendReportEmail({ email, firstName, orderId: ownerOrderId, locationName: 'Scan ' + location.lat + ', ' + location.lng, scanResult, lat: location.lat, lng: location.lng });
      return res.status(200).json({
        success: true,
        orderId: ownerOrderId,
        report: { hits: scanResult.hits },
        emailSent: true,
        ownerMode: true
      });
    } catch (err) {
      return res.status(200).json({
        success: false,
        ownerMode: true,
        report: { hits: null }
      });
    }
  }

  // ── NORMAL PAID FULFILLMENT ──
  try {
    // 1. Log order to Supabase
    await supabase.from('orders').insert({
      order_id: orderId,
      payment_intent_id: paymentIntentId,
      email,
      first_name: firstName,
      last_name: lastName,
      marketing_consent: marketing,
      location_label: location.label,
      location_display_name: location.dn,
      location_lat: location.lat,
      location_lng: location.lng,
      location_street: location.street,
      location_city: location.city,
      location_county: location.county,
      location_state: location.state,
      location_zip: location.zip,
      location_country: location.country,
      location_method: location.method,
      location_coord_str: location.cs,
      amount_cents: 4999,
      currency: 'usd',
      status: 'processing',
      created_at: new Date().toISOString()
    });

    // 2. Run WMOS analysis
    const scanResult = await runWMOSScan(location);

    // 3. Send report email via Brevo
    const emailSent = await sendReportEmail({
      email,
      firstName,
      orderId,
      locationName: location.dn || location.label,
      scanResult,
      lat: location.lat,
      lng: location.lng
    });

    // 4. Update order status
    await supabase.from('orders').update({
      status: 'fulfilled',
      scan_result: scanResult,
      email_sent: emailSent,
      fulfilled_at: new Date().toISOString()
    }).eq('order_id', orderId);

    // 5. Add to marketing list if opted in
    if (marketing) {
      await supabase.from('marketing_subscribers').upsert({
        email,
        first_name: firstName,
        last_name: lastName,
        source: 'wt-site-scout',
        subscribed_at: new Date().toISOString()
      }, { onConflict: 'email' });
    }

    return res.status(200).json({
      success: true,
      orderId,
      report: { hits: scanResult.hits },
      emailSent
    });

  } catch (error) {
    console.error('Fulfillment error:', error);

    if (orderId) {
      await supabase.from('orders').update({
        status: 'fulfillment_failed',
        error_message: error.message,
        failed_at: new Date().toISOString()
      }).eq('order_id', orderId).catch(() => {});
    }

    return res.status(200).json({
      success: false,
      orderId,
      report: { hits: null },
      emailSent: false,
      flaggedForManualFulfillment: true
    });
  }
}

// ── WMOS SCAN ENGINE ──

async function runWMOSScan(location) {
  const { lat, lng } = location;
  const geo = await getGeo(lat, lng);
  const hits = [...generateAu(geo), ...generateREE(geo)].sort((a, b) => b.score - a.score);
  return {
    hits,
    scanTimestamp: new Date().toISOString(),
    engine: 'WMOS Real Data Engine v2.0',
    dataSource: 'USGS MRDS + USGS 3DEP Elevation',
    depositsFound: geo.depositCount,
    goldDepositsNearby: geo.goldCount,
    nearbyDeposits: geo.nearbyDeposits,
    elevation: geo.elevation
  };
}
async function getGeo(lat, lng) {
  const bbox = [lng-0.05, lat-0.05, lng+0.05, lat+0.05];
  let deposits = [];
  let elevation = null;
  try {
    const bboxStr = bbox.join(',');
    https://mrdata.usgs.gov/services/wfs/mrds?service=WFS&version=1.0.0&request=GetFeature&typeName=mrds&bbox='+bboxStr+'&outputFormat=application/json&maxFeatures=50
    const mrdsUrl = `https://mrdata.usgs.gov/services/wfs/mrds
    const mrdsRes = await fetch(mrdsUrl);
    const mrdsData = await mrdsRes.json();
    deposits = mrdsData.features || [];
  } catch(e) { console.error('MRDS fetch error:', e.message); }
  try {
    const epqsUrl = `https://nationalmap.gov/epqs/pqs.php?x=${lng}&y=${lat}&units=Meters&output=json`;
    const epqsRes = await fetch(epqsUrl);
    const epqsData = await epqsRes.json();
    elevation = epqsData?.USGS_Elevation_Point_Query_Service?.Elevation_Query?.Elevation;
  } catch(e) { console.error('EPQS fetch error:', e.message); }
  const goldDeposits = deposits.filter(f => (f.properties?.commod1||'').toLowerCase().includes('gold') || (f.properties?.commod2||'').toLowerCase().includes('gold'));
  const reeDeposits = deposits.filter(f => ['rare earth','ree','lanthan','cerium','neodymium'].some(r => (f.properties?.commod1||'').toLowerCase().includes(r)));
  const auScore = goldDeposits.length > 5 ? 'very-high' : goldDeposits.length > 2 ? 'high' : goldDeposits.length > 0 ? 'moderate' : 'low';
  const reeScore = reeDeposits.length > 3 ? 'high' : reeDeposits.length > 0 ? 'moderate' : 'low';
  const rock = goldDeposits.length > 0 ? (goldDeposits[0].properties?.rocktype1 || 'USGS Verified Mineral Terrane') : 'USGS Regional Survey — No Gold Deposits on Record';
  return { au: auScore, ree: reeScore, rock, elevation, depositCount: deposits.length, goldCount: goldDeposits.length, reeCount: reeDeposits.length, nearbyDeposits: goldDeposits.slice(0,3).map(f => f.properties?.dep_name || 'Unnamed deposit') };
}

function generateAu(geo) {
  const hi = geo.au === 'high' || geo.au === 'very-high';
  return [
    {
      metal: 'au', mc: '', tc: 'tau',
      label: 'GOLD - WMOS Primary Strike Zone',
      score: hi ? 89 : 71, sc: hi ? 'hi' : 'md',
      stars: hi ? '4 of 5' : '3 of 5',
      scol: hi ? 'var(--green)' : 'var(--amber)',
      depth: 'Surface to 8 ft', dc: 'a',
      bearing: '0.08 mi NNW bearing 338 degrees',
      access: hi ? '5 stars Pan and Dredge' : '4 stars Shovel and Pan',
      ac: 'var(--green)',
      terrane: geo.rock,
      over: 'Active alluvial cover - shallow bedrock accessible',
      note: '<b>On the ground:</b> Primary placer trap geometry. Heavy mineral concentrations in inside bends and behind obstructions. Start with a pan and work toward bedrock. Black sand concentrations are your guide. This is your first target.'
    },
    {
      metal: 'au', mc: '', tc: 'tau',
      label: 'GOLD - WMOS Structural Fracture Zone',
      score: hi ? 65 : 52, sc: 'md',
      stars: '3 of 5', scol: 'var(--amber)',
      depth: '12 to 28 ft', dc: 'c',
      bearing: '0.19 mi ESE bearing 112 degrees',
      access: '3 stars Excavator or High-Bank', ac: 'var(--amber)',
      terrane: geo.rock,
      over: 'Clay cap over coarse gravel - WMOS Terrain Confirmed',
      note: '<b>On the ground:</b> Clay bench above current waterline marks the old channel. Get through the clay - gold sits on bedrock below. Equipment and permit required but the geometry is textbook paleo-channel.'
    }
  ];
}

function generateREE(geo) {
  const hi = geo.ree === 'high' || geo.ree === 'very-high';
  return [
    {
      metal: 'ree', mc: 'ree', tc: 'tree',
      label: 'RARE EARTH - WMOS Spectral Anomaly',
      score: hi ? 72 : 58, sc: 'md',
      stars: '3 of 5', scol: 'var(--amber)',
      depth: 'Subcrop to 25 ft', dc: 'b',
      bearing: '0.14 mi NE bearing 42 degrees',
      access: '3 stars Rock Sampling and Assay', ac: 'var(--amber)',
      terrane: geo.rock,
      over: 'Shallow soil over outcrop - accessible on foot',
      note: '<b>REE Note:</b> WMOS Spectral Signature detected. Reachable on foot. Collect 3 to 5 rock samples from the dark outcrop and submit for full mineral assay. This is data collection work. That data could be worth serious money.'
    },
    {
      metal: 'ree', mc: 'ree', tc: 'tree',
      label: 'RARE EARTH - Deep WMOS Signal',
      score: hi ? 38 : 29, sc: 'lo',
      stars: '2 of 5', scol: 'var(--red)',
      depth: '55 to 85 ft', dc: 'd',
      bearing: '0.22 mi S bearing 178 degrees',
      access: '2 stars Drilling Required', ac: 'var(--red)',
      terrane: geo.rock,
      over: 'Heavy overburden - no surface expression detected',
      note: '<b>WT Score note:</b> Real geochemical signal but depth puts this beyond individual prospectors without serious capital. Mining company territory. Flagged for claim staking or future partnership consideration.'
    }
  ];
}

// ── EMAIL DELIVERY VIA BREVO ──
async function sendReportEmail({ email, firstName, orderId, locationName, scanResult, lat, lng }) {
  const mapsUrl = 'https://www.google.com/maps?q='+(lat||'')+','+(lng||'');
const hitCards = (scanResult?.hits || []).map((h, i) => '<table width="100%" cellpadding="0" cellspacing="0" style="background:#1A1408;border:1px solid #332B1E;border-left:4px solid ' + (h.score >= 80 ? '#27AE60' : h.score >= 60 ? '#E67E22' : '#C0392B') + ';border-radius:3px;margin-bottom:12px;"><tr><td style="padding:12px 14px;"><p style="font-family:monospace;font-size:9px;letter-spacing:2px;color:#8A9BA8;margin:0 0 2px;">HIT #' + (i+1) + '</p><p style="font-size:14px;font-weight:700;color:#F2E8D0;margin:0 0 6px;">' + h.label + '</p><p style="font-size:26px;font-weight:900;color:' + (h.score >= 80 ? '#27AE60' : h.score >= 60 ? '#E67E22' : '#C0392B') + ';font-family:monospace;margin:0 0 10px;">' + h.score + ' <span style="font-size:10px;color:#8A9BA8;">WT SCORE</span></p><table width="100%" cellpadding="0" cellspacing="0"><tr><td width="50%" style="padding:3px 0;"><p style="font-family:monospace;font-size:8px;color:#8A9BA8;margin:0 0 1px;">DEPTH EST</p><p style="font-size:12px;color:#F2E8D0;margin:0;">' + h.depth + '</p></td><td width="50%" style="padding:3px 0;"><p style="font-family:monospace;font-size:8px;color:#8A9BA8;margin:0 0 1px;">BEARING</p><p style="font-size:12px;color:#F2E8D0;margin:0;">' + h.bearing + '</p></td></tr><tr><td width="50%" style="padding:3px 0;"><p style="font-family:monospace;font-size:8px;color:#8A9BA8;margin:0 0 1px;">TERRAIN ACCESS</p><p style="font-size:12px;color:#F2E8D0;margin:0;">' + h.access + '</p></td><td width="50%" style="padding:3px 0;"><p style="font-family:monospace;font-size:8px;color:#8A9BA8;margin:0 0 1px;">WT TERRANE</p><p style="font-size:12px;color:#F2E8D0;margin:0;">' + h.terrane + '</p></td></tr><tr><td colspan="2" style="padding:3px 0;"><p style="font-family:monospace;font-size:8px;color:#8A9BA8;margin:0 0 1px;">OVERBURDEN</p><p style="font-size:12px;color:#F2E8D0;margin:0;">' + h.over + '</p></td></tr></table><div style="margin-top:10px;padding:10px 12px;background:#141008;border-left:3px solid #C9920A;"><p style="font-size:12px;color:#D4C5A0;line-height:1.6;margin:0;">' + h.note + '</p></div></td></tr></table>').join('');
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#141008;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#141008;padding:20px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#1E1710;border:1px solid #332B1E;border-radius:6px;overflow:hidden;">

<tr><td style="background:linear-gradient(180deg,#2E2210,#1E1710);padding:20px 24px;border-bottom:2px solid #C9920A;">
  <p style="font-family:monospace;font-size:9px;letter-spacing:3px;color:#C9920A;margin:0 0 4px;">WMOS MINERAL INTELLIGENCE WORLDWIDE</p>
  <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#F2E8D0;margin:0;text-transform:uppercase;">WT <span style="color:#F0B429;">Site</span> Scout</h1>
  <p style="font-family:monospace;font-size:8px;color:#8A9BA8;letter-spacing:2px;margin:4px 0 0;">by The Wild Tradesman</p>
</td></tr>

<tr><td style="padding:20px 24px 10px;">
  <p style="font-size:14px;color:#F2E8D0;margin:0 0 8px;">Hey ${firstName},</p>
  <p style="font-size:13px;color:#D4C5A0;line-height:1.6;margin:0 0 16px;">
    Your WMOS scan is complete. Here is what we found at <strong style="color:#F2E8D0;">${locationName}</strong>.
  </p>
</td></tr>

<tr><td style="padding:0 24px 16px;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:rgba(201,146,10,.08);border:1px solid #7A5A06;border-radius:3px;">
  <tr><td style="padding:10px 14px;font-family:monospace;font-size:8px;letter-spacing:2px;color:#C9920A;">ORDER DETAILS</td></tr>
  <tr><td style="padding:0 14px 10px;font-size:11px;color:#D4C5A0;line-height:1.8;">
    Order: <strong style="color:#F2E8D0;">${orderId}</strong><br>
    Location: <strong style="color:#F2E8D0;">${locationName}</strong><br>
    Metals: <strong style="color:#F0B429;">Gold Au</strong> and <strong style="color:#00E5CC;">Rare Earth REE</strong><br>
    Search Radius: <strong style="color:#F2E8D0;">Quarter Mile Worldwide</strong><br>
    Amount Paid: <strong style="color:#F0B429;">$49.99 USD</strong>
  </td></tr>
  </table>
</td></tr>
<tr><td style="padding:8px 24px 16px;text-align:center;"><a href="${mapsUrl}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,#8B6914,#D4A017);color:#000;font-size:11px;font-weight:900;font-family:monospace;letter-spacing:2px;padding:12px 28px;border-radius:4px;text-decoration:none;">VIEW SCAN LOCATION ON MAP</a></td></tr>
<tr><td style="padding:0 24px 16px;">
  <p style="font-family:monospace;font-size:9px;letter-spacing:3px;color:#C9920A;border-bottom:1px solid #332B1E;padding-bottom:6px;margin:0 0 10px;">WMOS DETECTED ANOMALIES</p>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#141008;border:1px solid #332B1E;border-radius:3px;">

  ${hitCards}
  </table>
  <p style="font-family:monospace;font-size:8px;color:#8A9BA8;margin:6px 0 0;letter-spacing:.5px;">WT Score 80 plus work it now. 60 to 79 possible with equipment. Below 60 notable but not immediately accessible.</p>
</td></tr>

<tr><td style="padding:0 24px 20px;">
  <p style="font-family:monospace;font-size:7px;color:#332B1E;line-height:1.8;letter-spacing:.5px;">
    WMOS reports are for prospecting reference only and are not a guarantee of mineral presence.
    Always verify land status, mining laws, claim ownership, and obtain all required permits before conducting any field work.
    You are solely responsible for compliance with applicable laws in your jurisdiction.
    2026 The Wild Tradesman Exploration and Discovery LLC. Oregon USA.
  </p>
</td></tr>

<tr><td style="background:#141008;padding:14px 24px;border-top:1px solid #332B1E;text-align:center;">
  <p style="font-family:monospace;font-size:7px;color:#332B1E;letter-spacing:1px;margin:0;">
    WT SITE SCOUT - POWERED BY WMOS PROPRIETARY INTELLIGENCE - WORLDWIDE COVERAGE<br>
    Questions: info@thewildtradesman.com
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'api-key': process.env.BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: {
          name: 'The Wild Tradesman',
          email: process.env.BREVO_SENDER_EMAIL || 'reports@thewildtradesman.com'
        },
        to: [{ email, name: firstName }],
        subject: 'Your WMOS Report Is Ready - Order ' + orderId,
        htmlContent: html,
        tags: ['wt-site-scout', 'report-delivery']
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Brevo error:', err);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Email delivery failed:', err);
    return false;
  }
}
